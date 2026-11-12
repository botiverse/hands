import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { exportPKCS8, generateKeyPair } from "jose";
import { storeAscCredentials } from "../src/lib/asc_credentials";
import { requireAppRole } from "../src/lib/permissions";
import { handleEnableAscAnalyticsReports } from "../src/routes/asc_analytics_requests";

const migrationDir = fileURLToPath(new URL("../../migrations/sql/", import.meta.url));
let p8: string;
beforeAll(async () => {
  p8 = await exportPKCS8((await generateKeyPair("ES256", { extractable: true })).privateKey);
});
afterEach(() => vi.restoreAllMocks());

function d1(sqlite: Database.Database): D1Database {
  const prepare = (sql: string) => {
    const indexes: number[] = [];
    const statement = sqlite.prepare(sql.replace(/\?(\d+)/g, (_m, index) => { indexes.push(Number(index)); return "?"; }));
    const bind = (...parameters: unknown[]) => {
      const expanded = indexes.length ? indexes.map((index) => parameters[index - 1]) : parameters;
      return {
        run: async () => ({ success: true, meta: { changes: statement.run(...expanded).changes } }),
        all: async () => ({ success: true, results: statement.all(...expanded) }),
        first: async (column?: string) => {
          const row = statement.get(...expanded) as Record<string, unknown> | undefined;
          return column ? row?.[column] ?? null : row ?? null;
        },
      };
    };
    return { bind, run: () => bind().run(), all: () => bind().all(), first: () => bind().first() };
  };
  return { prepare } as unknown as D1Database;
}

async function harness(opts: { role?: "admin" | "publisher"; bundleId?: string | null; credentials?: boolean } = {}) {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  for (const name of readdirSync(migrationDir).sort()) if (name.endsWith(".sql")) sqlite.exec(readFileSync(`${migrationDir}${name}`, "utf8"));
  const now = Date.now();
  sqlite.prepare("INSERT INTO apps (id, slug, name, platform, created_at) VALUES ('app', 'raft-ios', 'Raft iOS', 'ios', ?)").run(now);
  sqlite.prepare("INSERT INTO channels (id, app_id, slug, name, bundle_id, created_at) VALUES ('ch', 'app', 'main', 'Main', ?, ?)")
    .run(opts.bundleId === undefined ? "build.raft.app" : opts.bundleId, now);
  sqlite.prepare(`INSERT INTO raft_accounts (id, provider, provider_subject, server_id, server_slug, principal_type, server_role,
      username, display_name, avatar_url, raw_profile, created_at, updated_at, last_login_at)
      VALUES ('acct', 'raft', 'acct', 'server', 'test', 'human', 'member', 'acct', 'Acct', NULL, '{}', ?, ?, ?)`).run(now, now, now);
  sqlite.prepare("INSERT INTO app_members (id, app_id, account_id, app_role, joined_at) VALUES ('m', 'app', 'acct', ?, ?)").run(opts.role ?? "admin", now);
  const env = { DB: d1(sqlite), ENVIRONMENT: "development", ASC_CRED_ENC_KEY: "test-key" } as unknown as Env;
  if (opts.credentials !== false) {
    await storeAscCredentials(env.DB, "test-key", { app_id: "app", key_id: "KEY123", issuer_id: "issuer", p8, actor: "raft:acct@test" });
  }
  const app = new Hono<{ Bindings: Env; Variables: { admin_account: any; admin_actor: string } }>();
  app.use("*", async (c, next) => {
    c.set("admin_account", { id: "acct", provider: "raft", provider_subject: "acct", server_id: "server", server_slug: "test",
      principal_type: "human", server_role: "member", username: "acct", display_name: "Acct", avatar_url: null, raw_profile: "{}",
      created_at: 1, updated_at: 1, last_login_at: 1 });
    c.set("admin_actor", "raft:acct@test");
    await next();
  });
  app.post("/api/apps/:appId/stats/app-store/analytics-report-requests", requireAppRole("admin"), handleEnableAscAnalyticsReports as any);
  const call = () => app.fetch(new Request("https://hands.test/api/apps/app/stats/app-store/analytics-report-requests", { method: "POST" }), env,
    { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext);
  return { sqlite, call };
}

type Existing = Array<{ id: string; accessType: string; stoppedDueToInactivity?: boolean }>;
function apple(existing: Existing, opts: { postStatus?: number; failSecond?: boolean } = {}) {
  let n = 0;
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    if (method === "GET" && url.pathname === "/v1/apps") {
      return Response.json({ data: [{ id: "other-app", attributes: { bundleId: "build.raft.app.extra" } }, { id: "asc-app", attributes: { bundleId: "build.raft.app" } }] });
    }
    if (method === "GET" && url.pathname === "/v1/apps/asc-app/analyticsReportRequests") {
      return Response.json({ data: existing.map((r) => ({ id: r.id, attributes: { accessType: r.accessType, stoppedDueToInactivity: r.stoppedDueToInactivity ?? false } })) });
    }
    if (method === "POST" && url.pathname === "/v1/analyticsReportRequests") {
      if (opts.postStatus || (opts.failSecond && n === 1)) return Response.json({ errors: [{ status: String(opts.postStatus), code: "FORBIDDEN_ERROR", title: "forbidden", detail: "role" }] }, { status: opts.postStatus ?? 403 });
      const body = JSON.parse(String(init?.body));
      expect(body.data.relationships.app.data).toEqual({ type: "apps", id: "asc-app" });
      return Response.json({ data: { id: `new-${++n}-${body.data.attributes.accessType}` } }, { status: 201 });
    }
    throw new Error(`unexpected Apple call ${method} ${url.pathname}`);
  });
}
const posts = (fetch: ReturnType<typeof apple>) => fetch.mock.calls.filter(([, init]) => init?.method === "POST")
  .map(([, init]) => JSON.parse(String(init?.body)).data.attributes.accessType);

describe("POST /api/apps/:appId/stats/app-store/analytics-report-requests", () => {
  it("creates both request kinds when none exist and audits them", async () => {
    const h = await harness(); const fetch = apple([]);
    const res = await h.call();
    expect(res.status).toBe(200);
    expect(posts(fetch)).toEqual(["ONGOING", "ONE_TIME_SNAPSHOT"]);
    expect(await res.json()).toMatchObject({ asc_app_id: "asc-app", requests: [
      { access_type: "ONGOING", id: "new-1-ONGOING", created: true },
      { access_type: "ONE_TIME_SNAPSHOT", id: "new-2-ONE_TIME_SNAPSHOT", created: true }] });
    const audit = h.sqlite.prepare("SELECT payload FROM audit_logs WHERE action='asc.analytics_report_requests.create'").all() as Array<{ payload: string }>;
    expect(audit.map((a) => JSON.parse(a.payload))).toEqual([
      { asc_app_id: "asc-app", id: "new-1-ONGOING", access_type: "ONGOING" },
      { asc_app_id: "asc-app", id: "new-2-ONE_TIME_SNAPSHOT", access_type: "ONE_TIME_SNAPSHOT" }]);
  });

  it("is idempotent: existing active requests are reused and nothing is written", async () => {
    const h = await harness(); const fetch = apple([{ id: "o", accessType: "ONGOING" }, { id: "s", accessType: "ONE_TIME_SNAPSHOT", stoppedDueToInactivity: true }]);
    const res = await h.call();
    expect(posts(fetch)).toEqual([]);
    expect((await res.json() as any).requests.map((r: any) => r.created)).toEqual([false, false]);
    expect(h.sqlite.prepare("SELECT count(*) n FROM audit_logs WHERE action='asc.analytics_report_requests.create'").get()).toEqual({ n: 0 });
  });

  it("replaces only an ONGOING request Apple stopped for inactivity", async () => {
    const h = await harness(); const fetch = apple([{ id: "o", accessType: "ONGOING", stoppedDueToInactivity: true }, { id: "s", accessType: "ONE_TIME_SNAPSHOT" }]);
    await h.call();
    expect(posts(fetch)).toEqual(["ONGOING"]);
  });

  it("refuses without a bundle id instead of picking another app on the key", async () => {
    const h = await harness({ bundleId: null }); const fetch = apple([]);
    const res = await h.call();
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "BUNDLE_ID_NOT_CONFIGURED" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("requires app admin and configured credentials", async () => {
    const publisher = await harness({ role: "publisher" }); const fetch = apple([]);
    expect((await publisher.call()).status).toBe(403);
    expect(fetch).not.toHaveBeenCalled();
    const none = await harness({ credentials: false });
    const res = await none.call();
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "ASC_NOT_CONFIGURED" });
  });

  it("reports an Apple rejection without auditing a creation", async () => {
    const h = await harness(); apple([], { postStatus: 403 });
    const res = await h.call();
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ code: "ASC_API_REJECTED", provider_status: 403 });
    expect(h.sqlite.prepare("SELECT count(*) n FROM audit_logs").get()).toEqual({ n: 0 });
  });

  it("audits and reports a creation that succeeded before a later rejection", async () => {
    const h = await harness(); apple([], { failSecond: true });
    const res = await h.call();
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ requests: [{ access_type: "ONGOING", id: "new-1-ONGOING", created: true }] });
    expect(h.sqlite.prepare("SELECT count(*) n FROM audit_logs WHERE action='asc.analytics_report_requests.create'").get()).toEqual({ n: 1 });
  });

  it("does not write when no app matches the bundle id exactly", async () => {
    const h = await harness({ bundleId: "build.raft" }); const fetch = apple([]);
    const res = await h.call();
    expect(res.status).toBe(404);
    expect(posts(fetch)).toEqual([]);
  });
});
