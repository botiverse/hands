/**
 * Org-level fine-grained access tokens (qvot_): an org admin picks apps (or all
 * apps) and read-only scopes. Every test here drives the real admin route table
 * so the auth boundary, the permission checks, and the management routes are the
 * shipped wiring, not a mini-app.
 */

import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";

vi.mock("@cloudflare/containers", () => ({
  Container: class {},
  getRandom: async () => ({ fetch: async () => Response.json({}) }),
}));
import { admin } from "../src/index";
import { generateDeployToken, hashDeployToken, sha256Hex } from "../src/lib/deploy_tokens";
import { generateOrgAccessToken, hashOrgAccessToken } from "../src/lib/org_access_tokens";

const MIGRATION_DIR = fileURLToPath(new URL("../../migrations/sql/", import.meta.url));

type BoundStatement = {
  _execute: () => { results: unknown[]; success: true; meta: { changes: number } };
  run: () => Promise<{ results: unknown[]; success: true; meta: { changes: number } }>;
  all: () => Promise<{ results: unknown[]; success: true; meta: { changes: number } }>;
  first: <T>() => Promise<T | null>;
};

/** Mirrors the D1 shim used by the other route tests, including ?N placeholders. */
function d1(db: Database.Database) {
  const prepare = (sql: string) => {
    const indexes: number[] = [];
    const normalized = sql.replace(/\?(\d+)/g, (_match, index) => {
      indexes.push(Number(index));
      return "?";
    });
    const statement = db.prepare(normalized);
    const bind = (...input: unknown[]): BoundStatement => {
      const params = (indexes.length > 0 ? indexes.map((index) => input[index - 1]) : input)
        .map((value) => value === undefined ? null : typeof value === "boolean" ? Number(value) : value);
      const execute = () => {
        if (statement.reader) {
          return { results: statement.all(...params), success: true as const, meta: { changes: 0 } };
        }
        const info = statement.run(...params);
        return { results: [], success: true as const, meta: { changes: info.changes } };
      };
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
    batch: async (statements: BoundStatement[]) =>
      db.transaction(() => statements.map((statement) => statement._execute()))(),
  };
}

const ADMIN_SESSION = "session-org-admin";
const MEMBER_SESSION = "session-org-member";

async function environment() {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  for (const name of readdirSync(MIGRATION_DIR).sort()) {
    if (name.endsWith(".sql")) sqlite.exec(readFileSync(`${MIGRATION_DIR}${name}`, "utf8"));
  }
  const insertOrg = sqlite.prepare(
    `INSERT INTO organizations (id, slug, name, external_provider, external_id, created_at)
     VALUES (?, ?, ?, 'raft', ?, 1)`,
  );
  insertOrg.run("org", "org", "Org", "server");
  insertOrg.run("other-org", "other-org", "Other", "other-server");
  const insertApp = sqlite.prepare(
    `INSERT INTO apps (id, org_id, slug, name, platform, client_key, created_at)
     VALUES (?, ?, ?, ?, 'electron', ?, 1)`,
  );
  insertApp.run("app-a", "org", "alpha", "App A", "ck-a");
  insertApp.run("app-b", "org", "bravo", "App B", "ck-b");
  insertApp.run("app-x", "other-org", "xray", "App X", "ck-x");

  const insertAccount = sqlite.prepare(
    `INSERT INTO raft_accounts
       (id, provider_subject, server_id, principal_type, display_name, username, raw_profile,
        created_at, updated_at, last_login_at)
     VALUES (?, ?, 'server', 'human', ?, ?, '{}', 1, 1, 1)`,
  );
  insertAccount.run("acct-admin", "acct-admin", "Admin", "admin");
  insertAccount.run("acct-member", "acct-member", "Member", "member");
  const insertMember = sqlite.prepare(
    `INSERT INTO org_members (id, org_id, account_id, org_role, joined_at)
     VALUES (?, 'org', ?, ?, 1)`,
  );
  insertMember.run("m-admin", "acct-admin", "admin");
  insertMember.run("m-member", "acct-member", "member");
  const insertSession = sqlite.prepare(
    `INSERT INTO raft_sessions (id, account_id, token_hash, created_at, expires_at, last_seen_at)
     VALUES (?, ?, ?, 1, ?, 1)`,
  );
  insertSession.run("s-admin", "acct-admin", await sha256Hex(ADMIN_SESSION), Date.now() + 3_600_000);
  insertSession.run("s-member", "acct-member", await sha256Hex(MEMBER_SESSION), Date.now() + 3_600_000);

  const env = {
    DB: d1(sqlite),
    ENVIRONMENT: "production",
    DASHBOARD_ORIGIN: "https://dashboard.example",
    FEEDBACK_AUDIT_HMAC_KEY: "org-token-test-audit-key-with-enough-entropy",
    FEEDBACK_AUDIT_KEY_VERSION: "test-v1",
  } as unknown as Env;
  return { sqlite, env };
}

type Harness = Awaited<ReturnType<typeof environment>>;

const call = (h: Harness, bearer: string, path: string, init: { method?: string; body?: unknown } = {}) =>
  admin.request(
    `https://hands.test${path}`,
    {
      method: init.method ?? "GET",
      headers: {
        authorization: `Bearer ${bearer}`,
        ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    },
    h.env,
  );

/** Mint through the real management route as the org admin. */
async function mint(h: Harness, body: Record<string, unknown>) {
  const response = await call(h, ADMIN_SESSION, "/api/orgs/org/access-tokens", { method: "POST", body });
  expect(response.status, await response.clone().text()).toBe(201);
  return await response.json() as {
    token: string;
    access_token: { id: string; token_prefix: string; apps: { id: string; slug: string; name: string }[]; all_apps: boolean };
  };
}

/** Insert directly, to control revocation/expiry and org placement. */
async function insertToken(
  h: Harness,
  opts: { org?: string; scopes?: string[]; apps?: string[]; allApps?: boolean; expiresAt?: number | null; revokedAt?: number | null },
) {
  const { token, token_prefix } = generateOrgAccessToken();
  const id = crypto.randomUUID();
  h.sqlite.prepare(
    `INSERT INTO org_access_tokens
       (id, org_id, name, token_prefix, token_hash, scopes_json, all_apps, created_by_actor,
        created_at, expires_at, revoked_at)
     VALUES (?, ?, 'direct', ?, ?, ?, ?, 'test', 1, ?, ?)`,
  ).run(
    id, opts.org ?? "org", token_prefix, await hashOrgAccessToken(token),
    JSON.stringify(opts.scopes ?? ["app:read", "feedback:read"]), opts.allApps ? 1 : 0,
    opts.expiresAt ?? null, opts.revokedAt ?? null,
  );
  for (const appId of opts.apps ?? []) {
    h.sqlite.prepare("INSERT INTO org_access_token_apps (token_id, app_id) VALUES (?, ?)").run(id, appId);
  }
  return token;
}

describe("org access token: app boundary", () => {
  it("reads feedback of a selected app and is refused on an unselected app in the same org", async () => {
    const h = await environment();
    const { token } = await mint(h, { name: "reader", scopes: ["feedback:read"], app_ids: ["app-a"] });
    expect(token.startsWith("qvot_")).toBe(true);

    expect((await call(h, token, "/api/apps/app-a/feedback")).status).toBe(200);
    expect((await call(h, token, "/api/apps/app-a/feedback/material-delta")).status).toBe(200);

    for (const path of ["/api/apps/app-b/feedback", "/api/apps/app-b/feedback/material-delta", "/api/apps/app-b"]) {
      const denied = await call(h, token, path);
      expect(denied.status, path).toBe(403);
      // Echoes only the requested app — never which apps the token does cover.
      expect(await denied.json(), path).toEqual({ error: "org_token_app_boundary", app_id: "app-b" });
    }
  });

  it("an all_apps token cannot reach an app in another org", async () => {
    const h = await environment();
    const { token } = await mint(h, { name: "everything", scopes: ["app:read", "feedback:read"], all_apps: true });
    const denied = await call(h, token, "/api/apps/app-x/feedback");
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ error: "org_token_app_boundary", app_id: "app-x" });
    expect((await call(h, token, "/api/apps/app-x/builds")).status).toBe(403);
  });

  it("a selected-app token in another org cannot reach this org's apps even by id", async () => {
    const h = await environment();
    // A row selecting a foreign-org app must still be refused: coverage requires
    // apps.org_id = token.org_id, not just a join row.
    const token = await insertToken(h, { org: "other-org", apps: ["app-x", "app-a"] });
    expect((await call(h, token, "/api/apps/app-x/feedback")).status).toBe(200);
    const denied = await call(h, token, "/api/apps/app-a/feedback");
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ error: "org_token_app_boundary" });
  });

  it("an all_apps token reads every app in its org, including one created after the token", async () => {
    const h = await environment();
    const { token } = await mint(h, { name: "everything", scopes: ["app:read", "feedback:read"], all_apps: true });
    h.sqlite.prepare(
      `INSERT INTO apps (id, org_id, slug, name, platform, client_key, created_at)
       VALUES ('app-new', 'org', 'newcomer', 'New', 'electron', 'ck-new', 2)`,
    ).run();
    for (const appId of ["app-a", "app-b", "app-new"]) {
      expect((await call(h, token, `/api/apps/${appId}/feedback`)).status, appId).toBe(200);
      expect((await call(h, token, `/api/apps/${appId}/builds`)).status, appId).toBe(200);
    }
  });

  it("refuses an app slug in place of the id", async () => {
    const h = await environment();
    const { token } = await mint(h, { name: "reader", scopes: ["app:read"], app_ids: ["app-a"] });
    expect((await call(h, token, "/api/apps/app-a")).status).toBe(200);
    const bySlug = await call(h, token, "/api/apps/alpha");
    expect(bySlug.status).toBe(403);
    expect(await bySlug.json()).toMatchObject({ error: "org_token_app_boundary", app_id: "alpha" });
  });

  it("is refused on every non-app path", async () => {
    const h = await environment();
    const { token } = await mint(h, { name: "everything", scopes: ["app:read", "feedback:read"], all_apps: true });
    for (const path of ["/api/orgs/org/members", "/api/apps", "/api/orgs", "/api/orgs/org/audit-logs", "/api/orgs/org/access-tokens"]) {
      const denied = await call(h, token, path);
      expect(denied.status, path).toBe(403);
      expect(await denied.json(), path).toMatchObject({ error: "org_token_app_boundary" });
    }
  });
});

describe("org access token: scopes", () => {
  it("feedback:read alone cannot read app:read routes", async () => {
    const h = await environment();
    const { token } = await mint(h, { name: "feedback-only", scopes: ["feedback:read"], app_ids: ["app-a"] });
    expect((await call(h, token, "/api/apps/app-a/feedback")).status).toBe(200);
    expect((await call(h, token, "/api/apps/app-a/builds")).status).toBe(403);
    expect((await call(h, token, "/api/apps/app-a")).status).toBe(403);
  });

  it("app:read reads viewer-tier routes but nothing above viewer", async () => {
    const h = await environment();
    const { token } = await mint(h, { name: "app-read", scopes: ["app:read"], app_ids: ["app-a"] });
    expect((await call(h, token, "/api/apps/app-a/builds")).status).toBe(200);
    expect((await call(h, token, "/api/apps/app-a")).status).toBe(200);
    // Publisher / admin tier stays closed.
    expect((await call(h, token, "/api/apps/app-a/deploy-tokens")).status).toBe(403);
    expect((await call(h, token, "/api/apps/app-a/builds", { method: "POST", body: {} })).status).toBe(403);
  });

  it("no write route on the admin table admits an all-scope org token", async () => {
    const h = await environment();
    const token = await insertToken(h, { allApps: true });
    const writeMethods = new Set(["POST", "PATCH", "PUT", "DELETE"]);
    const notRejected: string[] = [];
    const seen = new Set<string>();
    for (const route of admin.routes) {
      if (!writeMethods.has(route.method)) continue;
      const key = route.method + " " + route.path;
      if (seen.has(key)) continue;
      seen.add(key);
      const path = route.path
        .replace(":appId", "app-a")
        .replace(/:[A-Za-z]+/g, "11111111-1111-4111-8111-111111111111");
      // The Play API proxy is a viewer-tier POST that forwards Google reads; it
      // gates the mutating methods itself. Probe it with a mutating call.
      const body = route.path === "/api/apps/:appId/distributions/play/api"
        ? { method: "POST", path: "edits" }
        : {};
      const response = await call(h, token, path, { method: route.method, body });
      if (response.status !== 401 && response.status !== 403) {
        notRejected.push(`${route.method} ${route.path} -> ${response.status}`);
      }
    }
    expect(notRejected).toEqual([]);
  });
});

describe("org access token: lifecycle", () => {
  it("a revoked token is 401", async () => {
    const h = await environment();
    const { token, access_token } = await mint(h, { name: "short", scopes: ["feedback:read"], app_ids: ["app-a"] });
    expect((await call(h, token, "/api/apps/app-a/feedback")).status).toBe(200);
    const revoke = await call(h, ADMIN_SESSION, `/api/orgs/org/access-tokens/${access_token.id}`, { method: "DELETE" });
    expect(revoke.status).toBe(200);
    expect((await call(h, token, "/api/apps/app-a/feedback")).status).toBe(401);
    // Also 401 (not 403) on a path outside the boundary: revoked means unknown.
    expect((await call(h, token, "/api/orgs/org/members")).status).toBe(401);
  });

  it("an expired token is 401", async () => {
    const h = await environment();
    const token = await insertToken(h, { apps: ["app-a"], expiresAt: Date.now() - 1000 });
    expect((await call(h, token, "/api/apps/app-a/feedback")).status).toBe(401);
    const live = await insertToken(h, { apps: ["app-a"], expiresAt: Date.now() + 60_000 });
    expect((await call(h, live, "/api/apps/app-a/feedback")).status).toBe(200);
  });

  it("an unknown qvot_ bearer is 401", async () => {
    const h = await environment();
    const { token } = generateOrgAccessToken();
    expect((await call(h, token, "/api/apps/app-a/feedback")).status).toBe(401);
  });

  it("records last_used_at", async () => {
    const h = await environment();
    const { token, access_token } = await mint(h, { name: "t", scopes: ["feedback:read"], app_ids: ["app-a"] });
    await call(h, token, "/api/apps/app-a/feedback");
    const row = h.sqlite.prepare("SELECT last_used_at FROM org_access_tokens WHERE id = ?").get(access_token.id) as { last_used_at: number | null };
    expect(row.last_used_at).toBeGreaterThan(0);
  });

  it("revoking a token from another org is 404", async () => {
    const h = await environment();
    const token = await insertToken(h, { org: "other-org", apps: ["app-x"] });
    const id = (h.sqlite.prepare("SELECT id FROM org_access_tokens WHERE org_id = 'other-org'").get() as { id: string }).id;
    const response = await call(h, ADMIN_SESSION, `/api/orgs/org/access-tokens/${id}`, { method: "DELETE" });
    expect(response.status).toBe(404);
    expect((await call(h, token, "/api/apps/app-x/feedback")).status).toBe(200);
  });
});

describe("org access token: creation validation", () => {
  const create = (h: Harness, body: unknown, bearer = ADMIN_SESSION) =>
    call(h, bearer, "/api/orgs/org/access-tokens", { method: "POST", body });

  it.each([
    ["app:publish scope", { name: "x", scopes: ["app:publish"], app_ids: ["app-a"] }],
    ["feedback:write scope", { name: "x", scopes: ["feedback:write"], app_ids: ["app-a"] }],
    ["app:admin mixed in", { name: "x", scopes: ["app:read", "app:admin"], app_ids: ["app-a"] }],
    ["empty scopes", { name: "x", scopes: [], app_ids: ["app-a"] }],
    ["app from another org", { name: "x", scopes: ["app:read"], app_ids: ["app-a", "app-x"] }],
    ["unknown app", { name: "x", scopes: ["app:read"], app_ids: ["nope"] }],
    ["both app_ids and all_apps", { name: "x", scopes: ["app:read"], app_ids: ["app-a"], all_apps: true }],
    ["neither app_ids nor all_apps", { name: "x", scopes: ["app:read"] }],
    ["empty app_ids", { name: "x", scopes: ["app:read"], app_ids: [] }],
    ["unknown field", { name: "x", scopes: ["app:read"], app_ids: ["app-a"], app_role: "viewer" }],
    ["misspelled expiry", { name: "x", scopes: ["app:read"], app_ids: ["app-a"], expires_days: 3 }],
    ["both expiries", { name: "x", scopes: ["app:read"], app_ids: ["app-a"], expires_in_days: 3, expires_at: Date.now() + 86_400_000 }],
    ["expiry too long", { name: "x", scopes: ["app:read"], app_ids: ["app-a"], expires_in_days: 4000 }],
    ["expires_at beyond the cap", { name: "x", scopes: ["app:read"], app_ids: ["app-a"], expires_at: Date.now() + 3651 * 86_400_000 }],
    ["too many app_ids", { name: "x", scopes: ["app:read"], app_ids: Array.from({ length: 201 }, (_v, i) => `app-${i}`) }],
    ["missing name", { scopes: ["app:read"], app_ids: ["app-a"] }],
    ["name too long", { name: "n".repeat(81), scopes: ["app:read"], app_ids: ["app-a"] }],
  ])("rejects %s with 400", async (_label, body) => {
    const h = await environment();
    const response = await create(h, body);
    expect(response.status).toBe(400);
    expect(h.sqlite.prepare("SELECT COUNT(*) AS n FROM org_access_tokens").get()).toEqual({ n: 0 });
  });

  it("a non-admin org member cannot create, list, or revoke", async () => {
    const h = await environment();
    const created = await create(h, { name: "x", scopes: ["app:read"], app_ids: ["app-a"] }, MEMBER_SESSION);
    expect(created.status).toBe(403);
    expect((await call(h, MEMBER_SESSION, "/api/orgs/org/access-tokens")).status).toBe(403);
    const { access_token } = await mint(h, { name: "x", scopes: ["app:read"], app_ids: ["app-a"] });
    const revoked = await call(h, MEMBER_SESSION, `/api/orgs/org/access-tokens/${access_token.id}`, { method: "DELETE" });
    expect(revoked.status).toBe(403);
    expect(h.sqlite.prepare("SELECT revoked_at FROM org_access_tokens WHERE id = ?").get(access_token.id)).toEqual({ revoked_at: null });
  });

  it("deploy tokens and org tokens cannot manage org tokens", async () => {
    const h = await environment();
    // An unscoped (role) deploy token passes the auth middleware anywhere.
    const deploy = generateDeployToken();
    h.sqlite.prepare(
      `INSERT INTO app_deploy_tokens
         (id, app_id, name, token_prefix, token_hash, app_role, scopes_json, created_by_actor, created_at)
       VALUES ('dt', 'app-a', 'ci', ?, ?, 'publisher', NULL, 'test', 1)`,
    ).run(deploy.token_prefix, await hashDeployToken(deploy.token));
    const orgToken = await insertToken(h, { allApps: true });
    const { access_token } = await mint(h, { name: "victim", scopes: ["app:read"], app_ids: ["app-a"] });
    const before = (h.sqlite.prepare("SELECT COUNT(*) AS n FROM org_access_tokens").get() as { n: number }).n;
    for (const bearer of [deploy.token, orgToken]) {
      const minted = await create(h, { name: "x", scopes: ["app:read"], all_apps: true }, bearer);
      expect([401, 403]).toContain(minted.status);
      expect((await call(h, bearer, "/api/orgs/org/access-tokens")).status).not.toBe(200);
      const revoked = await call(h, bearer, `/api/orgs/org/access-tokens/${access_token.id}`, { method: "DELETE" });
      expect([401, 403]).toContain(revoked.status);
    }
    expect((h.sqlite.prepare("SELECT COUNT(*) AS n FROM org_access_tokens").get() as { n: number }).n).toBe(before);
    expect(h.sqlite.prepare("SELECT revoked_at FROM org_access_tokens WHERE id = ?").get(access_token.id)).toEqual({ revoked_at: null });
  });
});

describe("org access token: secrecy and audit", () => {
  it("stores only the hash, and never returns or audits the plaintext", async () => {
    const h = await environment();
    const { token, access_token } = await mint(h, { name: "secret", scopes: ["feedback:read"], app_ids: ["app-a", "app-b"] });
    const row = h.sqlite.prepare("SELECT * FROM org_access_tokens WHERE id = ?").get(access_token.id) as Record<string, unknown>;
    expect(row.token_hash).toBe(await hashOrgAccessToken(token));
    expect(JSON.stringify(row)).not.toContain(token);
    expect(token.startsWith(`${access_token.token_prefix}_`)).toBe(true);

    const list = await call(h, ADMIN_SESSION, "/api/orgs/org/access-tokens");
    expect(list.status).toBe(200);
    const listText = await list.text();
    expect(listText).not.toContain(token);
    expect(listText).not.toContain(row.token_hash as string);
    expect(listText).not.toContain("token_hash");
    const listed = (JSON.parse(listText) as { access_tokens: Array<Record<string, unknown>> }).access_tokens;
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      id: access_token.id,
      all_apps: false,
      scopes: ["feedback:read"],
      apps: [
        { id: "app-a", slug: "alpha", name: "App A" },
        { id: "app-b", slug: "bravo", name: "App B" },
      ],
      revoked_at: null,
    });

    const audits = h.sqlite.prepare("SELECT payload FROM audit_logs").all() as { payload: string }[];
    for (const audit of audits) expect(audit.payload).not.toContain(token);
  });

  it("writes one audit row per selected app on create and revoke", async () => {
    const h = await environment();
    const { access_token } = await mint(h, { name: "audited", scopes: ["app:read"], app_ids: ["app-a", "app-b"] });
    const created = h.sqlite.prepare(
      "SELECT app_id, actor, actor_id, payload FROM audit_logs WHERE action = 'org_access_token.create' ORDER BY app_id",
    ).all() as { app_id: string; actor: string; actor_id: string; payload: string }[];
    expect(created.map((r) => r.app_id)).toEqual(["app-a", "app-b"]);
    expect(created[0]!.actor_id).toBe("acct-admin");
    expect(JSON.parse(created[0]!.payload)).toMatchObject({
      id: access_token.id,
      name: "audited",
      token_prefix: access_token.token_prefix,
      scopes: ["app:read"],
      all_apps: false,
    });

    await call(h, ADMIN_SESSION, `/api/orgs/org/access-tokens/${access_token.id}`, { method: "DELETE" });
    const revoked = h.sqlite.prepare(
      "SELECT app_id FROM audit_logs WHERE action = 'org_access_token.revoke' ORDER BY app_id",
    ).all() as { app_id: string }[];
    expect(revoked.map((r) => r.app_id)).toEqual(["app-a", "app-b"]);
    // Revoking again changes nothing and writes no new audit rows.
    const again = await call(h, ADMIN_SESSION, `/api/orgs/org/access-tokens/${access_token.id}`, { method: "DELETE" });
    expect(again.status).toBe(200);
    expect((h.sqlite.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'org_access_token.revoke'").get() as { n: number }).n).toBe(2);
  });

  it("an all_apps token audits every current app in the org and none outside it", async () => {
    const h = await environment();
    await mint(h, { name: "all", scopes: ["app:read"], all_apps: true });
    const rows = h.sqlite.prepare(
      "SELECT app_id FROM audit_logs WHERE action = 'org_access_token.create' ORDER BY app_id",
    ).all() as { app_id: string }[];
    expect(rows.map((r) => r.app_id)).toEqual(["app-a", "app-b"]);
  });

  it("an org token acting on an app is named as an org token in the actor", async () => {
    const { currentActorInfo } = await import("../src/middleware/auth");
    const ctx = new Map<string, unknown>([
      ["admin_deploy_token", { id: "t", name: "bot", app_slug: "alpha" }],
      ["admin_org_token_id", "t"],
    ]);
    expect(currentActorInfo({ get: (k: string) => ctx.get(k) } as never).display_name).toBe("org-token:bot@alpha");
  });
});

describe("org access token: hardening", () => {
  it("refuses all_apps in an organization with no apps, so no token exists without an audit record", async () => {
    const h = await environment();
    h.sqlite.prepare(
      `INSERT INTO org_members (id, org_id, account_id, org_role, joined_at) VALUES ('m-x', 'other-org', 'acct-admin', 'admin', 1)`,
    ).run();
    h.sqlite.prepare("DELETE FROM apps WHERE org_id = 'other-org'").run();
    const response = await call(h, ADMIN_SESSION, "/api/orgs/other-org/access-tokens", {
      method: "POST", body: { name: "x", scopes: ["feedback:read"], all_apps: true },
    });
    expect(response.status).toBe(400);
    expect(h.sqlite.prepare("SELECT COUNT(*) AS n FROM org_access_tokens").get()).toEqual({ n: 0 });
  });

  it("commits the token and its audit rows together: a failing audit insert leaves no token", async () => {
    const h = await environment();
    h.sqlite.exec(`CREATE TRIGGER fail_audit BEFORE INSERT ON audit_logs
      WHEN NEW.action = 'org_access_token.create' BEGIN SELECT RAISE(ABORT, 'audit down'); END;`);
    const response = await call(h, ADMIN_SESSION, "/api/orgs/org/access-tokens", {
      method: "POST", body: { name: "x", scopes: ["feedback:read"], app_ids: ["app-a"] },
    }).catch(() => null);
    expect(response === null || response.status >= 500).toBe(true);
    expect(h.sqlite.prepare("SELECT COUNT(*) AS n FROM org_access_tokens").get()).toEqual({ n: 0 });
    expect(h.sqlite.prepare("SELECT COUNT(*) AS n FROM org_access_token_apps").get()).toEqual({ n: 0 });
  });

  it("an operation of another app is not readable through this app's operations route", async () => {
    const h = await environment();
    h.sqlite.prepare(
      `INSERT INTO operation_logs (id, app_id, kind, status, actor, created_at, updated_at)
       VALUES ('op-b', 'app-b', 'test', 'succeeded', 'test', 1, 1)`,
    ).run();
    const token = await insertToken(h, { scopes: ["app:read"], apps: ["app-a", "app-b"] });
    expect((await call(h, token, "/api/apps/app-a/operations/op-b")).status).toBe(404);
    expect((await call(h, token, "/api/apps/app-b/operations/op-b")).status).toBe(200);
  });
});
