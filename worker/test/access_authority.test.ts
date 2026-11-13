/**
 * Phase 0 authority fixes, driven through the real admin route table on the
 * real migrated schema:
 *
 * - I-1: an app member (added directly or through an app invite) gets that app
 *   and nothing else in its org. No org membership is created as a side effect.
 * - I-4: a direct org role and a co-owner (owner-server) role combine as the
 *   stronger of the two, and several matching grant rows resolve to the highest.
 * - I-17: only admin/owner of the owning org manage co-owner servers.
 * - I-11: invites only ever raise a role, owner grants need an owner, and an
 *   invite is used at most once.
 *
 * Transfer authority (I-7) is covered in app_transfer.test.ts.
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
import { sha256Hex } from "../src/lib/deploy_tokens";
import { getEffectiveRole } from "../src/lib/permissions";

const MIGRATION_DIR = fileURLToPath(new URL("../../migrations/sql/", import.meta.url));

type BoundStatement = {
  _execute: () => { results: unknown[]; success: true; meta: { changes: number } };
  run: () => Promise<{ results: unknown[]; success: true; meta: { changes: number } }>;
  all: () => Promise<{ results: unknown[]; success: true; meta: { changes: number } }>;
  first: <T>() => Promise<T | null>;
};

function d1(db: Database.Database, hooks: { beforeBatch: () => void }) {
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
    batch: async (statements: BoundStatement[]) => {
      hooks.beforeBatch();
      return db.transaction(() => statements.map((statement) => statement._execute()))();
    },
  };
}

// Sessions, by the account they authenticate.
const OWNER = "session-owner"; // owner of org (server "server")
const ADMIN = "session-admin"; // admin of org
const MEMBER = "session-member"; // member of org
const OUTSIDER = "session-outsider"; // member of other-org only (server "other-server")
const COOWNER = "session-coowner"; // admin of co-org (server "co-server"), co-owner of app-a

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
  insertOrg.run("co-org", "co-org", "Co", "co-server");
  const insertApp = sqlite.prepare(
    `INSERT INTO apps (id, org_id, slug, name, platform, client_key, created_at)
     VALUES (?, ?, ?, ?, 'electron', ?, 1)`,
  );
  insertApp.run("app-a", "org", "alpha", "App A", "ck-a");
  insertApp.run("app-b", "org", "bravo", "App B", "ck-b");

  const insertAccount = sqlite.prepare(
    `INSERT INTO raft_accounts
       (id, provider_subject, server_id, server_slug, principal_type, display_name, username, raw_profile,
        created_at, updated_at, last_login_at)
     VALUES (?, ?, ?, ?, 'human', ?, ?, '{}', 1, 1, 1)`,
  );
  const insertMember = sqlite.prepare(
    `INSERT INTO org_members (id, org_id, account_id, org_role, joined_at) VALUES (?, ?, ?, ?, 1)`,
  );
  const insertSession = sqlite.prepare(
    `INSERT INTO raft_sessions (id, account_id, token_hash, created_at, expires_at, last_seen_at)
     VALUES (?, ?, ?, 1, ?, 1)`,
  );
  const people: Array<[string, string, string, string, string]> = [
    // account, server, home org, role, session
    ["acct-owner", "server", "org", "owner", OWNER],
    ["acct-admin", "server", "org", "admin", ADMIN],
    ["acct-member", "server", "org", "member", MEMBER],
    ["acct-outsider", "other-server", "other-org", "member", OUTSIDER],
    ["acct-coowner", "co-server", "co-org", "admin", COOWNER],
  ];
  for (const [account, server, org, role, session] of people) {
    insertAccount.run(account, account, server, server, account, account);
    insertMember.run(`m-${account}`, org, account, role);
    insertSession.run(`s-${account}`, account, await sha256Hex(session), Date.now() + 3_600_000);
  }
  sqlite.prepare(
    `INSERT INTO app_server_grants
       (id, app_id, server_id, server_slug, app_role, access_model, created_at, updated_at)
     VALUES ('grant-co', 'app-a', 'co-server', NULL, 'admin', 'owner_server', 1, 1)`,
  ).run();

  const hooks = { beforeBatch: () => {} };
  const env = {
    DB: d1(sqlite, hooks),
    ENVIRONMENT: "production",
    DASHBOARD_ORIGIN: "https://dashboard.example",
    FEEDBACK_AUDIT_HMAC_KEY: "access-authority-test-audit-key-with-entropy",
    FEEDBACK_AUDIT_KEY_VERSION: "test-v1",
  } as unknown as Env;
  return { sqlite, env, hooks };
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

const orgRole = (h: Harness, orgId: string, accountId: string) =>
  h.sqlite.prepare("SELECT org_role FROM org_members WHERE org_id = ? AND account_id = ?")
    .pluck().get(orgId, accountId) as string | undefined;

const appRole = (h: Harness, appId: string, accountId: string) =>
  h.sqlite.prepare("SELECT app_role FROM app_members WHERE app_id = ? AND account_id = ?")
    .pluck().get(appId, accountId) as string | undefined;

async function listedAppIds(h: Harness, bearer: string) {
  const response = await call(h, bearer, "/api/apps");
  expect(response.status, await response.clone().text()).toBe(200);
  return ((await response.json()) as { apps: { id: string }[] }).apps.map((app) => app.id);
}

async function createInvite(h: Harness, bearer: string, body: Record<string, unknown>) {
  const response = await call(h, bearer, "/api/orgs/org/invites", { method: "POST", body });
  return response;
}

async function inviteToken(h: Harness, bearer: string, body: Record<string, unknown>) {
  const response = await createInvite(h, bearer, body);
  expect(response.status, await response.clone().text()).toBe(201);
  const { invite_url } = (await response.json()) as { invite_url: string };
  return invite_url.split("/invites/")[1]!;
}

async function expectOnlyAppA(h: Harness, bearer: string) {
  expect((await call(h, bearer, "/api/apps/app-a")).status).toBe(200);
  expect((await call(h, bearer, "/api/apps/app-b")).status).toBe(403);
  const listed = await listedAppIds(h, bearer);
  expect(listed).toContain("app-a");
  expect(listed).not.toContain("app-b");
  const orgs = (await (await call(h, bearer, "/api/orgs")).json()) as { orgs: { id: string }[] };
  expect(orgs.orgs.map((org) => org.id)).not.toContain("org");
  expect((await call(h, bearer, "/api/orgs/org/members")).status).toBe(403);
}

describe("I-1: app members get the app, not its org", () => {
  it("an added app member reads app A with their app role, cannot read app B, and sees A in their app list", async () => {
    const h = await environment();
    const added = await call(h, ADMIN, "/api/apps/app-a/members", {
      method: "POST",
      body: { account_id: "acct-outsider", app_role: "publisher" },
    });
    expect(added.status, await added.clone().text()).toBe(201);
    expect(orgRole(h, "org", "acct-outsider")).toBeUndefined();
    expect(appRole(h, "app-a", "acct-outsider")).toBe("publisher");
    await expectOnlyAppA(h, OUTSIDER);
    // Their app role still applies: a publisher, not an admin.
    const members = await call(h, OUTSIDER, "/api/apps/app-a/members");
    expect(members.status).toBe(200);
    expect((await call(h, OUTSIDER, "/api/apps/app-a/members", {
      method: "POST", body: { account_id: "acct-coowner", app_role: "viewer" },
    })).status).toBe(403);
  });

  it("an app admin cannot use membership to open the rest of the org to anyone", async () => {
    const h = await environment();
    h.sqlite.prepare(
      "INSERT INTO app_members (id, app_id, account_id, app_role, joined_at) VALUES ('am', 'app-a', 'acct-outsider', 'admin', 1)",
    ).run();
    const added = await call(h, OUTSIDER, "/api/apps/app-a/members", {
      method: "POST",
      body: { account_id: "acct-coowner", app_role: "viewer" },
    });
    expect(added.status).toBe(201);
    expect(orgRole(h, "org", "acct-coowner")).toBeUndefined();
    expect((await call(h, COOWNER, "/api/apps/app-b")).status).toBe(403);
  });

  it("accepting an app invite grants that app only", async () => {
    const h = await environment();
    const token = await inviteToken(h, ADMIN, { email: "out@example.com", role: "viewer", app_id: "app-a" });
    const accepted = await call(h, OUTSIDER, `/api/invites/${token}/accept`, { method: "POST" });
    expect(accepted.status, await accepted.clone().text()).toBe(200);
    expect(orgRole(h, "org", "acct-outsider")).toBeUndefined();
    expect(appRole(h, "app-a", "acct-outsider")).toBe("viewer");
    await expectOnlyAppA(h, OUTSIDER);
  });
});

describe("I-4: effective org role is the stronger of direct and co-owner", () => {
  it("a weak direct row in the owning org does not shadow co-owner admin", async () => {
    const h = await environment();
    // e.g. an old auto-created viewer row from an app invite
    h.sqlite.prepare(
      "INSERT INTO org_members (id, org_id, account_id, org_role, joined_at) VALUES ('old-viewer', 'org', 'acct-coowner', 'viewer', 1)",
    ).run();
    await expect(getEffectiveRole(h.env.DB, "acct-coowner", { appId: "app-a" })).resolves.toMatchObject({
      org_role: "admin",
      server_org_role: "admin",
    });
    // A publisher action through the owning-org path needs org admin.
    expect((await call(h, COOWNER, "/api/apps/app-a/members", {
      method: "POST", body: { account_id: "acct-outsider", app_role: "viewer" },
    })).status).toBe(201);
  });

  it("a stronger direct row still wins over a weaker co-owner role", async () => {
    const h = await environment();
    h.sqlite.exec("UPDATE org_members SET org_role = 'viewer' WHERE account_id = 'acct-coowner'");
    h.sqlite.prepare(
      "INSERT INTO org_members (id, org_id, account_id, org_role, joined_at) VALUES ('direct', 'org', 'acct-coowner', 'owner', 1)",
    ).run();
    await expect(getEffectiveRole(h.env.DB, "acct-coowner", { appId: "app-a" })).resolves.toMatchObject({
      org_role: "owner",
      server_org_role: "viewer",
    });
  });

  it("two matching grant rows resolve to the highest role, whatever the row order", async () => {
    const h = await environment();
    h.sqlite.exec(`
      UPDATE raft_accounts SET server_slug = 'co-slug' WHERE id = 'acct-coowner';
      DELETE FROM app_server_grants;
      INSERT INTO app_server_grants (id, app_id, server_id, server_slug, app_role, access_model, created_at, updated_at)
        VALUES ('g1', 'app-a', 'co-server', NULL, 'viewer', 'legacy_role', 1, 1),
               ('g2', 'app-a', NULL, 'co-slug', 'admin', 'owner_server', 1, 1);
    `);
    await expect(getEffectiveRole(h.env.DB, "acct-coowner", { appId: "app-a" })).resolves.toMatchObject({
      org_role: "admin",
      server_org_role: "admin",
      app_role: "viewer",
      server_app_role: "viewer",
    });
    h.sqlite.exec(`
      DELETE FROM app_server_grants;
      INSERT INTO app_server_grants (id, app_id, server_id, server_slug, app_role, access_model, created_at, updated_at)
        VALUES ('g1', 'app-a', 'co-server', NULL, 'viewer', 'legacy_role', 1, 1),
               ('g2', 'app-a', NULL, 'co-slug', 'admin', 'legacy_role', 1, 1);
    `);
    await expect(getEffectiveRole(h.env.DB, "acct-coowner", { appId: "app-a" })).resolves.toMatchObject({
      app_role: "admin",
      server_app_role: "admin",
    });
  });
});

describe("I-17: co-owner servers are managed by the owning org", () => {
  it("a co-owner admin cannot add, change or remove co-owners", async () => {
    const h = await environment();
    const add = await call(h, COOWNER, "/api/apps/app-a/server-grants", {
      method: "POST", body: { server_id: "other-server" },
    });
    expect(add.status).toBe(403);
    expect(await add.json()).toMatchObject({ code: "OWNING_ORG_ADMIN_REQUIRED" });
    expect((await call(h, COOWNER, "/api/apps/app-a/server-grants/co-server", { method: "DELETE" })).status).toBe(403);
    expect((await call(h, COOWNER, "/api/apps/app-a/server-grants/co-server", {
      method: "PATCH", body: { app_role: "viewer" },
    })).status).toBe(403);
    expect(h.sqlite.prepare("SELECT COUNT(*) FROM app_server_grants").pluck().get()).toBe(1);
  });

  it("an app_members admin cannot add or remove co-owners", async () => {
    const h = await environment();
    h.sqlite.prepare(
      "INSERT INTO app_members (id, app_id, account_id, app_role, joined_at) VALUES ('am', 'app-a', 'acct-outsider', 'admin', 1)",
    ).run();
    expect((await call(h, OUTSIDER, "/api/apps/app-a/server-grants", {
      method: "POST", body: { server_id: "other-server" },
    })).status).toBe(403);
    expect((await call(h, OUTSIDER, "/api/apps/app-a/server-grants/co-server", { method: "DELETE" })).status).toBe(403);
    expect(h.sqlite.prepare("SELECT COUNT(*) FROM app_server_grants").pluck().get()).toBe(1);
  });

  it("an org member who is also an app_members admin cannot manage co-owners", async () => {
    const h = await environment();
    h.sqlite.prepare(
      "INSERT INTO app_members (id, app_id, account_id, app_role, joined_at) VALUES ('am', 'app-a', 'acct-member', 'admin', 1)",
    ).run();
    expect((await call(h, MEMBER, "/api/apps/app-a/server-grants", {
      method: "POST", body: { server_id: "other-server" },
    })).status).toBe(403);
  });

  it("an admin of the owning org adds and removes co-owners", async () => {
    const h = await environment();
    const add = await call(h, ADMIN, "/api/apps/app-a/server-grants", {
      method: "POST", body: { server_id: "other-server" },
    });
    expect(add.status, await add.clone().text()).toBe(201);
    expect((await call(h, OWNER, "/api/apps/app-a/server-grants/co-server", { method: "DELETE" })).status).toBe(200);
    expect(h.sqlite.prepare("SELECT server_id FROM app_server_grants").pluck().all()).toEqual(["other-server"]);
    // Changing the role is still not a configurable thing, but only for org admins.
    expect((await call(h, ADMIN, "/api/apps/app-a/server-grants/other-server", {
      method: "PATCH", body: { app_role: "viewer" },
    })).status).toBe(409);
  });
});

describe("I-11: invites", () => {
  it("accepting a lower org invite never demotes an existing member", async () => {
    const h = await environment();
    const token = await inviteToken(h, ADMIN, { email: "member@example.com", role: "viewer" });
    expect((await call(h, MEMBER, `/api/invites/${token}/accept`, { method: "POST" })).status).toBe(200);
    expect(orgRole(h, "org", "acct-member")).toBe("member");
  });

  it("accepting an org invite cannot demote the last owner", async () => {
    const h = await environment();
    const token = await inviteToken(h, ADMIN, { email: "owner@example.com", role: "viewer" });
    expect((await call(h, OWNER, `/api/invites/${token}/accept`, { method: "POST" })).status).toBe(200);
    expect(orgRole(h, "org", "acct-owner")).toBe("owner");
    expect(h.sqlite.prepare("SELECT COUNT(*) FROM org_members WHERE org_id = 'org' AND org_role = 'owner'").pluck().get()).toBe(1);
  });

  it("accepting a higher org invite upgrades, and a new member gets the invited role", async () => {
    const h = await environment();
    const up = await inviteToken(h, ADMIN, { email: "up@example.com", role: "admin" });
    expect((await call(h, MEMBER, `/api/invites/${up}/accept`, { method: "POST" })).status).toBe(200);
    expect(orgRole(h, "org", "acct-member")).toBe("admin");
    const fresh = await inviteToken(h, ADMIN, { email: "new@example.com", role: "member" });
    expect((await call(h, OUTSIDER, `/api/invites/${fresh}/accept`, { method: "POST" })).status).toBe(200);
    expect(orgRole(h, "org", "acct-outsider")).toBe("member");
  });

  it("accepting a lower app invite never demotes an existing app role", async () => {
    const h = await environment();
    h.sqlite.prepare(
      "INSERT INTO app_members (id, app_id, account_id, app_role, joined_at) VALUES ('am', 'app-a', 'acct-outsider', 'admin', 1)",
    ).run();
    const token = await inviteToken(h, ADMIN, { email: "out@example.com", role: "viewer", app_id: "app-a" });
    expect((await call(h, OUTSIDER, `/api/invites/${token}/accept`, { method: "POST" })).status).toBe(200);
    expect(appRole(h, "app-a", "acct-outsider")).toBe("admin");
  });

  it("only an owner can create an owner invite; admins can invite up to admin", async () => {
    const h = await environment();
    const denied = await createInvite(h, ADMIN, { email: "boss@example.com", role: "owner" });
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ code: "OWNER_ROLE_REQUIRED" });
    expect((await createInvite(h, ADMIN, { email: "adm@example.com", role: "admin" })).status).toBe(201);
    expect((await createInvite(h, OWNER, { email: "boss@example.com", role: "owner" })).status).toBe(201);
  });

  it("an admin cannot resend (and so obtain) an owner invite link", async () => {
    const h = await environment();
    const created = await createInvite(h, OWNER, { email: "boss@example.com", role: "owner" });
    const { id } = (await created.json()) as { id: string };
    const resend = await call(h, ADMIN, `/api/orgs/org/invites/${id}/resend`, { method: "POST" });
    expect(resend.status).toBe(403);
    expect((await call(h, OWNER, `/api/orgs/org/invites/${id}/resend`, { method: "POST" })).status).toBe(200);
  });

  it("only an owner can promote someone to owner; admins can promote up to admin", async () => {
    const h = await environment();
    const denied = await call(h, ADMIN, "/api/orgs/org/members/acct-member", {
      method: "PATCH", body: { org_role: "owner" },
    });
    expect(denied.status).toBe(403);
    expect(orgRole(h, "org", "acct-member")).toBe("member");
    expect((await call(h, ADMIN, "/api/orgs/org/members/acct-member", {
      method: "PATCH", body: { org_role: "admin" },
    })).status).toBe(200);
    expect((await call(h, OWNER, "/api/orgs/org/members/acct-member", {
      method: "PATCH", body: { org_role: "owner" },
    })).status).toBe(200);
    expect(orgRole(h, "org", "acct-member")).toBe("owner");
  });

  it("an invite works once", async () => {
    const h = await environment();
    const token = await inviteToken(h, ADMIN, { email: "once@example.com", role: "member" });
    expect((await call(h, OUTSIDER, `/api/invites/${token}/accept`, { method: "POST" })).status).toBe(200);
    expect((await call(h, COOWNER, `/api/invites/${token}/accept`, { method: "POST" })).status).toBe(409);
    expect(orgRole(h, "org", "acct-coowner")).toBeUndefined();
  });

  it("a concurrent accept that loses the race grants nothing", async () => {
    const h = await environment();
    const token = await inviteToken(h, ADMIN, { email: "race@example.com", role: "admin" });
    // Another accept commits between this request's read and its write.
    h.hooks.beforeBatch = () => {
      h.sqlite.prepare("UPDATE invites SET status = 'accepted', accepted_by = 'acct-outsider' WHERE token = ?").run(token);
    };
    const response = await call(h, COOWNER, `/api/invites/${token}/accept`, { method: "POST" });
    expect(response.status).toBe(409);
    expect(orgRole(h, "org", "acct-coowner")).toBeUndefined();
    expect(h.sqlite.prepare("SELECT accepted_by FROM invites WHERE token = ?").pluck().get(token)).toBe("acct-outsider");
  });
});
