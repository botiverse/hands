import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { encryptP8 } from "../src/lib/asc_credentials";
import { buildFeedbackCommentEvent, buildFeedbackStatusEvent } from "../src/lib/feedback_events";
import {
  formatRaftNotificationMessage,
  handleConnectRaftBot,
  handleGetRaftNotifications,
  handleRaftNotificationWebhook,
  notificationObjectKey,
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
  return { sqlite, env, request, getConfig, connect, mutateHiddenWebhook };
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

const TICKET_ID = "38d49b32-9499-40d2-ad45-3a23dd8c37f7";
const feedbackBody = (event: string, extra: Record<string, unknown> = {}) => ({
  event,
  app_id: "abad63e9-e760-42e9-92df-f418735f32ea",
  delivered_at: 100,
  payload: { ticket_id: TICKET_ID, ...extra },
});

afterEach(() => vi.restoreAllMocks());

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
