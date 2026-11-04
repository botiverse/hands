import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { encryptP8 } from "../src/lib/asc_credentials";
import { buildFeedbackCommentEvent, buildFeedbackStatusEvent } from "../src/lib/feedback_events";
import { formatRaftNotificationMessage } from "../src/lib/raft_notification_content";
import { notificationObjectKey } from "../src/lib/raft_notification_identity";
import {
  handleConnectRaftBot,
  handleGetRaftNotifications,
  handleRaftNotificationWebhook,
  handleTestRaftNotification,
  handleUpdateRaftNotification,
} from "../src/routes/raft_notifications";
import { handleDeleteAppWebhook, handleUpdateAppWebhook, hmacSha256Hex } from "../src/routes/webhooks";

function d1(sqlite: Database.Database): D1Database {
  const prepare = (sql: string) => {
    const indexes: number[] = [];
    const statement = sqlite.prepare(sql.replace(/\?(\d+)/g, (_match, index) => {
      indexes.push(Number(index));
      return "?";
    }));
    const bind = (...parameters: unknown[]) => {
      const expanded = indexes.length ? indexes.map((index) => parameters[index - 1]) : parameters;
      return {
        run: async () => {
          const result = statement.run(...expanded);
          return { success: true, meta: { changes: result.changes } };
        },
        all: async <T>() => ({ success: true, results: statement.all(...expanded) as T[] }),
        first: async <T>() => (statement.get(...expanded) as T | undefined) ?? null,
      };
    };
    return { bind, run: () => bind().run(), all: <T>() => bind().all<T>(), first: <T>() => bind().first<T>() };
  };
  return { prepare } as unknown as D1Database;
}

const APP_ID = "app-1";
const SUBSCRIPTION_ID = "sub-1";
const SECRET = "webhook-secret";
const BOT_KEY = "sk_agent_test-key";

async function harness() {
  const sqlite = new Database(":memory:");
  sqlite.exec(`
    CREATE TABLE organizations (id TEXT PRIMARY KEY, external_provider TEXT NOT NULL, external_id TEXT NOT NULL);
    CREATE TABLE apps (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, slug TEXT, name TEXT, archived INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE webhooks (
      id TEXT PRIMARY KEY, org_id TEXT, app_id TEXT, url TEXT, secret TEXT NOT NULL,
      events_json TEXT, enabled INTEGER NOT NULL, archived_at INTEGER,
      created_at INTEGER, updated_at INTEGER
    );
    CREATE TABLE raft_notification_subscriptions (
      id TEXT PRIMARY KEY, app_id TEXT NOT NULL, server_id TEXT NOT NULL,
      channel_target TEXT NOT NULL, events_json TEXT NOT NULL, enabled INTEGER NOT NULL,
      bot_installation_id TEXT NOT NULL, webhook_id TEXT NOT NULL, created_by TEXT, created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL, archived_at INTEGER
    );
    CREATE TABLE raft_bot_installations (
      id TEXT PRIMARY KEY, server_id TEXT NOT NULL,
      installation_id TEXT NOT NULL, credential_id TEXT NOT NULL, agent_id TEXT,
      handle TEXT, key_ciphertext_b64 TEXT NOT NULL, key_iv_b64 TEXT NOT NULL,
      state TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      UNIQUE(server_id), UNIQUE(installation_id)
    );
    CREATE TABLE raft_notification_threads (
      subscription_id TEXT NOT NULL, object_key TEXT NOT NULL,
      parent_message_id TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      PRIMARY KEY(subscription_id, object_key)
    );
  `);
  sqlite.exec(readFileSync(new URL("../../migrations/sql/0087_raft_notification_cards.sql", import.meta.url), "utf8"));
  sqlite.prepare("INSERT INTO organizations (id, external_provider, external_id) VALUES ('org-1', 'raft', 'server-1')").run();
  sqlite.prepare("INSERT INTO apps (id, org_id, slug, name, archived) VALUES (?, 'org-1', 'sample-app', 'Sample App', 0)").run(APP_ID);
  sqlite.prepare(
    "INSERT INTO webhooks (id, org_id, app_id, url, secret, events_json, enabled, archived_at, created_at, updated_at) VALUES ('webhook-1', 'org-1', ?, 'https://hands.test/api/internal/raft-notifications/sub-1', ?, '[]', 1, NULL, 1, 1)",
  ).run(APP_ID, SECRET);
  const encrypted = await encryptP8(BOT_KEY, "enc-secret");
  sqlite.prepare(
    `INSERT INTO raft_bot_installations
       (id, server_id, installation_id, credential_id, agent_id, handle,
        key_ciphertext_b64, key_iv_b64, state, created_at, updated_at)
     VALUES ('bot-1', 'server-1', 'installation-1', 'credential-1', 'agent-1', 'hands-bot', ?, ?, 'active', 1, 1)`,
  ).run(encrypted.ciphertext_b64, encrypted.iv_b64);
  sqlite.prepare(
    `INSERT INTO raft_notification_subscriptions
       (id, app_id, server_id, channel_target, events_json, enabled, bot_installation_id, webhook_id, created_at, updated_at)
     VALUES (?, ?, 'server-1', '#releases', '["app_store:version_state_changed"]', 1, 'bot-1', 'webhook-1', 1, 1)`,
  ).run(SUBSCRIPTION_ID, APP_ID);
  const env = {
    DB: d1(sqlite),
    RAFT_API_ORIGIN: "https://api.raft.test",
    RAFT_CLIENT_ID: "hands-client",
    RAFT_CLIENT_SECRET: "client-secret",
    RAFT_BOT_ENC_KEY: "enc-secret",
  } as unknown as Env;
  const app = new Hono<{ Bindings: Env }>();
  app.patch("/api/apps/:appId/webhooks/:webhookId", handleUpdateAppWebhook);
  app.delete("/api/apps/:appId/webhooks/:webhookId", handleDeleteAppWebhook);
  app.post("/api/apps/:appId/raft-notifications/connect", handleConnectRaftBot);
  app.get("/api/apps/:appId/raft-notifications", handleGetRaftNotifications);
  app.patch("/api/apps/:appId/raft-notifications/:subscriptionId", handleUpdateRaftNotification);
  app.post("/api/apps/:appId/raft-notifications/:subscriptionId/test", handleTestRaftNotification);
  app.post("/api/internal/raft-notifications/:subscriptionId", handleRaftNotificationWebhook);
  const request = async (body: Record<string, unknown>, deliveryId: string, signature = SECRET) => {
    const raw = JSON.stringify(body);
    return app.fetch(new Request(`https://hands.test/api/internal/raft-notifications/${SUBSCRIPTION_ID}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Hands-Signature": `sha256=${await hmacSha256Hex(signature, raw)}`,
        "X-Hands-Delivery-Id": deliveryId,
      },
      body: raw,
    }), env);
  };
  const getConfig = () => app.fetch(new Request(`https://hands.test/api/apps/${APP_ID}/raft-notifications`), env);
  const updateConfig = (values: Record<string, unknown>) => app.fetch(new Request(`https://hands.test/api/apps/${APP_ID}/raft-notifications/${SUBSCRIPTION_ID}`, {
    method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(values),
  }), env);
  const testDestination = () => app.fetch(new Request(`https://hands.test/api/apps/${APP_ID}/raft-notifications/${SUBSCRIPTION_ID}/test`, { method: "POST" }), env);
  const connect = (appId = APP_ID, rotate = false) => app.fetch(new Request(`https://hands.test/api/apps/${appId}/raft-notifications/connect`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ rotate }),
  }), env);
  const mutateHiddenWebhook = () => app.fetch(new Request(`https://hands.test/api/apps/${APP_ID}/webhooks/webhook-1`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ events: ["build:failed"] }),
  }), env);
  return { sqlite, env, request, getConfig, updateConfig, testDestination, connect, mutateHiddenWebhook };
}

const body = (state: string) => ({
  event: "app_store:version_state_changed",
  delivered_at: 100,
  payload: {
    app: { slug: "raft-ios", name: "Raft App" },
    resource: { id: "version-1" },
    previous_state: "IN_REVIEW",
    state,
    version_string: "1.17.0",
    app_store_connect_url: "https://appstoreconnect.apple.com/apps/6789091965",
    review_message: "provider prose must never be forwarded",
  },
});
const stateBody = (state: string, occurredAt: string) => ({
  ...body(state), payload: { ...body(state).payload, occurred_at: occurredAt },
});

const TICKET_ID = "38d49b32-9499-40d2-ad45-3a23dd8c37f7";
const feedbackBody = (event: string, extra: Record<string, unknown> = {}) => ({
  event,
  app_id: "abad63e9-e760-42e9-92df-f418735f32ea",
  delivered_at: 100,
  payload: { ticket_id: TICKET_ID, ...extra },
});

afterEach(() => vi.restoreAllMocks());

function mockRaftFetch(implementation: typeof fetch) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    if (init?.method === "GET" && url.endsWith("/resolve")) {
      const messageId = decodeURIComponent(url.slice(url.lastIndexOf("/messages/") + "/messages/".length, -"/resolve".length));
      return Response.json({ message: { message_id: messageId, message_card: { revision: 1 } } });
    }
    return implementation(input, init);
  });
}

describe("Hands-managed Raft notifications", () => {
  it("renders a safe review card and omits provider prose", () => {
    const message = formatRaftNotificationMessage(body("REJECTED"));
    expect(message).toContain("app_store:version_state_changed");
    expect(message).toContain("1.17.0");
    expect(message).toContain("App Store Connect");
    expect(message).not.toContain("provider prose must never be forwarded");
  });

  it("uses a stable object key for later state changes", async () => {
    expect(await notificationObjectKey(body("IN_REVIEW"))).toBe(
      await notificationObjectKey(body("REJECTED")),
    );
  });

  it("adds clear icons to feedback events and the details command", () => {
    for (const [event, emoji] of [
      ["feedback:new", "📮"],
      ["feedback:comment_created", "💬"],
      ["feedback:status_changed", "🔄"],
    ] as const) {
      const message = formatRaftNotificationMessage(feedbackBody(event, { app_slug: "sample-app" }));
      expect(message.startsWith(`${emoji} **Hands · ${event}**`)).toBe(true);
      expect(message).toContain(`📖 View more: \`hands feedback show sample-app ${TICKET_ID}\``);
    }
    expect(formatRaftNotificationMessage(body("REJECTED")).startsWith("🍎 **Hands · app_store:version_state_changed**")).toBe(true);
  });

  it("keeps release context and identifies a first Play observation", () => {
    const message = formatRaftNotificationMessage({
      event: "google_play:release_state_changed", app_id: "abad63e9-e760-42e9-92df-f418735f32ea",
      payload: {
        package_name: "build.example.app", track: "alpha", version_code: 11800003,
        state: "PUBLISHED", state_label: "Track available", observation_display: "First observation, not a new change",
        rollout_percent: 20,
      },
    });
    expect(message.startsWith("▶️ **Hands · google_play:release_state_changed**")).toBe(true);
    expect(message).toContain("observation: First observation, not a new change");
    expect(message).toContain("description: Track available");
    expect(message).toContain("track: alpha");
    expect(message).toContain("rollout: 20%");
    const release = formatRaftNotificationMessage({
      event: "release:published", payload: { rollout: 100, version_transition: "1.0 → 1.1", version_code_transition: "1 → 2" },
    });
    expect(release).toContain("🚀 **Hands · release:published**");
    expect(release).toContain("version transition: 1.0 → 1.1");
    expect(release).toContain("version code transition: 1 → 2");
    expect(release).toContain("rollout: 100%");
  });

  it("uses common safe fields for events without a custom presentation", () => {
    const message = formatRaftNotificationMessage({
      event: "release:draft_created",
      payload: { version: "1.2.3", rollout: 25, state: "draft", message: "private text" },
    });
    expect(message.startsWith("**Hands · release:draft_created**")).toBe(true);
    expect(message).toContain("version: 1.2.3");
    expect(message).toContain("rollout: 25%");
    expect(message).not.toContain("private text");
    expect(formatRaftNotificationMessage({ event: "release", payload: { rollout: 25 } })).not.toContain("rollout:");
  });

  it("shows bounded, safe TestFlight notes and group context only for TestFlight", () => {
    const payload = {
      groups_display: "Test group: internal",
      what_to_test: { "zh-Hans": `Check @admin #release https://example.test/private ${"x".repeat(600)}` },
      source_commit: "a1b2c3d4",
    };
    const message = formatRaftNotificationMessage({ event: "testflight:internal_distribution_ready", payload });
    expect(message.startsWith("✈️ **Hands · testflight:internal_distribution_ready**")).toBe(true);
    expect(message).toContain("groups: Test group: internal");
    expect(message).toContain("Test notes (zh-Hans): Check @\u200badmin #\u200brelease \\[link\\]");
    expect(message).toContain("source commit: a1b2c3d4");
    expect(message).toContain("…");
    expect(message).not.toContain("https://example.test");
    expect(formatRaftNotificationMessage({ event: "release:published", payload })).not.toContain("Test notes");
  });

  it("separates Play state threads by package, track and version", async () => {
    const state = (track: string, version: number, value: string) => ({
      event: "google_play:release_state_changed", payload: { package_name: "build.example.app", track, version_code: version, state: value },
    });
    expect(await notificationObjectKey(state("alpha", 1, "IN_REVIEW"))).toBe(await notificationObjectKey(state("alpha", 1, "PUBLISHED")));
    expect(await notificationObjectKey(state("alpha", 1, "PUBLISHED"))).not.toBe(await notificationObjectKey(state("production", 1, "PUBLISHED")));
    expect(await notificationObjectKey(state("alpha", 1, "PUBLISHED"))).not.toBe(await notificationObjectKey(state("alpha", 2, "PUBLISHED")));
  });

  it("renders a bounded feedback preview, app identity, and a usable CLI command", () => {
    const message = formatRaftNotificationMessage(feedbackBody("feedback:new", {
      app_slug: "sample-app", kind: "feedback", message: `${"Hello ".repeat(40)}@admin https://example.test/signed?secret=abc`,
    }));
    expect(message).toContain("App: sample-app (abad63e9-e760-42e9-92df-f418735f32ea)");
    expect(message).toContain("Feedback: Hello ");
    expect(message).toContain("…");
    expect(message).toContain(`View more: \`hands feedback show sample-app ${TICKET_ID}\``);
    expect(message).not.toContain("@admin");
    expect(message).not.toContain("secret=abc");
  });

  it("does not render crash text, comments, mentions or links in feedback previews", () => {
    const crash = formatRaftNotificationMessage(feedbackBody("feedback:new", { app_slug: "sample-app", kind: "crash", message: "PRIVATE STACK" }));
    const comment = formatRaftNotificationMessage(feedbackBody("feedback:comment_created", { comment: { body: "PRIVATE COMMENT" } }));
    const feedback = formatRaftNotificationMessage(feedbackBody("feedback:new", { app_slug: "sample-app", kind: "bug", message: "Hi @admin #release https://example.test/path?q=secret" }));
    expect(crash).not.toContain("PRIVATE STACK");
    expect(comment).not.toContain("PRIVATE COMMENT");
    expect(feedback).not.toContain("@admin");
    expect(feedback).not.toContain("#release");
    expect(feedback).not.toContain("https://example.test");
    expect(feedback).toContain("Feedback: Hi @\u200badmin #\u200brelease");
    expect(feedback).toContain("\\[link\\]");
  });

  it("keeps the View more command when many fields would otherwise exceed the message limit", () => {
    const long = "x".repeat(500);
    const message = formatRaftNotificationMessage(feedbackBody("feedback:new", {
      app_slug: "sample-app", kind: "feedback", message: "short", status: long, state: long,
      previous_state: long, version: long, version_name: long, build_number: long,
      version_code: long, track: long, channel: long, distribution: long, platform: long,
    }));
    expect(message.length).toBeLessThanOrEqual(4000);
    expect(message).toContain(`View more: \`hands feedback show sample-app ${TICKET_ID}\``);
  });

  it("keeps the snapshot warning, review link, and time when release fields are long", () => {
    const long = "x".repeat(500);
    const message = formatRaftNotificationMessage({
      event: "app_store:version_state_changed", delivered_at: 1793556592575,
      payload: {
        status: long, previous_status: long, state: "REJECTED", previous_state: long,
        version_string: long, version_name: long, build_number: long, version_code: long,
        track: long, channel: long, distribution: long, platform: long,
        observation_display: "First observation, not a new change",
        app_store_connect_url: "https://appstoreconnect.apple.com/apps/123",
      },
    });
    expect(message.length).toBeLessThanOrEqual(4000);
    expect(message).toContain("observation: First observation, not a new change");
    expect(message).toContain("Review: https://appstoreconnect.apple.com/apps/123");
    expect(message).toContain("Apple's review message is available in App Store Connect.");
    expect(message).toContain("occurred: 2026-11-01T18:09:52.575Z");
  });

  it("shows a delivered-at millisecond timestamp as readable UTC and preserves provider timestamps", () => {
    const feedback = formatRaftNotificationMessage({ ...feedbackBody("feedback:new"), delivered_at: 1793556592575 });
    expect(feedback).toContain("occurred: 2026-11-01T18:09:52.575Z");
    const provider = formatRaftNotificationMessage({ ...body("REJECTED"), payload: { ...body("REJECTED").payload, occurred_at: "2026-11-01T17:00:00Z" } });
    expect(provider).toContain("occurred: 2026-11-01T17:00:00Z");
    expect(provider.match(/occurred:/g)).toHaveLength(1);
  });

  it("uses only shell-safe app and ticket identifiers in the CLI command", () => {
    const message = formatRaftNotificationMessage(feedbackBody("feedback:new", { app_slug: "app;echo-bad", kind: "feedback", message: "hi" }));
    expect(message).toContain(`hands feedback show abad63e9-e760-42e9-92df-f418735f32ea ${TICKET_ID}`);
    expect(message).not.toContain("hands feedback show app;echo-bad");
    const badTicket = formatRaftNotificationMessage(feedbackBody("feedback:new", { app_slug: "sample-app", ticket_id: "bad;echo" }));
    expect(badTicket).not.toContain("hands feedback show");
    const ambiguousSlug = formatRaftNotificationMessage(feedbackBody("feedback:new", { app_slug: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" }));
    expect(ambiguousSlug).toContain(`hands feedback show abad63e9-e760-42e9-92df-f418735f32ea ${TICKET_ID}`);
  });

  it("returns bot metadata without exposing the encrypted key", async () => {
    const { getConfig } = await harness();
    const response = await getConfig();
    const text = await response.text();
    expect(response.status).toBe(200);
    expect(text).toContain("hands-bot");
    expect(text).not.toContain("key_ciphertext_b64");
    expect(text).not.toContain(BOT_KEY);
  });

  it("tests the selected card mode against Raft and reports unsupported destinations", async () => {
    const { updateConfig, testDestination } = await harness();
    await updateConfig({ card_updates: true });
    let requestBody: Record<string, unknown> | undefined;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      requestBody = JSON.parse(String(init?.body));
      return Response.json({ code: "message_card_unsupported_target" }, { status: 400 });
    });
    const response = await testDestination();
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "message_card_unsupported_target" });
    expect(requestBody).toMatchObject({ target: "#releases", card: { version: 1 } });
  });

  it("mints and stores a bot key without returning it to the admin UI", async () => {
    const { connect } = await harness();
    const provider = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      if (String(input).endsWith("/api/oauth/installations/lookup")) return Response.json({ installation_id: "installation-1" });
      return Response.json({ credentialId: "credential-2", apiKey: "sk_agent_replacement", agentId: "agent-2" });
    });
    const response = await connect(APP_ID, true);
    const text = await response.text();
    expect(response.status).toBe(200);
    expect(text).not.toContain("sk_agent_replacement");
    expect(provider).toHaveBeenCalledTimes(2);
  });

  it("shares one server installation key across Hands apps without rotating it", async () => {
    const { connect, sqlite } = await harness();
    sqlite.prepare("INSERT INTO apps (id, org_id, archived) VALUES ('app-2', 'org-1', 0)").run();
    const provider = vi.spyOn(globalThis, "fetch");
    const response = await connect("app-2", false);
    expect(response.status).toBe(200);
    expect(provider).not.toHaveBeenCalled();
  });

  it("fails before minting when the dedicated bot encryption key is absent", async () => {
    const { connect, env } = await harness();
    delete (env as unknown as Record<string, unknown>).RAFT_BOT_ENC_KEY;
    const provider = vi.spyOn(globalThis, "fetch");
    const response = await connect(APP_ID, true);
    expect(response.status).toBe(503);
    expect(provider).not.toHaveBeenCalled();
  });

  it("does not expose the internal webhook row through generic mutation routes", async () => {
    const { mutateHiddenWebhook, sqlite } = await harness();
    const response = await mutateHiddenWebhook();
    expect(response.status).toBe(404);
    expect(sqlite.prepare("SELECT events_json FROM webhooks WHERE id = 'webhook-1'").pluck().get()).toBe("[]");
  });

  it("verifies the generic webhook signature before sending", async () => {
    const { request } = await harness();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ state: "sent", messageId: "msg-1" }));
    const response = await request(body("REJECTED"), "delivery-1", "wrong-secret");
    expect(response.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends the first card to the channel and later cards to its thread", async () => {
    const { request, sqlite } = await harness();
    const sentTargets: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      const payload = JSON.parse(String(init?.body)) as { target: string };
      sentTargets.push(payload.target);
      return Response.json({ state: "sent", messageId: sentTargets.length === 1 ? "parent-message-1" : "reply-message-1" });
    });
    const first = await request(body("IN_REVIEW"), "delivery-1");
    const second = await request(body("REJECTED"), "delivery-2");
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(sentTargets).toEqual(["#releases", "#releases:parent-m"]);
    expect(sqlite.prepare("SELECT parent_message_id FROM raft_notification_threads WHERE subscription_id = ? AND object_key LIKE 'app_store:%'").get(SUBSCRIPTION_ID)).toMatchObject({ parent_message_id: "parent-message-1" });
  });

  it("sends a card, updates the same message and ignores an older event", async () => {
    const { request, sqlite, updateConfig } = await harness();
    expect((await updateConfig({ card_updates: true })).status).toBe(200);
    const sent: Array<{ url: string; body: Record<string, unknown> }> = [];
    mockRaftFetch(async (input, init) => {
      sent.push({ url: String(input), body: JSON.parse(String(init?.body)) });
      return sent.length === 1 ? Response.json({ state: "sent", messageId: "parent-message-1" })
        : Response.json({ ok: true, messageId: "parent-message-1", revision: 2 });
    });
    const first = stateBody("IN_REVIEW", "2026-11-04T07:00:00Z");
    const second = stateBody("REJECTED", "2026-11-04T07:01:00Z");
    expect((await request(first, "a")).status).toBe(200);
    expect((await request(second, "b")).status).toBe(200);
    expect((await request(first, "c")).status).toBe(200);
    expect(sent).toHaveLength(2);
    expect(sent[0]!.body).toMatchObject({ target: "#releases", card: { version: 1 }, content: expect.stringContaining("IN\\_REVIEW") });
    expect(sent[1]!.url).toContain("/messages/parent-message-1/card");
    expect(sent[1]!.body).toMatchObject({ expectedRevision: 1, card: { version: 1 }, content: expect.stringContaining("REJECTED") });
    expect(sqlite.prepare("SELECT message_id,revision FROM raft_notification_cards").get()).toEqual({ message_id: "parent-message-1", revision: 2 });
  });

  it("uses Raft's explicit card receipt without relying on joint message readback", async () => {
    const { request, updateConfig } = await harness();
    await updateConfig({ card_updates: true });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({
      state: "sent", messageId: "parent-message-1", messageCard: { revision: 1 },
    }));
    const response = await request(stateBody("IN_REVIEW", "2026-11-04T07:00:00Z"), "a");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ card: true, message_id: "parent-message-1" });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("recognizes an older server that silently sent text and never tries to update it as a card", async () => {
    const { request, sqlite, updateConfig } = await harness();
    await updateConfig({ card_updates: true });
    const methods: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      const method = String(init?.method);
      methods.push(method);
      if (method === "GET") return Response.json({ message: { message_id: "parent-message-1" } });
      return Response.json({ state: "sent", messageId: methods.length === 1 ? "parent-message-1" : "reply-1" });
    });
    const response = await request(stateBody("IN_REVIEW", "2026-11-04T07:00:00Z"), "a");
    expect(await response.json()).toMatchObject({ card: false, card_fallback: "card_not_supported" });
    expect((await request(stateBody("REJECTED", "2026-11-04T07:01:00Z"), "b")).status).toBe(200);
    expect(methods).toEqual(["POST", "GET", "POST"]);
    expect(sqlite.prepare("SELECT state,revision FROM raft_notification_cards").get()).toEqual({ state: "retired", revision: 0 });
  });

  it("recovers an unreadable joint message from its same-key card receipt", async () => {
    const { request, sqlite, updateConfig } = await harness();
    await updateConfig({ card_updates: true });
    const sent: Array<Record<string, unknown>> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      if (init?.method === "GET") return Response.json({ code: "not_found" }, { status: 404 });
      const data = JSON.parse(String(init?.body)) as Record<string, unknown>;
      sent.push(data);
      if (sent.length === 1) return Response.json({ state: "sent", messageId: "parent-message-1" });
      if (data.reconcileOnly) return Response.json({ state: "committed", messageId: "parent-message-1" });
      return Response.json({ state: "sent", messageId: "parent-message-1", messageCard: { revision: 1 } });
    });
    const event = stateBody("IN_REVIEW", "2026-11-04T07:00:00Z");
    expect((await request(event, "a")).status).toBe(503);
    sqlite.prepare("UPDATE raft_notification_threads SET updated_at=1").run();
    expect((await request(event, "b")).status).toBe(200);
    expect(sent).toHaveLength(3);
    expect(sent[1]).toMatchObject({ reconcileOnly: true, idempotencyKey: sent[0]!.idempotencyKey });
    expect(sent[2]).toEqual(sent[0]);
  });

  it("does not send text when card readback is refused after a successful send", async () => {
    const { request, sqlite, updateConfig } = await harness();
    await updateConfig({ card_updates: true });
    const methods: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      methods.push(String(init?.method));
      return init?.method === "GET" ? Response.json({ code: "message_card_not_found" }, { status: 404 })
        : Response.json({ state: "sent", messageId: "parent-message-1" });
    });
    const response = await request(stateBody("IN_REVIEW", "2026-11-04T07:00:00Z"), "a");
    expect(response.status).toBe(503);
    expect(methods).toEqual(["POST", "GET"]);
    expect(sqlite.prepare("SELECT pending_uncertain FROM raft_notification_cards").pluck().get()).toBe(1);
    expect(sqlite.prepare("SELECT parent_message_id FROM raft_notification_threads").pluck().get()).toBe("pending");
  });

  it("accepts a card marker in the reconciliation receipt without a message read", async () => {
    const { request, sqlite, updateConfig } = await harness();
    await updateConfig({ card_updates: true });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      const data = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (!data.reconcileOnly) throw new Error("response lost");
      return Response.json({ state: "committed", messageId: "parent-message-1", messageCard: { revision: 1 } });
    });
    const event = stateBody("IN_REVIEW", "2026-11-04T07:00:00Z");
    expect((await request(event, "a")).status).toBe(503);
    sqlite.prepare("UPDATE raft_notification_threads SET updated_at=1").run();
    expect((await request(event, "b")).status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("uses reconciliation after a lost send response, including when cards are later disabled", async () => {
    const { request, sqlite, updateConfig } = await harness();
    await updateConfig({ card_updates: true });
    const requests: Array<Record<string, unknown>> = [];
    mockRaftFetch(async (_input, init) => {
      requests.push(JSON.parse(String(init?.body)));
      if (requests.length === 1) throw new Error("response lost after commit");
      return Response.json({ state: "committed", messageId: "parent-message-1", reconciliation: true });
    });
    const first = stateBody("IN_REVIEW", "2026-11-04T07:00:00Z");
    expect((await request(first, "a")).status).toBe(503);
    expect((await updateConfig({ card_updates: false })).status).toBe(409);
    // The original parent claim is deliberately held for the existing five-minute lease.
    sqlite.prepare("UPDATE raft_notification_threads SET updated_at=1").run();
    expect((await request(first, "a-retry")).status).toBe(200);
    expect(requests).toHaveLength(2);
    expect(requests[1]).toMatchObject({ target: "#releases", reconcileOnly: true, idempotencyKey: requests[0]!.idempotencyKey });
    expect(requests[1]).not.toHaveProperty("card");
    expect(sqlite.prepare("SELECT parent_message_id FROM raft_notification_threads").pluck().get()).toBe("parent-message-1");
  });

  it("never falls back to a new text message after an uncertain send", async () => {
    const { request, sqlite, updateConfig } = await harness();
    await updateConfig({ card_updates: true });
    const requests: Array<Record<string, unknown>> = [];
    mockRaftFetch(async (_input, init) => {
      const parsed = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requests.push(parsed);
      if (requests.length === 1) throw new Error("unknown result");
      if (parsed.reconcileOnly) return Response.json({ state: "not_found" });
      return Response.json({ code: "message_cards_disabled" }, { status: 400 });
    });
    const event = stateBody("IN_REVIEW", "2026-11-04T07:00:00Z");
    expect((await request(event, "a")).status).toBe(503);
    sqlite.prepare("UPDATE raft_notification_threads SET updated_at=1").run();
    const retry = await request(event, "b");
    expect(retry.status).toBe(503);
    expect(await retry.json()).toMatchObject({ error: "card_delivery_uncertain" });
    expect(requests).toHaveLength(3);
    expect(requests[2]!.idempotencyKey).toBe(requests[0]!.idempotencyKey);
    expect(requests[2]!.card).toEqual(requests[0]!.card);
    expect(sqlite.prepare("SELECT parent_message_id FROM raft_notification_threads").pluck().get()).toBe("pending");
  });

  it("safely falls back to text when the first card attempt is definitely refused", async () => {
    const { request, sqlite, updateConfig } = await harness();
    await updateConfig({ card_updates: true });
    const requests: Array<Record<string, unknown>> = [];
    mockRaftFetch(async (_input, init) => {
      requests.push(JSON.parse(String(init?.body)));
      return requests.length === 1 ? Response.json({ code: "message_card_unsupported_target" }, { status: 400 })
        : Response.json({ state: "sent", messageId: "text-parent-1" });
    });
    const delivered = await request(stateBody("IN_REVIEW", "2026-11-04T07:00:00Z"), "a");
    expect(delivered.status).toBe(200);
    expect(await delivered.json()).toMatchObject({ card_fallback: "message_card_unsupported_target" });
    expect(requests).toHaveLength(2);
    expect(requests[0]).toHaveProperty("card");
    expect(requests[1]).not.toHaveProperty("card");
    expect(sqlite.prepare("SELECT state FROM raft_notification_cards").pluck().get()).toBe("retired");
  });

  it("replays a lost update with the same body and revision", async () => {
    const { request, updateConfig } = await harness();
    await updateConfig({ card_updates: true });
    const requests: Array<Record<string, unknown>> = [];
    mockRaftFetch(async (_input, init) => {
      requests.push(JSON.parse(String(init?.body)));
      if (requests.length === 1) return Response.json({ state: "sent", messageId: "parent-message-1" });
      if (requests.length === 2) throw new Error("response lost after update committed");
      return Response.json({ ok: true, messageId: "parent-message-1", revision: 2 });
    });
    expect((await request(stateBody("IN_REVIEW", "2026-11-04T07:00:00Z"), "a")).status).toBe(200);
    const next = stateBody("REJECTED", "2026-11-04T07:01:00Z");
    expect((await request(next, "b")).status).toBe(503);
    expect((await request(next, "b-retry")).status).toBe(200);
    expect(requests).toHaveLength(3);
    expect(requests[2]).toEqual(requests[1]);
  });

  it("holds an uncertain update when a changed flag refuses its replay", async () => {
    const { request, sqlite, updateConfig } = await harness();
    await updateConfig({ card_updates: true });
    const requests: Array<Record<string, unknown>> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      requests.push(JSON.parse(String(init?.body)));
      if (requests.length === 1) return Response.json({ state: "sent", messageId: "parent-message-1", messageCard: { revision: 1 } });
      if (requests.length === 2) throw new Error("response lost after update committed");
      if (requests.length === 3) return Response.json({ code: "message_cards_disabled" }, { status: 400 });
      return Response.json({ ok: true, messageId: "parent-message-1", revision: 2 });
    });
    expect((await request(stateBody("IN_REVIEW", "2026-11-04T07:00:00Z"), "a")).status).toBe(200);
    const next = stateBody("REJECTED", "2026-11-04T07:01:00Z");
    expect((await request(next, "b")).status).toBe(503);
    const refused = await request(next, "b-retry");
    expect(refused.status).toBe(503);
    expect(await refused.json()).toMatchObject({ error: "card_delivery_uncertain" });
    expect(sqlite.prepare("SELECT pending_uncertain FROM raft_notification_cards").pluck().get()).toBe(1);
    expect((await request(next, "b-final")).status).toBe(200);
    expect(requests[2]).toEqual(requests[1]);
    expect(requests[3]).toEqual(requests[1]);
  });

  it("repairs a committed root after a crash before the thread pointer was saved", async () => {
    const { request, sqlite, updateConfig } = await harness();
    await updateConfig({ card_updates: true });
    const fetchMock = mockRaftFetch(async () => Response.json({ state: "sent", messageId: "parent-message-1" }));
    const event = stateBody("IN_REVIEW", "2026-11-04T07:00:00Z");
    expect((await request(event, "a")).status).toBe(200);
    sqlite.prepare("UPDATE raft_notification_threads SET parent_message_id='pending',updated_at=1").run();
    expect((await request(event, "a-retry")).status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sqlite.prepare("SELECT parent_message_id FROM raft_notification_threads").pluck().get()).toBe("parent-message-1");
  });

  it("recovers an earlier unknown send before updating it with a newer event", async () => {
    const { request, sqlite, updateConfig } = await harness();
    await updateConfig({ card_updates: true });
    const requests: Array<Record<string, unknown>> = [];
    mockRaftFetch(async (_input, init) => {
      const parsed = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requests.push(parsed);
      if (requests.length === 1) throw new Error("response lost");
      if (parsed.reconcileOnly) return Response.json({ state: "committed", messageId: "parent-message-1" });
      return Response.json({ ok: true, messageId: "parent-message-1", revision: 2 });
    });
    expect((await request(stateBody("IN_REVIEW", "2026-11-04T07:00:00Z"), "a")).status).toBe(503);
    sqlite.prepare("UPDATE raft_notification_threads SET updated_at=1").run();
    expect((await request(stateBody("REJECTED", "2026-11-04T07:01:00Z"), "b")).status).toBe(200);
    expect(requests).toHaveLength(3);
    expect(requests[1]).toMatchObject({ reconcileOnly: true, idempotencyKey: requests[0]!.idempotencyKey });
    expect(requests[2]).toMatchObject({ expectedRevision: 1, content: expect.stringContaining("REJECTED") });
    expect(sqlite.prepare("SELECT parent_message_id FROM raft_notification_threads").pluck().get()).toBe("parent-message-1");
  });

  it("serializes concurrent notifications and blocks changing mode during a send", async () => {
    const { request, updateConfig } = await harness();
    await updateConfig({ card_updates: true });
    let releaseSend: ((value: Response) => void) | undefined;
    let signalStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { signalStarted = resolve; });
    const fetchMock = mockRaftFetch(async () => {
      signalStarted?.();
      return new Promise<Response>((resolve) => { releaseSend = resolve; });
    });
    const first = request(stateBody("IN_REVIEW", "2026-11-04T07:00:00Z"), "a");
    await started;
    expect((await updateConfig({ card_updates: false })).status).toBe(409);
    expect((await request(stateBody("REJECTED", "2026-11-04T07:01:00Z"), "b")).status).toBe(503);
    expect(fetchMock).toHaveBeenCalledOnce();
    if (!releaseSend) throw new Error("send did not start");
    releaseSend(Response.json({ state: "sent", messageId: "parent-message-1" }));
    expect((await first).status).toBe(200);
  });

  it("fences an expired lease holder after a newer worker recovers its update", async () => {
    const { request, sqlite, updateConfig } = await harness();
    await updateConfig({ card_updates: true });
    let now = Date.parse("2026-11-04T07:00:00Z");
    vi.spyOn(Date, "now").mockImplementation(() => now);
    let releaseOld: ((value: Response) => void) | undefined;
    let signalStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { signalStarted = resolve; });
    const calls: Array<Record<string, unknown>> = [];
    mockRaftFetch(async (_input, init) => {
      calls.push(JSON.parse(String(init?.body)));
      if (calls.length === 1) return Response.json({ state: "sent", messageId: "parent-message-1" });
      if (calls.length === 2) {
        signalStarted?.();
        return new Promise<Response>((resolve) => { releaseOld = resolve; });
      }
      if (calls.length === 3) return Response.json({ ok: true, messageId: "parent-message-1", revision: 2 });
      return Response.json({ ok: true, messageId: "parent-message-1", revision: 3 });
    });
    expect((await request(stateBody("IN_REVIEW", "2026-11-04T07:00:00Z"), "a")).status).toBe(200);
    const old = request(stateBody("REJECTED", "2026-11-04T07:01:00Z"), "b");
    await started;
    now += 31_000;
    expect((await request(stateBody("APPROVED", "2026-11-04T07:02:00Z"), "c")).status).toBe(200);
    expect(calls[2]).toEqual(calls[1]);
    expect(calls[3]).toMatchObject({ expectedRevision: 2, content: expect.stringContaining("APPROVED") });
    if (!releaseOld) throw new Error("old update did not start");
    releaseOld(Response.json({ ok: true, messageId: "parent-message-1", revision: 2 }));
    expect((await old).status).toBe(503);
    expect(sqlite.prepare("SELECT revision FROM raft_notification_cards").pluck().get()).toBe(3);
  });

  it("keeps an ambiguous timestamp and later events as text instead of guessing their order", async () => {
    const { request, sqlite, updateConfig } = await harness();
    await updateConfig({ card_updates: true });
    const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
    mockRaftFetch(async (_input, init) => {
      calls.push({ method: String(init?.method), body: JSON.parse(String(init?.body)) });
      return Response.json({ state: "sent", messageId: calls.length === 1 ? "parent-message-1" : `reply-${calls.length}` });
    });
    expect((await request(stateBody("IN_REVIEW", "2026-11-04T07:00:00Z"), "a")).status).toBe(200);
    expect((await request(stateBody("REJECTED", "2026-11-04T07:00:00Z"), "b")).status).toBe(200);
    expect((await request(stateBody("APPROVED", "2026-11-04T07:01:00Z"), "c")).status).toBe(200);
    expect(calls.map((call) => call.method)).toEqual(["POST", "POST", "POST"]);
    expect(calls[1]!.body).toMatchObject({ target: "#releases:parent-m" });
    expect(calls[1]!.body).not.toHaveProperty("card");
    expect(sqlite.prepare("SELECT state FROM raft_notification_cards").pluck().get()).toBe("retired");
  });

  it("does not turn an existing text thread into a card when the destination is opted in", async () => {
    const { request, updateConfig } = await harness();
    const calls: Array<Record<string, unknown>> = [];
    mockRaftFetch(async (_input, init) => {
      calls.push(JSON.parse(String(init?.body)));
      return Response.json({ state: "sent", messageId: calls.length === 1 ? "parent-message-1" : "reply-1" });
    });
    expect((await request(stateBody("IN_REVIEW", "2026-11-04T07:00:00Z"), "a")).status).toBe(200);
    await updateConfig({ card_updates: true });
    expect((await request(stateBody("REJECTED", "2026-11-04T07:01:00Z"), "b")).status).toBe(200);
    expect(calls[1]).toMatchObject({ target: "#releases:parent-m" });
    expect(calls[1]).not.toHaveProperty("card");
  });

  it("keeps an object on text after cards are disabled and re-enabled", async () => {
    const { request, updateConfig } = await harness();
    await updateConfig({ card_updates: true });
    const calls: Array<Record<string, unknown>> = [];
    mockRaftFetch(async (_input, init) => {
      calls.push(JSON.parse(String(init?.body)));
      return Response.json({ state: "sent", messageId: calls.length === 1 ? "parent-message-1" : `reply-${calls.length}` });
    });
    expect((await request(stateBody("IN_REVIEW", "2026-11-04T07:00:00Z"), "a")).status).toBe(200);
    await updateConfig({ card_updates: false });
    expect((await request(stateBody("REJECTED", "2026-11-04T07:01:00Z"), "b")).status).toBe(200);
    await updateConfig({ card_updates: true });
    expect((await request(stateBody("APPROVED", "2026-11-04T07:02:00Z"), "c")).status).toBe(200);
    expect(calls[1]).not.toHaveProperty("card");
    expect(calls[2]).not.toHaveProperty("card");
  });

  it("keeps a new object on text when its first event has an invalid timestamp", async () => {
    const { request, updateConfig } = await harness();
    await updateConfig({ card_updates: true });
    const calls: Array<Record<string, unknown>> = [];
    mockRaftFetch(async (_input, init) => {
      calls.push(JSON.parse(String(init?.body)));
      return Response.json({ state: "sent", messageId: calls.length === 1 ? "parent-message-1" : "reply-1" });
    });
    expect((await request(stateBody("IN_REVIEW", "2026-02-30T07:00:00Z"), "a")).status).toBe(200);
    expect((await request(stateBody("REJECTED", "2026-11-04T07:01:00Z"), "b")).status).toBe(200);
    expect(calls[0]).not.toHaveProperty("card");
    expect(calls[1]).not.toHaveProperty("card");
  });

  it("sends a new card in the thread after the update window", async () => {
    const { request, sqlite, updateConfig } = await harness();
    await updateConfig({ card_updates: true });
    const calls: Array<Record<string, unknown>> = [];
    mockRaftFetch(async (_input, init) => {
      calls.push(JSON.parse(String(init?.body)));
      return Response.json({ state: "sent", messageId: calls.length === 1 ? "parent-message-1" : "next-card-1" });
    });
    expect((await request(stateBody("IN_REVIEW", "2026-11-04T07:00:00Z"), "a")).status).toBe(200);
    sqlite.prepare("UPDATE raft_notification_cards SET message_created_at=?").run(Date.now() - 15 * 24 * 60 * 60_000);
    expect((await request(stateBody("REJECTED", "2026-11-04T07:01:00Z"), "b")).status).toBe(200);
    expect(calls[1]).toMatchObject({ target: "#releases:parent-m", card: { version: 1 } });
    expect(sqlite.prepare("SELECT message_id,revision FROM raft_notification_cards").get()).toEqual({ message_id: "next-card-1", revision: 1 });
  });

  it("sends feedback, comment, and status for one ticket to the same thread", async () => {
    const { request, sqlite } = await harness();
    sqlite.prepare("UPDATE raft_notification_subscriptions SET events_json = ? WHERE id = ?").run(
      JSON.stringify(["feedback:new", "feedback:comment_created", "feedback:status_changed"]), SUBSCRIPTION_ID,
    );
    const sent: Array<{ target: string; content: string }> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      sent.push(JSON.parse(String(init?.body)) as { target: string; content: string });
      return Response.json({ state: "sent", messageId: sent.length === 1 ? "parent-message-1" : `reply-${sent.length}` });
    });
    const eventBase = {
      eventId: "event-1", createdAt: 101, orgId: "org-1", appId: APP_ID, ticketId: TICKET_ID,
      reporterIntegrationId: "integration-1", reporterId: "reporter-1",
    };
    const events = [
      feedbackBody("feedback:new", { kind: "feedback", message: "A short report" }),
      JSON.parse(buildFeedbackCommentEvent({ ...eventBase, eventType: "feedback:comment_created", comment: { id: "comment-1", author_type: "staff", author_actor: "actor", body: "Private comment", created_at: 101 } })) as Record<string, unknown>,
      JSON.parse(buildFeedbackStatusEvent({ ...eventBase, eventType: "feedback:status_changed", previousStatus: "open", status: "resolved" })) as Record<string, unknown>,
    ];
    for (const [index, event] of events.entries()) {
      const response = await request(event, `delivery-${index}`);
      expect(response.status).toBe(200);
    }
    expect(sent.map((item) => item.target)).toEqual(["#releases", "#releases:parent-m", "#releases:parent-m"]);
    expect(sent[0]!.content).toContain("App: Sample App (app-1)");
    expect(sent[1]!.content).not.toContain("Private comment");
    expect(sent[2]!.content).toContain("previous status: open");
    expect(sent[2]!.content).toContain("status: resolved");
    expect(sqlite.prepare("SELECT COUNT(*) FROM raft_notification_threads WHERE subscription_id = ?").pluck().get(SUBSCRIPTION_ID)).toBe(1);
  });

  it("reuses a previously created comment-only thread for the ticket", async () => {
    const { request, sqlite } = await harness();
    sqlite.prepare("UPDATE raft_notification_subscriptions SET events_json = ? WHERE id = ?").run(JSON.stringify(["feedback:status_changed"]), SUBSCRIPTION_ID);
    sqlite.prepare("INSERT INTO raft_notification_threads VALUES (?, ?, ?, ?, ?)").run(SUBSCRIPTION_ID, `feedback:comment_created:${TICKET_ID}`, "old-parent-123", 1, 1);
    const targets: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      targets.push((JSON.parse(String(init?.body)) as { target: string }).target);
      return Response.json({ state: "sent", messageId: "reply-1" });
    });
    expect((await request(feedbackBody("feedback:status_changed"), "status")).status).toBe(200);
    expect(targets).toEqual(["#releases:old-pare"]);
  });

  it("waits for a fresh legacy thread claim instead of creating a duplicate parent", async () => {
    const { request, sqlite } = await harness();
    sqlite.prepare("UPDATE raft_notification_subscriptions SET events_json = ? WHERE id = ?").run(JSON.stringify(["feedback:status_changed"]), SUBSCRIPTION_ID);
    sqlite.prepare("INSERT INTO raft_notification_threads VALUES (?, ?, ?, ?, ?)").run(SUBSCRIPTION_ID, `feedback:comment_created:${TICKET_ID}`, "pending", Date.now(), Date.now());
    const fetchMock = vi.spyOn(globalThis, "fetch");
    expect((await request(feedbackBody("feedback:status_changed"), "status")).status).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("creates a fresh canonical thread when the old claim has expired", async () => {
    const { request, sqlite } = await harness();
    sqlite.prepare("UPDATE raft_notification_subscriptions SET events_json = ? WHERE id = ?").run(JSON.stringify(["feedback:status_changed"]), SUBSCRIPTION_ID);
    sqlite.prepare("INSERT INTO raft_notification_threads VALUES (?, ?, ?, ?, ?)").run(SUBSCRIPTION_ID, `feedback:comment_created:${TICKET_ID}`, "pending", 1, 1);
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ state: "sent", messageId: "new-parent-1" }));
    expect((await request(feedbackBody("feedback:status_changed"), "status")).status).toBe(200);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(sqlite.prepare("SELECT parent_message_id FROM raft_notification_threads WHERE subscription_id = ? AND object_key = ?").pluck().get(SUBSCRIPTION_ID, `feedback:new:${TICKET_ID}`)).toBe("new-parent-1");
  });
});
