/**
 * These go through `handleCreateAppDeployToken`, the only production issuance
 * path, rather than inserting rows directly.
 *
 * That distinction is the whole point of the file. The #403/#404 tests built
 * tokens with `INSERT INTO app_deploy_tokens`, so they verified behaviour on a
 * state production could not actually produce: the console service token they
 * proved out was rejected at issuance with 400, and every test stayed green.
 *
 * A test that fabricates its own state can only tell you what happens *if* that
 * state exists.
 */

import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { handleCreateAppDeployToken } from "../src/routes/deploy_tokens";
import { authMiddleware } from "../src/middleware/auth";
import { requireAppRoleOrFeedbackPermission } from "../src/lib/permissions";
import { handleListFeedback } from "../src/routes/feedback";

const MIGRATION_DIR = fileURLToPath(new URL("../../migrations/sql/", import.meta.url));
const APP = "app-a";
const INTEGRATION = "33333333-3333-4333-8333-333333333333";

function d1(db: Database.Database) {
  const prepare = (sql: string) => {
    const indexes: number[] = [];
    const normalized = sql.replace(/\?(\d+)/g, (_m, i) => { indexes.push(Number(i)); return "?"; });
    const statement = db.prepare(normalized);
    const bind = (...input: unknown[]) => {
      const params = (indexes.length ? indexes.map((i) => input[i - 1]) : input)
        .map((v) => v === undefined ? null : v);
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
  sqlite.prepare(
    `INSERT INTO organizations (id, slug, name, external_provider, external_id, created_at)
     VALUES ('org','org','Org','raft','server',1)`,
  ).run();
  sqlite.prepare(
    `INSERT INTO apps (id, org_id, slug, name, platform, client_key, created_at)
     VALUES (?,'org','app-a','App A','electron','ck',1)`,
  ).run(APP);
  sqlite.prepare(
    `INSERT INTO app_reporter_integrations (id, app_id, name, created_at, updated_at)
     VALUES (?,?,'inbox',1,1)`,
  ).run(INTEGRATION, APP);
  return { sqlite, env: { DB: d1(sqlite) } as unknown as Env };
}

/** Calls the real handler; returns { status, body }. */
async function issue(env: Env, body: unknown) {
  let status = 200;
  const c = {
    env,
    req: { param: (n: string) => (n === "appId" ? APP : ""), json: async () => body },
    json: (data: unknown, s = 200) => { status = s; return new Response(JSON.stringify(data), { status: s }); },
    get: () => undefined,
  } as any;
  const response = await handleCreateAppDeployToken(c);
  return { status, body: await response.json() as any };
}

describe("issuing a console feedback token", () => {
  it("accepts role-free feedback:read with no reporter binding", async () => {
    // The exact token the console routes are built to accept. Before this fix
    // it was rejected 400, so the feature was undeliverable: the middleware
    // accepted a credential the issuer would not mint.
    const { env } = environment();
    const { status, body } = await issue(env, {
      name: "feedback-readback", scopes: ["feedback:read"],
    });
    expect(status).toBe(201);
    expect(body.deploy_token.app_role).toBeNull();
    expect(body.deploy_token.scopes).toEqual(["feedback:read"]);
    expect(body.token).toBeTruthy();
  });

  it("accepts role-free feedback:read + feedback:comment unbound", async () => {
    const { env } = environment();
    const { status } = await issue(env, {
      name: "support", scopes: ["feedback:read", "feedback:comment"],
    });
    expect(status).toBe(201);
  });

  it("accepts role-free feedback:triage unbound", async () => {
    const { env } = environment();
    const { status } = await issue(env, { name: "triage", scopes: ["feedback:triage"] });
    expect(status).toBe(201);
  });

  it("still requires a binding for feedback:write", async () => {
    // Unchanged on purpose: submitting on a user's behalf is only meaningful
    // for a proxy, so it must name the integration it proxies.
    const { env } = environment();
    const { status, body } = await issue(env, { name: "proxy", scopes: ["feedback:write"] });
    expect(status).toBe(400);
    expect(body.error).toContain("feedback:write");
  });

  it("still requires a binding for feedback:route", async () => {
    const { env } = environment();
    const { status } = await issue(env, { name: "router", scopes: ["feedback:route"] });
    expect(status).toBe(400);
  });

  it("requires a binding when a proxy scope is mixed with console scopes", async () => {
    // The relaxation is per-scope, not "any feedback scope is fine now".
    const { env } = environment();
    const { status, body } = await issue(env, {
      name: "mixed", scopes: ["feedback:read", "feedback:write"],
    });
    expect(status).toBe(400);
    expect(body.error).toContain("feedback:write");
    expect(body.error).not.toContain("feedback:read");
  });

  it("keeps the reporter path intact: bound token with feedback-only scopes", async () => {
    const { env } = environment();
    const { status } = await issue(env, {
      name: "reporter", scopes: ["feedback:read"], reporter_integration_id: INTEGRATION,
    });
    expect(status).toBe(201);
  });
});

describe("the seam: a token that was really issued is really accepted", () => {
  // Both halves were green while the feature was undeliverable, because each
  // tested its own half against an assumption about the other:
  //
  //   #403/#404  given such a token, the console admits it   (token fabricated)
  //   #406       such a token can be issued                  (never used)
  //
  // Nothing checked that the thing issuance produces is the thing the
  // middleware accepts. The bug lived exactly there. This mints through the
  // real handler and spends the returned token on the real route.
  it("mints a feedback:read token and uses it on the console list route", async () => {
    const { sqlite, env } = environment();

    const { status, body } = await issue(env, {
      name: "seam", scopes: ["feedback:read"],
    });
    expect(status).toBe(201);
    const token = body.token as string;

    const app = new Hono<any>();
    app.use("*", authMiddleware);
    app.get(
      "/api/apps/:appId/feedback",
      requireAppRoleOrFeedbackPermission("viewer", {}, "feedback:read"),
      handleListFeedback,
    );
    const response = await app.request(
      `https://hands.test/api/apps/${APP}/feedback`,
      { headers: { authorization: `Bearer ${token}` } },
      { ...env, DASHBOARD_ORIGIN: "https://dashboard.example" } as unknown as Env,
    );
    expect(response.status).toBe(200);
    expect(sqlite.prepare(
      "SELECT app_role, reporter_integration_id FROM app_deploy_tokens WHERE name = 'seam'",
    ).get()).toMatchObject({ app_role: null, reporter_integration_id: null });
  });
});
