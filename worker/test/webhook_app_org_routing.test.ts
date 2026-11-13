// App events (builds, releases) must reach the webhooks of the org that OWNS
// the app, never the org the caller currently has selected; and an org webhook
// may only narrow to an app that org owns.
import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { requireAppRole, requireOrgRole } from "../src/lib/permissions";
import { authMiddleware, type AdminEnv } from "../src/middleware/auth";
import { handleCreateBuild, handleUpdateBuild } from "../src/routes/builds";
import { handleCreateRelease } from "../src/routes/releases";
import { handleCreateWebhook } from "../src/routes/webhooks";

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
const SESSION = "cross-org-session";
const DEPLOY_TOKEN = "qvdt_routingtest_secretsecretsecret";
const ORG_ADMIN_SESSION = "owning-org-admin-session";

function harness() {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  for (const name of readdirSync(migrationDir).sort()) {
    if (name.endsWith(".sql")) sqlite.exec(readFileSync(`${migrationDir}${name}`, "utf8"));
  }
  const now = Date.now();
  // org-a owns the app; org-b is the actor's home (and currently selected) org.
  const org = sqlite.prepare(
    `INSERT INTO organizations (id, slug, name, external_provider, external_id, created_at, archived)
     VALUES (?, ?, ?, 'raft', ?, ?, 0)`,
  );
  org.run("org-a", "org-a", "Org A", "server-a", now);
  org.run("org-b", "org-b", "Org B", "server-b", now);
  const account = sqlite.prepare(
    `INSERT INTO raft_accounts
     (id, provider, provider_subject, server_id, server_slug, principal_type, server_role,
      username, display_name, avatar_url, raw_profile, created_at, updated_at, last_login_at)
     VALUES (?, 'raft', ?, ?, ?, 'human', 'member', ?, ?, NULL, '{}', ?, ?, ?)`,
  );
  account.run("actor", "actor-sub", "server-b", "org-b", "actor", "Actor", now, now, now);
  account.run("a-admin", "a-admin-sub", "server-a", "org-a", "aadmin", "A Admin", now, now, now);
  const member = sqlite.prepare(
    "INSERT INTO org_members (id, org_id, account_id, org_role, joined_at) VALUES (?, ?, ?, ?, ?)",
  );
  member.run("om-actor", "org-b", "actor", "admin", now);
  member.run("om-a-admin", "org-a", "a-admin", "admin", now);
  const session = sqlite.prepare(
    "INSERT INTO raft_sessions (id, account_id, token_hash, created_at, expires_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)",
  );
  session.run("s-actor", "actor", sha(SESSION), now, now + 60_000, now);
  session.run("s-a-admin", "a-admin", sha(ORG_ADMIN_SESSION), now, now + 60_000, now);

  for (const [id, orgId] of [["app-1", "org-a"], ["app-b", "org-b"]]) {
    sqlite.prepare("INSERT INTO apps (id, org_id, slug, name, platform, created_at) VALUES (?, ?, ?, ?, 'android', ?)")
      .run(id, orgId, id, id, now);
  }
  sqlite.prepare("INSERT INTO channels (id, app_id, slug, name, created_at) VALUES ('ch-main', 'app-1', 'main', 'Main', ?)")
    .run(now);
  // The actor reaches app-1 only through a direct app grant, not via org-a.
  sqlite.prepare("INSERT INTO app_members (id, app_id, account_id, app_role, joined_at) VALUES ('am', 'app-1', 'actor', 'publisher', ?)")
    .run(now);
  sqlite.prepare(
    `INSERT INTO app_deploy_tokens (id, app_id, name, token_prefix, token_hash, app_role, created_by_actor, created_at)
     VALUES ('dt', 'app-1', 'ci', 'qvdt_routingtest', ?, 'publisher', 'test', ?)`,
  ).run(sha(DEPLOY_TOKEN), now);
  // An org-wide catch-all webhook in each org.
  for (const [id, orgId] of [["wh-a", "org-a"], ["wh-b", "org-b"]]) {
    sqlite.prepare(
      `INSERT INTO webhooks (id, org_id, app_id, url, secret, events_json, enabled, created_by, created_at, updated_at)
       VALUES (?, ?, NULL, 'https://hooks.example/x', 's', '[]', 1, 'a-admin', ?, ?)`,
    ).run(id, orgId, now, now);
  }

  const env = { DB: d1(sqlite), ENVIRONMENT: "test" } as unknown as Env;
  const pending: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: (p: Promise<unknown>) => { pending.push(p); },
    passThroughOnException() {},
    props: {},
  } as unknown as ExecutionContext;
  const app = new Hono<AdminEnv & { Bindings: Env }>();
  app.use("*", authMiddleware);
  app.post("/api/apps/:appId/builds", requireAppRole("publisher"), handleCreateBuild);
  app.patch("/api/apps/:appId/builds/:buildId", requireAppRole("publisher"), handleUpdateBuild);
  app.post("/api/apps/:appId/releases", requireAppRole("publisher"), handleCreateRelease);
  app.post("/api/orgs/:orgId/webhooks", requireOrgRole("orgId", "admin"), handleCreateWebhook);
  const call = async (token: string, method: string, path: string, body: unknown) => {
    const response = await app.fetch(new Request(`https://hands.test${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    }), env, ctx);
    await Promise.all(pending.splice(0));
    return response;
  };
  const deliveries = () => sqlite.prepare(
    "SELECT webhook_id, event_type, json_extract(payload_json, '$.org_id') AS org_id FROM webhook_deliveries ORDER BY webhook_id, event_type",
  ).all() as Array<{ webhook_id: string; event_type: string; org_id: string }>;
  return { sqlite, call, deliveries };
}

describe("app event webhooks route to the app's owning org", () => {
  it("a cross-org actor's build and release events reach the app org, not the actor's org", async () => {
    const h = harness();
    const created = await h.call(SESSION, "POST", "/api/apps/app-1/builds", {
      version_name: "1.0.0", version_code: 1, channel_id: "ch-main", product_type: "apk", status: "succeeded",
    });
    expect(created.status).toBe(201);
    const buildId = ((await created.json()) as { id: string }).id;
    expect(h.deliveries()).toEqual([{ webhook_id: "wh-a", event_type: "build:succeeded", org_id: "org-a" }]);

    const release = await h.call(SESSION, "POST", "/api/apps/app-1/releases", {
      build_id: buildId, channel_id: "ch-main", status: "active",
    });
    expect(release.status).toBe(201);
    expect(h.deliveries()).toEqual([
      { webhook_id: "wh-a", event_type: "build:succeeded", org_id: "org-a" },
      { webhook_id: "wh-a", event_type: "release:new", org_id: "org-a" },
    ]);
  });

  it("an app-scoped webhook keeps firing for the app's events, whoever triggers them", async () => {
    const h = harness();
    const now = Date.now();
    h.sqlite.prepare(
      `INSERT INTO webhooks (id, org_id, app_id, url, secret, events_json, enabled, created_by, created_at, updated_at)
       VALUES ('wh-app', 'org-a', 'app-1', 'https://hooks.example/app', 's', '[]', 1, 'a-admin', ?, ?)`,
    ).run(now, now);
    for (const token of [SESSION, DEPLOY_TOKEN]) {
      const created = await h.call(token, "POST", "/api/apps/app-1/builds", {
        version_name: "1.0.0", version_code: token === SESSION ? 1 : 2, channel_id: "ch-main", product_type: "apk", status: "succeeded",
      });
      expect(created.status).toBe(201);
    }
    const appScoped = h.deliveries().filter((d) => d.webhook_id === "wh-app");
    expect(appScoped).toHaveLength(2);
    expect(appScoped.every((d) => d.event_type === "build:succeeded" && d.org_id === "org-a")).toBe(true);
    expect(h.deliveries().some((d) => d.webhook_id === "wh-b")).toBe(false);
  });

  it("a deploy-token request emits build and release events to the app org", async () => {
    const h = harness();
    const created = await h.call(DEPLOY_TOKEN, "POST", "/api/apps/app-1/builds", {
      version_name: "1.0.0", version_code: 1, channel_id: "ch-main", product_type: "apk", status: "running",
    });
    expect(created.status).toBe(201);
    const buildId = ((await created.json()) as { id: string }).id;
    expect(h.deliveries()).toEqual([]);
    const failed = await h.call(DEPLOY_TOKEN, "PATCH", `/api/apps/app-1/builds/${buildId}`, { status: "failed" });
    expect(failed.status).toBe(200);
    expect(h.deliveries()).toEqual([{ webhook_id: "wh-a", event_type: "build:failed", org_id: "org-a" }]);

    h.sqlite.prepare("UPDATE builds SET status = 'succeeded' WHERE id = ?").run(buildId);
    const draft = await h.call(DEPLOY_TOKEN, "POST", "/api/apps/app-1/releases", {
      build_id: buildId, channel_id: "ch-main", status: "draft",
    });
    expect(draft.status).toBe(201);
    expect(h.deliveries()).toEqual([
      { webhook_id: "wh-a", event_type: "build:failed", org_id: "org-a" },
      { webhook_id: "wh-a", event_type: "release:draft_created", org_id: "org-a" },
    ]);
  });
});

describe("org webhook app_id must belong to the org", () => {
  it("rejects a foreign app id and accepts an owned one", async () => {
    const h = harness();
    const foreign = await h.call(ORG_ADMIN_SESSION, "POST", "/api/orgs/org-a/webhooks", {
      url: "https://hooks.example/y", secret: "s", app_id: "app-b",
    });
    expect(foreign.status).toBe(404);
    expect(await foreign.json()).toEqual({ error: "app not found" });
    const missing = await h.call(ORG_ADMIN_SESSION, "POST", "/api/orgs/org-a/webhooks", {
      url: "https://hooks.example/y", secret: "s", app_id: "no-such-app",
    });
    expect(missing.status).toBe(404);
    const malformed = await h.call(ORG_ADMIN_SESSION, "POST", "/api/orgs/org-a/webhooks", {
      url: "https://hooks.example/y", secret: "s", app_id: 42,
    });
    expect(malformed.status).toBe(400);
    expect(h.sqlite.prepare("SELECT COUNT(*) FROM webhooks WHERE app_id IS NOT NULL").pluck().get()).toBe(0);

    const owned = await h.call(ORG_ADMIN_SESSION, "POST", "/api/orgs/org-a/webhooks", {
      url: "https://hooks.example/y", secret: "s", app_id: "app-1",
    });
    expect(owned.status).toBe(201);
    const orgWide = await h.call(ORG_ADMIN_SESSION, "POST", "/api/orgs/org-a/webhooks", {
      url: "https://hooks.example/z", secret: "s", app_id: null,
    });
    expect(orgWide.status).toBe(201);
    expect(h.sqlite.prepare("SELECT org_id, app_id FROM webhooks WHERE url LIKE '%/y'").all())
      .toEqual([{ org_id: "org-a", app_id: "app-1" }]);
  });
});
