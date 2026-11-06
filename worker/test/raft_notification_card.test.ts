import { describe, expect, it } from "vitest";
import { formatRaftNotificationCard, withoutPlayConsoleFooter } from "../src/lib/raft_notification_card";
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

  it("only colors known statuses and preserves a long state without truncating its qualification", () => {
    for (const [state, tone] of [["IN_REVIEW", "info"], ["REJECTED", "danger"], ["READY_FOR_SALE", "success"], ["UNRECOGNIZED", "neutral"]] as const) {
      const { card } = formatRaftNotificationCard({ event: "app_store:version_state_changed", payload: { state } });
      expect(card.header?.tags?.[0]?.tone).toBe(tone);
    }
    const { card } = formatRaftNotificationCard({ event: "google_play:release_state_changed", payload: { state: "RELEASE_LIFECYCLE_STATE_PUBLISHED" } });
    expect(card.header?.tags).toBeUndefined();
    expect(card.elements.state).toMatchObject({ type: "Badge", props: { text: "Available on track (may be partially rolled out or paused)" } });
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
      { label: "Version code", value: "12000003", mono: true },
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

  it("keeps an invalid provider time as text rather than showing a different relative date", () => {
    const { card, content } = formatRaftNotificationCard({ event: "google_play:release_state_changed", delivered_at: 100,
      payload: { occurred_at: "2026-02-30T12:00:00Z", state: "RELEASE_LIFECYCLE_STATE_IN_REVIEW" } });
    expect(card.elements.time).toBeUndefined();
    expect(card.elements.footer0).toMatchObject({ props: { text: "At: 2026-02-30 12:00:00 UTC", tone: "muted" } });
    expect(content).toContain("At: 2026-02-30 12:00:00 UTC");
  });
});
