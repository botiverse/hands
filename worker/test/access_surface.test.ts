/**
 * Access-surface holes closed in phase 0 of the permissions cleanup:
 *
 *   I-5  GET /api/apps lists exactly the apps the caller can open.
 *   I-12 GET /api/admin/container/build is Hands-admin only.
 *   I-13 /dl/:slug/releases/:releaseId/:file serves only releases a public surface publishes.
 *   I-14 GET /api/users/:accountId/audit returns real rows, scoped to the current org at member+.
 *
 * Everything runs on the real migration chain, and the admin routes run through the shipped
 * route table (`admin`), so the auth middleware and role gates are the real ones.
 */

import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";

vi.mock("@cloudflare/containers", () => ({
  Container: class {},
  getRandom: async () => ({ fetch: async () => Response.json({ build: "abc123" }) }),
}));
import { admin } from "../src/index";
import { generateDeployToken, hashDeployToken, sha256Hex } from "../src/lib/deploy_tokens";
import { handleExternalReleaseDl } from "../src/routes/external_dl";

const MIGRATION_DIR = fileURLToPath(new URL("../../migrations/sql/", import.meta.url));

type BoundStatement = {
  _execute: () => { results: unknown[]; success: true; meta: { changes: number } };
  run: () => Promise<{ results: unknown[]; success: true; meta: { changes: number } }>;
  all: () => Promise<{ results: unknown[]; success: true; meta: { changes: number } }>;
  first: <T>() => Promise<T | null>;
};

/**
 * D1 shim that numbers placeholders the way SQLite does: `?N` is parameter N, and a bare `?`
 * is one more than the largest number used so far. Unbound parameters are NULL. This is what
 * made the old user-audit query silently match nothing, so the shim must reproduce it rather
 * than throw.
 */
function d1(db: Database.Database) {
  const prepare = (sql: string) => {
    const indexes: number[] = [];
    let largest = 0;
    const normalized = sql.replace(/\?(\d*)/g, (_match, digits: string) => {
      const index = digits ? Number(digits) : largest + 1;
      largest = Math.max(largest, index);
      indexes.push(index);
      return "?";
    });
    const statement = db.prepare(normalized);
    const bind = (...input: unknown[]): BoundStatement => {
      const params = indexes
        .map((index) => input[index - 1])
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

function migratedDb() {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  for (const name of readdirSync(MIGRATION_DIR).sort()) {
    if (name.endsWith(".sql")) sqlite.exec(readFileSync(`${MIGRATION_DIR}${name}`, "utf8"));
  }
  return sqlite;
}

const ADMIN_API_TOKEN = "dev-token-for-tests";

async function seedPeople(sqlite: Database.Database) {
  const org = sqlite.prepare(
    `INSERT INTO organizations (id, slug, name, external_provider, external_id, created_at)
     VALUES (?, ?, ?, 'raft', ?, 1)`,
  );
  org.run("home", "home", "Home", "srv-home");
  org.run("other", "other", "Other", "srv-other");
  org.run("am-org", "am-org", "App-member org", "srv-am");
  org.run("guest-org", "guest-org", "Guest org", "srv-guest");
  org.run("out-org", "out-org", "Outsider org", "srv-out");

  const account = sqlite.prepare(
    `INSERT INTO raft_accounts
       (id, provider_subject, server_id, server_slug, server_role, principal_type, display_name,
        username, raw_profile, created_at, updated_at, last_login_at)
     VALUES (?, ?, ?, ?, ?, 'human', ?, ?, '{}', 1, 1, 1)`,
  );
  const member = sqlite.prepare(
    `INSERT INTO org_members (id, org_id, account_id, org_role, joined_at) VALUES (?, ?, ?, ?, 1)`,
  );
  const session = sqlite.prepare(
    `INSERT INTO raft_sessions (id, account_id, token_hash, created_at, expires_at, last_seen_at)
     VALUES (?, ?, ?, 1, ?, 1)`,
  );
  const people: Array<[id: string, server: string, slug: string, serverRole: string, orgs: Array<[string, string]>]> = [
    ["owner", "srv-home", "home", "owner", [["home", "owner"]]],
    ["admin", "srv-home", "home", "admin", [["home", "admin"]]],
    ["member", "srv-home", "home", "member", [["home", "member"]]],
    ["viewer", "srv-home", "home", "member", [["home", "viewer"]]],
    // Only path to anything: an app_members row on an app in another org.
    ["appmember", "srv-am", "am", "member", [["am-org", "member"]]],
    // Invited into `home` as a viewer, but NOT a member of the Raft org for its own server
    // (guest-org). Grants naming srv-guest therefore confer nothing (getOwnerServerRole).
    ["guest", "srv-guest", "guest", "member", [["home", "viewer"]]],
    ["outsider", "srv-out", "out", "member", [["out-org", "member"]]],
    // Member of `other`, for the user-audit scope test.
    ["other-member", "srv-other", "other", "member", [["other", "member"]]],
  ];
  for (const [id, server, slug, serverRole, orgs] of people) {
    account.run(id, id, server, slug, serverRole, id, id);
    for (const [orgId, role] of orgs) member.run(`m-${id}-${orgId}`, orgId, id, role);
    session.run(`s-${id}`, id, await sha256Hex(`session-${id}`), Date.now() + 3_600_000);
  }
}

function seedApps(sqlite: Database.Database) {
  const app = sqlite.prepare(
    `INSERT INTO apps (id, org_id, slug, name, platform, client_key, created_at, archived)
     VALUES (?, ?, ?, ?, 'electron', ?, ?, ?)`,
  );
  const apps: Array<[id: string, org: string, archived: number]> = [
    ["app-home", "home", 0],
    ["app-home-archived", "home", 1],
    ["app-other-plain", "other", 0],
    ["app-other-member", "other", 0],
    ["app-other-cowner-id", "other", 0],
    ["app-other-cowner-slug", "other", 0],
    ["app-other-legacy", "other", 0],
    ["app-guest-cowner", "other", 0],
    ["app-guest-legacy", "other", 0],
  ];
  apps.forEach(([id, org, archived], index) => app.run(id, org, id, id, `ck-${id}`, index + 1, archived));

  sqlite.prepare(
    `INSERT INTO app_members (id, app_id, account_id, app_role, joined_at)
     VALUES ('am-1', 'app-other-member', 'appmember', 'viewer', 1)`,
  ).run();
  const grant = sqlite.prepare(
    `INSERT INTO app_server_grants
       (id, app_id, server_id, server_slug, app_role, access_model, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, 1)`,
  );
  grant.run("g1", "app-other-cowner-id", "srv-home", null, "admin", "owner_server");
  grant.run("g2", "app-other-cowner-slug", null, "home", "admin", "owner_server");
  grant.run("g3", "app-other-legacy", "srv-home", null, "viewer", "legacy_role");
  // These match the guest's server by id / slug, but the guest is not a member of the Raft
  // org for that server, so neither grant opens the app. The old list showed both.
  grant.run("g4", "app-guest-cowner", "srv-guest", null, "admin", "owner_server");
  grant.run("g5", "app-guest-legacy", null, "guest", "publisher", "legacy_role");
}

async function environment() {
  const sqlite = migratedDb();
  await seedPeople(sqlite);
  seedApps(sqlite);
  const env = {
    DB: d1(sqlite),
    ENVIRONMENT: "development",
    ADMIN_API_TOKEN,
    HANDS_ADMIN_ALLOWED_SERVER_IDS: "srv-home",
    DASHBOARD_ORIGIN: "https://dashboard.example",
    APK_PARSER: {},
  } as unknown as Env;
  return { sqlite, env };
}
type Harness = Awaited<ReturnType<typeof environment>>;

const call = (h: Harness, bearer: string, path: string, headers: Record<string, string> = {}) =>
  admin.request(`https://hands.test${path}`, { headers: { authorization: `Bearer ${bearer}`, ...headers } }, h.env);

const ALL_APPS = [
  "app-home", "app-home-archived", "app-other-plain", "app-other-member", "app-other-cowner-id",
  "app-other-cowner-slug", "app-other-legacy", "app-guest-cowner", "app-guest-legacy",
];

describe("I-5: GET /api/apps lists exactly the apps the caller can open", () => {
  const homeMemberView = [
    "app-home", "app-home-archived", "app-other-cowner-id", "app-other-cowner-slug", "app-other-legacy",
  ];
  const principals: Array<[name: string, headers: Record<string, string>, expected: string[]]> = [
    ["owner", {}, homeMemberView],
    ["admin", {}, homeMemberView],
    ["member", {}, homeMemberView],
    ["viewer", {}, homeMemberView],
    ["appmember", {}, ["app-other-member"]],
    ["guest", { "x-hands-org-id": "home" }, ["app-home", "app-home-archived"]],
    ["outsider", {}, []],
  ];

  it.each(principals)("%s: list membership equals GET /api/apps/:id access", async (name, headers, expected) => {
    const h = await environment();
    const listed = await call(h, `session-${name}`, "/api/apps", headers);
    expect(listed.status, await listed.clone().text()).toBe(200);
    const listIds = ((await listed.json()) as { apps: { id: string }[] }).apps.map((a) => a.id).sort();

    const openable: string[] = [];
    for (const appId of ALL_APPS) {
      const res = await call(h, `session-${name}`, `/api/apps/${appId}`, headers);
      expect([200, 403]).toContain(res.status);
      if (res.status === 200) openable.push(appId);
    }
    expect(listIds).toEqual(openable.sort());
    expect(listIds).toEqual([...expected].sort());
  });
});

describe("I-12: GET /api/admin/container/build is Hands-admin only", () => {
  it("admits a Hands admin session", async () => {
    const h = await environment();
    const res = await call(h, "session-admin", "/api/admin/container/build");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, status: 200, build: "abc123", stamped: true });
  });

  it("refuses a non-admin session, an unscoped deploy token and the dev token", async () => {
    const h = await environment();
    const nonAdmin = await call(h, "session-member", "/api/admin/container/build");
    expect(nonAdmin.status).toBe(403);
    expect(await nonAdmin.json()).toEqual({ error: "forbidden", code: "HANDS_ADMIN_REQUIRED" });

    const deploy = generateDeployToken();
    h.sqlite.prepare(
      `INSERT INTO app_deploy_tokens
         (id, app_id, name, token_prefix, token_hash, app_role, scopes_json, created_by_actor, created_at)
       VALUES ('dt', 'app-home', 'ci', ?, ?, 'publisher', NULL, 'test', 1)`,
    ).run(deploy.token_prefix, await hashDeployToken(deploy.token));
    expect((await call(h, deploy.token, "/api/admin/container/build")).status).toBe(401);
    expect((await call(h, ADMIN_API_TOKEN, "/api/admin/container/build")).status).toBe(401);
  });
});

describe("I-13: /dl/:slug/releases/:releaseId/:file serves only published releases", () => {
  async function dlEnvironment() {
    const sqlite = migratedDb();
    sqlite.prepare(
      `INSERT INTO organizations (id, slug, name, external_provider, external_id, created_at)
       VALUES ('org', 'org', 'Org', 'raft', 'srv', 1)`,
    ).run();
    const app = sqlite.prepare(
      `INSERT INTO apps (id, org_id, slug, name, platform, client_key, created_at,
                         archived, public_history, history_show_downloads)
       VALUES (?, 'org', ?, ?, 'electron', ?, 1, ?, ?, ?)`,
    );
    // [id, archived, public_history, history_show_downloads]
    const apps: Array<[string, number, number, number]> = [
      ["pub", 0, 1, 1],
      ["priv", 0, 0, 0],
      ["arch", 1, 1, 1],
      ["nodl", 0, 1, 0],
    ];
    for (const [id, archived, history, downloads] of apps) {
      app.run(id, id, id, `ck-${id}`, archived, history, downloads);
      sqlite.prepare(
        "INSERT INTO channels (id, app_id, slug, name, created_at) VALUES (?, ?, 'main', 'Main', 1)",
      ).run(`ch-${id}`, id);
    }
    let n = 0;
    const release = (
      appId: string,
      opts: { status: "active" | "superseded"; hidden?: number; productType?: string; releaseType?: string; fullScope?: boolean },
    ) => {
      n += 1;
      const productType = opts.productType ?? "desktop-installer";
      const releaseType = opts.releaseType ?? "stable";
      const buildId = `b${n}`;
      const releaseId = `r${n}`;
      sqlite.prepare(
        `INSERT INTO builds (id, app_id, channel_id, product_type, release_type, version_name, version_code,
                             source, status, build_metadata_json, parsed_metadata_json, provenance_json,
                             created_at, updated_at, artifact_mode)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'external', 'succeeded', '{}', '{}', '{}', 1, 1, 'external')`,
      ).run(buildId, appId, `ch-${appId}`, productType, releaseType, `1.0.${n}`, n);
      sqlite.prepare(
        `INSERT INTO releases (id, app_id, build_id, channel_id, product_type, release_type, status,
                               hidden, provenance_json, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, '{}', 'test', 1, 1)`,
      ).run(releaseId, appId, buildId, `ch-${appId}`, productType, releaseType, opts.status, opts.hidden ?? 0);
      if (opts.fullScope) {
        sqlite.prepare(
          `INSERT INTO release_scopes (id, release_id, scope_type, scope_value, created_at)
           VALUES (?, ?, 'full', 'all', 1)`,
        ).run(`s${n}`, releaseId);
      }
      sqlite.prepare(
        `INSERT INTO external_build_targets (id, app_id, build_id, version_name, target, source_url,
                                             raw_sha256, raw_size_bytes, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'linux-x64', ?, ?, 10, 1, 1)`,
      ).run(`t${n}`, appId, buildId, `1.0.${n}`, `https://cdn.example/${releaseId}`, "a".repeat(64));
      return releaseId;
    };
    const router = new Hono<{ Bindings: Env }>();
    router.get("/dl/:slug/releases/:releaseId/:file", handleExternalReleaseDl);
    const env = { DB: d1(sqlite) } as unknown as Env;
    const get = (slug: string, releaseId: string) =>
      router.request(`https://hands.test/dl/${slug}/releases/${releaseId}/linux-x64`, {}, env);
    return { release, get };
  }

  it("still serves current releases, public-history releases and pinned CLI releases", async () => {
    const h = await dlEnvironment();
    const cases: Array<[string, string]> = [
      // The current release of an app with no public history: what /dl/{slug}/{channel}/... resolves to.
      ["priv", h.release("priv", { status: "active" })],
      // Even a hidden current release stays served: /latest and the channel route still hand it out.
      ["priv", h.release("priv", { status: "active", hidden: 1 })],
      ["arch", h.release("arch", { status: "active" })],
      // A superseded release on the public history page with downloads on.
      ["pub", h.release("pub", { status: "superseded" })],
      // A superseded CLI release /updates/check?version= publishes, history off.
      ["priv", h.release("priv", { status: "superseded", productType: "cli-binary", fullScope: true })],
    ];
    for (const [slug, releaseId] of cases) {
      const res = await h.get(slug, releaseId);
      expect(res.status, `${slug}/${releaseId}`).toBe(302);
      expect(res.headers.get("location")).toBe(`https://cdn.example/${releaseId}`);
    }
  });

  it("returns 404 for superseded releases no public surface publishes", async () => {
    const h = await dlEnvironment();
    const cases: Array<[label: string, slug: string, releaseId: string]> = [
      ["hidden", "pub", h.release("pub", { status: "superseded", hidden: 1 })],
      ["history off", "priv", h.release("priv", { status: "superseded" })],
      ["archived app", "arch", h.release("arch", { status: "superseded" })],
      ["history downloads off", "nodl", h.release("nodl", { status: "superseded" })],
      ["qa build", "pub", h.release("pub", { status: "superseded", releaseType: "qa" })],
      ["hidden pinned cli", "priv", h.release("priv", { status: "superseded", productType: "cli-binary", fullScope: true, hidden: 1 })],
      ["partial-scope cli", "priv", h.release("priv", { status: "superseded", productType: "cli-binary" })],
    ];
    for (const [label, slug, releaseId] of cases) {
      const res = await h.get(slug, releaseId);
      expect(res.status, label).toBe(404);
      expect(await res.json(), label).toEqual({ error: "release not found" });
    }
  });
});

describe("I-14: GET /api/users/:accountId/audit", () => {
  function seedAudit(h: Harness) {
    const insert = h.sqlite.prepare(
      `INSERT INTO audit_logs (id, app_id, action, actor, actor_id, actor_type, payload, created_at)
       VALUES (?, ?, ?, 'x', ?, 'human', '{}', ?)`,
    );
    insert.run("l1", "app-home", "app.update", "member", 100);
    insert.run("l2", "app-home-archived", "channel.create", "member", 200);
    insert.run("l3", "app-other-plain", "app.update", "member", 300);
    insert.run("l4", "app-home", "app.update", "admin", 400);
  }

  it("returns the account's entries in the current org to an org member", async () => {
    const h = await environment();
    seedAudit(h);
    const res = await call(h, "session-admin", "/api/users/member/audit");
    expect(res.status, await res.clone().text()).toBe(200);
    const body = (await res.json()) as { logs: { id: string; app_slug: string }[]; total: number };
    expect(body.logs.map((l) => l.id)).toEqual(["l2", "l1"]);
    expect(body.total).toBe(2);
    expect(body.logs[1]!.app_slug).toBe("app-home");

    const since = await call(h, "session-member", "/api/users/member/audit?since=150");
    expect(((await since.json()) as { logs: { id: string }[] }).logs.map((l) => l.id)).toEqual(["l2"]);
  });

  it("scopes to the caller's current org and refuses an org viewer", async () => {
    const h = await environment();
    seedAudit(h);
    // A member of `other` reads only `other`'s entries about the account, never home's.
    const otherOrg = await call(h, "session-other-member", "/api/users/member/audit");
    expect(otherOrg.status).toBe(200);
    expect(((await otherOrg.json()) as { logs: { id: string }[] }).logs.map((l) => l.id)).toEqual(["l3"]);

    // Viewer: the org audit listing needs member, so this does too.
    const viewer = await call(h, "session-viewer", "/api/users/member/audit");
    expect(viewer.status).toBe(403);
    expect(await viewer.json()).toMatchObject({ code: "INSUFFICIENT_ORG_ROLE" });

    // An outsider in its own org sees nothing about the account.
    const outsider = await call(h, "session-outsider", "/api/users/member/audit");
    expect(outsider.status).toBe(200);
    expect(((await outsider.json()) as { logs: unknown[] }).logs).toEqual([]);
  });
});
