// Organization rename and ownership transfer, and webhook secret rotation and
// test deliveries, for org admins (and app admins for app webhooks).
import Database from "better-sqlite3";
import { createHash, createHmac } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { requireAppRole, requireOrgRole } from "../src/lib/permissions";
import { authMiddleware, type AdminEnv } from "../src/middleware/auth";
import { handleTransferOrgOwnership, handleUpdateOrg } from "../src/routes/orgs";
import { upsertRaftOrgMembership } from "../src/routes/auth";
import {
  handleRotateAppWebhookSecret,
  handleRotateWebhookSecret,
  handleTestAppWebhook,
  handleTestWebhook,
} from "../src/routes/webhooks";

const migrationDir = fileURLToPath(new URL("../../migrations/sql/", import.meta.url));

function d1(sqlite: Database.Database): D1Database {
  const prepare = (sql: string) => {
    const indexes: number[] = [];
    const statement = sqlite.prepare(
      sql.replace(/\?(\d+)/g, (_m, index) => {
        indexes.push(Number(index));
        return "?";
      }),
    );
    const bind = (...parameters: unknown[]) => {
      const expanded = indexes.length ? indexes.map((index) => parameters[index - 1]) : parameters;
      const runSync = () => ({ success: true, meta: { changes: statement.run(...expanded).changes } });
      return {
        _batchSync: () => (statement.reader ? { success: true, results: statement.all(...expanded) } : runSync()),
        run: async () => runSync(),
        all: async () => ({ success: true, results: statement.all(...expanded) }),
        first: async (column?: string) => {
          const row = statement.get(...expanded) as Record<string, unknown> | undefined;
          return column ? row?.[column] ?? null : row ?? null;
        },
      };
    };
    return { bind, run: () => bind().run(), all: () => bind().all(), first: () => bind().first() };
  };
  return {
    prepare,
    batch: async (statements: Array<{ _batchSync: () => unknown }>) =>
      sqlite.transaction(() => statements.map((statement) => statement._batchSync()))(),
  } as unknown as D1Database;
}

const sha = (value: string) => createHash("sha256").update(value).digest("hex");

function harness() {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  for (const name of readdirSync(migrationDir).sort()) {
    if (name.endsWith(".sql")) sqlite.exec(readFileSync(`${migrationDir}${name}`, "utf8"));
  }
  const now = Date.now();
  const org = sqlite.prepare(
    `INSERT INTO organizations (id, slug, name, raft_name, external_provider, external_id, created_at, archived)
     VALUES (?, ?, ?, ?, 'raft', ?, ?, 0)`,
  );
  org.run("raft_server-a", "org-a", "server-a", "server-a", "server-a", now);
  org.run("org-b", "org-b", "Org B", "Org B", "server-b", now);
  const account = sqlite.prepare(
    `INSERT INTO raft_accounts
     (id, provider, provider_subject, server_id, server_slug, principal_type, server_role,
      username, display_name, avatar_url, raw_profile, created_at, updated_at, last_login_at)
     VALUES (?, 'raft', ?, 'server-a', 'server-a', 'human', 'member', ?, ?, NULL, '{}', ?, ?, ?)`,
  );
  const member = sqlite.prepare(
    "INSERT INTO org_members (id, org_id, account_id, org_role, joined_at) VALUES (?, ?, ?, ?, ?)",
  );
  const session = sqlite.prepare(
    "INSERT INTO raft_sessions (id, account_id, token_hash, created_at, expires_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)",
  );
  for (const [id, role] of [["owner", "owner"], ["admin", "admin"], ["member", "member"]] as const) {
    account.run(id, `${id}-sub`, id, id, now, now, now);
    member.run(`om-${id}`, "raft_server-a", id, role, now);
    session.run(`s-${id}`, id, sha(`tok-${id}`), now, now + 60_000, now);
  }
  account.run("outsider", "outsider-sub", "outsider", "outsider", now, now, now);
  session.run("s-outsider", "outsider", sha("tok-outsider"), now, now + 60_000, now);
  sqlite.prepare("INSERT INTO apps (id, org_id, slug, name, platform, created_at) VALUES ('app-1', 'raft_server-a', 'app-1', 'App', 'android', ?)").run(now);
  sqlite.prepare("INSERT INTO app_members (id, app_id, account_id, app_role, joined_at) VALUES ('am', 'app-1', 'member', 'admin', ?)").run(now);
  const webhook = sqlite.prepare(
    `INSERT INTO webhooks (id, org_id, app_id, url, secret, events_json, enabled, created_by, created_at, updated_at, archived_at)
     VALUES (?, ?, ?, 'https://hooks.example/x', 'old-secret', '[]', ?, 'admin', ?, ?, ?)`,
  );
  webhook.run("wh-a", "raft_server-a", null, 1, now, now, null);
  webhook.run("wh-paused", "raft_server-a", null, 0, now, now, null);
  webhook.run("wh-gone", "raft_server-a", null, 1, now, now, now);
  webhook.run("wh-b", "org-b", null, 1, now, now, null);
  webhook.run("wh-app", "raft_server-a", "app-1", 1, now, now, null);

  const db = d1(sqlite);
  const env = { DB: db, ENVIRONMENT: "test" } as unknown as Env;
  const app = new Hono<AdminEnv & { Bindings: Env }>();
  app.use("*", authMiddleware);
  app.patch("/api/orgs/:orgId", requireOrgRole("orgId", "admin"), handleUpdateOrg);
  app.post("/api/orgs/:orgId/transfer-ownership", requireOrgRole("orgId", "owner"), handleTransferOrgOwnership);
  app.post("/api/orgs/:orgId/webhooks/:webhookId/rotate-secret", requireOrgRole("orgId", "admin"), handleRotateWebhookSecret);
  app.post("/api/orgs/:orgId/webhooks/:webhookId/test", requireOrgRole("orgId", "admin"), handleTestWebhook);
  app.post("/api/apps/:appId/webhooks/:webhookId/rotate-secret", requireAppRole("admin"), handleRotateAppWebhookSecret);
  app.post("/api/apps/:appId/webhooks/:webhookId/test", requireAppRole("admin"), handleTestAppWebhook);
  const call = (who: string, method: string, path: string, body: unknown = {}) =>
    app.fetch(new Request(`https://hands.test${path}`, {
      method,
      headers: { authorization: `Bearer tok-${who}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    }), env);
  const row = <T>(sql: string, ...args: unknown[]) => sqlite.prepare(sql).get(...args) as T;
  return { sqlite, db, call, row };
}

const signIn = (db: D1Database, serverSlug: string) =>
  upsertRaftOrgMembership(db, {
    id: "owner", server_id: "server-a", server_slug: serverSlug, principal_type: "human", server_role: "member",
  } as unknown as Parameters<typeof upsertRaftOrgMembership>[1]);

afterEach(() => vi.unstubAllGlobals());

describe("organization rename", () => {
  it("keeps a name set in Hands through sign-in and can hand it back to Raft", async () => {
    const h = harness();
    const org = () => h.row<{ name: string; raft_name: string; name_customized: number }>(
      "SELECT name, raft_name, name_customized FROM organizations WHERE id = 'raft_server-a'");

    await signIn(h.db, "server-renamed");
    expect(org()).toEqual({ name: "server-renamed", raft_name: "server-renamed", name_customized: 0 });

    const renamed = await h.call("admin", "PATCH", "/api/orgs/raft_server-a", { name: "  Botiverse  " });
    expect(renamed.status).toBe(200);
    expect(org()).toEqual({ name: "Botiverse", raft_name: "server-renamed", name_customized: 1 });

    await signIn(h.db, "server-again");
    expect(org()).toEqual({ name: "Botiverse", raft_name: "server-again", name_customized: 1 });

    expect((await h.call("admin", "PATCH", "/api/orgs/raft_server-a", { name: null })).status).toBe(200);
    expect(org()).toEqual({ name: "server-again", raft_name: "server-again", name_customized: 0 });
  });

  it("refuses members, outsiders and bad names", async () => {
    const h = harness();
    expect((await h.call("member", "PATCH", "/api/orgs/raft_server-a", { name: "X" })).status).toBe(403);
    expect((await h.call("outsider", "PATCH", "/api/orgs/raft_server-a", { name: "X" })).status).toBe(403);
    expect((await h.call("admin", "PATCH", "/api/orgs/raft_server-a", { name: "   " })).status).toBe(400);
    expect((await h.call("admin", "PATCH", "/api/orgs/raft_server-a", { name: "x".repeat(81) })).status).toBe(400);
    expect((await h.call("admin", "PATCH", "/api/orgs/raft_server-a", { name: 3 })).status).toBe(400);
    expect(h.row<{ name: string }>("SELECT name FROM organizations WHERE id = 'raft_server-a'").name).toBe("server-a");
  });
});

describe("organization ownership transfer", () => {
  const roles = (h: ReturnType<typeof harness>) =>
    Object.fromEntries((h.sqlite.prepare("SELECT account_id, org_role FROM org_members ORDER BY account_id").all() as Array<{ account_id: string; org_role: string }>)
      .map((r) => [r.account_id, r.org_role]));

  it("makes the member owner and the caller admin in one step", async () => {
    const h = harness();
    const res = await h.call("owner", "POST", "/api/orgs/raft_server-a/transfer-ownership", { account_id: "member" });
    expect(res.status).toBe(200);
    expect(roles(h)).toEqual({ admin: "admin", member: "owner", owner: "admin" });
  });

  it("is owner only and needs a member other than the caller", async () => {
    const h = harness();
    expect((await h.call("admin", "POST", "/api/orgs/raft_server-a/transfer-ownership", { account_id: "member" })).status).toBe(403);
    expect((await h.call("owner", "POST", "/api/orgs/raft_server-a/transfer-ownership", { account_id: "outsider" })).status).toBe(404);
    expect((await h.call("owner", "POST", "/api/orgs/raft_server-a/transfer-ownership", { account_id: "owner" })).status).toBe(400);
    expect((await h.call("owner", "POST", "/api/orgs/raft_server-a/transfer-ownership", {})).status).toBe(400);
    expect(roles(h)).toEqual({ admin: "admin", member: "member", owner: "owner" });
  });
});

describe("webhook secret rotation", () => {
  it("returns a new secret once and stores it", async () => {
    const h = harness();
    const res = await h.call("admin", "POST", "/api/orgs/raft_server-a/webhooks/wh-a/rotate-secret");
    expect(res.status).toBe(200);
    const { secret } = (await res.json()) as { secret: string };
    expect(secret).toMatch(/^whsec_[0-9a-f]{64}$/);
    expect(h.row<{ secret: string }>("SELECT secret FROM webhooks WHERE id = 'wh-a'").secret).toBe(secret);
  });

  it("stays inside its scope", async () => {
    const h = harness();
    expect((await h.call("member", "POST", "/api/orgs/raft_server-a/webhooks/wh-a/rotate-secret")).status).toBe(403);
    expect((await h.call("admin", "POST", "/api/orgs/raft_server-a/webhooks/wh-b/rotate-secret")).status).toBe(404);
    expect((await h.call("admin", "POST", "/api/orgs/raft_server-a/webhooks/wh-gone/rotate-secret")).status).toBe(404);
    // An app admin reaches the app's webhook, not the org-wide one.
    expect((await h.call("member", "POST", "/api/apps/app-1/webhooks/wh-a/rotate-secret")).status).toBe(404);
    expect((await h.call("member", "POST", "/api/apps/app-1/webhooks/wh-app/rotate-secret")).status).toBe(200);
    expect(h.row<{ secret: string }>("SELECT secret FROM webhooks WHERE id = 'wh-a'").secret).toBe("old-secret");
  });
});

describe("webhook test delivery", () => {
  it("sends one signed ping and records what the endpoint answered", async () => {
    const h = harness();
    const seen: Array<{ url: string; headers: Headers; body: string }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      seen.push({ url, headers: new Headers(init.headers), body: String(init.body) });
      return new Response("pong", { status: 200 });
    }));
    const res = await h.call("admin", "POST", "/api/orgs/raft_server-a/webhooks/wh-paused/test");
    expect(res.status).toBe(200);
    const { delivery } = (await res.json()) as { delivery: Record<string, unknown> };
    expect(delivery).toMatchObject({
      webhook_id: "wh-paused", event_type: "ping", status: "succeeded", attempts: 1, max_attempts: 1,
      last_response_status: 200, last_response_body: "pong", last_error: null, next_attempt_at: null,
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe("https://hooks.example/x");
    expect(seen[0]!.headers.get("x-hands-event")).toBe("ping");
    const expected = createHmac("sha256", "old-secret").update(seen[0]!.body).digest("hex");
    expect(seen[0]!.headers.get("x-hands-signature")).toBe(`sha256=${expected}`);
    expect(JSON.parse(seen[0]!.body)).toMatchObject({ event: "ping", org_id: "raft_server-a", payload: { webhook_id: "wh-paused" } });
  });

  it("records a failing endpoint once, without retries", async () => {
    const h = harness();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 500 })));
    const res = await h.call("member", "POST", "/api/apps/app-1/webhooks/wh-app/test");
    expect(res.status).toBe(200);
    const { delivery } = (await res.json()) as { delivery: Record<string, unknown> };
    expect(delivery).toMatchObject({ status: "failed", attempts: 1, last_response_status: 500, last_error: "webhook_http_error", next_attempt_at: null });
  });

  it("refuses webhooks outside the caller's scope and archived ones", async () => {
    const h = harness();
    const fetchMock = vi.fn(async () => new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    expect((await h.call("admin", "POST", "/api/orgs/raft_server-a/webhooks/wh-b/test")).status).toBe(404);
    expect((await h.call("admin", "POST", "/api/orgs/raft_server-a/webhooks/wh-gone/test")).status).toBe(404);
    expect((await h.call("member", "POST", "/api/orgs/raft_server-a/webhooks/wh-a/test")).status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
