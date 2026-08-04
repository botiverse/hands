import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
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
  return <span data-theme={value.theme}>{value.unreadTotal ?? "unknown"}</span>;
}

describe("FeedbackProvider", () => {
  it("exposes theme without accepting credentials or reporter identity", () => {
    const html = renderToStaticMarkup(
      <FeedbackProvider transport={transport} theme="brutal">
        <Probe />
      </FeedbackProvider>,
    );
    expect(html).toMatch(/data-theme="brutal"/);
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
    expect(feedbackMessage("zh-CN", "active")).toBe("活跃");
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

  it("ships package-owned nonzero skeleton sizing without Tailwind utilities", () => {
    const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8");
    expect(css).toMatch(/\.hands-feedback-skeleton-row[^}]*height:\s*4rem/);
    expect(css).toMatch(/\.hands-feedback-skeleton-detail[^}]*height:\s*10rem/);
    expect(css).not.toMatch(/\.h-16\b|\.h-40\b|\.w-full\b/);
    expect(css).toMatch(/@media \(max-width: 640px\)/);
    expect(css).toMatch(/\.hands-feedback-middle[^}]*overflow-y:\s*auto/);
    expect(css).toMatch(/env\(safe-area-inset-bottom\)/);
    expect(css).toMatch(/prefers-reduced-motion:\s*reduce/);
    expect(css).toMatch(
      /\.hands-feedback-detail \.hands-feedback-middle[^}]*overflow:\s*hidden/,
    );
    expect(css).toMatch(
      /\.hands-feedback-close[^}]*padding:\s*0 4px 4px 0/,
    );
    expect(css).toMatch(
      /\.hands-feedback-conversation[^}]*flex:\s*1[^}]*overflow-y:\s*auto/,
    );
    expect(css).toMatch(
      /\.hands-feedback-conversation[^}]*align-content:\s*start/,
    );
    expect(css).toMatch(
      /\.hands-feedback-conversation article\s*\{[^}]*max-width:\s*min\(42rem, 88%\)[^}]*width:\s*fit-content/,
    );
    expect(css).toMatch(
      /article\[data-author="reporter"\][^}]*justify-self:\s*end/,
    );
    expect(css).toMatch(
      /article\[data-author="staff"\][^}]*justify-self:\s*start/,
    );
    expect(css).toMatch(
      /\.hands-feedback-ticket-row:hover,\s*\.hands-feedback-ticket-row:focus-visible\s*\{[^}]*background:\s*var\(--hf-surface\)/,
    );
    expect(css).not.toMatch(
      /\.hands-feedback-ticket-row:hover\s*\{[^}]*(?:outline|box-shadow)/,
    );
    expect(css).toMatch(
      /\.hands-feedback-ticket-row:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--hf-border-strong\)/,
    );
    expect(css).not.toMatch(
      /\.hands-feedback-ticket-row:(?:hover|focus-visible)[^{]*\{[^}]*var\(--hf-accent\)/,
    );
    for (const [status, token] of [
      ["open", "cyan"],
      ["in_progress", "cyan"],
      ["resolved", "lime"],
      ["closed", "lime"],
    ] as const) {
      expect(css).toMatch(
        new RegExp(
          `\\.hands-feedback-status\\[data-feedback-status="${status}"\\][^}]*var\\(--color-brutal-${token}`,
        ),
      );
    }
    expect(css).toMatch(
      /\.hands-feedback-unread-dot[^}]*var\(--color-brutal-pink/,
    );
    expect(css).not.toMatch(
      /\.hands-feedback-unread-dot[^}]*var\(--danger/,
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
