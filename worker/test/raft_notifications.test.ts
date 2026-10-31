import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { encryptP8 } from "../src/lib/asc_credentials";
import {
  formatRaftNotificationMessage,
  handleConnectRaftBot,
  handleGetRaftNotifications,
  handleRaftNotificationWebhook,
  notificationObjectKey,
} from "../src/routes/raft_notifications";
import { hmacSha256Hex } from "../src/routes/webhooks";

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
    CREATE TABLE apps (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE webhooks (id TEXT PRIMARY KEY, secret TEXT NOT NULL, enabled INTEGER NOT NULL, archived_at INTEGER);
    CREATE TABLE raft_notification_subscriptions (
      id TEXT PRIMARY KEY, app_id TEXT NOT NULL, server_id TEXT NOT NULL,
      channel_target TEXT NOT NULL, events_json TEXT NOT NULL, enabled INTEGER NOT NULL,
      webhook_id TEXT NOT NULL, created_by TEXT, created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL, archived_at INTEGER
    );
    CREATE TABLE raft_bot_installations (
      id TEXT PRIMARY KEY, app_id TEXT NOT NULL, server_id TEXT NOT NULL,
      installation_id TEXT NOT NULL, credential_id TEXT NOT NULL, agent_id TEXT,
      handle TEXT, key_ciphertext_b64 TEXT NOT NULL, key_iv_b64 TEXT NOT NULL,
      state TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      UNIQUE(app_id, server_id)
    );
    CREATE TABLE raft_notification_threads (
      subscription_id TEXT NOT NULL, object_key TEXT NOT NULL,
      parent_message_id TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      PRIMARY KEY(subscription_id, object_key)
    );
  `);
  sqlite.prepare("INSERT INTO organizations (id, external_provider, external_id) VALUES ('org-1', 'raft', 'server-1')").run();
  sqlite.prepare("INSERT INTO apps (id, org_id, archived) VALUES (?, 'org-1', 0)").run(APP_ID);
  sqlite.prepare("INSERT INTO webhooks (id, secret, enabled, archived_at) VALUES ('webhook-1', ?, 1, NULL)").run(SECRET);
  sqlite.prepare(
    `INSERT INTO raft_notification_subscriptions
       (id, app_id, server_id, channel_target, events_json, enabled, webhook_id, created_at, updated_at)
     VALUES (?, ?, 'server-1', '#releases', '["app_store:version_state_changed"]', 1, 'webhook-1', 1, 1)`,
  ).run(SUBSCRIPTION_ID, APP_ID);
  const encrypted = await encryptP8(BOT_KEY, "enc-secret");
  sqlite.prepare(
    `INSERT INTO raft_bot_installations
       (id, app_id, server_id, installation_id, credential_id, agent_id, handle,
        key_ciphertext_b64, key_iv_b64, state, created_at, updated_at)
     VALUES ('bot-1', ?, 'server-1', 'installation-1', 'credential-1', 'agent-1', 'hands-bot', ?, ?, 'active', 1, 1)`,
  ).run(APP_ID, encrypted.ciphertext_b64, encrypted.iv_b64);
  const env = {
    DB: d1(sqlite),
    RAFT_API_ORIGIN: "https://api.raft.test",
    RAFT_CLIENT_ID: "hands-client",
    RAFT_CLIENT_SECRET: "client-secret",
    RAFT_BOT_ENC_KEY: "enc-secret",
  } as unknown as Env;
  const app = new Hono<{ Bindings: Env }>();
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
  const connect = (rotate = false) => app.fetch(new Request(`https://hands.test/api/apps/${APP_ID}/raft-notifications/connect`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ rotate }),
  }), env);
  return { sqlite, env, request, getConfig, connect };
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
    const response = await connect(true);
    const text = await response.text();
    expect(response.status).toBe(200);
    expect(text).not.toContain("sk_agent_replacement");
    expect(provider).toHaveBeenCalledTimes(2);
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
});
