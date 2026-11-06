import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { encryptP8 } from "../src/lib/asc_credentials";
import { buildFeedbackCommentEvent, buildFeedbackStatusEvent } from "../src/lib/feedback_events";
import { formatRaftNotificationCard } from "../src/lib/raft_notification_card";
import { formatRaftNotificationMessage } from "../src/lib/raft_notification_content";
import { appGalleryCardObjectKey, isReleaseChannelEvent, notificationObjectKey, sha256Hex } from "../src/lib/raft_notification_identity";
import {
  handleConnectRaftBot,
  handleGetRaftNotifications,
  handleListRaftNotificationFailures,
  handleRaftNotificationWebhook,
  handleRetryRaftNotificationFailure,
  handleTestRaftNotification,
  handleUpdateRaftNotification,
} from "../src/routes/raft_notifications";
import { handleDeleteAppWebhook, handleUpdateAppWebhook, hmacSha256Hex, reapWebhookDeliveries, WEBHOOK_EVENT_TYPES } from "../src/routes/webhooks";

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
        _run: () => {
          const result = statement.run(...expanded);
          return { success: true, meta: { changes: result.changes } };
        },
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
  const batch = async (statements: Array<{ _run: () => unknown }>) =>
    sqlite.transaction(() => statements.map((statement) => statement._run()))();
  return { prepare, batch } as unknown as D1Database;
}

const APP_ID = "abad63e9-e760-42e9-92df-f418735f32ea";
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
    CREATE TABLE webhook_deliveries (
      id TEXT PRIMARY KEY, webhook_id TEXT NOT NULL, event_type TEXT NOT NULL, payload_json TEXT NOT NULL,
      signing_secret TEXT, external_event_id TEXT, event_id TEXT, feedback_submission_event_id TEXT,
      status TEXT NOT NULL, attempts INTEGER NOT NULL, max_attempts INTEGER NOT NULL,
      last_attempt_at INTEGER, next_attempt_at INTEGER, last_response_status INTEGER, last_response_body TEXT,
      last_error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, completed_at INTEGER
    );
    CREATE TABLE audit_logs (
      id TEXT PRIMARY KEY, app_id TEXT NOT NULL, action TEXT NOT NULL, actor TEXT NOT NULL,
      actor_id TEXT, actor_type TEXT, payload TEXT NOT NULL, created_at INTEGER NOT NULL
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
    DASHBOARD_ORIGIN: "https://hands.test",
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
  app.get("/api/apps/:appId/raft-notifications/:subscriptionId/failures", handleListRaftNotificationFailures);
  app.post("/api/apps/:appId/raft-notifications/:subscriptionId/failures/:deliveryId/retry", handleRetryRaftNotificationFailure);
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
  const failures = (appId = APP_ID) => app.fetch(new Request(`https://hands.test/api/apps/${appId}/raft-notifications/${SUBSCRIPTION_ID}/failures`), env);
  const retryFailure = (id: string, appId = APP_ID) => app.fetch(new Request(`https://hands.test/api/apps/${appId}/raft-notifications/${SUBSCRIPTION_ID}/failures/${id}/retry`, { method: "POST" }), env);
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
  return { sqlite, env, app, request, getConfig, updateConfig, testDestination, failures, retryFailure, connect, mutateHiddenWebhook };
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
const playFailureBody = (receiptId: string) => ({
  event: "google_play:submission_failed", delivered_at: 100,
  payload: { receipt_id: receiptId, release_id: "release-1", version: "1.20.0", version_code: 12000003,
    track: "production", state: "SUBMISSION_FAILED", reason: "play_api_error",
    play_failure_cause: "EDIT_IN_REVIEW", play_failure_cause_source: "structured",
    play_failure_reason: "CHANGES_ALREADY_IN_REVIEW", occurred_at: "2026-11-05T12:35:08.416Z" },
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
  it("sends each Play failure receipt as a separate channel card and deduplicates its replay", async () => {
    const { request, sqlite, updateConfig } = await harness();
    await updateConfig({ events: ["google_play:submission_failed"] });
    await updateConfig({ card_updates: true });
    const calls: Array<Record<string, unknown>> = [];
    mockRaftFetch(async (_input, init) => {
      calls.push(JSON.parse(String(init?.body)));
      return Response.json({ state: "sent", messageId: `card-${calls.length}` });
    });
    const first = playFailureBody("11111111-1111-4111-8111-111111111111");
    const second = playFailureBody("22222222-2222-4222-8222-222222222222");
    expect((await request(first, "a")).status).toBe(200);
    expect((await request(first, "a-retry")).status).toBe(200);
    expect((await request(second, "b")).status).toBe(200);
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call).toMatchObject({ target: "#releases", card: { version: 1 },
        content: expect.stringContaining("Google Play has changes in review") });
      expect(call.content).toContain("[Open Play Console](https://play.google.com/console/)");
      expect(JSON.stringify(call.card)).toContain("CHANGES_ALREADY_IN_REVIEW");
    }
    expect(sqlite.prepare("SELECT COUNT(*) FROM raft_notification_cards").pluck().get()).toBe(2);
  });

  it("keeps a failure without a valid receipt ID on text", async () => {
    const { request, updateConfig } = await harness();
    await updateConfig({ events: ["google_play:submission_failed"] });
    await updateConfig({ card_updates: true });
    const calls: Array<Record<string, unknown>> = [];
    mockRaftFetch(async (_input, init) => {
      calls.push(JSON.parse(String(init?.body)));
      return Response.json({ state: "sent", messageId: "text-1" });
    });
    expect((await request(playFailureBody("invalid"), "a")).status).toBe(200);
    expect(calls[0]).not.toHaveProperty("card");
    expect(calls[0]).toMatchObject({ content: expect.stringContaining("Google Play has changes in review") });
  });

  it("replays a failure card whose send response was lost without posting it again", async () => {
    const { request, sqlite, updateConfig } = await harness();
    await updateConfig({ events: ["google_play:submission_failed"] });
    await updateConfig({ card_updates: true });
    const calls: Array<Record<string, unknown>> = [];
    mockRaftFetch(async (_input, init) => {
      const sent = JSON.parse(String(init?.body)) as Record<string, unknown>;
      calls.push(sent);
      if (calls.length === 1 && sent.card) throw new Error("card committed, response lost");
      if (sent.card && JSON.stringify(sent) === JSON.stringify(calls[0])) return Response.json({ state: "committed", messageId: "card-1", messageCard: { revision: 1 } });
      throw new Error("unexpected extra send");
    });
    const event = playFailureBody("11111111-1111-4111-8111-111111111111");
    expect((await request(event, "first")).status).toBe(503);
    sqlite.prepare("UPDATE raft_notification_threads SET updated_at=1").run();
    const retry = await request(event, "retry");
    expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({ message_id: "card-1", card: true });
    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual(calls[0]);
  });

  it("uses the original failure-card key when cards are disabled during an uncertain send", async () => {
    const { request, sqlite, updateConfig } = await harness();
    await updateConfig({ events: ["google_play:submission_failed"] });
    await updateConfig({ card_updates: true });
    const calls: Array<Record<string, unknown>> = [];
    mockRaftFetch(async (_input, init) => {
      const sent = JSON.parse(String(init?.body)) as Record<string, unknown>;
      calls.push(sent);
      if (sent.card) throw new Error("response lost");
      return Response.json({ state: "sent", messageId: "text-1" });
    });
    const event = playFailureBody("11111111-1111-4111-8111-111111111111");
    expect((await request(event, "first")).status).toBe(503);
    expect((await updateConfig({ card_updates: false })).status).toBe(200);
    sqlite.prepare("UPDATE raft_notification_threads SET updated_at=1").run();
    const retry = await request(event, "retry");
    expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({ message_id: "text-1", card: false });
    expect(calls[1]).toMatchObject({ idempotencyKey: calls[0]?.idempotencyKey,
      target: "#releases", content: expect.stringContaining("Google Play has changes in review") });
    expect(calls[1]).not.toHaveProperty("card");
    expect(String(calls[1]?.content)).not.toContain("card may be out of date");
    expect((await request(event, "third")).status).toBe(200);
    expect(calls).toHaveLength(2);
  });

  it("recognizes a legacy channel text that won the same event key without sending a duplicate", async () => {
    const { request, sqlite, updateConfig } = await harness();
    await updateConfig({ events: ["google_play:submission_failed"] });
    await updateConfig({ card_updates: true });
    sqlite.prepare("INSERT INTO raft_notification_threads VALUES (?,?,?,?,?)")
      .run(SUBSCRIPTION_ID, "google_play:submission_failed:release-1", "old-parent", 1, 1);
    const calls: Array<Record<string, unknown>> = [];
    mockRaftFetch(async (_input, init) => {
      const sent = JSON.parse(String(init?.body)) as Record<string, unknown>;
      calls.push(sent);
      if (!sent.card && sent.target === "#releases" && !String(sent.content).includes("Google Play has changes in review")) {
        return Response.json({ state: "committed", messageId: "legacy-message" });
      }
      return Response.json({ code: "idempotency_key_reused" }, { status: 409 });
    });
    const event = playFailureBody("11111111-1111-4111-8111-111111111111");
    const result = await request(event, "a");
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({ message_id: "legacy-message", card: false });
    expect(calls.every((c) => c.idempotencyKey === calls[0]?.idempotencyKey)).toBe(true);
    const attempts = calls.length;
    expect((await request(event, "retry")).status).toBe(200);
    expect(calls).toHaveLength(attempts);
  });

  it.each(["#releases", "#releases:old-pare"])(
    "reconciles a previously sent Play failure without the new link at %s",
    async (oldTarget) => {
      const { request, sqlite, updateConfig } = await harness();
      await updateConfig({ events: ["google_play:submission_failed"] });
      await updateConfig({ card_updates: true });
      sqlite.prepare("INSERT INTO raft_notification_threads VALUES (?,?,?,?,?)")
        .run(SUBSCRIPTION_ID, "google_play:submission_failed:release-1", "old-parent-message", 1, 1);
      const event = playFailureBody("11111111-1111-4111-8111-111111111111");
      const oldContent = formatRaftNotificationMessage(event, { id: APP_ID, slug: "sample-app", name: "Sample App" });
      const calls: Array<Record<string, unknown>> = [];
      mockRaftFetch(async (_input, init) => {
        const sent = JSON.parse(String(init?.body)) as Record<string, unknown>;
        calls.push(sent);
        if (sent.target === oldTarget && !sent.card && sent.content === oldContent) {
          return Response.json({ state: "committed", messageId: "old-message" });
        }
        if (String(sent.idempotencyKey).startsWith("hands-raft-channel:")) {
          return Response.json({ state: "sent", messageId: "channel-copy" });
        }
        return Response.json({ code: "idempotency_key_reused" }, { status: 409 });
      });
      const result = await request(event, "a");
      expect(result.status).toBe(200);
      expect(await result.json()).toMatchObject({ message_id: oldTarget === "#releases" ? "old-message" : "channel-copy", card: false });
      expect(calls.some((sent) => sent.target === oldTarget && sent.content === oldContent)).toBe(true);
      const copies = calls.filter((sent) => String(sent.idempotencyKey).startsWith("hands-raft-channel:"));
      expect(copies).toHaveLength(oldTarget === "#releases" ? 0 : 1);
      if (copies.length) expect(copies[0]?.content).toContain("[Open Play Console](https://play.google.com/console/)");
      const attempts = calls.length;
      expect((await request(event, "retry")).status).toBe(200);
      expect(calls).toHaveLength(attempts);
    },
  );

  it("proves a legacy threaded text before sending one enriched channel copy", async () => {
    const { request, sqlite, updateConfig } = await harness();
    await updateConfig({ events: ["google_play:submission_failed"] });
    await updateConfig({ card_updates: true });
    sqlite.prepare("INSERT INTO raft_notification_threads VALUES (?,?,?,?,?)")
      .run(SUBSCRIPTION_ID, "google_play:submission_failed:release-1", "old-parent-message", 1, 1);
    const calls: Array<Record<string, unknown>> = [];
    mockRaftFetch(async (_input, init) => {
      const sent = JSON.parse(String(init?.body)) as Record<string, unknown>;
      calls.push(sent);
      if (sent.target === "#releases:old-pare" && !sent.card
          && !String(sent.content).includes("Google Play has changes in review")) {
        return Response.json({ state: "committed", messageId: "legacy-thread-message" });
      }
      if (String(sent.idempotencyKey).startsWith("hands-raft-channel:")) {
        return Response.json({ state: "sent", messageId: "channel-copy" });
      }
      return Response.json({ code: "idempotency_key_reused" }, { status: 409 });
    });
    const event = playFailureBody("11111111-1111-4111-8111-111111111111");
    const result = await request(event, "a");
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({ message_id: "channel-copy", card: false });
    const copies = calls.filter((c) => String(c.idempotencyKey).startsWith("hands-raft-channel:"));
    expect(copies).toHaveLength(1);
    expect(copies[0]).toMatchObject({ target: "#releases", content: expect.stringContaining("Google Play has changes in review") });
    expect((await request(event, "retry")).status).toBe(200);
    expect(calls.filter((c) => String(c.idempotencyKey).startsWith("hands-raft-channel:"))).toHaveLength(1);
  });

  it("does not use a new channel key if a legacy failure cannot be proven", async () => {
    const { request, sqlite, updateConfig } = await harness();
    await updateConfig({ events: ["google_play:submission_failed"] });
    await updateConfig({ card_updates: true });
    sqlite.prepare("INSERT INTO raft_notification_threads VALUES (?,?,?,?,?)")
      .run(SUBSCRIPTION_ID, "google_play:submission_failed:release-1", "old-parent-message", 1, 1);
    const calls: Array<Record<string, unknown>> = [];
    mockRaftFetch(async (_input, init) => {
      calls.push(JSON.parse(String(init?.body)));
      return Response.json({ code: "idempotency_key_reused" }, { status: 409 });
    });
    expect((await request(playFailureBody("11111111-1111-4111-8111-111111111111"), "a")).status).toBe(503);
    expect(calls.length).toBeGreaterThan(1);
    expect(calls.every((call) => call.idempotencyKey === calls[0]?.idempotencyKey)).toBe(true);
  });

  it("replays a lost response for the proven legacy thread's channel copy using the same key and body", async () => {
    const { request, sqlite, updateConfig } = await harness();
    await updateConfig({ events: ["google_play:submission_failed"] });
    await updateConfig({ card_updates: true });
    sqlite.prepare("INSERT INTO raft_notification_threads VALUES (?,?,?,?,?)")
      .run(SUBSCRIPTION_ID, "google_play:submission_failed:release-1", "old-parent-message", 1, 1);
    const copies: Array<Record<string, unknown>> = [];
    mockRaftFetch(async (_input, init) => {
      const sent = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (sent.reconcileOnly) return Response.json({ state: "not_found" });
      if (sent.target === "#releases:old-pare" && !sent.card
          && !String(sent.content).includes("Google Play has changes in review")) {
        return Response.json({ state: "committed", messageId: "legacy-thread-message" });
      }
      if (String(sent.idempotencyKey).startsWith("hands-raft-channel:")) {
        copies.push(sent);
        if (copies.length === 1) throw new Error("channel copy committed, response lost");
        return Response.json({ state: "committed", messageId: "channel-copy" });
      }
      return Response.json({ code: "idempotency_key_reused" }, { status: 409 });
    });
    const event = playFailureBody("11111111-1111-4111-8111-111111111111");
    expect((await request(event, "first")).status).toBe(503);
    sqlite.prepare("UPDATE raft_notification_threads SET updated_at=1 WHERE object_key LIKE '%:receipt:%'").run();
    const retry = await request(event, "retry");
    expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({ message_id: "channel-copy", card: false });
    expect(copies).toHaveLength(2);
    expect(copies[1]).toEqual(copies[0]);
  });
  it("renders a safe review card and omits provider prose", () => {
    const message = formatRaftNotificationMessage(body("REJECTED"));
    expect(message).toContain("App Store · Review rejected");
    expect(message).toContain("1.17.0");
    expect(message).toContain("App Store Connect");
    expect(message).not.toContain("provider prose must never be forwarded");
  });

  it("uses a stable object key for later state changes", async () => {
    expect(await notificationObjectKey(body("IN_REVIEW"))).toBe(
      await notificationObjectKey(body("REJECTED")),
    );
  });

  it("gives AppGallery submissions and packages distinct card identities even when they share a build", () => {
    const make = (event: string, id: string) => ({ event, payload: {
      build_id: "same-build", ...(event === "appgallery:invitation_state_changed" ? { submission_id: id } : { package_id: id }),
    } });
    expect(appGalleryCardObjectKey(make("appgallery:invitation_state_changed", "submission-a")))
      .not.toBe(appGalleryCardObjectKey(make("appgallery:invitation_state_changed", "submission-b")));
    expect(appGalleryCardObjectKey(make("appgallery:package_state_changed", "package-a")))
      .not.toBe(appGalleryCardObjectKey(make("appgallery:package_state_changed", "package-b")));
    expect(appGalleryCardObjectKey(make("appgallery:package_state_changed", "x".repeat(161)))).toBeNull();
  });

  it("adds clear icons to feedback events and the details command", () => {
    for (const [event, heading] of [
      ["feedback:new", "📮 **New feedback report · sample-app**"],
      ["feedback:comment_created", "💬 **New comment · sample-app**"],
      ["feedback:status_changed", "🔄 **Feedback status changed · sample-app**"],
    ] as const) {
      const message = formatRaftNotificationMessage(feedbackBody(event, { app_slug: "sample-app" }));
      expect(message.startsWith(heading)).toBe(true);
      expect(message).toContain(`📖 View more: \`hands feedback show sample-app ${TICKET_ID}\``);
    }
    expect(formatRaftNotificationMessage(body("REJECTED")).startsWith("🍎 **Raft App · App Store · Review rejected**")).toBe(true);
  });

  it("keeps release context and identifies a first Play observation", () => {
    const message = formatRaftNotificationMessage({
      event: "google_play:release_state_changed", app_id: "abad63e9-e760-42e9-92df-f418735f32ea",
      payload: {
        package_name: "build.example.app", track: "alpha", version_code: 11800003,
        state: "RELEASE_LIFECYCLE_STATE_PUBLISHED", state_label: "Track available", observation: "initial_snapshot",
        rollout_percent: 20,
      },
    });
    expect(message).toContain("Google Play · Available on track (may be partially rolled out or paused)");
    expect(message).toContain("First observation; this may not be a recent change.");
    expect(message).toContain("track: alpha");
    expect(message).toContain("Reported rollout: 20%");
    const release = formatRaftNotificationMessage({
      event: "release:published", payload: { rollout: 100, version_transition: "1.0 → 1.1", version_code_transition: "1 → 2" },
    });
    expect(release).toContain("🚀 **Release published**");
    expect(release).toContain("Version change: 1.0 → 1.1");
    expect(release).toContain("Build change: 1 → 2");
    expect(release).toContain("Rollout: 100%");
  });

  it("distinguishes Play promotion, saved edits, review requests and symbol uploads", () => {
    const make = (event: string, extra: Record<string, unknown> = {}) => formatRaftNotificationMessage({
      event, payload: { app: { name: "Raft Android" }, version: "1.19.0", version_code: 11900002, ...extra },
    });
    const submitted = make("google_play:submission_succeeded", { track: "production", rollout_percent: 20 });
    expect(submitted).toContain("Google Play · Release submitted");
    expect(submitted).toContain("Review status is not yet confirmed");
    expect(submitted).toContain("1.19.0 · version code 11900002 · track: production");
    expect(submitted).toContain("Requested rollout: 20%");
    const distinct = make("google_play:submission_succeeded", { build_number: "ci-12", version_code: 11900002 });
    expect(distinct).toContain("version code 11900002");
    expect(distinct).toContain("Build: ci-12");
    const saved = make("google_play:submission_succeeded", { action: "promote", review_requested: false });
    expect(saved).toContain("Release saved; not sent for review");
    expect(saved).not.toContain("Review status is not yet confirmed");
    const request = make("google_play:submission_succeeded", { action: "send-for-review", review_requested: true });
    expect(request).toContain("Review request sent");
    expect(request).toContain("Review status is not yet confirmed");
    const symbols = make("google_play:submission_succeeded", { action: "upload-symbols" });
    expect(symbols).toContain("Symbols uploaded");
    expect(symbols).not.toContain("Release submitted");
    expect(symbols).not.toContain("Review status is not yet confirmed");
    const failedSymbols = make("google_play:submission_failed", { action: "upload-symbols", reason: "play_api_rejected" });
    expect(failedSymbols).toContain("Symbols upload failed or was blocked");
    expect(failedSymbols).toContain("Reason code: play\\_api\\_rejected");
    expect(failedSymbols).not.toContain("Release submission failed");
  });

  it("renders known review states without overstating Play availability or TestFlight invitations", () => {
    const play = formatRaftNotificationMessage({ event: "google_play:release_state_changed", payload: {
      app: { name: "Raft Android" }, state: "RELEASE_LIFECYCLE_STATE_PUBLISHED",
      previous_state: "RELEASE_LIFECYCLE_STATE_IN_REVIEW", observation: "transition", track: "production",
    } });
    expect(play).toContain("Available on track (may be partially rolled out or paused)");
    expect(play).toContain("Previously: In review");
    expect(play).not.toContain("First observation");
    const notSent = formatRaftNotificationMessage({ event: "google_play:release_state_changed", payload: {
      state: "RELEASE_LIFECYCLE_STATE_NOT_SENT_FOR_REVIEW",
    } });
    expect(notSent).toContain("Google Play · Not sent for review");
    expect(notSent).not.toContain("Ready to submit");
    const testflight = formatRaftNotificationMessage({ event: "testflight:external_state_changed", payload: {
      app: { name: "Raft App" }, state: "READY_FOR_BETA_TESTING", build: { version: "1.19.1", version_code: "11901002" },
      groups_display: "测试组：Botiverse（内部）、Insiders（外部）",
    } });
    expect(testflight).toContain("TestFlight · Ready for beta testing");
    expect(testflight).toContain("1.19.1 · build 11901002");
    expect(testflight).toContain("Test groups: Botiverse（内部）、Insiders（外部）");
    expect(testflight).not.toContain("invited");
    const unknown = formatRaftNotificationMessage({ event: "testflight:external_state_changed", payload: { state: "A_NEW_APPLE_STATE" } });
    expect(unknown).toContain("TestFlight · Status changed");
    expect(unknown).toContain("Status: A\\_NEW\\_APPLE\\_STATE");
  });

  it("distinguishes an AppGallery market package from invitation-test review", () => {
    const market = formatRaftNotificationMessage({ event: "appgallery:package_state_changed", payload: {
      state: "ready", previous_state: "processing", observation_display: "定时查询观测（不是正式上架审核结果）",
    } });
    expect(market).toContain("Market package processed");
    expect(market).not.toContain("not submitted for review");
    expect(market).toContain("Observed by polling; this is not an app-store review result.");
    const withdrawn = formatRaftNotificationMessage({ event: "appgallery:invitation_state_changed", payload: {
      state: "ready", previous_state: "testing_review", state_label: "开发者撤回邀请测试审核",
    } });
    expect(withdrawn).toContain("Invitation test review withdrawn by developer");
    expect(withdrawn).not.toContain("Ready to submit for invitation testing");
  });

  it("does not imply a canary replaced a release and names the restored version on rollback", () => {
    const base = { app: { name: "Desktop" }, channel: "main", version: "2.0", version_code: 200, rollout: 20 };
    const canary = formatRaftNotificationMessage({ event: "release:published", payload: { ...base, previous_version: null } });
    expect(canary).toContain("Desktop · Release published");
    expect(canary).toContain("2.0 (200) · channel: main");
    expect(canary).toContain("Rollout: 20%");
    expect(canary).not.toContain("Replaced:");
    const rollback = formatRaftNotificationMessage({ event: "release:rolled_back", payload: {
      ...base, version: "1.9", version_code: 190, previous_version: "2.0", previous_version_code: 200, rollout: 100,
    } });
    expect(rollback).toContain("Restored: 1.9 (190) · channel: main");
    expect(rollback).toContain("Replaced: 2.0 (200)");
    const empty = formatRaftNotificationMessage({ event: "release:channel_emptied", payload: base });
    expect(empty).toContain("no active release");
    expect(empty).toContain("Cancelled: 2.0 (200) · channel: main");
  });

  it("uses common safe fields for events without a custom presentation", () => {
    const message = formatRaftNotificationMessage({
      event: "release:future_event",
      payload: { version: "1.2.3", rollout: 25, state: "draft", message: "private text" },
    });
    expect(message.startsWith("**Hands · release:future_event**")).toBe(true);
    expect(message).toContain("version: 1.2.3");
    expect(message).toContain("rollout: 25%");
    expect(message).not.toContain("private text");
    expect(formatRaftNotificationMessage({ event: "release", payload: { rollout: 25 } })).not.toContain("rollout:");
  });

  it("shows bounded, safe TestFlight notes and group context only for TestFlight", () => {
    const payload = {
      groups_display: "测试组：Botiverse",
      what_to_test: { "zh-Hans": `Check @admin #release https://example.test/private ${"x".repeat(1200)}` },
      source: "hands_operation_receipt",
      source_commit: "a1b2c3d4",
    };
    const message = formatRaftNotificationMessage({ event: "testflight:internal_distribution_ready", payload });
    expect(message.startsWith("✈️ **TestFlight · Ready for internal testing**")).toBe(true);
    expect(message).toContain("Test groups: Botiverse");
    expect(message).toContain("What to test:\n```text\n  Check @\u200badmin #\u200brelease [link]");
    expect(message).toContain("Commit: a1b2c3d4");
    expect(message).not.toContain("hands_operation_receipt");
    expect(payload.source).toBe("hands_operation_receipt");
    expect(message).toContain("…");
    expect(message).not.toContain("https://example.test");
    expect(formatRaftNotificationMessage({ event: "release:published", payload })).not.toContain("Test notes");
  });

  it("renders a descriptive heading for every supported webhook event", () => {
    for (const event of WEBHOOK_EVENT_TYPES) {
      const message = formatRaftNotificationMessage({ event, payload: { kind: "feedback" } });
      expect(message.split("\n")[0], event).not.toContain(event);
      expect(message.split("\n")[0], event).toMatch(/\*\*.+\*\*/);
    }
  });

  it("combines state transitions and avoids repeating identical build values", () => {
    const message = formatRaftNotificationMessage({
      event: "app_store:build_upload_state_changed", app_id: "app-id",
      payload: { app: { name: "Raft App" }, state: "COMPLETE", previous_state: "PROCESSING",
        version: "1.19.2", version_name: "1.19.2", build_number: "11902002", version_code: 11902002 },
    });
    expect(message).toContain("📦 **Raft App · App Store · Upload processed**\n1.19.2 · build 11902002\nPreviously: Processing upload");
    expect(message).not.toContain("app-id");
    expect(message).not.toContain("previous state:");
    expect(message).not.toContain("version name:");
    expect(message).not.toContain("version code:");
    const distinct = formatRaftNotificationMessage({ event: "build:succeeded", payload: {
      version: "1.0", version_name: "1.0-beta", build_number: "12", version_code: 13,
    } });
    expect(distinct).toContain("1.0 (12)");
    expect(distinct).toContain("Version name: 1.0-beta");
    expect(distinct).toContain("Version code: 13");
  });

  it("makes crash spikes actionable without including crash content", () => {
    const message = formatRaftNotificationMessage({
      event: "crash:spike", app_id: "abad63e9-e760-42e9-92df-f418735f32ea",
      payload: { app_slug: "sample-app", ticket_id: TICKET_ID, count_last_hour: 50,
        version_name: "1.19.2", message: "PRIVATE STACK", signature: "PRIVATE SIGNATURE" },
    });
    expect(message).toContain("📈 **sample-app · Crash spike**");
    expect(message).toContain("50 reports in the last hour");
    expect(message).toContain(`hands feedback show sample-app ${TICKET_ID}`);
    expect(message.match(new RegExp(TICKET_ID, "g"))).toHaveLength(1);
    expect(message).not.toContain("PRIVATE STACK");
    expect(message).not.toContain("PRIVATE SIGNATURE");
  });

  it("does not show internal event source metadata in release notifications", () => {
    for (const [event, source] of [
      ["testflight:upload_processing", "hands_operation_receipt"],
      ["google_play:release_state_changed", "google_play_release_lifecycle"],
      ["appgallery:package_state_changed", "hands_appgallery_market_package"],
    ] as const) {
      const payload = { source, state: "READY", version: "1.19.2", build: { source: "build-source" } };
      const message = formatRaftNotificationMessage({ event, payload });
      expect(message).toContain("Status: READY");
      expect(message).toContain("1.19.2");
      expect(message).not.toContain("\nsource:");
      expect(message).not.toContain(source);
      expect(message).not.toContain("build-source");
      expect(payload.source).toBe(source);
    }
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
    expect(message).toContain("📮 **New feedback · sample-app**\nFeedback: Hello ");
    expect(message).not.toContain("abad63e9-e760-42e9-92df-f418735f32ea");
    expect(message.match(new RegExp(TICKET_ID, "g"))).toHaveLength(1);
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
    expect(feedback).toContain("📮 **New bug report · sample-app**\nFeedback: Hi @\u200badmin #\u200brelease");
    expect(feedback).toContain("\\[link\\]");
  });

  it("renders compact comment and status notifications with a safe details link", () => {
    const known = { id: APP_ID, name: "Sample App", slug: "sample-app", dashboardOrigin: "https://hands.test" };
    const report = formatRaftNotificationMessage(feedbackBody("feedback:new", { kind: "bug", message: "Cannot save" }), known);
    expect(report).toContain(`📮 **New bug report · Sample App** · [View feedback](https://hands.test/apps/${APP_ID}/feedback/${TICKET_ID})`);
    expect(report).toContain("Cannot save");
    const fieldLike = formatRaftNotificationMessage(feedbackBody("feedback:new", { kind: "bug", message: "Status: resolved", status: "open" }), known);
    expect(fieldLike).toContain("Feedback: Status: resolved\nStatus: open");
    expect(report).not.toContain("hands feedback show");
    const comment = formatRaftNotificationMessage(feedbackBody("feedback:comment_created", {
      comment: { body: "PRIVATE COMMENT" },
    }), known);
    expect(comment).toContain(`💬 **New comment · Sample App** · [View feedback](https://hands.test/apps/${APP_ID}/feedback/${TICKET_ID})`);
    expect(comment).not.toContain("hands feedback show");
    expect(comment).not.toContain("PRIVATE COMMENT");
    const status = formatRaftNotificationMessage(feedbackBody("feedback:status_changed", {
      previous_status: "open", status: "resolved",
    }), known);
    expect(status).toContain("Status: open → resolved");
    expect(status).toContain(`[View feedback](https://hands.test/apps/${APP_ID}/feedback/${TICKET_ID})`);
    for (const badOrigin of ["https://hands.test/path", "https://user:password@hands.test", "javascript:alert(1)"]) {
      const fallback = formatRaftNotificationMessage(feedbackBody("feedback:comment_created"), { ...known, dashboardOrigin: badOrigin });
      expect(fallback).not.toContain("[View feedback]");
      expect(fallback).toContain(`hands feedback show sample-app ${TICKET_ID}`);
    }
    const alert = formatRaftNotificationMessage({ event: "crash:spike", app_id: APP_ID, payload: {
      ticket_id: TICKET_ID, count_last_hour: 50, message: "PRIVATE STACK",
    } }, known);
    expect(alert).toContain("📈 **Sample App · Crash spike** · [View feedback]");
    expect(alert).toContain("50 reports in the last hour");
    expect(alert).not.toContain("PRIVATE STACK");
  });

  it("keeps test-note line breaks without creating mentions, links or fake footer lines", () => {
    const message = formatRaftNotificationMessage({
      event: "testflight:internal_distribution_ready", delivered_at: 100,
      payload: { what_to_test: { "zh-Hans": "First check\noccurred: not a timestamp\n```\n@admin https://example.test/secret" } },
    });
    expect(message).toContain("What to test:\n```text\n  First check\n  occurred: not a timestamp\n  `\u200b`\u200b`\u200b\n  @\u200badmin [link]\n```");
    expect(message.match(/^```/gm)).toHaveLength(2);
    expect(message).not.toContain("https://example.test/secret");
    expect(message).toContain("\nAt: 1970-01-01 00:00:00.100 UTC");
  });

  it("closes the test-note code block and retains the link and time when the message is clipped", () => {
    const long = "🧪".repeat(600);
    const message = formatRaftNotificationMessage({ event: "testflight:external_state_changed", delivered_at: 100,
      payload: { app: { name: long }, state: "A_NEW_STATE", previous_state: long, version: long,
        build_number: long, groups_display: long, what_to_test: { en: long + long },
        app_store_connect_url: "https://appstoreconnect.apple.com/apps/123" },
    });
    expect(message.length).toBeLessThanOrEqual(4000);
    expect(message).toContain("What to test:\n```text");
    expect(message.match(/^```/gm)).toHaveLength(2);
    expect(message).toContain("[Open App Store Connect](https://appstoreconnect.apple.com/apps/123)");
    expect(message).toContain("At: 1970-01-01 00:00:00.100 UTC");
  });

  it("combines feedback identity, version, and status without repeating identifiers", () => {
    const report = formatRaftNotificationMessage(feedbackBody("feedback:new", {
      app_slug: "sample-app", kind: "bug", message: "Cannot save", version_name: "1.19.2", version_code: 11902002,
    }));
    expect(report).toContain("📮 **New bug report · sample-app**\nFeedback: Cannot save\nVersion: 1.19.2 (11902002)");
    expect(report).not.toContain("kind:");
    expect(report).not.toContain("ticket:");
    expect(report.match(new RegExp(TICKET_ID, "g"))).toHaveLength(1);
    const status = formatRaftNotificationMessage(feedbackBody("feedback:status_changed", {
      app_slug: "sample-app", previous_status: "open", status: "resolved",
    }));
    expect(status).toContain("🔄 **Feedback status changed · sample-app**\nStatus: open → resolved");
    expect(status).not.toContain("previous status:");
    const fallback = formatRaftNotificationMessage({ event: "feedback:new", payload: { ticket_id: "bad;echo", kind: "crash" } });
    expect(fallback).toContain("📮 **New crash report**");
    expect(fallback).toContain("ticket: bad;echo");
    expect(fallback).not.toContain("hands feedback show");
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
    expect(message).toContain("Observation: First observation, not a new change");
    expect(message).toContain("[Open App Store Connect](https://appstoreconnect.apple.com/apps/123)");
    expect(message).toContain("Review details are available in App Store Connect.");
    expect(message).toContain("At: 2026-11-01 18:09:52.575 UTC");
  });

  it("shows a delivered-at millisecond timestamp as readable UTC and preserves provider timestamps", () => {
    const feedback = formatRaftNotificationMessage({ ...feedbackBody("feedback:new"), delivered_at: 1793556592575 });
    expect(feedback).toContain("At: 2026-11-01 18:09:52.575 UTC");
    const provider = formatRaftNotificationMessage({ ...body("REJECTED"), payload: { ...body("REJECTED").payload, occurred_at: "2026-11-01T17:00:00Z" } });
    expect(provider).toContain("At: 2026-11-01 17:00:00 UTC");
    expect(provider.match(/At:/g)).toHaveLength(1);
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

  it("sends each release status as a channel message in text mode", async () => {
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
    expect(sentTargets).toEqual(["#releases", "#releases"]);
    expect(await second.json()).toMatchObject({ threaded: false });
    expect(sqlite.prepare("SELECT parent_message_id FROM raft_notification_threads WHERE subscription_id = ? AND object_key LIKE 'app_store:%'").get(SUBSCRIPTION_ID)).toMatchObject({ parent_message_id: "parent-message-1" });
  });

  it("routes release families to the channel without changing feedback and crash grouping", () => {
    for (const event of ["release:published", "release:rolled_back", "build:failed",
      "app_store:version_state_changed", "app_store:build_upload_state_changed",
      "testflight:upload_processing", "testflight:internal_distribution_ready", "testflight:external_state_changed",
      "google_play:release_state_changed", "google_play:submission_failed", "appgallery:package_state_changed"]) {
      expect(isReleaseChannelEvent(event), event).toBe(true);
    }
    for (const event of ["feedback:new", "feedback:comment_created", "feedback:status_changed",
      "crash:new_group", "testflight:crash_submission_created", "error:spike"]) {
      expect(isReleaseChannelEvent(event), event).toBe(false);
    }
  });

  it("recovers an old threaded send and posts only one channel copy after a lost response", async () => {
    const { request, sqlite } = await harness();
    const event = body("REJECTED");
    const objectKey = await notificationObjectKey(event);
    sqlite.prepare("INSERT INTO raft_notification_threads VALUES (?, ?, ?, ?, ?)")
      .run(SUBSCRIPTION_ID, objectKey, "legacy-parent-1", 1, 1);
    const originalKey = `hands-raft:${SUBSCRIPTION_ID}:${await sha256Hex(JSON.stringify(event))}`;
    const content = formatRaftNotificationMessage(event, {
      id: APP_ID, slug: "sample-app", name: "Sample App", dashboardOrigin: "https://hands.test",
    });
    const messages = new Map<string, { target: string; content: string; messageId: string }>([
      [originalKey, { target: "#releases:legacy-p", content, messageId: "legacy-reply" }],
    ]);
    let lostChannelResponse = false;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      const data = JSON.parse(String(init?.body)) as { target: string; content: string; idempotencyKey: string };
      const found = messages.get(data.idempotencyKey);
      if (found) {
        if (found.target !== data.target || found.content !== data.content) {
          return Response.json({ code: "idempotency_key_reused" }, { status: 409 });
        }
        return Response.json({ state: "committed", messageId: found.messageId });
      }
      const created = { target: data.target, content: data.content, messageId: "channel-copy" };
      messages.set(data.idempotencyKey, created);
      if (!lostChannelResponse) { lostChannelResponse = true; throw new Error("response lost after commit"); }
      return Response.json({ state: "sent", messageId: created.messageId });
    });
    expect((await request(event, "delivery-1")).status).toBe(503);
    const retried = await request(event, "delivery-2");
    expect(retried.status).toBe(200);
    expect(await retried.json()).toMatchObject({ message_id: "channel-copy", threaded: false });
    expect([...messages.values()].filter((message) => message.target === "#releases")).toHaveLength(1);
    expect(messages.get(originalKey)?.messageId).toBe("legacy-reply");
  });

  it.each(["#releases", "#releases:legacy-p"])(
    "recognizes the old card-fallback warning sent to %s before changing its wording",
    async (oldTarget) => {
      const { request, sqlite } = await harness();
      const event = body("REJECTED");
      const objectKey = await notificationObjectKey(event);
      sqlite.prepare("INSERT INTO raft_notification_threads VALUES (?, ?, ?, ?, ?)")
        .run(SUBSCRIPTION_ID, objectKey, "legacy-parent-1", 1, 1);
      sqlite.prepare("INSERT INTO raft_notification_cards (subscription_id, object_key, state, updated_at) VALUES (?, ?, 'retired', 1)")
        .run(SUBSCRIPTION_ID, objectKey);
      const originalKey = `hands-raft:${SUBSCRIPTION_ID}:${await sha256Hex(JSON.stringify(event))}`;
      const oldContent = formatRaftNotificationMessage(event, {
        id: APP_ID, slug: "sample-app", name: "Sample App", dashboardOrigin: "https://hands.test",
      }) + "\n⚠️ A previous status card may be out of date; follow this thread for newer updates.";
      const messages = new Map<string, { target: string; content: string; messageId: string }>([
        [originalKey, { target: oldTarget, content: oldContent, messageId: "old-message" }],
      ]);
      vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
        const data = JSON.parse(String(init?.body)) as { target: string; content: string; idempotencyKey: string };
        const found = messages.get(data.idempotencyKey);
        if (found) {
          if (found.target !== data.target || found.content !== data.content) {
            return Response.json({ code: "idempotency_key_reused" }, { status: 409 });
          }
          return Response.json({ state: "committed", messageId: found.messageId });
        }
        const created = { target: data.target, content: data.content, messageId: "channel-copy" };
        messages.set(data.idempotencyKey, created);
        return Response.json({ state: "sent", messageId: created.messageId });
      });
      const result = await request(event, "delivery-1");
      expect(result.status).toBe(200);
      expect(await result.json()).toMatchObject({
        message_id: oldTarget === "#releases" ? "old-message" : "channel-copy", threaded: false,
      });
      expect([...messages.values()].filter((message) => message.target === "#releases")).toHaveLength(1);
    },
  );

  it("does not use a fresh key when the old threaded request cannot be verified", async () => {
    const { request, sqlite } = await harness();
    const event = body("REJECTED");
    sqlite.prepare("INSERT INTO raft_notification_threads VALUES (?, ?, ?, ?, ?)")
      .run(SUBSCRIPTION_ID, await notificationObjectKey(event), "legacy-parent-1", 1, 1);
    const attempts: Array<{ target: string; idempotencyKey: string }> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      attempts.push(JSON.parse(String(init?.body)));
      return Response.json({ code: "idempotency_key_reused" }, { status: 409 });
    });
    expect((await request(event, "delivery-1")).status).toBe(409);
    expect(attempts.map((attempt) => attempt.target)).toEqual(["#releases", "#releases:legacy-p"]);
    expect(new Set(attempts.map((attempt) => attempt.idempotencyKey)).size).toBe(1);
  });

  it("replays the original channel copy if the fallback warning changes between attempts", async () => {
    const { request, sqlite } = await harness();
    const event = body("REJECTED");
    const objectKey = await notificationObjectKey(event);
    sqlite.prepare("INSERT INTO raft_notification_threads VALUES (?, ?, ?, ?, ?)")
      .run(SUBSCRIPTION_ID, objectKey, "legacy-parent-1", 1, 1);
    const originalKey = `hands-raft:${SUBSCRIPTION_ID}:${await sha256Hex(JSON.stringify(event))}`;
    const content = formatRaftNotificationMessage(event, {
      id: APP_ID, slug: "sample-app", name: "Sample App", dashboardOrigin: "https://hands.test",
    });
    const messages = new Map<string, { target: string; content: string; messageId: string }>([
      [originalKey, { target: "#releases:legacy-p", content, messageId: "legacy-reply" }],
    ]);
    let lostResponse = false;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      const data = JSON.parse(String(init?.body)) as { target: string; content: string; idempotencyKey: string };
      const found = messages.get(data.idempotencyKey);
      if (found) {
        if (found.target !== data.target || found.content !== data.content) {
          return Response.json({ code: "idempotency_key_reused" }, { status: 409 });
        }
        return Response.json({ state: "committed", messageId: found.messageId });
      }
      messages.set(data.idempotencyKey, { target: data.target, content: data.content, messageId: "channel-copy" });
      if (!lostResponse) { lostResponse = true; throw new Error("response lost after commit"); }
      return Response.json({ state: "sent", messageId: "channel-copy" });
    });
    expect((await request(event, "delivery-1")).status).toBe(503);
    sqlite.prepare("INSERT INTO raft_notification_cards (subscription_id, object_key, state, updated_at) VALUES (?, ?, 'retired', 1)")
      .run(SUBSCRIPTION_ID, objectKey);
    const retried = await request(event, "delivery-2");
    expect(retried.status).toBe(200);
    expect(await retried.json()).toMatchObject({ message_id: "channel-copy", threaded: false });
    expect([...messages.values()].filter((message) => message.target === "#releases")).toHaveLength(1);
  });

  it("posts successive Play and AppGallery status changes to the channel", async () => {
    const { request, updateConfig } = await harness();
    expect((await updateConfig({ events: ["google_play:release_state_changed", "appgallery:package_state_changed"] })).status).toBe(200);
    const targets: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      targets.push((JSON.parse(String(init?.body)) as { target: string }).target);
      return Response.json({ state: "sent", messageId: `message-${targets.length}` });
    });
    for (const event of ["google_play:release_state_changed", "appgallery:package_state_changed"]) {
      const make = (state: string) => ({ event, delivered_at: 100, payload: {
        package_name: "build.raft.app", track: "internal", version_code: 12000003,
        resource: { id: "same-package" }, state,
      } });
      expect((await request(make("IN_REVIEW"), `${event}-1`)).status).toBe(200);
      expect((await request(make("PUBLISHED"), `${event}-2`)).status).toBe(200);
    }
    expect(targets).toEqual(["#releases", "#releases", "#releases", "#releases"]);
  });

  it.each([
    "testflight:upload_processing", "testflight:internal_distribution_ready",
    "app_store:build_upload_state_changed", "google_play:submission_succeeded",
    "release:new", "release:draft_created", "release:superseded", "release:rolled_back",
    "release:channel_emptied", "release:cancelled", "release:published",
    "build:succeeded", "build:failed",
  ])("sends each %s receipt as a separate channel card and deduplicates retries", async (eventName) => {
    const { request, sqlite, updateConfig } = await harness();
    expect((await updateConfig({ events: [eventName] })).status).toBe(200);
    expect((await updateConfig({ card_updates: true })).status).toBe(200);
    const calls: Array<Record<string, unknown>> = [];
    mockRaftFetch(async (_input, init) => {
      calls.push(JSON.parse(String(init?.body)));
      expect(init?.method).toBe("POST");
      return Response.json({ state: "sent", messageId: `card-${calls.length}`, messageCard: { revision: 1 } });
    });
    // A timestamp is not needed to order standalone receipts.
    const first = { event: eventName, delivered_at: 100, payload: {
      release_id: "release-1", build_id: "build-1", version: "1.20.0", version_code: 12000003,
      track: "production", state: "PROCESSING",
    } };
    const second = { ...first, payload: { ...first.payload, version_code: 12000004 } };
    expect((await request(first, "one")).status).toBe(200);
    expect((await request(first, "retry")).status).toBe(200);
    expect((await request(second, "two")).status).toBe(200);
    expect(calls).toHaveLength(2);
    for (const call of calls) expect(call).toMatchObject({ target: "#releases", card: { version: 1 }, content: expect.any(String) });
    expect(calls[0]!.idempotencyKey).not.toBe(calls[1]!.idempotencyKey);
    expect(sqlite.prepare("SELECT COUNT(*) FROM raft_notification_cards").pluck().get()).toBe(2);
  });

  it("does not resend a standalone text receipt when cards are enabled before a retry", async () => {
    const { request, updateConfig } = await harness();
    await updateConfig({ events: ["testflight:upload_processing"] });
    const event = { event: "testflight:upload_processing", payload: { build_id: "build-1", version: "1.20.0" } };
    const messages = new Map<string, Record<string, unknown>>();
    const calls: Array<Record<string, unknown>> = [];
    mockRaftFetch(async (_input, init) => {
      const data = JSON.parse(String(init?.body)) as Record<string, unknown>;
      calls.push(data);
      const key = String(data.idempotencyKey);
      const prior = messages.get(key);
      if (prior) return JSON.stringify(prior) === JSON.stringify(data)
        ? Response.json({ state: "committed", messageId: "original" })
        : Response.json({ code: "idempotency_key_reused" }, { status: 409 });
      messages.set(key, data);
      return Response.json({ state: "sent", messageId: "original" });
    });
    expect((await request(event, "text")).status).toBe(200);
    expect(calls[0]).not.toHaveProperty("card");
    expect((await updateConfig({ card_updates: true })).status).toBe(200);
    const retried = await request(event, "retry");
    expect(retried.status).toBe(200);
    expect(await retried.json()).toMatchObject({ message_id: "original", card: false });
    expect(messages.size).toBe(1);
    expect(calls.some((call) => !!call.card)).toBe(true);
    expect(new Set(calls.map((call) => call.idempotencyKey)).size).toBe(1);
  });

  it("falls back to one channel text notice if Raft refuses an update notice card", async () => {
    const { request, updateConfig } = await harness();
    await updateConfig({ card_updates: true });
    const notices: Array<Record<string, unknown>> = [];
    mockRaftFetch(async (_input, init) => {
      const data = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (init?.method === "PUT") return Response.json({ ok: true, messageId: "card-1", revision: 2 });
      if (String(data.idempotencyKey).startsWith("hands-card:send:")) return Response.json({ state: "sent", messageId: "card-1", messageCard: { revision: 1 } });
      notices.push(data);
      return data.card ? Response.json({ code: "message_cards_disabled" }, { status: 400 })
        : Response.json({ state: "sent", messageId: "text-notice" });
    });
    expect((await request(stateBody("IN_REVIEW", "2026-11-04T07:00:00Z"), "a")).status).toBe(200);
    expect((await request(stateBody("REJECTED", "2026-11-04T07:01:00Z"), "b")).status).toBe(200);
    expect(notices).toHaveLength(2);
    expect(notices[0]).toHaveProperty("card");
    expect(notices[1]).not.toHaveProperty("card");
    expect(notices[1]).toMatchObject({ target: "#releases", idempotencyKey: notices[0]?.idempotencyKey, content: notices[0]?.content });
  });

  it("recognizes a standalone event already delivered as old threaded text before creating one channel copy", async () => {
    const { request, sqlite, updateConfig } = await harness();
    await updateConfig({ events: ["google_play:submission_succeeded"] });
    await updateConfig({ card_updates: true });
    const event = { event: "google_play:submission_succeeded", delivered_at: 100, payload: {
      release_id: "release-1", version: "1.20.0", version_code: 12000003, track: "production",
    } };
    const oldText = formatRaftNotificationMessage(event, { id: APP_ID, slug: "sample-app", name: "Sample App", dashboardOrigin: "https://hands.test" });
    const key = `hands-raft:${SUBSCRIPTION_ID}:${await sha256Hex(JSON.stringify(event))}`;
    sqlite.prepare("INSERT INTO raft_notification_threads VALUES (?, ?, ?, ?, ?)")
      .run(SUBSCRIPTION_ID, await notificationObjectKey(event), "legacy-parent-1", 1, 1);
    const messages = new Map<string, { target: string; content: string; card?: unknown; messageId: string }>([
      [key, { target: "#releases:legacy-p", content: oldText, messageId: "old-thread-message" }],
    ]);
    const attempts: Array<Record<string, unknown>> = [];
    mockRaftFetch(async (_input, init) => {
      const data = JSON.parse(String(init?.body)) as Record<string, unknown>;
      attempts.push(data);
      const prior = messages.get(String(data.idempotencyKey));
      if (prior) {
        if (prior.target !== data.target || prior.content !== data.content || JSON.stringify(prior.card ?? null) !== JSON.stringify(data.card ?? null))
          return Response.json({ code: "idempotency_key_reused" }, { status: 409 });
        return Response.json({ state: "committed", messageId: prior.messageId });
      }
      const message = { target: String(data.target), content: String(data.content), card: data.card, messageId: "channel-copy" };
      messages.set(String(data.idempotencyKey), message);
      return Response.json({ state: "sent", messageId: message.messageId });
    });
    expect((await request(event, "old-worker-race")).status).toBe(200);
    expect(attempts[0]).toMatchObject({ target: "#releases", idempotencyKey: key, card: { version: 1 } });
    expect(attempts.some((attempt) => attempt.target === "#releases:legacy-p" && attempt.idempotencyKey === key && attempt.content === oldText)).toBe(true);
    expect([...messages.values()].filter((message) => message.target === "#releases")).toHaveLength(1);
    const count = attempts.length;
    expect((await request(event, "retry")).status).toBe(200);
    expect(attempts).toHaveLength(count);
  });

  it("proves an old threaded standalone winner after a lost card response instead of treating key reconciliation as channel delivery", async () => {
    const { request, sqlite, updateConfig } = await harness();
    await updateConfig({ events: ["testflight:upload_processing"] });
    await updateConfig({ card_updates: true });
    const event = { event: "testflight:upload_processing", payload: { build_id: "build-1", version: "1.20.0" } };
    const oldText = formatRaftNotificationMessage(event, { id: APP_ID, slug: "sample-app", name: "Sample App", dashboardOrigin: "https://hands.test" });
    const key = `hands-raft:${SUBSCRIPTION_ID}:${await sha256Hex(JSON.stringify(event))}`;
    sqlite.prepare("INSERT INTO raft_notification_threads VALUES (?, ?, ?, ?, ?)")
      .run(SUBSCRIPTION_ID, await notificationObjectKey(event), "legacy-parent-1", 1, 1);
    const calls: Array<Record<string, unknown>> = [];
    const messages = new Map<string, { target: string; content: string; messageId: string }>([
      [key, { target: "#releases:legacy-p", content: oldText, messageId: "old-thread-message" }],
    ]);
    let lost = false;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      const data = JSON.parse(String(init?.body)) as Record<string, unknown>;
      calls.push(data);
      if (!lost) { lost = true; throw new Error("response lost"); }
      // Reconciliation can return the old thread's message regardless of target.
      if (data.reconcileOnly) return Response.json({ state: "committed", messageId: "old-thread-message" });
      const previous = messages.get(String(data.idempotencyKey));
      if (previous) return !data.card && data.target === previous.target && data.content === previous.content
        ? Response.json({ state: "committed", messageId: previous.messageId })
        : Response.json({ code: "idempotency_key_reused" }, { status: 409 });
      const next = { target: String(data.target), content: String(data.content), messageId: "channel-copy" };
      messages.set(String(data.idempotencyKey), next);
      return Response.json({ state: "sent", messageId: next.messageId });
    });
    expect((await request(event, "first")).status).toBe(503);
    sqlite.prepare("UPDATE raft_notification_threads SET updated_at=1 WHERE parent_message_id='pending'").run();
    expect((await request(event, "retry")).status).toBe(200);
    expect(calls.some((call) => call.reconcileOnly)).toBe(false);
    expect(calls.some((call) => call.target === "#releases:legacy-p" && call.content === oldText)).toBe(true);
    expect([...messages.values()].filter((message) => message.target === "#releases")).toHaveLength(1);
    expect(sqlite.prepare("SELECT message_id,pending_json FROM raft_notification_cards").get())
      .toEqual({ message_id: "channel-copy", pending_json: null });
  });

  it("falls back to the proven old threaded text after a standalone card is refused", async () => {
    const { request, sqlite, updateConfig } = await harness();
    await updateConfig({ events: ["testflight:internal_distribution_ready"] });
    await updateConfig({ card_updates: true });
    const event = { event: "testflight:internal_distribution_ready", payload: { build_id: "build-1" } };
    const text = formatRaftNotificationMessage(event, { id: APP_ID, slug: "sample-app", name: "Sample App", dashboardOrigin: "https://hands.test" });
    const key = `hands-raft:${SUBSCRIPTION_ID}:${await sha256Hex(JSON.stringify(event))}`;
    sqlite.prepare("INSERT INTO raft_notification_threads VALUES (?, ?, ?, ?, ?)")
      .run(SUBSCRIPTION_ID, await notificationObjectKey(event), "legacy-parent-1", 1, 1);
    const calls: Array<Record<string, unknown>> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      const data = JSON.parse(String(init?.body)) as Record<string, unknown>;
      calls.push(data);
      if (data.card) return Response.json({ code: "message_cards_disabled" }, { status: 400 });
      if (data.idempotencyKey === key) return data.target === "#releases:legacy-p" && data.content === text
        ? Response.json({ state: "committed", messageId: "old-thread-message" })
        : Response.json({ code: "idempotency_key_reused" }, { status: 409 });
      return Response.json({ state: "sent", messageId: "channel-copy" });
    });
    const result = await request(event, "refused");
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({ message_id: "channel-copy", card_fallback: "message_cards_disabled" });
    expect(calls.some((call) => call.target === "#releases:legacy-p" && call.idempotencyKey === key)).toBe(true);
    expect(calls.at(-1)).toMatchObject({ target: "#releases", idempotencyKey: key.replace("hands-raft:", "hands-raft-channel:"), content: text });
  });

  it("keeps an unknown standalone-key conflict pending without emitting a new key", async () => {
    const { request, sqlite, updateConfig } = await harness();
    await updateConfig({ events: ["testflight:upload_processing"] });
    await updateConfig({ card_updates: true });
    const event = { event: "testflight:upload_processing", payload: { build_id: "build-1" } };
    sqlite.prepare("INSERT INTO raft_notification_threads VALUES (?, ?, ?, ?, ?)")
      .run(SUBSCRIPTION_ID, await notificationObjectKey(event), "legacy-parent-1", 1, 1);
    const attempts: Array<Record<string, unknown>> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      attempts.push(JSON.parse(String(init?.body)));
      return Response.json({ code: "idempotency_key_reused" }, { status: 409 });
    });
    expect((await request(event, "conflict")).status).toBe(503);
    expect(new Set(attempts.map((attempt) => attempt.idempotencyKey)).size).toBe(1);
    expect(sqlite.prepare("SELECT pending_uncertain FROM raft_notification_cards").pluck().get()).toBe(1);
  });

  it("uses text for an update notice if cards were disabled while the update was in flight", async () => {
    const { request, sqlite, updateConfig } = await harness();
    await updateConfig({ card_updates: true });
    const calls: Array<Record<string, unknown>> = [];
    mockRaftFetch(async (_input, init) => {
      const data = JSON.parse(String(init?.body)) as Record<string, unknown>;
      calls.push(data);
      if (init?.method === "PUT") {
        sqlite.prepare("UPDATE raft_notification_subscriptions SET card_updates=0").run();
        return Response.json({ ok: true, messageId: "card-1", revision: 2 });
      }
      return Response.json({ state: "sent", messageId: calls.length === 1 ? "card-1" : "notice", ...(data.card ? { messageCard: { revision: 1 } } : {}) });
    });
    expect((await request(stateBody("IN_REVIEW", "2026-11-04T07:00:00Z"), "a")).status).toBe(200);
    expect((await request(stateBody("REJECTED", "2026-11-04T07:01:00Z"), "b")).status).toBe(200);
    expect(calls).toHaveLength(3);
    expect(calls[2]).toMatchObject({ target: "#releases", content: expect.stringContaining("Review rejected") });
    expect(calls[2]).not.toHaveProperty("card");
  });

  it("confirms an already-committed card notice after cards are disabled without sending another notice", async () => {
    const { request, sqlite, updateConfig } = await harness();
    await updateConfig({ card_updates: true });
    const calls: Array<Record<string, unknown>> = [];
    const committed = new Map<string, Record<string, unknown>>();
    let lost = false;
    mockRaftFetch(async (_input, init) => {
      const data = JSON.parse(String(init?.body)) as Record<string, unknown>;
      calls.push(data);
      if (init?.method === "PUT") return Response.json({ ok: true, messageId: "card-1", revision: 2 });
      if (String(data.idempotencyKey).startsWith("hands-card:send:"))
        return Response.json({ state: "sent", messageId: "card-1", messageCard: { revision: 1 } });
      const key = String(data.idempotencyKey);
      const previous = committed.get(key);
      if (previous) {
        if (JSON.stringify(previous) !== JSON.stringify(data)) return Response.json({ code: "idempotency_key_reused" }, { status: 409 });
        return Response.json({ state: "committed", messageId: "notice", messageCard: { revision: 1 } });
      }
      committed.set(key, data);
      if (!lost) { lost = true; throw new Error("notice committed but response was lost"); }
      return Response.json({ state: "sent", messageId: "notice" });
    });
    expect((await request(stateBody("IN_REVIEW", "2026-11-04T07:00:00Z"), "a")).status).toBe(200);
    const changed = stateBody("REJECTED", "2026-11-04T07:01:00Z");
    expect((await request(changed, "b")).status).toBe(503);
    expect((await updateConfig({ card_updates: false })).status).toBe(200);
    expect((await request(changed, "retry")).status).toBe(200);
    expect(committed.size).toBe(1);
    const notices = calls.filter((call) => String(call.idempotencyKey).startsWith("hands-raft:"));
    expect(notices[0]).toHaveProperty("card");
    expect(notices.at(-1)).toEqual(notices[0]);
    expect(notices.slice(1, -1).every((call) => !call.card && call.idempotencyKey === notices[0]!.idempotencyKey)).toBe(true);
    expect(sqlite.prepare("SELECT pending_json FROM raft_notification_cards").pluck().get()).toBeNull();
  });

  it("sends a card, updates the same message and ignores an older event", async () => {
    const { request, sqlite, updateConfig } = await harness();
    expect((await updateConfig({ card_updates: true })).status).toBe(200);
    const sent: Array<{ url: string; body: Record<string, unknown> }> = [];
    mockRaftFetch(async (input, init) => {
      sent.push({ url: String(input), body: JSON.parse(String(init?.body)) });
      if (sent.length === 1) return Response.json({ state: "sent", messageId: "parent-message-1" });
      return init?.method === "PUT" ? Response.json({ ok: true, messageId: "parent-message-1", revision: 2 })
        : Response.json({ state: "sent", messageId: "channel-notice-1" });
    });
    const first = stateBody("IN_REVIEW", "2026-11-04T07:00:00Z");
    const second = stateBody("REJECTED", "2026-11-04T07:01:00Z");
    expect((await request(first, "a")).status).toBe(200);
    expect((await request(second, "b")).status).toBe(200);
    expect((await request(first, "c")).status).toBe(200);
    expect(sent).toHaveLength(3);
    expect(sent[0]!.body).toMatchObject({ target: "#releases", card: { version: 1 }, content: expect.stringContaining("In review") });
    expect(sent[1]!.url).toContain("/messages/parent-message-1/card");
    expect(sent[1]!.body).toMatchObject({ expectedRevision: 1, card: { version: 1 }, content: expect.stringContaining("Review rejected") });
    expect(sent[2]!.body).toMatchObject({ target: "#releases", content: expect.stringContaining("Review rejected") });
    expect(sent[2]!.body.card).toEqual(sent[1]!.body.card);
    expect(sqlite.prepare("SELECT message_id,revision FROM raft_notification_cards").get()).toEqual({ message_id: "parent-message-1", revision: 2 });
  });

  it("recognizes a pre-deploy Play channel notice without the new console link", async () => {
    const { request, updateConfig } = await harness();
    await updateConfig({ events: ["google_play:release_state_changed"] });
    await updateConfig({ card_updates: true });
    const make = (state: string, occurred_at: string) => ({ event: "google_play:release_state_changed", payload: {
      package_name: "build.raft.app", track: "production", version_code: 12000003, state, occurred_at,
    } });
    const first = make("RELEASE_LIFECYCLE_STATE_IN_REVIEW", "2026-11-05T10:00:00Z");
    const next = make("RELEASE_LIFECYCLE_STATE_PUBLISHED", "2026-11-05T10:01:00Z");
    const oldNotice = formatRaftNotificationMessage(next, { id: APP_ID, slug: "sample-app", name: "Sample App" });
    const notices: Array<Record<string, unknown>> = [];
    mockRaftFetch(async (_input, init) => {
      const sent = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (init?.method === "PUT") return Response.json({ ok: true, messageId: "card-1", revision: 2 });
      if (String(sent.idempotencyKey).startsWith("hands-card:send:")) return Response.json({ state: "sent", messageId: "card-1", messageCard: { revision: 1 } });
      notices.push(sent);
      return !sent.card && sent.content === oldNotice
        ? Response.json({ state: "committed", messageId: "old-notice" })
        : Response.json({ code: "idempotency_key_reused" }, { status: 409 });
    });
    expect((await request(first, "a")).status).toBe(200);
    expect((await request(next, "b")).status).toBe(200);
    expect(notices[0]?.content).toContain("[Open Play Console](https://play.google.com/console/)");
    expect(notices[0]?.card).toMatchObject({ version: 1 });
    expect(notices.at(-1)?.content).toBe(oldNotice);
    expect(new Set(notices.map((notice) => notice.idempotencyKey)).size).toBe(1);
    const count = notices.length;
    expect((await request(next, "retry")).status).toBe(200);
    expect(notices).toHaveLength(count);
  });

  it("cards AppGallery states and updates each submission independently", async () => {
    const { request, updateConfig } = await harness();
    await updateConfig({ events: ["appgallery:invitation_state_changed", "appgallery:package_state_changed"] });
    await updateConfig({ card_updates: true });
    const calls: Array<{ method: string; body: Record<string, unknown>; url: string }> = [];
    let cards = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const data = JSON.parse(String(init?.body)) as Record<string, unknown>;
      calls.push({ method: String(init?.method), body: data, url: String(input) });
      if (init?.method === "PUT") return Response.json({ ok: true, messageId: "card-1", revision: 2 });
      if (calls.at(-2)?.method === "PUT") return Response.json({ state: "sent", messageId: "channel-notice", messageCard: { revision: 1 } });
      if (data.card) return Response.json({ state: "sent", messageId: `card-${++cards}`, messageCard: { revision: 1 } });
      return Response.json({ state: "sent", messageId: "channel-text" });
    });
    const invite = (id: string, state: string, time: string) => ({ event: "appgallery:invitation_state_changed",
      payload: { submission_id: id, build_id: "same-build", state, occurred_at: time } });
    const packageEvent = { event: "appgallery:package_state_changed", payload: {
      package_id: "package-a", build_id: "same-build", state: "processing", occurred_at: "2026-11-05T11:00:00Z",
    } };
    expect((await request(invite("submission-a", "testing_review", "2026-11-05T11:00:00Z"), "a")).status).toBe(200);
    expect((await request(invite("submission-a", "testing_active", "2026-11-05T11:01:00Z"), "b")).status).toBe(200);
    expect((await request(invite("submission-b", "testing_review", "2026-11-05T11:02:00Z"), "c")).status).toBe(200);
    expect((await request(packageEvent, "d")).status).toBe(200);
    expect(cards).toBe(3);
    expect(calls.filter((call) => call.body.card && call.method === "POST")).toHaveLength(4);
    expect(calls.find((call) => call.method === "PUT")?.url).toContain("/messages/card-1/card");
    expect(calls[2]).toMatchObject({ method: "POST", body: { target: "#releases", card: { version: 1 } } });
  });

  it("keeps AppGallery objects with a legacy text thread on text", async () => {
    const { request, sqlite, updateConfig } = await harness();
    await updateConfig({ events: ["appgallery:invitation_state_changed"] });
    await updateConfig({ card_updates: true });
    const event = { event: "appgallery:invitation_state_changed", payload: {
      submission_id: "submission-a", build_id: "same-build", state: "testing_review", occurred_at: "2026-11-05T11:00:00Z",
    } };
    sqlite.prepare("INSERT INTO raft_notification_threads VALUES (?, ?, ?, ?, ?)")
      .run(SUBSCRIPTION_ID, await notificationObjectKey(event), "old-parent", 1, 1);
    const calls: Array<Record<string, unknown>> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      calls.push(JSON.parse(String(init?.body)));
      return Response.json({ state: "sent", messageId: "channel-text" });
    });
    expect((await request(event, "a")).status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ target: "#releases" });
    expect(calls[0]).not.toHaveProperty("card");
    expect(sqlite.prepare("SELECT COUNT(*) FROM raft_notification_cards").pluck().get()).toBe(0);
  });

  it("recognizes an old worker's AppGallery text winning the same-key card race", async () => {
    const { request, sqlite, updateConfig } = await harness();
    await updateConfig({ events: ["appgallery:invitation_state_changed"] });
    await updateConfig({ card_updates: true });
    const event = { event: "appgallery:invitation_state_changed", payload: {
      submission_id: "submission-a", build_id: "same-build", state: "testing_review", occurred_at: "2026-11-05T11:00:00Z",
    } };
    const text = formatRaftNotificationMessage(event, { id: APP_ID, slug: "sample-app", name: "Sample App" });
    const expectedKey = `hands-raft:${SUBSCRIPTION_ID}:${await sha256Hex(JSON.stringify(event))}`;
    const calls: Array<Record<string, unknown>> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      const data = JSON.parse(String(init?.body)) as Record<string, unknown>;
      calls.push(data);
      expect(data.idempotencyKey).toBe(expectedKey);
      expect(data.target).toBe("#releases");
      expect(data.content).toBe(text);
      return data.card ? Response.json({ code: "idempotency_key_reused" }, { status: 409 })
        : Response.json({ state: "committed", messageId: "old-text" });
    });
    const result = await request(event, "a");
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({ message_id: "old-text", card: false });
    expect(calls).toHaveLength(2);
    expect(sqlite.prepare("SELECT state,revision FROM raft_notification_cards").get()).toEqual({ state: "retired", revision: 0 });
  });

  it.each([false, true])("recognizes existing AppGallery text with the warning variant (thread=%s)", async (thread) => {
    const { request, sqlite, updateConfig } = await harness();
    await updateConfig({ events: ["appgallery:invitation_state_changed"] });
    await updateConfig({ card_updates: true });
    const event = { event: "appgallery:invitation_state_changed", payload: {
      submission_id: "submission-a", build_id: "same-build", state: "testing_review", occurred_at: "2026-11-05T11:00:00Z",
    } };
    const base = formatRaftNotificationMessage(event, { id: APP_ID, slug: "sample-app", name: "Sample App" });
    const warning = base + (thread
      ? "\n⚠️ A previous status card may be out of date; follow this thread for newer updates."
      : "\n⚠️ A previous status card may be out of date; check newer channel messages.");
    const expectedKey = `hands-raft:${SUBSCRIPTION_ID}:${await sha256Hex(JSON.stringify(event))}`;
    const calls: Array<Record<string, unknown>> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      const data = JSON.parse(String(init?.body)) as Record<string, unknown>;
      calls.push(data);
      expect(data.idempotencyKey).toBe(expectedKey);
      expect(data.target).toBe("#releases");
      return !data.card && data.content === warning
        ? Response.json({ state: "committed", messageId: "old-warning" })
        : Response.json({ code: "idempotency_key_reused" }, { status: 409 });
    });
    const response = await request(event, "a");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ message_id: "old-warning", card: false });
    expect(calls.at(-1)?.content).toBe(warning);
    expect(sqlite.prepare("SELECT state,pending_json FROM raft_notification_cards").get()).toEqual({ state: "retired", pending_json: null });
  });

  it("recovers an existing warning when an uncertain AppGallery send is switched to text", async () => {
    const { request, sqlite, updateConfig } = await harness();
    await updateConfig({ events: ["appgallery:package_state_changed"] });
    await updateConfig({ card_updates: true });
    const event = { event: "appgallery:package_state_changed", payload: {
      package_id: "package-a", build_id: "same-build", state: "processing", occurred_at: "2026-11-05T11:00:00Z",
    } };
    const base = formatRaftNotificationMessage(event, { id: APP_ID, slug: "sample-app", name: "Sample App" });
    const warning = base + "\n⚠️ A previous status card may be out of date; check newer channel messages.";
    const calls: Array<Record<string, unknown>> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      const data = JSON.parse(String(init?.body)) as Record<string, unknown>;
      calls.push(data);
      if (data.card) throw new Error("card response lost");
      return data.content === warning ? Response.json({ state: "committed", messageId: "old-warning" })
        : Response.json({ code: "idempotency_key_reused" }, { status: 409 });
    });
    expect((await request(event, "a")).status).toBe(503);
    expect((await updateConfig({ card_updates: false })).status).toBe(200);
    sqlite.prepare("UPDATE raft_notification_threads SET updated_at=1").run();
    const recovered = await request(event, "b");
    expect(recovered.status).toBe(200);
    expect(await recovered.json()).toMatchObject({ message_id: "old-warning", card: false });
    expect(new Set(calls.map((call) => call.idempotencyKey)).size).toBe(1);
    expect(sqlite.prepare("SELECT state,pending_json FROM raft_notification_cards").get()).toEqual({ state: "retired", pending_json: null });
  });

  it("keeps AppGallery events without an object ID on text", async () => {
    const { request, sqlite, updateConfig } = await harness();
    await updateConfig({ events: ["appgallery:package_state_changed"] });
    await updateConfig({ card_updates: true });
    const calls: Array<Record<string, unknown>> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      calls.push(JSON.parse(String(init?.body)));
      return Response.json({ state: "sent", messageId: `text-${calls.length}` });
    });
    for (const state of ["processing", "ready"]) {
      expect((await request({ event: "appgallery:package_state_changed", payload: {
        build_id: "same-build", state, occurred_at: "2026-11-05T11:00:00Z",
      } }, state)).status).toBe(200);
    }
    expect(calls).toHaveLength(2);
    expect(calls.every((call) => !call.card)).toBe(true);
    expect(sqlite.prepare("SELECT COUNT(*) FROM raft_notification_cards").pluck().get()).toBe(0);
  });

  it("recovers a committed old text after the initial card response is lost and joint readback is unavailable", async () => {
    const { request, sqlite, updateConfig } = await harness();
    await updateConfig({ events: ["appgallery:invitation_state_changed"] });
    await updateConfig({ card_updates: true });
    const event = { event: "appgallery:invitation_state_changed", payload: {
      submission_id: "submission-a", build_id: "same-build", state: "testing_review", occurred_at: "2026-11-05T11:00:00Z",
    } };
    const expectedKey = `hands-raft:${SUBSCRIPTION_ID}:${await sha256Hex(JSON.stringify(event))}`;
    const calls: Array<Record<string, unknown>> = [];
    let lostResponse = false;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      if (init?.method === "GET") return Response.json({ code: "message_not_found" }, { status: 404 });
      const data = JSON.parse(String(init?.body)) as Record<string, unknown>;
      calls.push(data);
      expect(data.idempotencyKey).toBe(expectedKey);
      expect(data.target).toBe("#releases");
      if (data.reconcileOnly) return Response.json({ state: "committed", messageId: "old-text" });
      if (!lostResponse) { lostResponse = true; throw new Error("response lost"); }
      return data.card ? Response.json({ code: "idempotency_key_reused" }, { status: 409 })
        : Response.json({ state: "committed", messageId: "old-text" });
    });
    expect((await request(event, "a")).status).toBe(503);
    sqlite.prepare("UPDATE raft_notification_threads SET updated_at=1").run();
    const retried = await request(event, "b");
    expect(retried.status).toBe(200);
    expect(await retried.json()).toMatchObject({ message_id: "old-text", card: false });
    expect(calls).toHaveLength(3);
    expect(calls.some((call) => call.reconcileOnly)).toBe(false);
    expect(sqlite.prepare("SELECT state,pending_json FROM raft_notification_cards").get()).toEqual({ state: "retired", pending_json: null });
  });

  it("keeps an unverifiable AppGallery conflict pending without trying a new key", async () => {
    const { request, sqlite, updateConfig } = await harness();
    await updateConfig({ events: ["appgallery:package_state_changed"] });
    await updateConfig({ card_updates: true });
    const event = { event: "appgallery:package_state_changed", payload: {
      package_id: "package-a", build_id: "same-build", state: "processing", occurred_at: "2026-11-05T11:00:00Z",
    } };
    const calls: Array<Record<string, unknown>> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      calls.push(JSON.parse(String(init?.body)));
      return Response.json({ code: "idempotency_key_reused" }, { status: 409 });
    });
    expect((await request(event, "a")).status).toBe(503);
    expect(calls).toHaveLength(4);
    expect(new Set(calls.map((call) => call.idempotencyKey))).toEqual(new Set([
      `hands-raft:${SUBSCRIPTION_ID}:${await sha256Hex(JSON.stringify(event))}`,
    ]));
    expect(sqlite.prepare("SELECT pending_uncertain FROM raft_notification_cards").pluck().get()).toBe(1);
  });

  it("recovers an AppGallery card that won the same-key race when its response was lost", async () => {
    const { request, sqlite, updateConfig } = await harness();
    await updateConfig({ events: ["appgallery:invitation_state_changed"] });
    await updateConfig({ card_updates: true });
    const event = { event: "appgallery:invitation_state_changed", payload: {
      submission_id: "submission-a", build_id: "same-build", state: "testing_review", occurred_at: "2026-11-05T11:00:00Z",
    } };
    const expectedKey = `hands-raft:${SUBSCRIPTION_ID}:${await sha256Hex(JSON.stringify(event))}`;
    const calls: Array<Record<string, unknown>> = [];
    const messages = new Map<string, Record<string, unknown>>();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      const data = JSON.parse(String(init?.body)) as Record<string, unknown>;
      calls.push(data);
      expect(data.idempotencyKey).toBe(expectedKey);
      expect(data.target).toBe("#releases");
      if (messages.has(expectedKey)) return JSON.stringify(messages.get(expectedKey)) === JSON.stringify(data)
        ? Response.json({ state: "committed", messageId: "new-card", messageCard: { revision: 1 } })
        : Response.json({ code: "idempotency_key_reused" }, { status: 409 });
      messages.set(expectedKey, data);
      throw new Error("card committed but response lost");
    });
    expect((await request(event, "a")).status).toBe(503);
    sqlite.prepare("UPDATE raft_notification_threads SET updated_at=1").run();
    const retried = await request(event, "b");
    expect(retried.status).toBe(200);
    expect(await retried.json()).toMatchObject({ message_id: "new-card", card: true });
    const oldText = await fetch("https://api.raft.test/internal/agent-api/v2/send", {
      method: "POST", body: JSON.stringify({ target: "#releases", idempotencyKey: expectedKey, content: calls[0]!.content }),
    });
    expect(oldText.status).toBe(409);
    expect(messages.size).toBe(1);
    expect(sqlite.prepare("SELECT state,revision,pending_json FROM raft_notification_cards").get())
      .toEqual({ state: "active", revision: 1, pending_json: null });
  });

  it("retries a lost channel notice with the same content and key before acknowledging the card update", async () => {
    const { request, sqlite, updateConfig } = await harness();
    await updateConfig({ card_updates: true });
    const updates: Array<Record<string, unknown>> = [];
    const notices: Array<Record<string, unknown>> = [];
    const delivered = new Map<string, string>();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      const data = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (init?.method === "PUT") {
        updates.push(data);
        return Response.json({ ok: true, messageId: "parent-message-1", revision: 2 });
      }
      if (String(data.idempotencyKey).startsWith("hands-card:send:")) return Response.json({ state: "sent", messageId: "parent-message-1", messageCard: { revision: 1 } });
      notices.push(data);
      const key = String(data.idempotencyKey);
      if (!delivered.has(key)) {
        delivered.set(key, JSON.stringify({ target: data.target, content: data.content, card: data.card }));
        throw new Error("notice committed but response was lost");
      }
      expect(JSON.stringify({ target: data.target, content: data.content, card: data.card })).toBe(delivered.get(key));
      return Response.json({ state: "committed", messageId: "channel-notice-1" });
    });
    const first = stateBody("IN_REVIEW", "2026-11-04T07:00:00Z");
    const next = stateBody("REJECTED", "2026-11-04T07:01:00Z");
    expect((await request(first, "a")).status).toBe(200);
    expect((await request(next, "b")).status).toBe(503);
    expect(sqlite.prepare("SELECT revision,pending_uncertain FROM raft_notification_cards").get())
      .toEqual({ revision: 1, pending_uncertain: 1 });
    expect((await request(next, "b-retry")).status).toBe(200);
    expect((await request(next, "b-duplicate")).status).toBe(200);
    expect(updates).toHaveLength(2);
    expect(updates[1]).toEqual(updates[0]);
    expect(notices).toHaveLength(2);
    expect(notices[1]).toEqual(notices[0]);
    expect(notices[0]).toMatchObject({ target: "#releases", content: expect.stringContaining("Review rejected"), card: { version: 1 } });
    expect(delivered.size).toBe(1);
    expect(sqlite.prepare("SELECT revision,pending_json FROM raft_notification_cards").get())
      .toEqual({ revision: 2, pending_json: null });
  });

  it("announces an older pending card send that was committed to a thread", async () => {
    const { request, sqlite, updateConfig } = await harness();
    await updateConfig({ card_updates: true });
    const calls: Array<Record<string, unknown>> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      const data = JSON.parse(String(init?.body)) as Record<string, unknown>;
      calls.push(data);
      if (data.reconcileOnly) return Response.json({ state: "committed", messageId: "legacy-card", messageCard: { revision: 1 } });
      if (data.card) return Response.json({ state: "sent", messageId: "parent-message-1", messageCard: { revision: 1 } });
      return Response.json({ state: "sent", messageId: "channel-notice-1" });
    });
    expect((await request(stateBody("IN_REVIEW", "2026-11-04T07:00:00Z"), "a")).status).toBe(200);
    const event = stateBody("REJECTED", "2026-11-04T07:01:00Z");
    const rendered = formatRaftNotificationCard(event, { id: APP_ID, slug: "sample-app", name: "Sample App" });
    const hash = await sha256Hex(JSON.stringify(event));
    const pending = {
      kind: "send", eventHash: hash, eventMs: Date.parse(event.payload.occurred_at),
      idempotencyKey: `hands-card:send:${SUBSCRIPTION_ID}:${hash}`,
      content: rendered.content, card: rendered.card, target: "#releases:parent-m",
      messageId: null, expectedRevision: 1, createsRoot: false, createdAt: Date.now(),
    };
    sqlite.prepare("UPDATE raft_notification_cards SET pending_json=?,pending_uncertain=1").run(JSON.stringify(pending));
    expect((await request(event, "b")).status).toBe(200);
    expect(calls[1]).toMatchObject({ target: "#releases:parent-m", idempotencyKey: pending.idempotencyKey, reconcileOnly: true });
    expect(calls[2]).toMatchObject({ target: "#releases", content: expect.stringContaining("Review rejected") });
    expect(calls[2]).toHaveProperty("card");
    expect(sqlite.prepare("SELECT message_id,pending_json FROM raft_notification_cards").get())
      .toEqual({ message_id: "legacy-card", pending_json: null });
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

  it("recovers the card when it wins a same-key race against a switch to text", async () => {
    const { request, sqlite, updateConfig } = await harness();
    await updateConfig({ card_updates: true });
    const requests: Array<Record<string, unknown>> = [];
    mockRaftFetch(async (_input, init) => {
      requests.push(JSON.parse(String(init?.body)));
      if (requests.length === 1) throw new Error("response lost after commit");
      if (requests.length === 2) return Response.json({ code: "idempotency_key_reused" }, { status: 409 });
      return Response.json({ state: "sent", messageId: "parent-message-1", messageCard: { revision: 1 } });
    });
    const first = stateBody("IN_REVIEW", "2026-11-04T07:00:00Z");
    expect((await request(first, "a")).status).toBe(503);
    expect((await updateConfig({ card_updates: false })).status).toBe(200);
    expect((await updateConfig({ card_updates: true })).status).toBe(409);
    expect(sqlite.prepare("SELECT pending_uncertain FROM raft_notification_cards").pluck().get()).toBe(1);
    // The original parent claim is deliberately held for the existing five-minute lease.
    sqlite.prepare("UPDATE raft_notification_threads SET updated_at=1").run();
    expect((await request(first, "a-retry")).status).toBe(200);
    expect(requests).toHaveLength(3);
    expect(requests[1]).toMatchObject({ target: "#releases", idempotencyKey: requests[0]!.idempotencyKey });
    expect(requests[1]).not.toHaveProperty("card");
    expect(requests[2]).toEqual(requests[0]);
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
      return init?.method === "PUT" ? Response.json({ ok: true, messageId: "parent-message-1", revision: 2 })
        : Response.json({ state: "sent", messageId: "channel-notice-1" });
    });
    expect((await request(stateBody("IN_REVIEW", "2026-11-04T07:00:00Z"), "a")).status).toBe(200);
    const next = stateBody("REJECTED", "2026-11-04T07:01:00Z");
    expect((await request(next, "b")).status).toBe(503);
    expect((await request(next, "b-retry")).status).toBe(200);
    expect(requests).toHaveLength(4);
    expect(requests[2]).toEqual(requests[1]);
    expect(requests[3]).toMatchObject({ target: "#releases", content: expect.stringContaining("Review rejected") });
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
      return init?.method === "PUT" ? Response.json({ ok: true, messageId: "parent-message-1", revision: 2 })
        : Response.json({ state: "sent", messageId: "channel-notice-1" });
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

  it("delivers later events as warned text while keeping an uncertain update for same-key recovery", async () => {
    const { request, sqlite, updateConfig } = await harness();
    await updateConfig({ card_updates: true });
    const texts: Array<Record<string, unknown>> = [];
    const updates: Array<Record<string, unknown>> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const data = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (String(input).endsWith("/card")) {
        updates.push(data);
        if (updates.length < 3) throw new Error("unknown update result");
        return Response.json({ ok: true, messageId: "parent-message-1", revision: 2 });
      }
      if (data.card) return Response.json({ state: "sent", messageId: "parent-message-1", messageCard: { revision: 1 } });
      texts.push(data);
      return Response.json({ state: "sent", messageId: "text-reply-1" });
    });
    const first = stateBody("IN_REVIEW", "2026-11-04T07:00:00Z");
    const uncertain = stateBody("REJECTED", "2026-11-04T07:01:00Z");
    const later = stateBody("APPROVED", "2026-11-04T07:02:00Z");
    expect((await request(first, "a")).status).toBe(200);
    expect((await request(uncertain, "b")).status).toBe(503);
    expect((await updateConfig({ card_updates: false })).status).toBe(200);
    expect((await request(later, "c")).status).toBe(200);
    expect(texts[0]).toMatchObject({ target: "#releases", content: expect.stringContaining("previous status card may be out of date") });
    expect(sqlite.prepare("SELECT state,pending_uncertain FROM raft_notification_cards").get()).toEqual({ state: "retired", pending_uncertain: 1 });
    expect((await updateConfig({ card_updates: true })).status).toBe(409);
    expect((await request(uncertain, "b-retry")).status).toBe(200);
    expect(updates[2]).toEqual(updates[0]);
    expect((await request(later, "c-retry")).status).toBe(200);
    expect(texts[1]).toMatchObject({ target: "#releases", content: expect.stringContaining("Review rejected") });
    expect(texts[2]).toEqual(texts[0]);
    expect(sqlite.prepare("SELECT state,pending_json FROM raft_notification_cards").get()).toEqual({ state: "retired", pending_json: null });
  });

  it("catches up a card to the newest warned text once its earlier uncertain update is recovered", async () => {
    const { request, sqlite, updateConfig } = await harness();
    await updateConfig({ card_updates: true });
    const updates: Array<Record<string, unknown>> = [];
    const texts = new Map<string, { content: string; messageId: string }>();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const data = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (String(input).endsWith("/card")) {
        updates.push(data);
        if (updates.length < 3) throw new Error("earlier update result unknown");
        return Response.json({ ok: true, messageId: "parent-message-1", revision: Number(data.expectedRevision) + 1 });
      }
      if (data.card) return Response.json({ state: "sent", messageId: "parent-message-1", messageCard: { revision: 1 } });
      const key = String(data.idempotencyKey);
      const previous = texts.get(key);
      if (previous) return previous.content === data.content
        ? Response.json({ state: "committed", messageId: previous.messageId })
        : Response.json({ code: "idempotency_key_reused" }, { status: 409 });
      const message = { content: String(data.content), messageId: `channel-${texts.size + 1}` };
      texts.set(key, message);
      return Response.json({ state: "sent", messageId: message.messageId });
    });
    const first = stateBody("IN_REVIEW", "2026-11-04T07:00:00Z");
    const uncertain = stateBody("REJECTED", "2026-11-04T07:01:00Z");
    const later = stateBody("APPROVED", "2026-11-04T07:02:00Z");
    expect((await request(first, "a")).status).toBe(200);
    expect((await request(uncertain, "b")).status).toBe(503);
    expect((await request(later, "c")).status).toBe(200);
    expect([...texts.values()][0]?.content).toContain("previous status card may be out of date");
    expect((await request(uncertain, "b-retry")).status).toBe(200);
    expect(updates[2]).toEqual(updates[0]);
    expect(updates[3]).toMatchObject({ expectedRevision: 2, content: expect.stringContaining("APPROVED") });
    expect(sqlite.prepare("SELECT state,revision,pending_json FROM raft_notification_cards").get())
      .toEqual({ state: "active", revision: 3, pending_json: null });
    expect([...texts.values()].filter((message) => message.content.includes("APPROVED"))).toHaveLength(1);
    expect([...texts.values()].some((message) => message.content.includes("Review rejected"))).toBe(false);
    expect(texts.size).toBe(1);
  });

  async function pendingUpdateHarness() {
    const h = await harness();
    await h.updateConfig({ card_updates: true });
    const controls = { oldBlocked: true, loseCatchupResponse: false, loseNoticeAt: 0, noticeReplays: 0 };
    const updates: Array<Record<string, unknown>> = [];
    const committedUpdates = new Map<string, number>();
    const texts = new Map<string, { content: string; messageId: string; card: unknown }>();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const data = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (String(input).endsWith("/card")) {
        updates.push(data);
        if (data.expectedRevision === 1 && controls.oldBlocked) throw new Error("earlier update result unknown");
        const key = String(data.idempotencyKey);
        const revision = committedUpdates.get(key) ?? Number(data.expectedRevision) + 1;
        if (!committedUpdates.has(key)) {
          committedUpdates.set(key, revision);
          if (data.expectedRevision === 2 && controls.loseCatchupResponse) {
            controls.loseCatchupResponse = false;
            throw new Error("catch-up committed but response lost");
          }
        }
        return Response.json({ ok: true, messageId: "parent-message-1", revision });
      }
      if (String(data.idempotencyKey).startsWith("hands-card:send:")) return Response.json({ state: "sent", messageId: "parent-message-1", messageCard: { revision: 1 } });
      const key = String(data.idempotencyKey);
      const old = texts.get(key);
      if (old) {
        if (old.content !== data.content || JSON.stringify(old.card ?? null) !== JSON.stringify(data.card ?? null)) return Response.json({ code: "idempotency_key_reused" }, { status: 409 });
        if (old.content.includes("APPROVED")) {
          controls.noticeReplays++;
          if (controls.loseNoticeAt === controls.noticeReplays) throw new Error("notice replay response lost");
        }
        return Response.json({ state: "committed", messageId: old.messageId });
      }
      const message = { content: String(data.content), messageId: `channel-${texts.size + 1}`, card: data.card };
      texts.set(key, message);
      return Response.json({ state: "sent", messageId: message.messageId, ...(data.card ? { messageCard: { revision: 1 } } : {}) });
    });
    const initial = stateBody("IN_REVIEW", "2026-11-04T07:00:00Z");
    const old = stateBody("REJECTED", "2026-11-04T07:01:00Z");
    expect((await h.request(initial, "a")).status).toBe(200);
    expect((await h.request(old, "b")).status).toBe(503);
    return { ...h, old, controls, updates, committedUpdates, texts };
  }

  it("keeps the newest ordered state when later text events arrive out of order", async () => {
    const h = await pendingUpdateHarness();
    const newest = stateBody("APPROVED", "2026-11-04T07:03:00Z");
    const older = stateBody("WAITING_FOR_REVIEW", "2026-11-04T07:02:00Z");
    expect((await h.request(newest, "newest")).status).toBe(200);
    expect((await h.request(older, "older")).status).toBe(200);
    h.controls.oldBlocked = false;
    expect((await h.request(h.old, "b-retry")).status).toBe(200);
    expect(h.updates.at(-1)).toMatchObject({ expectedRevision: 2, content: expect.stringContaining("APPROVED") });
    expect(h.sqlite.prepare("SELECT revision,state FROM raft_notification_cards").get()).toEqual({ revision: 3, state: "active" });
  });

  it("does not guess the order when warned text events have the same timestamp", async () => {
    const h = await pendingUpdateHarness();
    expect((await h.request(stateBody("APPROVED", "2026-11-04T07:02:00Z"), "new-1")).status).toBe(200);
    expect((await h.request(stateBody("WAITING_FOR_REVIEW", "2026-11-04T07:02:00Z"), "new-2")).status).toBe(200);
    h.controls.oldBlocked = false;
    expect((await h.request(h.old, "b-retry")).status).toBe(200);
    expect(h.updates.every((update) => update.expectedRevision === 1)).toBe(true);
    expect(h.sqlite.prepare("SELECT revision,state,pending_json FROM raft_notification_cards").get())
      .toEqual({ revision: 2, state: "retired", pending_json: null });
  });

  it("does not catch up after the destination is switched back to text", async () => {
    const h = await pendingUpdateHarness();
    expect((await h.request(stateBody("APPROVED", "2026-11-04T07:02:00Z"), "new")).status).toBe(200);
    expect((await h.updateConfig({ card_updates: false })).status).toBe(200);
    h.controls.oldBlocked = false;
    expect((await h.request(h.old, "b-retry")).status).toBe(200);
    expect(h.updates.every((update) => update.expectedRevision === 1)).toBe(true);
    expect(h.sqlite.prepare("SELECT revision,state,pending_json FROM raft_notification_cards").get())
      .toEqual({ revision: 2, state: "retired", pending_json: null });
  });

  it("continues on text if a pre-upgrade worker cleared the pending update during rollout", async () => {
    const h = await pendingUpdateHarness();
    expect((await h.request(stateBody("APPROVED", "2026-11-04T07:02:00Z"), "new")).status).toBe(200);
    // An older Worker does not understand deferred state and can clear it
    // while finishing the original request. Do not reactivate that object.
    h.sqlite.prepare("UPDATE raft_notification_cards SET pending_json=NULL,pending_uncertain=0,revision=2,state='retired'").run();
    expect((await h.request(stateBody("WAITING_FOR_REVIEW", "2026-11-04T07:03:00Z"), "later")).status).toBe(200);
    expect(h.updates.every((update) => update.expectedRevision === 1)).toBe(true);
    expect(h.sqlite.prepare("SELECT revision,state,pending_json FROM raft_notification_cards").get())
      .toEqual({ revision: 2, state: "retired", pending_json: null });
  });

  it("does not queue a catch-up update outside the card update window", async () => {
    const h = await pendingUpdateHarness();
    expect((await h.request(stateBody("APPROVED", "2026-11-04T07:02:00Z"), "new")).status).toBe(200);
    h.sqlite.prepare("UPDATE raft_notification_cards SET message_created_at=?").run(Date.now() - 15 * 24 * 60 * 60_000);
    h.controls.oldBlocked = false;
    expect((await h.request(h.old, "b-retry")).status).toBe(200);
    expect(h.updates.every((update) => update.expectedRevision === 1)).toBe(true);
    expect(h.sqlite.prepare("SELECT revision,state,pending_json FROM raft_notification_cards").get())
      .toEqual({ revision: 2, state: "retired", pending_json: null });
  });

  it("leaves the card on text when a later event lacks an orderable timestamp", async () => {
    const h = await pendingUpdateHarness();
    expect((await h.request(stateBody("APPROVED", "2026-11-04T07:02:00Z"), "new")).status).toBe(200);
    expect((await h.request(body("WAITING_FOR_REVIEW"), "unknown-time")).status).toBe(200);
    h.controls.oldBlocked = false;
    expect((await h.request(h.old, "b-retry")).status).toBe(200);
    expect(h.updates.every((update) => update.expectedRevision === 1)).toBe(true);
    expect(h.sqlite.prepare("SELECT revision,state,pending_json FROM raft_notification_cards").get())
      .toEqual({ revision: 2, state: "retired", pending_json: null });
  });

  it("replays a committed catch-up with its original key after its response is lost", async () => {
    const h = await pendingUpdateHarness();
    expect((await h.request(stateBody("APPROVED", "2026-11-04T07:02:00Z"), "new")).status).toBe(200);
    h.controls.oldBlocked = false;
    h.controls.loseCatchupResponse = true;
    expect((await h.request(h.old, "b-retry-1")).status).toBe(503);
    expect(h.sqlite.prepare("SELECT pending_uncertain FROM raft_notification_cards").pluck().get()).toBe(1);
    expect((await h.request(h.old, "b-retry-2")).status).toBe(200);
    const catchups = h.updates.filter((update) => update.expectedRevision === 2);
    expect(catchups).toHaveLength(2);
    expect(catchups[1]).toEqual(catchups[0]);
    expect(h.committedUpdates.size).toBe(2);
    expect([...h.texts.values()].filter((message) => message.content.includes("APPROVED"))).toHaveLength(1);
    expect(h.sqlite.prepare("SELECT revision,state,pending_json FROM raft_notification_cards").get())
      .toEqual({ revision: 3, state: "active", pending_json: null });
  });

  it("keeps the older update pending if the newer channel notice cannot be confirmed", async () => {
    const h = await pendingUpdateHarness();
    expect((await h.request(stateBody("APPROVED", "2026-11-04T07:02:00Z"), "new")).status).toBe(200);
    h.controls.oldBlocked = false;
    h.controls.loseNoticeAt = 1;
    expect((await h.request(h.old, "b-retry-1")).status).toBe(503);
    expect(h.updates.filter((update) => update.expectedRevision === 2)).toHaveLength(0);
    expect(h.sqlite.prepare("SELECT pending_uncertain FROM raft_notification_cards").pluck().get()).toBe(1);
    expect((await h.request(h.old, "b-retry-2")).status).toBe(200);
    expect(h.updates.filter((update) => update.expectedRevision === 2)).toHaveLength(1);
    expect([...h.texts.values()].filter((message) => message.content.includes("APPROVED"))).toHaveLength(1);
  });

  it("retains the catch-up until the existing channel notice is confirmed", async () => {
    const h = await pendingUpdateHarness();
    expect((await h.request(stateBody("APPROVED", "2026-11-04T07:02:00Z"), "new")).status).toBe(200);
    h.controls.oldBlocked = false;
    h.controls.loseNoticeAt = 2;
    expect((await h.request(h.old, "b-retry-1")).status).toBe(503);
    expect(h.sqlite.prepare("SELECT pending_uncertain FROM raft_notification_cards").pluck().get()).toBe(1);
    expect((await h.request(h.old, "b-retry-2")).status).toBe(200);
    const catchups = h.updates.filter((update) => update.expectedRevision === 2);
    expect(catchups).toHaveLength(2);
    expect(catchups[1]).toEqual(catchups[0]);
    expect([...h.texts.values()].filter((message) => message.content.includes("APPROVED"))).toHaveLength(1);
    expect(h.sqlite.prepare("SELECT revision,state,pending_json FROM raft_notification_cards").get())
      .toEqual({ revision: 3, state: "active", pending_json: null });
  });

  it("posts one newer channel notice when its fallback is still in flight during recovery", async () => {
    const { request, sqlite, updateConfig } = await harness();
    await updateConfig({ card_updates: true });
    const texts = new Map<string, { content: string; messageId: string }>();
    const updates: Array<Record<string, unknown>> = [];
    let releaseFallback: (() => void) | undefined;
    let fallbackStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { fallbackStarted = resolve; });
    const held = new Promise<void>((resolve) => { releaseFallback = resolve; });
    let heldOnce = false;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const data = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (String(input).endsWith("/card")) {
        updates.push(data);
        if (updates.length < 3) throw new Error("older update uncertain");
        return Response.json({ ok: true, messageId: "parent-message-1", revision: Number(data.expectedRevision) + 1 });
      }
      if (data.card) return Response.json({ state: "sent", messageId: "parent-message-1", messageCard: { revision: 1 } });
      if (String(data.content).includes("APPROVED") && !heldOnce) {
        heldOnce = true;
        fallbackStarted?.();
        await held;
      }
      const key = String(data.idempotencyKey);
      const old = texts.get(key);
      if (old) return old.content === data.content ? Response.json({ state: "committed", messageId: old.messageId })
        : Response.json({ code: "idempotency_key_reused" }, { status: 409 });
      const message = { content: String(data.content), messageId: `channel-${texts.size + 1}` };
      texts.set(key, message);
      return Response.json({ state: "sent", messageId: message.messageId });
    });
    const old = stateBody("REJECTED", "2026-11-04T07:01:00Z");
    expect((await request(stateBody("IN_REVIEW", "2026-11-04T07:00:00Z"), "a")).status).toBe(200);
    expect((await request(old, "b")).status).toBe(503);
    const later = request(stateBody("APPROVED", "2026-11-04T07:02:00Z"), "c");
    await started;
    let recoveryStatus: number;
    try { recoveryStatus = (await request(old, "b-retry")).status; }
    finally { releaseFallback?.(); }
    expect(recoveryStatus).toBe(200);
    expect((await later).status).toBe(200);
    expect(texts.size).toBe(1);
    expect([...texts.values()][0]?.content).toContain("APPROVED");
    expect(updates.at(-1)).toMatchObject({ expectedRevision: 2, content: expect.stringContaining("APPROVED") });
    expect(sqlite.prepare("SELECT revision,state FROM raft_notification_cards").get()).toEqual({ revision: 3, state: "active" });
  });

  it("fences an uncertain root with same-key text before posting later events", async () => {
    const { request, sqlite, updateConfig } = await harness();
    await updateConfig({ card_updates: true });
    let sendCount = 0;
    const requests: Array<Record<string, unknown>> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      const data = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requests.push(data);
      if (data.reconcileOnly) return Response.json({ state: "not_found" });
      if (data.card) {
        sendCount++;
        if (sendCount === 1) throw new Error("unknown send result");
        return Response.json({ code: "message_cards_disabled" }, { status: 400 });
      }
      return Response.json({ state: "sent", messageId: data.target === "#releases" ? "text-parent-1" : "reply-1" });
    });
    const first = stateBody("IN_REVIEW", "2026-11-04T07:00:00Z");
    expect((await request(first, "a")).status).toBe(503);
    sqlite.prepare("UPDATE raft_notification_threads SET updated_at=1").run();
    expect((await request(stateBody("REJECTED", "2026-11-04T07:01:00Z"), "b")).status).toBe(200);
    expect(sqlite.prepare("SELECT parent_message_id FROM raft_notification_threads").pluck().get()).toBe("text-parent-1");
    expect((await request(first, "a-retry")).status).toBe(200);
    expect(requests[3]).toMatchObject({ target: "#releases", idempotencyKey: requests[0]!.idempotencyKey });
    expect(requests[3]).not.toHaveProperty("card");
    expect(requests[4]).toMatchObject({ target: "#releases", content: expect.stringContaining("previous status card may be out of date") });
    expect(requests).toHaveLength(5); // Retry of the fenced first event did not post again.
    expect(sqlite.prepare("SELECT state,pending_json FROM raft_notification_cards").get()).toEqual({ state: "retired", pending_json: null });
  });

  it("lets same-key text win while an earlier card request is still running", async () => {
    const { request, sqlite, updateConfig } = await harness();
    await updateConfig({ card_updates: true });
    let now = Date.parse("2026-11-04T07:00:00Z");
    vi.spyOn(Date, "now").mockImplementation(() => now);
    let releaseOld: ((value: Response) => void) | undefined;
    let signalStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { signalStarted = resolve; });
    const calls: Array<Record<string, unknown>> = [];
    let firstCardKey: unknown;
    let committedText = false;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      const data = JSON.parse(String(init?.body)) as Record<string, unknown>;
      calls.push(data);
      if (data.card && !firstCardKey) {
        firstCardKey = data.idempotencyKey;
        signalStarted?.();
        return new Promise<Response>((resolve) => { releaseOld = resolve; });
      }
      if (data.reconcileOnly) return Response.json({ state: "not_found" });
      if (data.card) throw new Error("retry response lost");
      if (data.idempotencyKey === firstCardKey) {
        expect(committedText).toBe(false);
        committedText = true;
        return Response.json({ state: "sent", messageId: "text-parent-1" });
      }
      return Response.json({ state: "sent", messageId: "text-reply-1" });
    });
    const first = request(stateBody("IN_REVIEW", "2026-11-04T07:00:00Z"), "a");
    await started;
    now += 6 * 60_000;
    expect((await request(stateBody("APPROVED", "2026-11-04T07:01:00Z"), "b")).status).toBe(200);
    expect(committedText).toBe(true);
    expect(calls[3]).toMatchObject({ target: "#releases", idempotencyKey: firstCardKey });
    expect(calls[3]).not.toHaveProperty("card");
    if (!releaseOld) throw new Error("old card request did not start");
    // Model Raft's sender+key uniqueness: the late card loses to the text.
    releaseOld(Response.json({ code: "idempotency_key_reused" }, { status: 409 }));
    expect((await first).status).toBe(503);
    expect(sqlite.prepare("SELECT parent_message_id FROM raft_notification_threads").pluck().get()).toBe("text-parent-1");
    expect(sqlite.prepare("SELECT state,pending_json FROM raft_notification_cards").get()).toEqual({ state: "retired", pending_json: null });
  });

  it("retries a lost text-fence response with the same key and does not send the event twice", async () => {
    const { request, sqlite, updateConfig } = await harness();
    await updateConfig({ card_updates: true });
    const calls: Array<Record<string, unknown>> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      const data = JSON.parse(String(init?.body)) as Record<string, unknown>;
      calls.push(data);
      if (calls.length <= 2) throw new Error("response lost after commit");
      return Response.json({ state: "sent", messageId: "text-parent-1" });
    });
    const event = stateBody("IN_REVIEW", "2026-11-04T07:00:00Z");
    expect((await request(event, "a")).status).toBe(503);
    expect((await updateConfig({ card_updates: false })).status).toBe(200);
    sqlite.prepare("UPDATE raft_notification_threads SET updated_at=1").run();
    expect((await request(event, "b")).status).toBe(503);
    sqlite.prepare("UPDATE raft_notification_threads SET updated_at=1").run();
    expect((await request(event, "c")).status).toBe(200);
    expect(calls[1]).toEqual(calls[2]);
    expect(calls[1]).toMatchObject({ idempotencyKey: calls[0]!.idempotencyKey });
    expect(calls[1]).not.toHaveProperty("card");
    expect((await request(event, "d")).status).toBe(200);
    expect(calls).toHaveLength(3);
  });

  it("lets an app admin retry an exhausted internal delivery with the same body, key and an audit entry", async () => {
    const { request, sqlite, env, app, updateConfig, failures, retryFailure } = await harness();
    await updateConfig({ card_updates: true });
    const calls: Array<Record<string, unknown>> = [];
    mockRaftFetch(async (_input, init) => {
      calls.push(JSON.parse(String(init?.body)));
      if (calls.length === 1) throw new Error("response lost");
      return Response.json({ state: "committed", messageId: "parent-message-1" });
    });
    const event = stateBody("IN_REVIEW", "2026-11-04T07:00:00Z");
    expect((await request(event, "original")).status).toBe(503);
    const raw = JSON.stringify(event);
    sqlite.prepare(`INSERT INTO webhook_deliveries
      (id,webhook_id,event_type,payload_json,signing_secret,status,attempts,max_attempts,created_at,updated_at)
      VALUES ('failed-1','webhook-1',?,?,'old-secret','failed',3,3,1,1)`).run(event.event, raw);
    const listing = await failures();
    expect(await listing.json()).toEqual({ failures: [{ id: "failed-1", event_type: event.event, created_at: 1,
      last_attempt_at: null, last_response_status: null }] });
    expect((await failures("another-app")).status).toBe(404);
    expect((await retryFailure("failed-1", "another-app")).status).toBe(404);
    const scheduled = await retryFailure("failed-1");
    expect(scheduled.status).toBe(202);
    const { delivery_id: retryId } = await scheduled.json() as { delivery_id: string };
    expect((await retryFailure("failed-1")).status).toBe(409);
    expect(sqlite.prepare("SELECT payload_json,signing_secret,status FROM webhook_deliveries WHERE id=?").get(retryId))
      .toEqual({ payload_json: raw, signing_secret: SECRET, status: "pending" });
    expect(sqlite.prepare("SELECT action,payload FROM audit_logs").all()).toEqual([{
      action: "raft_notification.retry",
      payload: JSON.stringify({ subscription_id: SUBSCRIPTION_ID, failed_delivery_id: "failed-1", retry_delivery_id: retryId }),
    }]);
    // Even if the event is no longer subscribed, the old in-flight operation
    // still has to be reconciled before it can be forgotten.
    sqlite.prepare("UPDATE raft_notification_subscriptions SET events_json='[\"build:failed\"]'").run();
    sqlite.prepare("UPDATE raft_notification_threads SET updated_at=1").run();
    const fetchInternal: typeof fetch = async (input, init) => app.fetch(new Request(input, init), env);
    const summary = await reapWebhookDeliveries(env, { fetchImpl: fetchInternal, now: Date.now() + 1_000 });
    expect(summary.succeeded).toBe(1);
    expect(sqlite.prepare("SELECT status FROM webhook_deliveries WHERE id=?").pluck().get(retryId)).toBe("succeeded");
    expect(calls[1]).toMatchObject({ reconcileOnly: true, idempotencyKey: calls[0]!.idempotencyKey });
    expect(sqlite.prepare("SELECT pending_json FROM raft_notification_cards").pluck().get()).toBeNull();
    expect(await (await failures()).json()).toEqual({ failures: [] });
  });

  it.each(["appgallery:invitation_state_changed", "appgallery:package_state_changed"])(
    "lists and schedules an audited retry for a failed %s delivery", async (eventType) => {
      const { sqlite, failures, retryFailure } = await harness();
      const payload = JSON.stringify({ event: eventType, payload: { state: "processing" } });
      sqlite.prepare(`INSERT INTO webhook_deliveries
        (id,webhook_id,event_type,payload_json,signing_secret,status,attempts,max_attempts,created_at,updated_at)
        VALUES ('failed-agc','webhook-1',?,?,'old-secret','failed',3,3,1,1)`).run(eventType, payload);
      expect(await (await failures()).json()).toEqual({ failures: [{ id: "failed-agc", event_type: eventType,
        created_at: 1, last_attempt_at: null, last_response_status: null }] });
      const response = await retryFailure("failed-agc");
      expect(response.status).toBe(202);
      const { delivery_id: retryId } = await response.json() as { delivery_id: string };
      expect(sqlite.prepare("SELECT event_type,payload_json,signing_secret,status FROM webhook_deliveries WHERE id=?").get(retryId))
        .toEqual({ event_type: eventType, payload_json: payload, signing_secret: SECRET, status: "pending" });
      expect(sqlite.prepare("SELECT COUNT(*) FROM audit_logs WHERE action='raft_notification.retry'").pluck().get()).toBe(1);
      expect((await retryFailure("failed-agc")).status).toBe(409);
    },
  );

  it("does not queue a retry without its audit record or for a disabled destination", async () => {
    const { sqlite, retryFailure } = await harness();
    const event = stateBody("IN_REVIEW", "2026-11-04T07:00:00Z");
    sqlite.prepare(`INSERT INTO webhook_deliveries
      (id,webhook_id,event_type,payload_json,status,attempts,max_attempts,created_at,updated_at)
      VALUES ('failed-1','webhook-1',?,?,'failed',3,3,1,1)`).run(event.event, JSON.stringify(event));
    sqlite.prepare("UPDATE raft_notification_subscriptions SET enabled=0").run();
    expect((await retryFailure("failed-1")).status).toBe(409);
    sqlite.prepare("UPDATE raft_notification_subscriptions SET enabled=1").run();
    sqlite.exec("CREATE TRIGGER reject_audit BEFORE INSERT ON audit_logs BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END");
    expect((await retryFailure("failed-1")).status).toBe(503);
    expect(sqlite.prepare("SELECT COUNT(*) FROM webhook_deliveries WHERE status='pending'").pluck().get()).toBe(0);
  });

  it("queues only one audited retry for simultaneous admin requests", async () => {
    const { sqlite, retryFailure } = await harness();
    const event = stateBody("IN_REVIEW", "2026-11-04T07:00:00Z");
    sqlite.prepare(`INSERT INTO webhook_deliveries
      (id,webhook_id,event_type,payload_json,status,attempts,max_attempts,created_at,updated_at)
      VALUES ('failed-1','webhook-1',?,?,'failed',3,3,1,1)`).run(event.event, JSON.stringify(event));
    const responses = await Promise.all([retryFailure("failed-1"), retryFailure("failed-1")]);
    expect(responses.map((response) => response.status).sort()).toEqual([202, 409]);
    expect(sqlite.prepare("SELECT COUNT(*) FROM webhook_deliveries WHERE status='pending'").pluck().get()).toBe(1);
    expect(sqlite.prepare("SELECT COUNT(*) FROM audit_logs").pluck().get()).toBe(1);
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
      return init?.method === "PUT" ? Response.json({ ok: true, messageId: "parent-message-1", revision: 2 })
        : Response.json({ state: "sent", messageId: "channel-notice-1" });
    });
    expect((await request(stateBody("IN_REVIEW", "2026-11-04T07:00:00Z"), "a")).status).toBe(503);
    sqlite.prepare("UPDATE raft_notification_threads SET updated_at=1").run();
    expect((await request(stateBody("REJECTED", "2026-11-04T07:01:00Z"), "b")).status).toBe(200);
    expect(requests).toHaveLength(4);
    expect(requests[1]).toMatchObject({ reconcileOnly: true, idempotencyKey: requests[0]!.idempotencyKey });
    expect(requests[2]).toMatchObject({ expectedRevision: 1, content: expect.stringContaining("Review rejected") });
    expect(requests[3]).toMatchObject({ target: "#releases", content: expect.stringContaining("Review rejected") });
    expect(sqlite.prepare("SELECT parent_message_id FROM raft_notification_threads").pluck().get()).toBe("parent-message-1");
  });

  it("serializes concurrent notifications and retains an in-flight send when cards are disabled", async () => {
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
    expect((await updateConfig({ card_updates: false })).status).toBe(200);
    expect((await updateConfig({ card_updates: true })).status).toBe(409);
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
      const data = JSON.parse(String(init?.body)) as Record<string, unknown>;
      calls.push(data);
      if (calls.length === 1) return Response.json({ state: "sent", messageId: "parent-message-1" });
      if (calls.length === 2) {
        signalStarted?.();
        return new Promise<Response>((resolve) => { releaseOld = resolve; });
      }
      if (init?.method !== "PUT") return Response.json({ state: "sent", messageId: `notice-${calls.length}` });
      return Response.json({ ok: true, messageId: "parent-message-1", revision: Number(data.expectedRevision) + 1 });
    });
    expect((await request(stateBody("IN_REVIEW", "2026-11-04T07:00:00Z"), "a")).status).toBe(200);
    const old = request(stateBody("REJECTED", "2026-11-04T07:01:00Z"), "b");
    await started;
    now += 31_000;
    expect((await request(stateBody("APPROVED", "2026-11-04T07:02:00Z"), "c")).status).toBe(200);
    expect(calls[2]).toEqual(calls[1]);
    expect(calls[3]).toMatchObject({ target: "#releases", content: expect.stringContaining("Review rejected") });
    expect(calls[4]).toMatchObject({ expectedRevision: 2, content: expect.stringContaining("APPROVED") });
    expect(calls[5]).toMatchObject({ target: "#releases", content: expect.stringContaining("APPROVED") });
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
    expect(calls[1]!.body).toMatchObject({ target: "#releases" });
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
    expect(calls[1]).toMatchObject({ target: "#releases" });
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

  it("sends a new card to the channel after the update window", async () => {
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
    expect(calls[1]).toMatchObject({ target: "#releases", card: { version: 1 } });
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
    expect(sent[0]!.content).toContain("📮 **New feedback · Sample App**");
    expect(sent[1]!.content).toContain(`[View feedback](https://hands.test/apps/${APP_ID}/feedback/${TICKET_ID})`);
    expect(sent[1]!.content).not.toContain("hands feedback show");
    expect(sent[1]!.content).not.toContain("Private comment");
    expect(sent[2]!.content).toContain("Status: open → resolved");
    expect(sent[2]!.content).toContain("[View feedback]");
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
