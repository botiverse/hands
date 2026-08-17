/**
 * Route-level tests for the agent-login action — they go through the REAL
 * `authMiddleware` (session lookup, x-hands-org-id org switch, deploy-token branch)
 * and `app.request`, not a Context stub. This is what proves the handler binds the
 * grant to the pre-org-switch authenticated identity even when the middleware puts a
 * different (org-switched) account in `admin_account`.
 *
 * Real migrations are applied so 0066 (grants/refresh with account_id) is exercised.
 */
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { authMiddleware } from "../src/middleware/auth";
import { handleAgentLoginAction } from "../src/routes/agent_login";
import { handleCreateAppDeployToken } from "../src/routes/deploy_tokens";
import { sha256Base64Url, sha256Hex } from "../src/lib/agent_login";

const MIGRATION_DIR = fileURLToPath(new URL("../../migrations/sql/", import.meta.url));
const VERIFIER = "test-verifier-0123456789-abcdefghijklmnopqrstuvwxyz_.~";

/** D1 shim over better-sqlite3 with batch() (mirrors deploy_token_issuance.test.ts). */
function d1(db: Database.Database) {
  const prepare = (sql: string) => {
    const indexes: number[] = [];
    const normalized = sql.replace(/\?(\d+)/g, (_m, i) => { indexes.push(Number(i)); return "?"; });
    const statement = db.prepare(normalized);
    const bind = (...input: unknown[]) => {
      const params = (indexes.length ? indexes.map((i) => input[i - 1]) : input)
        .map((v) => (v === undefined ? null : v));
      const execute = () => statement.reader
        ? { results: statement.all(...params), success: true as const, meta: { changes: 0 } }
        : { results: [], success: true as const, meta: { changes: statement.run(...params).changes } };
      return {
        _execute: execute,
        run: async () => execute(),
        all: async () => execute(),
        first: async <T>() => (statement.get(...params) as T | undefined) ?? null,
      };
    };
    return { bind, run: () => bind().run(), all: () => bind().all(), first: <T>() => bind().first<T>() };
  };
  return {
    prepare,
    batch: async (sts: { _execute: () => unknown }[]) =>
      db.transaction(() => sts.map((s) => s._execute()))(),
  };
}

function environment() {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  for (const name of readdirSync(MIGRATION_DIR).sort()) {
    if (name.endsWith(".sql")) sqlite.exec(readFileSync(`${MIGRATION_DIR}${name}`, "utf8"));
  }
  const env = {
    DB: d1(sqlite),
    RAFT_CLIENT_ID: "hands-4cc7a2",
    SIGNED_URL_SECRET: "test-secret",
    ENVIRONMENT: "production", // dev-token bypass OFF
  } as unknown as Env;
  return { sqlite, env };
}

function seedAccount(
  sqlite: Database.Database,
  a: { id: string; subject: string; serverId: string; principal: "agent" | "human" },
) {
  sqlite
    .prepare(
      `INSERT INTO raft_accounts
         (id, provider, provider_subject, server_id, server_slug, principal_type,
          server_role, username, display_name, avatar_url, raw_profile,
          created_at, updated_at, last_login_at)
       VALUES (?, 'raft', ?, ?, ?, ?, NULL, ?, ?, NULL, '{}', 1, 1, 1)`,
    )
    .run(a.id, a.subject, a.serverId, a.serverId, a.principal, a.id, a.id);
}

async function seedSession(sqlite: Database.Database, token: string, accountId: string) {
  const hash = await sha256Hex(token);
  sqlite
    .prepare(
      `INSERT INTO raft_sessions (id, account_id, token_hash, created_at, expires_at, last_seen_at)
       VALUES (?, ?, ?, 1, 9999999999999, 1)`,
    )
    .run(`sess-${accountId}`, accountId, hash);
}

function app() {
  const a = new Hono();
  a.post("/api/auth/agent/login", authMiddleware as any, handleAgentLoginAction as any);
  return a;
}

async function loginBody() {
  return JSON.stringify({
    schema: "raft-cli-agent-login-request.v1",
    code_challenge: await sha256Base64Url(VERIFIER),
    code_challenge_method: "S256",
  });
}

describe("agent-login route (real authMiddleware)", () => {
  it("binds the grant to the authenticated agent's provider_subject + account id", async () => {
    const { sqlite, env } = environment();
    seedAccount(sqlite, { id: "acctA", subject: "raftAgentA", serverId: "serverA", principal: "agent" });
    await seedSession(sqlite, "token-A", "acctA");

    const res = await app().request(
      "/api/auth/agent/login",
      { method: "POST", headers: { authorization: "Bearer token-A", "content-type": "application/json" }, body: await loginBody() },
      env,
    );
    expect(res.status).toBe(200);
    const row = sqlite.prepare("SELECT server_id, agent_id, account_id, service FROM agent_login_grants LIMIT 1").get() as any;
    expect(row).toMatchObject({
      server_id: "serverA",
      agent_id: "raftAgentA", // provider_subject
      account_id: "acctA", // account row id
      service: "hands-4cc7a2", // exact RAFT_CLIENT_ID, not brand
    });
  });

  it("with x-hands-org-id switching admin_account to a linked org, still binds the PRE-switch account", async () => {
    const { sqlite, env } = environment();
    // Two accounts sharing the same provider_subject on different servers (the linked
    // identity the org switch resolves to). Account B is a member of orgB.
    seedAccount(sqlite, { id: "acctA", subject: "raftAgentX", serverId: "serverA", principal: "agent" });
    seedAccount(sqlite, { id: "acctB", subject: "raftAgentX", serverId: "serverB", principal: "agent" });
    sqlite.prepare(
      `INSERT INTO organizations (id, slug, name, external_provider, external_id, archived, created_at)
       VALUES ('orgB','orgb','Org B','raft','serverB',0,1)`,
    ).run();
    sqlite.prepare(
      `INSERT INTO org_members (org_id, account_id, org_role, joined_at) VALUES ('orgB','acctB','admin',1)`,
    ).run();
    await seedSession(sqlite, "token-A", "acctA");

    const res = await app().request(
      "/api/auth/agent/login",
      {
        method: "POST",
        headers: {
          authorization: "Bearer token-A",
          "x-hands-org-id": "orgB", // switches admin_account to acctB/serverB
          "content-type": "application/json",
        },
        body: await loginBody(),
      },
      env,
    );
    expect(res.status).toBe(200);
    const row = sqlite.prepare("SELECT server_id, account_id FROM agent_login_grants LIMIT 1").get() as any;
    // Bound to the AUTHENTICATED account (A/serverA), never the org-switched B/serverB.
    expect(row).toMatchObject({ server_id: "serverA", account_id: "acctA" });
  });

  it("rejects a human session (403) — no grant issued", async () => {
    const { sqlite, env } = environment();
    seedAccount(sqlite, { id: "human1", subject: "raftHuman", serverId: "serverA", principal: "human" });
    await seedSession(sqlite, "token-H", "human1");
    const res = await app().request(
      "/api/auth/agent/login",
      { method: "POST", headers: { authorization: "Bearer token-H", "content-type": "application/json" }, body: await loginBody() },
      env,
    );
    expect(res.status).toBe(403);
    expect((sqlite.prepare("SELECT COUNT(*) AS n FROM agent_login_grants").get() as any).n).toBe(0);
  });

  it("rejects an unauthenticated request (401)", async () => {
    const { env } = environment();
    const res = await app().request(
      "/api/auth/agent/login",
      { method: "POST", headers: { "content-type": "application/json" }, body: await loginBody() },
      env,
    );
    expect(res.status).toBe(401);
  });

  it("a deploy token cannot mint a grant (scoped → app-boundary 403; unscoped → no authenticated_account 401)", async () => {
    const { sqlite, env } = environment();
    // Seed an app + issue a real deploy token through the production issuance path.
    sqlite.prepare(
      `INSERT INTO organizations (id, slug, name, external_provider, external_id, archived, created_at)
       VALUES ('org','org','Org','raft','serverA',0,1)`,
    ).run();
    sqlite.prepare(
      `INSERT INTO apps (id, org_id, slug, name, platform, client_key, created_at)
       VALUES ('app-a','org','app-a','App A','electron','ck',1)`,
    ).run();
    let issued: any;
    await handleCreateAppDeployToken({
      env,
      req: { param: (n: string) => (n === "appId" ? "app-a" : ""), json: async () => ({ name: "ci", scopes: ["feedback:read"] }) },
      json: (data: unknown, s = 200) => { issued = { status: s, data }; return new Response("{}"); },
      get: () => undefined,
    } as any);
    expect(issued.status).toBe(201);
    const deployToken = issued.data.token as string;

    const res = await app().request(
      "/api/auth/agent/login",
      { method: "POST", headers: { authorization: `Bearer ${deployToken}`, "content-type": "application/json" }, body: await loginBody() },
      env,
    );
    // A scoped token is blocked at the app-boundary (403) before reaching the action;
    // an unscoped one would reach it but has no authenticated_account (401). Either way
    // the deploy-token path can never mint an agent grant.
    expect([401, 403]).toContain(res.status);
    expect((sqlite.prepare("SELECT COUNT(*) AS n FROM agent_login_grants").get() as any).n).toBe(0);
  });
});
