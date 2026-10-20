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
import { handleAgentManifest, handleAgentMigrationHelp } from "../src/routes/auth";
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

describe("manifest: actions retained + deprecated, migration-help added", () => {
  it("keeps existing actions, adds agent-login + migration-help, prefixes old actions", async () => {
    const app = new Hono();
    app.get("/.well-known/raft-agent-manifest.json", handleAgentManifest as any);
    const res = await app.request("/.well-known/raft-agent-manifest.json", {}, { RAFT_CLIENT_ID: "hands-4cc7a2" } as any);
    const body = (await res.json()) as any;
    const names = body.actions.map((a: any) => a.name);
    // existing actions retained + the two new ones present
    for (const n of ["help", "whoami", "list-apps", "agent-login", "migration-help"]) expect(names).toContain(n);
    const prefix = "Deprecated — see migration-help (raft integration invoke --service hands-4cc7a2 --action migration-help)";
    // every OLD action is prefixed; the two NEW actions are not
    expect(body.actions.find((a: any) => a.name === "help").description.startsWith(prefix)).toBe(true);
    expect(body.actions.find((a: any) => a.name === "whoami").description.startsWith(prefix)).toBe(true);
    expect(body.actions.find((a: any) => a.name === "agent-login").description.startsWith("Deprecated")).toBe(false);
    expect(body.actions.find((a: any) => a.name === "migration-help").description.startsWith("Deprecated")).toBe(false);
    // machine contract unchanged: help still GET /api/agent/help
    expect(body.actions.find((a: any) => a.name === "help").endpoint).toEqual({ method: "GET", path: "/api/agent/help" });
  });

  it("migration-help endpoint returns install + login guidance", async () => {
    const app = new Hono();
    app.get("/api/agent/migration-help", handleAgentMigrationHelp as any);
    const res = await app.request("/api/agent/migration-help", {}, {} as any);
    const body = (await res.json()) as any;
    expect(JSON.stringify(body.install)).toContain("@botiverse/hands-cli");
    expect(body.login.agents).toMatch(/hands login/);
  });
});

// The agent manifest is the ONLY contract an agent codes against. A body field the
// handler accepts but the manifest omits is effectively invisible: `update-feedback`
// shipped that way (`closure_reason`, `duplicate_of_ticket_id` were implemented and
// enforced, but undeclared), so mark-as-duplicate could only be expressed in a
// comment. These cases fail if the declared body contract drifts from the handler's.
describe("manifest: update-feedback body contract matches the handler", () => {
  async function manifestAction(name: string) {
    const app = new Hono();
    app.get("/.well-known/raft-agent-manifest.json", handleAgentManifest as any);
    const res = await app.request(
      "/.well-known/raft-agent-manifest.json",
      {},
      { RAFT_CLIENT_ID: "hands-4cc7a2" } as any,
    );
    const body = (await res.json()) as any;
    return body.actions.find((a: any) => a.name === name);
  }

  it("declares every body field handleUpdateFeedback reads", async () => {
    const action = await manifestAction("update-feedback");
    expect(action).toBeTruthy();
    const bodyParams = Object.entries(action.parameters ?? {})
      .filter(([, p]: [string, any]) => p.in === "body")
      .map(([key]) => key)
      .sort();

    // Derived from the handler's SOURCE, not a hand-copied list: a literal here
    // would only catch the manifest losing a field, while the bug that actually
    // happened was the handler gaining one that the manifest never declared.
    // Reading the handler means the test fails in BOTH directions.
    const handlerSource = readFileSync(
      new URL("../src/routes/feedback.ts", import.meta.url),
      "utf8",
    );
    // Bound to THIS function: slicing to the end of the file would sweep in the
    // neighbouring handlers' body reads (e.g. `body.internal` from comments).
    const start = handlerSource.indexOf("export async function handleUpdateFeedback");
    const nextExport = handlerSource.indexOf("\nexport ", start + 1);
    const handleBody = handlerSource.slice(
      start,
      nextExport === -1 ? undefined : nextExport,
    );
    const handlerBodyFields = [
      ...new Set(
        (handleBody.match(/body\.[a-zA-Z_]+/g) ?? []).map((m) => m.slice("body.".length)),
      ),
    ].sort();

    expect(handlerBodyFields.length).toBeGreaterThan(0); // the derivation itself must work

    // The derivation only sees `body.<name>` dot-reads. A bracket read
    // (`body["x"]`) or destructuring (`const { x } = body`) would HIDE a field
    // from it, so the set could shrink while a real contract field exists —
    // an invisible miss, not a loud failure. Kirby flagged this during review
    // (#301). Neither form is used today; this guard keeps it that way so the
    // blind spot cannot open silently.
    expect({ bracketReads: /body\s*\[/.test(handleBody), destructured: /\}\s*=\s*body\b/.test(handleBody) }).toEqual({
      bracketReads: false,
      destructured: false,
    });

    expect(bodyParams).toEqual(handlerBodyFields);
  });

  it("describes the closure contract an agent cannot otherwise discover", async () => {
    const action = await manifestAction("update-feedback");
    // The values must be the real enum, not prose that drifts from the handler.
    expect(action.parameters.closure_reason.description).toContain("duplicate");
    expect(action.parameters.closure_reason.description).toContain("completed");
    // The duplicate field must say when it is required AND when it is rejected;
    // both rules are enforced by the handler.
    expect(action.parameters.duplicate_of_ticket_id.description).toContain("Required");
    expect(action.parameters.duplicate_of_ticket_id.description).toContain("rejected");
  });
});

// The agent manifest is fetched and parsed by every agent runtime that talks to
// Hands, and at least one of them (Raft) refuses a manifest above 64 KiB with
// INTEGRATION_MANIFEST_INVALID ("manifest response is too large") — which takes
// EVERY agent-facing Hands action offline at once, not just the action that grew.
//
// That limit was invisible: not in the diff, not asserted anywhere, so a change
// that added two truthful field declarations (#761) pushed the payload 18 bytes
// over the ceiling and broke all agent access for ~2 hours. A hard external limit
// needs a test that fails before the limit is crossed, not an operator who
// remembers to measure bytes.
describe("manifest: stays under the consumer payload limit", () => {
  // 64 KiB is the ceiling Raft enforces on the response body.
  const LIMIT = 64 * 1024;
  // Leave room for honest growth between checks: crossing this fails loudly while
  // there is still headroom to fix it deliberately rather than in an incident.
  const BUDGET = LIMIT - 512;

  it("serializes below the budget", async () => {
    const app = new Hono();
    app.get("/.well-known/raft-agent-manifest.json", handleAgentManifest as any);
    const res = await app.request(
      "/.well-known/raft-agent-manifest.json",
      {},
      { RAFT_CLIENT_ID: "hands-4cc7a2" } as any,
    );
    const body = await res.text();
    const bytes = Buffer.byteLength(body, "utf8");

    // Guard the guard: an empty/erroring response would trivially pass a size test.
    expect(body).toContain("update-feedback");
    expect(bytes).toBeLessThanOrEqual(BUDGET);
  });
});

// The manifest is the contract an agent codes against, so an authorization or
// confirmation rule that exists in the handler must be stated here. #762's
// byte-trim removed the confirmation requirement from expire-testflight-build;
// Kirby caught it (task #301 follow-up). Pinned so a future size trim cannot
// silently drop a rule again: if the description shrinks past this, the test says
// which rule went missing instead of a reviewer having to diff prose.
describe("manifest: expire-testflight-build states its confirmation rule", () => {
  it("keeps the exact-confirmation requirement the handler enforces", async () => {
    const app = new Hono();
    app.get("/.well-known/raft-agent-manifest.json", handleAgentManifest as any);
    const res = await app.request(
      "/.well-known/raft-agent-manifest.json",
      {},
      { RAFT_CLIENT_ID: "hands-4cc7a2" } as any,
    );
    const body = (await res.json()) as any;
    const action = body.actions.find((a: any) => a.name === "expire-testflight-build");
    expect(action).toBeTruthy();

    // assertExpireConfirmation() rejects a mismatch with EXPIRE_CONFIRMATION_MISMATCH
    // (409) and the route requires app admin; the manifest must say both.
    // Assert the SENTENCE, not loose keywords: the surrounding text already
    // mentions "confirmations" and "app admin", so a keyword match passes even
    // when the requirement clause itself was deleted (caught by mutation).
    expect(action.description).toContain(
      "Requires app admin plus exact version/build confirmation of the immutable build",
    );
    // The three body confirmations the handler actually reads must stay declared.
    const bodyParams = Object.entries(action.parameters ?? {})
      .filter(([, p]: [string, any]) => p.in === "body")
      .map(([k]) => k)
      .sort();
    expect(bodyParams).toEqual([
      "asc_build_id",
      "bundle_id",
      "confirm_build_number",
      "confirm_version",
    ]);
  });
});
