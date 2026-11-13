import Database from "better-sqlite3";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { requireAppRole } from "../src/lib/permissions";
import type { AdminAccount, AdminEnv } from "../src/middleware/auth";
import { handleTransferApp } from "../src/routes/apps";

type Statement = { _run: () => { success: boolean; meta: { changes: number } } };
function d1(sqlite: Database.Database, beforeBatch: () => void): D1Database {
  const prepare = (sql: string) => {
    const indexes: number[] = [];
    const statement = sqlite.prepare(sql.replace(/\?(\d+)/g, (_match, index) => {
      indexes.push(Number(index));
      return "?";
    }));
    const bind = (...parameters: unknown[]) => {
      const values = indexes.length ? indexes.map((index) => parameters[index - 1]) : parameters;
      const run = () => ({ success: true, meta: { changes: statement.run(...values).changes } });
      return {
        _run: run, run: async () => run(),
        first: async <T>() => (statement.get(...values) as T | undefined) ?? null,
        all: async <T>() => ({ success: true, results: statement.all(...values) as T[] }),
      };
    };
    return { bind, first: <T>() => bind().first<T>(), all: <T>() => bind().all<T>(), run: () => bind().run() };
  };
  return {
    prepare,
    batch: async (statements: Statement[]) => {
      beforeBatch();
      return sqlite.transaction(() => statements.map((statement) => statement._run()))();
    },
  } as unknown as D1Database;
}

const actor: AdminAccount = {
  id: "actor", provider: "raft", provider_subject: "same-person", server_id: "server-source",
  server_slug: "source", principal_type: "human", server_role: "member", username: "person",
  display_name: "Person", avatar_url: null, raw_profile: "{}", created_at: 1, updated_at: 1, last_login_at: 1,
};
const body = { expected_source_org_id: "source", target_org_id: "target", idempotency_key: "request-1" };

function harness() {
  const sqlite = new Database(":memory:");
  sqlite.exec(`
    CREATE TABLE organizations (id TEXT PRIMARY KEY, name TEXT, external_provider TEXT, external_id TEXT, archived INTEGER NOT NULL);
    CREATE TABLE raft_accounts (id TEXT PRIMARY KEY, provider TEXT, provider_subject TEXT, principal_type TEXT, server_id TEXT, server_slug TEXT);
    CREATE TABLE org_members (org_id TEXT, account_id TEXT, org_role TEXT, UNIQUE(org_id, account_id));
    CREATE TABLE apps (id TEXT PRIMARY KEY, org_id TEXT, slug TEXT, name TEXT);
    CREATE TABLE app_members (app_id TEXT, account_id TEXT, app_role TEXT, UNIQUE(app_id, account_id));
    CREATE TABLE app_server_grants (app_id TEXT, server_id TEXT, server_slug TEXT, app_role TEXT, access_model TEXT);
    CREATE TABLE webhooks (id TEXT PRIMARY KEY, org_id TEXT, app_id TEXT);
    CREATE TABLE invites (id TEXT PRIMARY KEY, org_id TEXT, app_id TEXT);
    CREATE TABLE audit_logs (id TEXT PRIMARY KEY, app_id TEXT, action TEXT, actor TEXT, actor_id TEXT, actor_type TEXT, payload TEXT, created_at INTEGER);
    INSERT INTO organizations VALUES ('source', 'Source', 'raft', 'server-source', 0), ('target', 'Target', 'raft', 'server-target', 0), ('third', 'Third', 'raft', 'server-third', 0);
    INSERT INTO raft_accounts VALUES ('actor', 'raft', 'same-person', 'human', 'server-source', 'source'), ('linked', 'raft', 'same-person', 'human', 'server-target', 'target');
    INSERT INTO org_members VALUES ('source', 'actor', 'admin'), ('target', 'linked', 'member');
    INSERT INTO apps VALUES ('app-1', 'source', 'my-app', 'My App');
    INSERT INTO app_members VALUES ('app-1', 'actor', 'admin');
    INSERT INTO webhooks VALUES ('webhook', 'source', 'app-1');
    INSERT INTO invites VALUES ('invite', 'source', 'app-1');
  `);
  let beforeBatch = () => {};
  const env = { DB: d1(sqlite, () => beforeBatch()), DASHBOARD_ORIGIN: "https://dashboard.test" } as unknown as Env;
  const app = new Hono<AdminEnv & { Bindings: Env }>();
  app.use("*", async (c, next) => { c.set("admin_account", actor); c.set("org_id", "source"); await next(); });
  app.post("/api/apps/:appId/transfer", requireAppRole("admin"), handleTransferApp);
  const request = (values: Record<string, unknown> = body) => app.fetch(new Request("https://hands.test/api/apps/app-1/transfer", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(values),
  }), env);
  const snapshot = () => ({
    app: sqlite.prepare("SELECT org_id FROM apps WHERE id = 'app-1'").pluck().get(),
    webhook: sqlite.prepare("SELECT org_id FROM webhooks WHERE id = 'webhook'").pluck().get(),
    invite: sqlite.prepare("SELECT org_id FROM invites WHERE id = 'invite'").pluck().get(),
    audit: sqlite.prepare("SELECT COUNT(*) FROM audit_logs WHERE action = 'app.transfer'").pluck().get(),
  });
  return { sqlite, request, snapshot, onBatch: (fn: () => void) => { beforeBatch = fn; } };
}

const unchanged = { app: "source", webhook: "source", invite: "source", audit: 0 };

describe("app transfer authority and atomicity", () => {
  it("allows a source org admin with linked target membership and moves all scoped rows once", async () => {
    const h = harness();
    const response = await h.request();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, idempotent: false, target_org_id: "target" });
    expect(h.snapshot()).toEqual({ app: "target", webhook: "target", invite: "target", audit: 1 });
    expect(h.sqlite.prepare("SELECT actor_id, actor_type FROM audit_logs").get()).toEqual({ actor_id: "actor", actor_type: "human" });
    const replay = await h.request();
    expect(await replay.json()).toMatchObject({ ok: true, idempotent: true });
    expect(h.snapshot().audit).toBe(1);
    const conflict = await h.request({ ...body, target_org_id: "third" });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  });

  it("allows source organization admin even without a direct app role", async () => {
    const h = harness();
    h.sqlite.exec("DELETE FROM app_members");
    expect((await h.request()).status).toBe(200);
    expect(h.snapshot().app).toBe("target");
  });

  it("allows a source org owner", async () => {
    const h = harness();
    h.sqlite.exec("UPDATE org_members SET org_role='owner' WHERE org_id='source'");
    expect((await h.request()).status).toBe(200);
    expect(h.snapshot().app).toBe("target");
  });

  // I-7: transfer is the owning org's decision. An app-level admin (app_members),
  // a legacy admin server grant or a co-owner server admin used to be able to
  // move the app out from under the org that owns it.
  it("rejects an app_members admin who is only a member of the source org", async () => {
    const h = harness();
    h.sqlite.exec("UPDATE org_members SET org_role='member' WHERE org_id='source'");
    const response = await h.request();
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "OWNING_ORG_ADMIN_REQUIRED" });
    expect(h.snapshot()).toEqual(unchanged);
  });

  it("rejects an app_members admin with no role in the source org", async () => {
    const h = harness();
    h.sqlite.exec("DELETE FROM org_members WHERE org_id='source'");
    expect((await h.request()).status).toBe(403);
    expect(h.snapshot()).toEqual(unchanged);
  });

  it.each(["owner_server", "legacy_role"])("rejects a %s server-grant admin who is not admin of the owning org", async (model) => {
    const h = harness();
    // The app belongs to 'third'. The actor is admin of their own server's org
    // ('source'), which holds an admin grant on the app.
    h.sqlite.exec(`DELETE FROM app_members;
      UPDATE apps SET org_id='third'; UPDATE webhooks SET org_id='third'; UPDATE invites SET org_id='third';`);
    h.sqlite.prepare("INSERT INTO app_server_grants VALUES ('app-1', 'server-source', NULL, 'admin', ?)").run(model);
    const response = await h.request({ ...body, expected_source_org_id: "third" });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "OWNING_ORG_ADMIN_REQUIRED" });
    expect(h.snapshot()).toEqual({ app: "third", webhook: "third", invite: "third", audit: 0 });
  });

  it("fails closed if the authenticated account identity changes before the write", async () => {
    const h = harness();
    h.onBatch(() => h.sqlite.exec("UPDATE raft_accounts SET provider_subject='different-person'"));
    expect((await h.request()).status).toBe(403);
    expect(h.snapshot()).toEqual(unchanged);
  });

  it("ignores malformed unrelated historical audit payloads", async () => {
    const h = harness();
    h.sqlite.exec("INSERT INTO audit_logs VALUES ('old', 'app-1', 'app.transfer', 'actor', 'actor', 'human', '{bad', 1)");
    expect((await h.request()).status).toBe(200);
    expect(h.snapshot().app).toBe("target");
  });

  it("rejects non-string request identifiers before changing data", async () => {
    const h = harness();
    expect((await h.request({ ...body, idempotency_key: { value: "unexpected" } })).status).toBe(400);
    expect(h.snapshot()).toEqual(unchanged);
  });

  it.each([
    ["viewer", "UPDATE org_members SET org_role='viewer' WHERE org_id='target'"],
    ["different subject", "UPDATE raft_accounts SET provider_subject='someone-else' WHERE id='linked'"],
    ["different provider", "UPDATE raft_accounts SET provider='other' WHERE id='linked'"],
    ["different principal type", "UPDATE raft_accounts SET principal_type='agent' WHERE id='linked'"],
    ["no target membership", "DELETE FROM org_members WHERE org_id='target'"],
  ])("rejects target %s without changing app data", async (_name, sql) => {
    const h = harness();
    h.sqlite.exec(sql);
    expect((await h.request()).status).toBe(403);
    expect(h.snapshot()).toEqual(unchanged);
  });

  it("rejects a source org viewer before transfer", async () => {
    const h = harness();
    h.sqlite.exec("UPDATE org_members SET org_role='viewer' WHERE org_id='source'");
    expect((await h.request()).status).toBe(403);
    expect(h.snapshot()).toEqual(unchanged);
  });

  it.each([
    ["source org admin role", "UPDATE org_members SET org_role='member' WHERE org_id='source'"],
    ["target membership", "DELETE FROM org_members WHERE org_id='target'"],
  ])("rechecks revoked %s inside the atomic write", async (_name, sql) => {
    const h = harness();
    h.onBatch(() => h.sqlite.exec(sql));
    expect((await h.request()).status).toBe(403);
    expect(h.snapshot()).toEqual(unchanged);
  });

  it("does not move anything if the target is archived before commit", async () => {
    const h = harness();
    h.onBatch(() => h.sqlite.exec("UPDATE organizations SET archived=1 WHERE id='target'"));
    expect((await h.request()).status).toBe(400);
    expect(h.snapshot()).toEqual(unchanged);
  });

  it("reconciles a same-key concurrent winner without duplicating audit or writes", async () => {
    const h = harness();
    h.onBatch(() => {
      h.sqlite.transaction(() => {
        h.sqlite.prepare("UPDATE apps SET org_id='target' WHERE id='app-1'").run();
        h.sqlite.prepare("UPDATE webhooks SET org_id='target' WHERE app_id='app-1'").run();
        h.sqlite.prepare("UPDATE invites SET org_id='target' WHERE app_id='app-1'").run();
        h.sqlite.prepare("INSERT INTO audit_logs VALUES ('winner', 'app-1', 'app.transfer', 'actor', 'actor', 'human', ?, 1)")
          .run(JSON.stringify({ idempotency_key: body.idempotency_key, from_org_id: "source", target_org_id: "target" }));
      })();
    });
    const response = await h.request();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ idempotent: true });
    expect(h.snapshot()).toEqual({ app: "target", webhook: "target", invite: "target", audit: 1 });
  });
});
