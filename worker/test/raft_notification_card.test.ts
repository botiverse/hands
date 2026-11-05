import { describe, expect, it } from "vitest";
import { formatRaftNotificationCard } from "../src/lib/raft_notification_card";
import { formatRaftNotificationMessage } from "../src/lib/raft_notification_content";
import { playFailureNotificationFields } from "../src/lib/play_failure_notification";

describe("Raft release notification cards", () => {
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
      reason: "play_api_error", play_failure_cause: "EDIT_IN_REVIEW", play_failure_cause_source: "structured",
      play_failure_reason: "CHANGES_ALREADY_IN_REVIEW", provider_message: "secret https://example.test @admin",
    } };
    const { card, content } = formatRaftNotificationCard(body);
    expect(content).toContain("Google Play has changes in review");
    expect(content).toContain("Play reason code: CHANGES_ALREADY_IN_REVIEW");
    expect(JSON.stringify(card)).toContain("Google Play has changes in review");
    expect(card.elements.state).toEqual({ type: "Badge", props: { text: "Failed", tone: "neutral" } });
    expect(JSON.stringify(card)).not.toContain("secret https://example.test");
    expect(content).not.toContain("@admin");
    const inferred = formatRaftNotificationMessage({ ...body, payload: { ...body.payload, play_failure_cause_source: "message" } });
    expect(inferred).toContain("Possible reason (inferred):");
    expect(inferred).not.toContain("Play reason code: CHANGES_ALREADY_IN_REVIEW");
    const unknownSource = formatRaftNotificationMessage({ ...body, payload: { ...body.payload, play_failure_cause_source: null } });
    expect(unknownSource).toContain("Possible reason (source unconfirmed):");
    expect(unknownSource).not.toContain("Play reason code: CHANGES_ALREADY_IN_REVIEW");
    const unknown = formatRaftNotificationMessage({ ...body, payload: { ...body.payload, play_failure_cause: "secret_unknown" } });
    expect(unknown).not.toContain("secret_unknown");
    expect(unknown).toContain("Reason code: play\\_api\\_error");
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
    expect(result.card.elements.state).toEqual({ type: "Badge", props: { text: "Ready for beta testing", tone: "neutral" } });
    expect(result.content).toContain("Previously: Waiting for beta review");
    expect(result.card.elements.review).toEqual({
      type: "Button", props: { label: "Open in App Store Connect", action: { kind: "navigate", url: "https://appstoreconnect.apple.com/apps/6789091965" } },
    });
    const serialized = JSON.stringify(result.card);
    expect(serialized).toContain("1.19.0");
    expect(serialized).toContain("11900001");
    expect(serialized).toContain("Internal and external testers");
    expect(serialized).toContain("Commit: a1b2c3d4");
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
    expect(content).toBe(formatRaftNotificationMessage(body));
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
    expect(displayed).toContain("At: 2024-10-27 03:33:20.000 UTC");
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
    expect(text).toContain("At: 1970-01-01 00:00:00.100 UTC");
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
    expect(text).toContain("At: 1970-01-01 00:00:00.100 UTC");
  });
});
