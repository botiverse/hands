import { describe, expect, it } from "vitest";
import { formatRaftNotificationCard, withoutPlayConsoleFooter } from "../src/lib/raft_notification_card";
import { renderStatusCardAsText } from "../src/lib/raft_card_text";
import { formatRaftNotificationMessage } from "../src/lib/raft_notification_content";
import { playFailureNotificationFields } from "../src/lib/play_failure_notification";

describe("Raft release notification cards", () => {
  it("keeps long app names bounded without hiding the event label", () => {
    const body = { event: "google_play:submission_failed", payload: { state: "SUBMISSION_FAILED", version: "1.20.0" } };
    const { card, content } = formatRaftNotificationCard(body, { id: "app", slug: "x", name: "测试😀".repeat(100) });
    expect(Array.from(card.header!.title)).toHaveLength(100);
    expect(card.header!.title).toContain("Release submission failed");
    expect(card.header!.title).toContain("…");
    expect(content).toContain("Release submission failed or was blocked");
  });

  it.each([
    ["app_store:version_state_changed", "PENDING_DEVELOPER_RELEASE", "Approved; not released", "success", "Approved; waiting for developer release"],
    ["app_store:version_state_changed", "PENDING_APPLE_RELEASE", "Apple release pending", "success", "Waiting for Apple release"],
    ["app_store:version_state_changed", "READY_FOR_SALE", "Ready for distribution", "success", "Ready for distribution"],
    ["app_store:version_state_changed", "READY_FOR_DISTRIBUTION", "Ready for distribution", "success", "Ready for distribution"],
    ["app_store:version_state_changed", "READY_FOR_REVIEW", "Ready to submit", "neutral", "Ready to submit for review"],
    ["app_store:version_state_changed", "WAITING_FOR_EXPORT_COMPLIANCE", "Export compliance", "warning", "Waiting for export compliance"],
    ["app_store:version_state_changed", "REPLACED_WITH_NEW_VERSION", "Replaced", "neutral", "Replaced with a new version"],
    ["google_play:release_state_changed", "RELEASE_LIFECYCLE_STATE_APPROVED_NOT_PUBLISHED", "Approved; not released", "success", "Approved; waiting for release"],
    ["google_play:release_state_changed", "RELEASE_LIFECYCLE_STATE_PUBLISHED", "Available on track", "success", "Available on track (may be partially rolled out or paused)"],
    ["google_play:submission_succeeded", "SUBMISSION_SUCCEEDED", "Operation succeeded", "success", "Release submitted"],
    ["testflight:external_state_changed", "BETA_APPROVED", "Beta approved", "success", "Approved for beta testing"],
    ["testflight:external_state_changed", "READY_FOR_BETA_TESTING", "Ready for beta testing", "success", "Ready for beta testing"],
    ["app_store:build_upload_state_changed", "COMPLETE", "Upload processed", "success", "Upload processed"],
    ["appgallery:invitation_state_changed", "testing_scheduled", "Approved; test pending", "success", "Approved; waiting for testing to start"],
    ["appgallery:invitation_state_changed", "testing_active", "Invitation testing open", "success", "Invitation testing open"],
    ["appgallery:package_state_changed", "ready", "Package processed", "success", "Market package processed"],
  ] as const)("shows a qualified success for %s %s", (event, state, tag, tone, title) => {
    const body = { event, payload: { state } };
    const { card, content } = formatRaftNotificationCard(body);
    expect(card.header?.tags).toEqual([{ text: tag, tone }]);
    expect(card.header?.title).toContain(title);
    expect(Array.from(tag).length).toBeLessThanOrEqual(24);
    // The established text is also an idempotency key's replay body; do not change it.
    const fallback = formatRaftNotificationMessage(body);
    expect(content).toBe(fallback + (event.startsWith("google_play:") ? "\n[Open Play Console](https://play.google.com/console/)" : ""));
    if (state === "READY_FOR_DISTRIBUTION") {
      expect(fallback).toContain("Status changed");
      expect(fallback).toContain("READY\\_FOR\\_DISTRIBUTION");
    }
    if (state === "RELEASE_LIFECYCLE_STATE_PUBLISHED") {
      expect(card.header?.title).toContain("may be partially rolled out or paused");
    }
    if (state === "SUBMISSION_SUCCEEDED") expect(content).toContain("Review status is not yet confirmed");
  });

  it.each([
    ["app_store:version_state_changed", "WAITING_FOR_REVIEW", "info"],
    ["app_store:version_state_changed", "IN_REVIEW", "info"],
    ["app_store:version_state_changed", "REJECTED", "danger"],
    ["app_store:version_state_changed", "METADATA_REJECTED", "danger"],
    ["app_store:version_state_changed", "DEVELOPER_REJECTED", "warning"],
    ["app_store:version_state_changed", "UNRECOGNIZED", "neutral"],
    ["google_play:release_state_changed", "RELEASE_LIFECYCLE_STATE_IN_REVIEW", "info"],
    ["google_play:release_state_changed", "RELEASE_LIFECYCLE_STATE_NOT_APPROVED", "danger"],
    ["google_play:release_state_changed", "RELEASE_LIFECYCLE_STATE_DRAFT", "neutral"],
    ["testflight:external_state_changed", "WAITING_FOR_BETA_REVIEW", "info"],
    ["testflight:external_state_changed", "READY_FOR_BETA_SUBMISSION", "neutral"],
    ["testflight:external_state_changed", "BETA_REJECTED", "danger"],
    ["testflight:external_state_changed", "MISSING_EXPORT_COMPLIANCE", "warning"],
    ["app_store:build_upload_state_changed", "FAILED", "danger"],
    ["appgallery:invitation_state_changed", "ready", "neutral"],
    ["appgallery:invitation_state_changed", "testing_review", "info"],
    ["appgallery:invitation_state_changed", "rejected", "danger"],
    ["appgallery:invitation_state_changed", "stopped", "warning"],
  ] as const)("does not make %s %s a success", (event, state, tone) => {
    const { card } = formatRaftNotificationCard({ event, payload: { state } });
    expect(card.header?.tags?.[0]?.tone).toBe(tone);
  });

  it("does not color another provider's state or an unknown long state as success", () => {
    for (const [event, state] of [
      ["app_store:version_state_changed", "READY_FOR_BETA_TESTING"],
      ["testflight:external_state_changed", "READY_FOR_SALE"],
      ["appgallery:invitation_state_changed", "COMPLETE"],
    ]) {
      const { card } = formatRaftNotificationCard({ event, payload: { state } });
      expect(card.header?.tags?.[0]?.tone).toBe("neutral");
    }
    const state = "UNKNOWN_" + "L".repeat(40);
    const { card } = formatRaftNotificationCard({ event: "app_store:version_state_changed", payload: { state } });
    expect(card.header?.tags).toBeUndefined();
    expect(card.elements.state).toMatchObject({ type: "Badge", props: { text: state, tone: "neutral" } });
  });

  it.each([
    ["build:succeeded", "Build succeeded", "success", "succeeded"],
    ["build:failed", "Build failed", "danger", "failed"],
    ["release:new", "Active on Hands", "success", "active"],
    ["release:published", "Published on Hands", "success", "active"],
  ] as const)("colors %s operation receipts even when their producer omits a state", (event, text, tone, state) => {
    for (const payload of [{}, { status: state }]) {
      const { card, content } = formatRaftNotificationCard({ event, payload });
      expect(card.header?.tags).toEqual([{ text, tone }]);
      expect(content).toBe(formatRaftNotificationMessage({ event, payload }));
    }
    const { card } = formatRaftNotificationCard({ event, payload: { status: "UNKNOWN" } });
    expect(card.header?.tags?.[0]?.tone).toBe("neutral");
  });

  it("qualifies a Hands release's partial rollout without implying store publication", () => {
    const { card, content } = formatRaftNotificationCard({ event: "release:published", payload: { rollout: 25 } });
    expect(card.header?.tags).toEqual([{ text: "Published on Hands", tone: "success" }]);
    expect(JSON.stringify(card)).toContain("Rollout: 25%");
    expect(content).toContain("Rollout: 25%");
  });

  it("uses the displayed market state, not a conflicting status field", () => {
    const body = { event: "app_store:version_state_changed", payload: { state: "REJECTED", status: "READY_FOR_SALE" } };
    const { card, content } = formatRaftNotificationCard(body);
    expect(card.header?.title).toContain("Review rejected");
    expect(card.header?.tags).toEqual([{ text: "Review rejected", tone: "danger" }]);
    expect(content).toContain("Review rejected");
  });

  it.each(["ready", "testing_active", "testing_scheduled"])("does not mark withdrawn AppGallery review as approved when state is %s", (state) => {
    const { card, content } = formatRaftNotificationCard({ event: "appgallery:invitation_state_changed", payload: {
      state, state_label: "开发者撤回邀请测试审核",
    } });
    expect(card.header?.title).toContain("Invitation test review withdrawn by developer");
    expect(card.header?.tags).toEqual([{ text: "Review withdrawn", tone: "warning" }]);
    expect(content).toContain("Invitation test review withdrawn by developer");
  });

  it("keeps long Chinese test notes whole in the text layout: no blank line inside a line", () => {
    const lines = Array.from({ length: 30 }, (_, i) => `- 第 ${i} 项：「计算机」页面支持搜索、筛选和排序，卡片可删除计算机`);
    const body = { event: "testflight:external_state_changed", payload: { state: "READY_FOR_BETA_TESTING",
      version: "1.24.0", what_to_test: { "zh-Hans": lines.join("\n") } } };
    const { card } = formatRaftNotificationCard(body);
    expect(Object.keys(card.elements).filter((id) => /^detail\d+$/.test(id)).length).toBeGreaterThan(1);
    // The card keeps fixed 500-character pieces (its 12-child budget assumes it).
    expect(Object.entries(card.elements).filter(([id]) => /^detail\d+$/.test(id)).slice(0, -1)
      .every(([, el]) => Array.from(String((el as any).props.text)).length === 500)).toBe(true);
    expect((card.elements[card.root] as { children: string[] }).children.length).toBeLessThanOrEqual(12);
    const text = renderStatusCardAsText(card);
    // Every note line that is shown appears whole on one line.
    const shown = text.split("\n").filter((line) => line.includes("项："));
    expect(shown.length).toBeGreaterThan(3);
    for (const line of shown.slice(0, -1)) expect(line).toMatch(/^\\- 第 \d+ 项：「计算机」页面支持搜索、筛选和排序，卡片可删除计算机$/);
    // And the notes stay one block: consecutive lines are not separated by a blank line.
    for (let i = 1; i < shown.length; i++) expect(text).toContain(`${shown[i - 1]}\n${shown[i]}`);
  });

  it("never copies user-provided text into Markdown and retains the complete fallback", () => {
    const body = { event: "testflight:external_state_changed", payload: { state: "READY_FOR_BETA_TESTING",
      version: "1.20.0", groups_display: "# heading **bold** <script> @everyone https://bad.test",
      what_to_test: { en: "- [x] task\n**fake emphasis**\n<script> @admin https://bad.test" },
    } };
    const { card, content } = formatRaftNotificationCard(body);
    expect(content).toBe(formatRaftNotificationMessage(body));
    expect(Object.values(card.elements).filter((element) => element.type === "Markdown")).toEqual([]);
    expect(JSON.stringify(card)).not.toContain("https://bad.test");
    expect(JSON.stringify(card)).toContain("@\u200beveryone");
    expect(content).toContain("- [x] task");
  });

  it("keeps long identity and test notes in the body rather than cutting a subtitle", () => {
    const body = { event: "testflight:external_state_changed", payload: { state: "READY_FOR_BETA_TESTING",
      version: "version-" + "x".repeat(140), what_to_test: { en: "test notes" },
    } };
    const { card } = formatRaftNotificationCard(body);
    expect(card.header?.subtitle).toBeUndefined();
    const bodyText = Object.values(card.elements).filter((element) => element.type === "Text").map((element) => element.props.text).join("");
    expect(bodyText).toContain("version-" + "x".repeat(140));
    expect(bodyText).toContain("test notes");
  });

  it("recovers the original fallback even when its content already contains the console link", () => {
    const footer = "\n[Open Play Console](https://play.google.com/console/)";
    const original = `Status details${footer}\nOther details`;
    expect(withoutPlayConsoleFooter(original + footer)).toBe(original);
    expect(withoutPlayConsoleFooter(original)).toBe(original);
  });
  it("does not expose unknown provider identifiers or free-form error data", () => {
    expect(playFailureNotificationFields({ cause: { provider_cause: "secretToken", cause_source: "structured",
      provider_identifiers: { details: [{ reason: "secretToken" }], metadata: "private-token" },
      message: "private provider text" } })).toEqual({});
    expect(playFailureNotificationFields({ cause: { provider_cause: "EDIT_IN_REVIEW", cause_source: "message",
      provider_identifiers: { details: [{ reason: "CHANGES_ALREADY_IN_REVIEW" }] }, message: "private provider text" } }))
      .toEqual({ play_failure_cause: "EDIT_IN_REVIEW", play_failure_cause_source: "message" });
  });
  it("shows safe Play failure details in both the card and fallback, while labeling inferred causes", () => {
    const body = { event: "google_play:submission_failed", delivered_at: 100, payload: {
      state: "SUBMISSION_FAILED", version: "1.20.0", version_code: 12000003, track: "production",
      package_name: "build.raft.app", occurred_at: "2026-11-05T13:35:09.102Z",
      reason: "play_api_error", play_failure_cause: "EDIT_IN_REVIEW", play_failure_cause_source: "structured",
      play_failure_reason: "CHANGES_ALREADY_IN_REVIEW", provider_message: "secret https://example.test @admin",
    } };
    const { card, content } = formatRaftNotificationCard(body);
    expect(content).toContain("Google Play has changes in review");
    expect(content).toContain("Play reason code: CHANGES_ALREADY_IN_REVIEW");
    expect(JSON.stringify(card)).toContain("Google Play has changes in review");
    expect(card.header).toMatchObject({ tags: [{ text: "Failed", tone: "danger" }], subtitle: "1.20.0 · track: production" });
    expect(card.elements.reasonLabel).toEqual({ type: "Markdown", props: { content: "**Reason:**" } });
    expect(card.elements.reason0).toEqual({ type: "Text", props: {
      text: "Google Play has changes in review. Wait for review to finish before submitting again.", tone: "warning",
    } });
    expect(card.elements.fields).toEqual({ type: "Fields", props: { items: [
      { label: "Build", value: "12000003", mono: true },
      { label: "Package", value: "build.raft.app", mono: true },
      { label: "Reason code", value: "play_api_error", mono: true },
      { label: "Play reason code", value: "CHANGES_ALREADY_IN_REVIEW", mono: true },
    ] } });
    expect(card.elements.divider).toEqual({ type: "Divider", props: {} });
    expect(card.elements.time).toEqual({ type: "RelativeTime", props: { at: "2026-11-05T13:35:09.102Z" } });
    expect(card.elements.review).toEqual({ type: "Button", props: { label: "Open Play Console",
      action: { kind: "navigate", url: "https://play.google.com/console/" } } });
    const root = card.elements.root;
    if (!root || root.type !== "Stack") throw new Error("missing root stack");
    expect(root.children.indexOf("reasonLabel")).toBeLessThan(root.children.indexOf("reason0"));
    expect(root.children.indexOf("reason0")).toBeLessThan(root.children.indexOf("fields"));
    expect(content).toBe(formatRaftNotificationMessage(body) + "\n[Open Play Console](https://play.google.com/console/)");
    expect(JSON.stringify(card)).not.toContain("secret https://example.test");
    expect(content).not.toContain("@admin");
    const inferred = formatRaftNotificationMessage({ ...body, payload: { ...body.payload, play_failure_cause_source: "message" } });
    expect(inferred).toContain("Possible reason (inferred):");
    expect(inferred).not.toContain("Play reason code: CHANGES_ALREADY_IN_REVIEW");
    const inferredCard = formatRaftNotificationCard({ ...body, payload: { ...body.payload, play_failure_cause_source: "message" } }).card;
    expect(inferredCard.elements.reasonLabel).toEqual({ type: "Markdown", props: { content: "**Possible reason (inferred):**" } });
    expect(inferredCard.elements.reason0).toMatchObject({ props: { text: expect.stringContaining("Google Play"), tone: "warning" } });
    const unknownSource = formatRaftNotificationMessage({ ...body, payload: { ...body.payload, play_failure_cause_source: null } });
    expect(unknownSource).toContain("Possible reason (source unconfirmed):");
    expect(unknownSource).not.toContain("Play reason code: CHANGES_ALREADY_IN_REVIEW");
    const unknown = formatRaftNotificationMessage({ ...body, payload: { ...body.payload, play_failure_cause: "secret_unknown" } });
    expect(unknown).not.toContain("secret_unknown");
    expect(unknown).toContain("Reason code: play\\_api\\_error");
    const unknownCard = formatRaftNotificationCard({ ...body, payload: { ...body.payload, play_failure_cause: "secret_unknown" } }).card;
    expect(unknownCard.elements.reason0).toBeUndefined();
    expect(JSON.stringify(unknownCard)).not.toContain("secret_unknown");
  });
  it("shows release state and preserves the complete existing text for older clients", () => {
    const body = {
      event: "testflight:external_state_changed", delivered_at: 1730000000000,
      payload: {
        app: { name: "Raft App" }, state: "READY_FOR_BETA_TESTING", previous_state: "WAITING_FOR_BETA_REVIEW",
        build: { version: "1.19.0", version_code: "11900001" },
        groups_display: "Internal and external testers",
        what_to_test: { "zh-Hans": "Check @people and https://example.test/private" },
        source: "hands_operation_receipt", source_commit: "a1b2c3d4",
        app_store_connect_url: "https://appstoreconnect.apple.com/apps/6789091965",
        review_message: "private provider message",
      },
    };
    const result = formatRaftNotificationCard(body);
    expect(result.content).toBe(formatRaftNotificationMessage(body));
    expect(result.card.header?.tags).toEqual([{ text: "Ready for beta testing", tone: "success" }]);
    expect(result.content).toContain("Previously: Waiting for beta review");
    expect(result.card.elements.review).toEqual({
      type: "Button", props: { label: "Open in App Store Connect", action: { kind: "navigate", url: "https://appstoreconnect.apple.com/apps/6789091965" } },
    });
    const serialized = JSON.stringify(result.card);
    expect(serialized).toContain("1.19.0");
    expect(serialized).toContain("11900001");
    expect(serialized).toContain("Internal and external testers");
    expect(result.card.elements.fields).toMatchObject({ props: { items: expect.arrayContaining([{ label: "Commit", value: "a1b2c3d4", mono: true }]) } });
    expect(serialized).not.toContain("hands_operation_receipt");
    expect(result.content).not.toContain("hands_operation_receipt");
    expect(body.payload.source).toBe("hands_operation_receipt");
    expect(serialized).toContain("Check @\u200bpeople and [link]");
    expect(serialized).not.toContain("```text");
    expect(serialized).not.toContain("private provider message");
    expect(serialized).not.toContain("https://example.test/private");
    expect(serialized).not.toContain("[Open App Store Connect]");
  });

  it("fits long multibyte content within the card limits while keeping its timestamp and fallback", () => {
    const body = {
      event: "google_play:release_state_changed", delivered_at: 1730000000000,
      payload: {
        state: "RELEASE_LIFECYCLE_STATE_PUBLISHED", package_name: "build.example.app", track: "production", version_code: 11900002,
        state_label: "发布😀".repeat(250), groups_display: "组🧪".repeat(350),
        observation_display: "First observation, not a new change",
      },
    };
    const { card, content } = formatRaftNotificationCard(body);
    expect(content).toBe(formatRaftNotificationMessage(body) + "\n[Open Play Console](https://play.google.com/console/)");
    expect(new TextEncoder().encode(JSON.stringify(card)).length).toBeLessThanOrEqual(8192);
    const root = card.elements.root;
    expect(root?.type).toBe("Stack");
    if (!root || root.type !== "Stack") throw new Error("missing root stack");
    expect(root.children.length).toBeLessThanOrEqual(12);
    for (const child of root.children) {
      const element = card.elements[child];
      expect(element).toBeDefined();
      if (!element) throw new Error(`missing element ${child}`);
      if (element.type === "Text") expect(Array.from(element.props.text).length).toBeLessThanOrEqual(500);
    }
    const displayed = Object.values(card.elements).filter((element) => element.type === "Text").map((element) => element.props.text).join("");
    expect(displayed).toContain("First observation, not a new change");
    expect(card.elements.time).toEqual({ type: "RelativeTime", props: { at: "2024-10-27T03:33:20.000Z" } });
    expect(displayed).toContain("…");
  });

  it("only creates a navigation button for a canonical App Store Connect app link", () => {
    for (const link of [
      "https://appstoreconnect.apple.com.evil.test/apps/123",
      "https://user@appstoreconnect.apple.com/apps/123",
      "https://appstoreconnect.apple.com/apps/123?token=private",
      "https://appstoreconnect.apple.com/apps/123#fragment",
      "http://appstoreconnect.apple.com/apps/123",
    ]) {
      const { card } = formatRaftNotificationCard({ event: "app_store:version_state_changed", payload: { app_store_connect_url: link } });
      expect(Object.values(card.elements).some((element) => element.type === "Button")).toBe(false);
    }
  });

  it("keeps fenced test notes as plain card text without confusing them with the event footer", () => {
    const { card, content } = formatRaftNotificationCard({ event: "testflight:external_state_changed", delivered_at: 100,
      payload: { state: "READY_FOR_BETA_TESTING", what_to_test: { en: "At: not a timestamp\n```\nCheck @admin" } },
    });
    expect(content).toContain("What to test:\n```text\n  At: not a timestamp");
    expect(content.match(/^```/gm)).toHaveLength(2);
    const text = Object.values(card.elements).filter((e) => e.type === "Text").map((e) => e.props.text).join("\n");
    expect(text).toContain("At: not a timestamp");
    expect(card.elements.time).toEqual({ type: "RelativeTime", props: { at: "1970-01-01T00:00:00.100Z" } });
    expect(text).toContain("@\u200badmin");
    expect(text).not.toContain("```text");
  });

  it.each(["testflight:external_state_changed", "testflight:internal_distribution_ready"])(
    "removes only the added fenced-note indentation from %s cards, without changing fallback", (event) => {
      const body = { event, delivered_at: 100, payload: {
        state: "READY_FOR_BETA_TESTING", version: "1.21.0", groups_display: "Group 1",
        what_to_test: { en: "  Intro\n- first\n    - nested  item\n\n- second\nAt: not a timestamp\nCommit: not metadata\nVersion code: 42\n\\*literal\\*\n```\n@user" },
      } };
      const { card, content } = formatRaftNotificationCard(body);
      expect(content).toBe(formatRaftNotificationMessage(body));
      expect(content).toContain("What to test:\n```text\n  Intro\n  - first\n  - nested item\n  \n  - second");
      const text = Object.values(card.elements).filter((element) => element.type === "Text")
        .map((element) => element.props.text).join("");
      expect(text).toContain("Test groups: Group 1\nWhat to test:\n  Intro\n- first\n    - nested  item\n\n- second\nAt: not a timestamp\nCommit: not metadata\nVersion code: 42\n\\*literal\\*");
      expect(card.elements.fields).toBeUndefined();
      expect(text).not.toContain("\n  - first");
      expect(text).toContain("@\u200buser");
      expect(text).not.toContain("```text");
      expect(card.elements.time?.type).toBe("RelativeTime");
    },
  );

  it("retains note formatting while selecting the same preferred locale and protecting mentions and links", () => {
    const body = { event: "testflight:external_state_changed", delivered_at: 100, payload: {
      state: "IN_BETA_TESTING", app_store_connect_url: "https://appstoreconnect.apple.com/apps/123",
      what_to_test: { en: "Wrong locale", "zh-Hans": "- 一级\n  - 二级\n    - 三级\n  @name #channel https://example.test/secret" },
    } };
    const { card, content } = formatRaftNotificationCard(body);
    const text = Object.values(card.elements).filter((e) => e.type === "Text").map((e) => e.props.text).join("");
    expect(content).toBe(formatRaftNotificationMessage(body));
    expect(content).toContain("  - 一级\n  - 二级\n  - 三级");
    expect(text).toContain("- 一级\n  - 二级\n    - 三级\n  @\u200bname #\u200bchannel [link]");
    expect(text).not.toContain("Wrong locale");
    expect(text).not.toContain("example.test");
    expect(card.elements.time?.type).toBe("RelativeTime");
    expect(card.elements.review?.type).toBe("Button");
  });

  it("fits lengthy multibyte test notes while keeping the event time", () => {
    const { card, content } = formatRaftNotificationCard({ event: "testflight:external_state_changed", delivered_at: 100,
      payload: { state: "READY_FOR_BETA_TESTING", what_to_test: { en: "🧪".repeat(1200) } },
    });
    expect(content).toContain("What to test:\n```text");
    expect(content).toContain("…\n```");
    expect(new TextEncoder().encode(JSON.stringify(card)).length).toBeLessThanOrEqual(8192);
    const text = Object.values(card.elements).filter((e) => e.type === "Text").map((e) => e.props.text).join("\n");
    expect(card.elements.time).toEqual({ type: "RelativeTime", props: { at: "1970-01-01T00:00:00.100Z" } });
  });

  it("retains long test notes when the card has room alongside metadata, time and a button", () => {
    const { card } = formatRaftNotificationCard({ event: "testflight:external_state_changed", delivered_at: 100,
      payload: { state: "READY_FOR_BETA_TESTING", version: "v".repeat(150), groups_display: "g".repeat(480),
        source_commit: "a1b2c3", app_store_connect_url: "https://appstoreconnect.apple.com/apps/123",
        what_to_test: { en: `${"n".repeat(850)} END-OF-NOTES` } },
    });
    const text = Object.values(card.elements).filter((e) => e.type === "Text").map((e) => e.props.text).join("");
    expect(text).toContain("END-OF-NOTES");
    expect(card.elements.time?.type).toBe("RelativeTime");
    expect(card.elements.review?.type).toBe("Button");
    expect(new TextEncoder().encode(JSON.stringify(card)).length).toBeLessThanOrEqual(8192);
    const root = card.elements.root;
    if (!root || root.type !== "Stack") throw new Error("missing root stack");
    expect(root.children.length).toBeLessThanOrEqual(12);
  });

  it("keeps note lines that duplicate actual footer text in place without treating them as footer or fields", () => {
    const occurred = "2026-11-08T05:00:00Z";
    const body = { event: "testflight:external_state_changed", payload: {
      state: "IN_BETA_TESTING", occurred_at: occurred, observation_display: "same",
      what_to_test: { en: "At: 2026-11-08 05:00:00 UTC\nObservation: same\nCommit: fake\nFirst observation; not a footer\nend" },
    } };
    const { card, content } = formatRaftNotificationCard(body);
    const detail = Object.entries(card.elements).filter(([id, el]) => id.startsWith("detail") && el.type === "Text")
      .map(([, el]) => el.type === "Text" ? el.props.text : "").join("");
    const footer = Object.entries(card.elements).filter(([id, el]) => id.startsWith("footer") && el.type === "Text")
      .map(([, el]) => el.type === "Text" ? el.props.text : "").join("");
    expect(detail).toContain("What to test:\nAt: 2026-11-08 05:00:00 UTC\nObservation: same\nCommit: fake\nFirst observation; not a footer\nend");
    expect(footer).toContain("Observation: same");
    expect(card.elements.time).toEqual({ type: "RelativeTime", props: { at: "2026-11-08T05:00:00.000Z" } });
    expect(card.elements.fields).toBeUndefined();
    expect(content).toBe(formatRaftNotificationMessage(body));
  });

  it("keeps an invalid provider time as text rather than showing a different relative date", () => {
    const { card, content } = formatRaftNotificationCard({ event: "google_play:release_state_changed", delivered_at: 100,
      payload: { occurred_at: "2026-02-30T12:00:00Z", state: "RELEASE_LIFECYCLE_STATE_IN_REVIEW" } });
    expect(card.elements.time).toBeUndefined();
    expect(card.elements.footer0).toMatchObject({ props: { text: "At: 2026-02-30 12:00:00 UTC", tone: "muted" } });
    expect(content).toContain("At: 2026-02-30 12:00:00 UTC");
  });

  it("formats background system kill device and version spike alerts clearly", () => {
    const deviceSpike = formatRaftNotificationMessage({
      event: "crash:spike",
      payload: {
        app_slug: "raft-android",
        signature: "SystemKill@background",
        alert_reason: "device_daily_repeat",
        device_id: "dev-abc",
        count_last_24h: 3,
        version_name: "1.22.0",
        version_code: 1022000,
        ticket_id: "t-123",
      },
    });
    expect(deviceSpike).toContain("Background system kill spike (后台被系统结束)");
    expect(deviceSpike).toContain("Same device killed in background 3 times in 24h (device: dev-abc)");

    const versionSpike = formatRaftNotificationMessage({
      event: "crash:spike",
      payload: {
        app_slug: "raft-android",
        signature: "SystemKill@background",
        alert_reason: "version_spike",
        version_name: "1.23.0",
        version_code: 1023000,
        version_count: 12,
        version_device_count: 4,
        previous_version_name: "1.22.0",
        previous_version_code: 1022000,
        previous_version_count: 5,
        previous_version_device_count: 3,
        ticket_id: "t-456",
      },
    });
    expect(versionSpike).toContain("Background system kill spike (后台被系统结束)");
    expect(versionSpike).toContain("Version background kill spike: 12 reports across 4 devices vs 5 reports (3 devices) on 1.22.0 (1022000)");

    const dailySummary = formatRaftNotificationMessage({
      event: "crash:spike",
      payload: {
        app_slug: "raft-android",
        signature: "SystemKill@background",
        alert_reason: "background_system_kill_daily_summary",
        day: "2026-11-11",
        total_count: 15,
        device_count: 7,
        by_version: [
          {
            version_name: "1.23.0",
            version_code: 1023000,
            count: 10,
            device_count: 5,
            previous_version_name: "1.22.0",
            previous_version_code: 1022000,
            previous_version_count: 5,
            previous_version_device_count: 2,
            spike: true,
          },
        ],
        top_devices: [
          {
            device_id: "dev-oppo",
            device_model: "PME110",
            count: 6,
          },
        ],
      },
    });
    expect(dailySummary).toContain("后台被系统结束每日汇总 (2026-11-11)");
    expect(dailySummary).toContain("总次数: 15 · 涉及设备: 7");
    expect(dailySummary).toContain("1.23.0 (1023000): 10 次 (5 台设备)");
    // A summary sent before rows were per channel still renders, without the
    // cross-channel, all-time comparison it used to show.
    expect(dailySummary).not.toContain("上一版本");
    expect(dailySummary).not.toContain("显著上升");
    expect(dailySummary).not.toContain("口径");
    expect(dailySummary).toContain("PME110 (dev-oppo): 6 次");
    // The footer must be a command the published CLI accepts and must select
    // exactly the tickets the summary counted.
    expect(dailySummary).toContain("View more: `hands feedback list raft-android --signature SystemKill@background`");
    expect(dailySummary).not.toContain("feedback crashes");
  });

  it("renders the per-channel daily background kill summary with denominators, cleanup and comparisons", () => {
    const text = formatRaftNotificationMessage({
      event: "crash:spike",
      payload: {
        app_slug: "raft-android",
        signature: "SystemKill@background",
        alert_reason: "background_system_kill_daily_summary",
        day: "2026-11-26",
        total_count: 55,
        device_count: 29,
        user_cleanup_count: 2,
        total_count_excluding_cleanup: 53,
        by_version: [
          {
            channel: "main", version_name: "1.30.0", version_code: 13000016, version_codes: [13000015, 13000016],
            count: 30, device_count: 15, user_cleanup_count: 2, count_excluding_cleanup: 28, device_count_excluding_cleanup: 14,
            active_devices: 36, coverage: { matched: 14, reporters: 14 }, rate_unavailable_reason: null,
            kills_per_active_device: 28 / 36, affected_device_share: 14 / 36,
            baseline: { version_name: "1.29.0", version_codes: [12900011, 12900012], window_start_day: "2026-11-17",
              window_end_day: "2026-11-23", count: 60, active_device_days: 210, rate: 60 / 210, coverage: { matched: 50, reporters: 52 } },
            baseline_unavailable_reason: null, spike: true,
          },
          {
            channel: "preview", version_name: "1.30.0", version_code: 13000014, version_codes: [13000014],
            count: 3, device_count: 3, user_cleanup_count: 0, count_excluding_cleanup: 3, device_count_excluding_cleanup: 3,
            active_devices: 5, coverage: { matched: 3, reporters: 3 }, rate_unavailable_reason: null,
            kills_per_active_device: 0.6, affected_device_share: 0.6,
            baseline: null, baseline_unavailable_reason: "insufficient_history", spike: false,
          },
          {
            channel: "main", version_name: "1.29.0", version_code: 12900012, version_codes: [12900012],
            count: 4, device_count: 4, user_cleanup_count: 0, count_excluding_cleanup: 4, device_count_excluding_cleanup: 4,
            active_devices: 12, coverage: { matched: 2, reporters: 4 }, rate_unavailable_reason: "low_coverage",
            kills_per_active_device: null, affected_device_share: null,
            baseline: null, baseline_unavailable_reason: "low_coverage", spike: false,
          },
          {
            channel: "unknown", version_name: "unknown", version_code: null, version_codes: [],
            count: 1, device_count: 1, user_cleanup_count: 0, count_excluding_cleanup: 1, device_count_excluding_cleanup: 1,
            active_devices: null, coverage: null, rate_unavailable_reason: "no_ping_data",
            kills_per_active_device: null, affected_device_share: null,
            baseline: null, baseline_unavailable_reason: "no_ping_data", spike: false,
          },
        ],
        top_devices: [],
      },
    });
    expect(text).toContain("总次数: 55（其中用户主动清理 2 次，剔除后 53 次） · 涉及设备: 29");
    expect(text).toContain("按渠道和版本统计:");
    expect(text).toContain(
      "- main · 1.30.0 (13000015, 13000016): 30 次 / 15 台（主动清理 2 次） · 当日活跃 36 台 · 覆盖 14/14 · 次数/已上报活跃设备 28/36 = 0.78 · 受影响设备占活跃 39%"
      + " · 基线 1.29.0 (12900011, 12900012) 60/210 = 0.29 次/设备日 ⚠️ 已上报设备的观察指标较上一版本上升（非发生率或回归结论）",
    );
    expect(text).toContain("- preview · 1.30.0 (13000014): 3 次 / 3 台 · 当日活跃 5 台 · 覆盖 3/3 · 次数/已上报活跃设备 3/5 = 0.60 · 受影响设备占活跃 60%"
      + " · 无可比基线（新版本出现前 7 天没有完整的活跃设备记录）");
    expect(text).toContain("- main · 1.29.0 (12900012): 4 次 / 4 台 · 当日活跃 12 台 · 覆盖 2/4 · 覆盖不足，比例和预警不可比"
      + " · 无可比基线（旧版本的退出设备活跃记录覆盖不足）");
    expect(text).toContain("- unknown · unknown: 1 次 / 1 台 · 当日没有完整的活跃设备记录，比例和预警不可比 · 无可比基线（缺少完整的活跃设备记录）");
    expect(text).toContain("main 同时包含 Play 和 Hands main 两种分发，未分开比较");
    expect(text).toContain("Android 活跃上报最多一天一次");
    expect(text).toContain("按服务器接收日");
    expect(text).toContain("低于 90% 不给比例和预警");
    expect(text).not.toContain("另有");
    expect(text.match(/较上一版本上升/g)).toHaveLength(1);
  });

  it("labels main rows by distribution, gives Play and unconfirmed rows counts only, and shows a held flag", () => {
    const base = {
      version_name: "1.30.0", user_cleanup_count: 0, device_count: 2, device_count_excluding_cleanup: 2,
      spike: false, spike_held: false,
    };
    const text = formatRaftNotificationMessage({
      event: "crash:spike",
      payload: {
        app_slug: "raft-android",
        signature: "SystemKill@background",
        alert_reason: "background_system_kill_daily_summary",
        day: "2026-11-28",
        total_count: 30, device_count: 20, user_cleanup_count: 0, total_count_excluding_cleanup: 30,
        by_version: [
          {
            ...base, channel: "main", distribution: "hands", version_code: 13000015, version_codes: [13000015],
            count: 20, count_excluding_cleanup: 20, active_devices: 20, coverage: { matched: 2, reporters: 2 },
            rate_unavailable_reason: null, kills_per_active_device: 1, affected_device_share: 0.1,
            baseline: { version_name: "1.29.0", version_codes: [12900011], window_start_day: "2026-11-17",
              window_end_day: "2026-11-23", count: 14, active_device_days: 70, rate: 0.2, coverage: { matched: 9, reporters: 9 } },
            baseline_unavailable_reason: null, spike_held: true,
          },
          {
            ...base, channel: "main", distribution: "play", version_code: 13000016, version_codes: [13000016],
            count: 7, count_excluding_cleanup: 7, active_devices: null, coverage: null,
            rate_unavailable_reason: "distribution_not_comparable", kills_per_active_device: null, affected_device_share: null,
            baseline: null, baseline_unavailable_reason: "distribution_not_comparable",
          },
          {
            ...base, channel: "main", distribution: "unconfirmed", version_code: 13000017, version_codes: [13000017],
            count: 3, count_excluding_cleanup: 3, active_devices: null, coverage: null,
            rate_unavailable_reason: "distribution_not_comparable", kills_per_active_device: null, affected_device_share: null,
            baseline: null, baseline_unavailable_reason: "distribution_not_comparable",
          },
        ],
        top_devices: [],
      },
    });
    expect(text).toContain("- main（Hands） · 1.30.0 (13000015): 20 次 / 2 台 · 当日活跃 20 台 · 覆盖 2/2 · 次数/已上报活跃设备 20/20 = 1.00"
      + " · 受影响设备占活跃 10% · 基线 1.29.0 (12900011) 14/70 = 0.20 次/设备日（预警暂停，待核对基线和覆盖）");
    expect(text).toContain("- main（Play） · 1.30.0 (13000016): 7 次 / 2 台 · 只给次数，不给比例和预警");
    expect(text).toContain("- main（未确认归属） · 1.30.0 (13000017): 3 次 / 2 台 · 只给次数，不给比例和预警");
    expect(text).not.toContain("较上一版本上升");
    expect(text).toContain("main 按可核验的分发记录拆分");
    expect(text).not.toContain("未分开比较");
  });
});
