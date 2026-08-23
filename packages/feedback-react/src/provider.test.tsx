import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { useThemeFamily } from "raft-ui";
import { describe, expect, it } from "vitest";
import {
  FeedbackWorkspace,
  isNearConversationBottom,
  MAX_FEEDBACK_ATTACHMENT_BYTES,
  mergeCommentPages,
  mergeTicketPages,
  validateFeedbackAttachments,
} from "./components.js";
import {
  FeedbackProvider,
  nextUnreadReport,
  useHandsFeedback,
} from "./provider.js";
import {
  feedbackMessage,
  resolveFeedbackLocale,
  resolveFeedbackLocaleFromPreferences,
} from "./locale.js";
import type { HandsFeedbackTransport } from "./types.js";

const transport = {} as HandsFeedbackTransport;

function Probe() {
  const value = useHandsFeedback();
  const raftTheme = useThemeFamily();
  return (
    <span data-theme={value.theme} data-raft-theme={raftTheme}>
      {value.unreadTotal ?? "unknown"}
    </span>
  );
}

describe("FeedbackProvider", () => {
  it("exposes theme without accepting credentials or reporter identity", () => {
    const html = renderToStaticMarkup(
      <FeedbackProvider transport={transport} theme="brutal">
        <Probe />
      </FeedbackProvider>,
    );
    expect(html).toMatch(/data-theme="brutal"/);
    expect(html).toMatch(/data-raft-theme="brutal"/);
    expect(html).toMatch(/>unknown/);
  });

  it("supports explicit locale and has deterministic browser fallback", () => {
    const html = renderToStaticMarkup(
      <FeedbackProvider transport={transport} locale="zh-CN">
        <FeedbackWorkspace />
      </FeedbackProvider>,
    );
    expect(html).toContain("新建反馈");
    expect(resolveFeedbackLocale("en")).toBe("en");
    expect(resolveFeedbackLocaleFromPreferences(["en-US", "zh-CN"])).toBe("en");
    expect(
      resolveFeedbackLocaleFromPreferences(["fr-FR", "zh-CN", "en-US"]),
    ).toBe("zh-CN");
    expect(feedbackMessage("en", "active")).toBe("Active");
    expect(feedbackMessage("en", "workspaceTitle")).toBe("My Feedback");
    expect(feedbackMessage("zh-CN", "active")).toBe("活跃");
    expect(feedbackMessage("zh-CN", "workspaceTitle")).toBe("我的反馈");
    expect(feedbackMessage("en", "idea")).toBe("Idea");
    expect(feedbackMessage("en", "problem")).toBe("Bug");
    expect(feedbackMessage("zh-CN", "idea")).toBe("想法");
    expect(feedbackMessage("zh-CN", "problem")).toBe("问题");
    expect(feedbackMessage("en", "emptyActiveTitle")).toBe(
      "Nothing in progress",
    );
    expect(feedbackMessage("zh-CN", "emptyAllTitle")).toBe("还没有反馈");
    expect(feedbackMessage("zh-CN", "emptyEndedTitle")).toBe(
      "还没有已结束的反馈",
    );
    expect(
      feedbackMessage(
        "en",
        "attachmentTooMany",
        { attachmentTooMany: "Limit {count}" },
        { count: 3 },
      ),
    ).toBe("Limit 3");
  });

  it("renders the ticket inbox as the landing surface", () => {
    const html = renderToStaticMarkup(
      <FeedbackProvider transport={transport} theme="brutal">
        <FeedbackWorkspace />
      </FeedbackProvider>,
    );
    expect(html).toContain('data-hands-feedback-theme="brutal"');
    expect(html).toContain("Feedback");
    expect(html).toContain("New feedback");
    expect(html).not.toContain("dashboard");
  });

  it("fails closed outside a reporter-scoped provider", () => {
    expect(() => renderToStaticMarkup(<Probe />)).toThrow(
      /require FeedbackProvider/,
    );
  });

  it("emits only authoritative unread total changes", () => {
    expect(nextUnreadReport(null, { total: 3, source: "list" })).toEqual({
      next: 3,
      notify: true,
    });
    expect(nextUnreadReport(3, { total: 3, source: "detail" })).toEqual({
      next: 3,
      notify: false,
    });
    expect(nextUnreadReport(3, { total: 1, source: "detail" })).toEqual({
      next: 1,
      notify: true,
    });
    expect(() => nextUnreadReport(1, { total: -1, source: "list" })).toThrow(
      /non-negative/,
    );
    expect(() => nextUnreadReport(1, { total: 1.5, source: "list" })).toThrow(
      /safe integer/,
    );
    expect(() =>
      nextUnreadReport(1, { total: Number.NaN, source: "list" }),
    ).toThrow(/safe integer/);
  });

  it("deduplicates overlapping cursor pages and keeps the fresh ticket value", () => {
    const ticket = {
      id: "ticket-1",
      kind: "feedback" as const,
      status: "open" as const,
      message: "First",
      createdAt: 1,
      updatedAt: 1,
      unread: false,
      unreadCount: 0,
      attachmentCount: 0,
      commentCount: 0,
    };
    const result = mergeTicketPages(
      [ticket],
      [
        { ...ticket, message: "Fresh", updatedAt: 2 },
        { ...ticket, id: "ticket-2", message: "Second" },
      ],
    );
    expect(result.map(({ id, message }) => ({ id, message }))).toEqual([
      { id: "ticket-1", message: "Fresh" },
      { id: "ticket-2", message: "Second" },
    ]);
  });

  it("deduplicates overlapping comment pages in chronological order", () => {
    const comment = (id: string, createdAt: number, body = id) => ({
      id,
      createdAt,
      body,
      authorType: "staff" as const,
    });
    expect(
      mergeCommentPages(
        [comment("b", 2), comment("a", 1)],
        [comment("b", 2, "fresh"), comment("c", 3)],
      ),
    ).toEqual([comment("a", 1), comment("b", 2, "fresh"), comment("c", 3)]);
  });

  it("ships package-owned layout without restyling raft-ui primitives", () => {
    const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8");
    expect(css).toMatch(/\.hands-feedback-skeleton-row[^}]*height:\s*4rem/);
    expect(css).toMatch(/\.hands-feedback-skeleton-detail[^}]*height:\s*10rem/);
    expect(css).not.toMatch(/\.h-16\b|\.h-40\b|\.w-full\b/);
    expect(css).toMatch(/@media \(max-width: 640px\)/);
    expect(css).toMatch(/\.hands-feedback-middle[^}]*overflow-y:\s*auto/);
    expect(css).toMatch(/env\(safe-area-inset-bottom\)/);
    expect(css).toMatch(/prefers-reduced-motion:\s*reduce/);
    expect(css).toMatch(
      /\.hands-feedback-header h2\s*\{[^}]*font-size:\s*17px[^}]*font-weight:\s*700/,
    );
    expect(css).toMatch(
      /\.hands-feedback-list-scroll\[data-feedback-empty-scroll="true"\]\s*\{[^}]*align-content:\s*stretch[^}]*gap:\s*0[^}]*grid-template-rows:\s*auto minmax\(0, 1fr\)[^}]*padding:\s*6px 2px 0/,
    );
    expect(css).toMatch(
      /\.hands-feedback-list-scroll\[data-feedback-empty-scroll="true"\][^{]*> \.hands-feedback-pull-indicator\s*\{[^}]*margin-bottom:\s*0/,
    );
    expect(css).toMatch(
      /\.hands-feedback-inbox-content\s*\{[^}]*padding:\s*18px 18px calc\(18px \+ env\(safe-area-inset-bottom, 0px\)\)/,
    );
    expect(css).toMatch(
      /@media \(max-width: 640px\)[\s\S]*?\.hands-feedback-inbox-content\s*\{[^}]*padding:\s*18px 16px calc\(18px \+ env\(safe-area-inset-bottom, 0px\)\)/,
    );
    expect(css).toMatch(
      /\.hands-feedback-empty\s*\{[^}]*align-self:\s*stretch[^}]*border:\s*2px dashed[^}]*height:\s*auto[^}]*justify-content:\s*center[^}]*justify-self:\s*stretch[^}]*min-height:\s*0[^}]*padding:\s*40px 24px 48px/,
    );
    expect(css).toMatch(
      /\.hands-feedback-empty-icon\s*\{[^}]*border:\s*2px solid[^}]*box-shadow:\s*2px 2px 0[^}]*height:\s*44px[^}]*width:\s*44px/,
    );
    expect(css).toMatch(
      /\.hands-feedback-reply-footer[^}]*padding-bottom:\s*calc\(18px \+ env\(safe-area-inset-bottom\)\)/,
    );
    expect(css).toMatch(
      /\.hands-feedback-unread-count\s*\{[^}]*border-radius:\s*6px[^}]*color:\s*var\(--foreground-inverse[^}]*min-width:\s*20px/,
    );
    expect(css).not.toMatch(/\.hands-feedback-unread-dot\s*\{/);
    expect(css).toMatch(
      /\.hands-feedback-problem-chip\s*\{[^}]*--reference-icon:\s*var\(--danger[^}]*background-color:\s*var\(--danger-muted/,
    );
    expect(css).toMatch(
      /\.hands-feedback-reference-chip\s*\{[^}]*font-size:\s*10\.5px[^}]*height:\s*20px[^}]*min-height:\s*20px[^}]*padding:\s*0 6px/,
    );
    expect(css).toMatch(
      /\.hands-feedback-reference-chip-content svg\s*\{[^}]*height:\s*10px[^}]*width:\s*10px/,
    );
    expect(css).toMatch(
      /\.hands-feedback-ticket-title\s*\{[^}]*overflow:\s*hidden[^}]*text-overflow:\s*ellipsis[^}]*white-space:\s*nowrap/,
    );
    expect(css).toMatch(
      /\.hands-feedback-ticket-date\s*\{[^}]*line-height:\s*1\.4[^}]*margin-top:\s*4px/,
    );
    expect(css).toMatch(
      /\.hands-feedback-ticket-content\s*\{[^}]*pointer-events:\s*auto[^}]*z-index:\s*1/,
    );
    expect(css).toMatch(
      /\.hands-feedback-close-split\s*\{[^}]*height:\s*20px/,
    );
    expect(css).toMatch(
      /\.hands-feedback-close-caret\s*\{[^}]*min-width:\s*20px/,
    );
    expect(css).toMatch(
      /\.hands-feedback-close-split\[data-menu-open\],[\s\S]*\.hands-feedback-close-split:has\(\.hands-feedback-close-main:active\),[\s\S]*\.hands-feedback-close-split:has\(\.hands-feedback-close-caret:active\)\s*\{[^}]*box-shadow:\s*4px 4px 0 var\(--line-strong\)[^}]*translate:\s*0 -1px/,
    );
    expect(css).toMatch(
      /\.hands-feedback-close-caret\[data-popup-open\]\s*\{[^}]*box-shadow:\s*none !important[^}]*translate:\s*0 !important/,
    );
    expect(css).toMatch(
      /\.hands-feedback-close-main:active,[\s\S]*\.hands-feedback-close-caret:active\s*\{[^}]*box-shadow:\s*none !important[^}]*translate:\s*0 !important/,
    );
    expect(css).toMatch(
      /\.hands-feedback-close-menu-item \[data-slot="dropdown-menu-item-label"\],[\s\S]*\.hands-feedback-close-menu-item \[data-slot="dropdown-menu-item-label"\] span\s*\{[^}]*overflow:\s*visible[^}]*text-overflow:\s*clip[^}]*white-space:\s*normal/,
    );
    expect(css).toMatch(
      /\.hands-feedback-close-menu\s*\{[^}]*max-width:\s*calc\(100vw - 24px\)[^}]*min-width:\s*max-content[^}]*width:\s*max-content/,
    );
    expect(css).toMatch(
      /\.hands-feedback-close-menu-item\s*\{[^}]*width:\s*100%/,
    );
    expect(css).not.toMatch(
      /@media \(max-width: 640px\)[\s\S]*\.hands-feedback-close-main,[\s\S]*\.hands-feedback-close-caret\s*\{/,
    );
    expect(css).toMatch(
      /\.hands-feedback-pull-indicator\s*\{[^}]*transition:\s*height 160ms ease-out/,
    );
    expect(css).not.toMatch(
      /\[data-slot=["'](?:badge|composer|message-item|tabs|task-card)/,
    );
    expect(css).not.toMatch(/display:\s*none[^}]*hands-feedback-conversation/);
  });

  it("classifies the conversation follow threshold deterministically", () => {
    expect(
      isNearConversationBottom({
        scrollHeight: 500,
        scrollTop: 336,
        clientHeight: 100,
      }),
    ).toBe(true);
    expect(
      isNearConversationBottom({
        scrollHeight: 500,
        scrollTop: 100,
        clientHeight: 100,
      }),
    ).toBe(false);
  });

  it("rejects unsafe screenshot selections before calling the transport", () => {
    const image = (name: string, type: string, size: number) =>
      ({
        name,
        type,
        size,
        lastModified: 0,
      }) as File;
    expect(
      validateFeedbackAttachments([
        image("1.png", "image/png", 1),
        image("2.webp", "image/webp", 1),
      ]),
    ).toBeNull();
    expect(
      validateFeedbackAttachments([
        image("1.png", "image/png", 1),
        image("2.png", "image/png", 1),
        image("3.png", "image/png", 1),
        image("4.png", "image/png", 1),
      ]),
    ).toMatch(/no more than 3/);
    expect(
      validateFeedbackAttachments([image("notes.txt", "text/plain", 1)]),
    ).toMatch(/supported image/);
    expect(
      validateFeedbackAttachments([
        image("huge.png", "image/png", MAX_FEEDBACK_ATTACHMENT_BYTES + 1),
      ]),
    ).toMatch(/larger than 10 MB/);
  });
});
