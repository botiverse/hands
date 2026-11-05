import { describe, expect, it } from "vitest";
import { formatRaftNotificationCard } from "../src/lib/raft_notification_card";
import { formatRaftNotificationMessage } from "../src/lib/raft_notification_content";

describe("Raft release notification cards", () => {
  it("shows release state and preserves the complete existing text for older clients", () => {
    const body = {
      event: "testflight:external_state_changed", delivered_at: 1730000000000,
      payload: {
        app: { name: "Raft App" }, state: "READY_FOR_BETA_TESTING",
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
    expect(result.card.elements.state).toEqual({ type: "Badge", props: { text: "READY_FOR_BETA_TESTING", tone: "neutral" } });
    expect(result.card.elements.review).toEqual({
      type: "Button", props: { label: "Open in App Store Connect", action: { kind: "navigate", url: "https://appstoreconnect.apple.com/apps/6789091965" } },
    });
    const serialized = JSON.stringify(result.card);
    expect(serialized).toContain("1.19.0");
    expect(serialized).toContain("11900001");
    expect(serialized).toContain("Internal and external testers");
    expect(serialized).toContain("source commit: a1b2c3d4");
    expect(serialized).not.toContain("hands_operation_receipt");
    expect(result.content).not.toContain("hands_operation_receipt");
    expect(body.payload.source).toBe("hands_operation_receipt");
    expect(serialized).toContain("Check @\u200bpeople and [link]");
    expect(serialized).not.toContain("private provider message");
    expect(serialized).not.toContain("https://example.test/private");
  });

  it("fits long multibyte content within the card limits while keeping its timestamp and fallback", () => {
    const body = {
      event: "google_play:release_state_changed", delivered_at: 1730000000000,
      payload: {
        state: "PUBLISHED", package_name: "build.example.app", track: "production", version_code: 11900002,
        state_label: "发布😀".repeat(250), groups_display: "组🧪".repeat(250),
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
    expect(displayed).toContain("occurred: 2024-10-27T03:33:20.000Z");
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
});
