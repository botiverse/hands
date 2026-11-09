import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { generateDeployToken, hashDeployToken } from "../src/lib/deploy_tokens";
import { installAscFake, makeContext, realCreds, type AscCall } from "./asc_fake";
import { normalizeAppInfoInput, pushAppInfoCandidate } from "../src/routes/app_store_app_info";
import { openApiDocument } from "../src/openapi";

vi.mock("@cloudflare/containers", () => ({ Container: class {}, getRandom: async () => ({ fetch: async () => new Response() }) }));
let creds: Awaited<ReturnType<typeof realCreds>> | undefined;
vi.mock("../src/lib/asc_credentials", () => ({ getAscCredentials: async () => (creds ??= await realCreds()) }));
vi.mock("../src/lib/asc_api", async (original) => ({ ...(await original<typeof import("../src/lib/asc_api")>()), resolveAscAppId: async () => "asc-app-1" }));

const migrations = fileURLToPath(new URL("../../migrations/sql/", import.meta.url));
const APP = "11111111-2222-4333-8444-555555555555";
const OTHER = "22222222-2222-4333-8444-555555555555";
const path = `/api/apps/${APP}/app-store/versions/ver-1/app-info`;

function d1(db: Database.Database): D1Database {
  const prepare = (sql: string) => {
    const indices: number[] = [];
    const statement = db.prepare(sql.replace(/\?(\d+)/g, (_match, index) => { indices.push(Number(index)); return "?"; }));
    const bind = (...args: unknown[]) => {
      const values = (indices.length ? indices.map((i) => args[i - 1]) : args).map((v) => v === undefined ? null : v);
      const execute = () => statement.reader
        ? { success: true, results: statement.all(...values), meta: { changes: 0 } }
        : { success: true, results: [], meta: { changes: statement.run(...values).changes } };
      return { _execute: execute, run: async () => execute(), all: async () => execute(), first: async () => statement.get(...values) ?? null };
    };
    return { bind, run: () => bind().run(), all: () => bind().all(), first: () => bind().first() };
  };
  return { prepare, batch: async (items: Array<{ _execute: () => unknown }>) => db.transaction(() => items.map((item) => item._execute()))() } as unknown as D1Database;
}

async function harness() {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  for (const name of readdirSync(migrations).sort()) if (name.endsWith(".sql")) sqlite.exec(readFileSync(`${migrations}${name}`, "utf8"));
  sqlite.prepare("INSERT INTO apps (id, slug, name, platform, created_at) VALUES (?, ?, ?, 'ios', 1)").run(APP, "app-one", "App One");
  sqlite.prepare("INSERT INTO apps (id, slug, name, platform, created_at) VALUES (?, ?, ?, 'ios', 1)").run(OTHER, "app-two", "App Two");
  sqlite.prepare("INSERT INTO channels (id, app_id, slug, name, bundle_id, created_at) VALUES ('channel-1', ?, 'main', 'Main', 'build.example.app', 1)").run(APP);
  async function token(role: "publisher" | "viewer", app: string, name: string) {
    const token = generateDeployToken();
    sqlite.prepare(`INSERT INTO app_deploy_tokens (id, app_id, name, token_prefix, token_hash, app_role, scopes_json, created_by_actor, created_at)
      VALUES (?, ?, ?, ?, ?, ?, NULL, 'test', 1)`)
      .run(name, app, name, token.token_prefix, await hashDeployToken(token.token), role);
    return token.token;
  }
  const viewer = await token("viewer", APP, "viewer");
  const publisher = await token("publisher", APP, "publisher");
  const other = await token("publisher", OTHER, "other");
  const { admin } = await import("../src/index");
  const env = { DB: d1(sqlite), ENVIRONMENT: "production", DASHBOARD_ORIGIN: "https://dashboard.example", ASC_CRED_ENC_KEY: "test-key" } as unknown as Env;
  const post = (bearer: string | undefined, body: unknown) => admin.fetch(new Request(`https://hands.test${path}`, {
    method: "POST", headers: { "content-type": "application/json", ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) }, body: JSON.stringify(body),
  }), env, { waitUntil() {} } as unknown as ExecutionContext);
  return { sqlite, env, viewer, publisher, other, post };
}

function appleRead({ method, path, url }: AscCall, name = "Old Name") {
  if (method !== "GET") return undefined;
  if (path.startsWith("/v1/apps/asc-app-1/appStoreVersions?")) return { json: { data: [{ type: "appStoreVersions", id: "ver-1", attributes: { versionString: "1.22.0", platform: "IOS", appVersionState: "PREPARE_FOR_SUBMISSION" } }], links: { self: url } } };
  if (path.startsWith("/v1/apps/asc-app-1/appInfos?")) return { json: { data: [{ type: "appInfos", id: "info-1", attributes: { state: "PREPARE_FOR_SUBMISSION" } }], links: { self: url } } };
  if (path.startsWith("/v1/appInfos/info-1/appInfoLocalizations?")) return { json: { data: [{ type: "appInfoLocalizations", id: "loc-1", attributes: { locale: "en-US", name, subtitle: "Old subtitle" } }], links: { self: url } } };
  if (path.startsWith("/v1/appStoreVersions/ver-1/appStoreVersionLocalizations?")) return { json: { data: [{ type: "appStoreVersionLocalizations", id: "version-loc-1", attributes: { locale: "en-US" } }], links: { self: url } } };
  if (path === "/v1/appInfos/info-1/relationships/primaryCategory") return { json: { data: { type: "appCategories", id: "UTILITIES" } } };
  return undefined;
}
function fakeApple() {
  return installAscFake((call) => {
    if (call.method !== "GET") throw new Error("preview must never write");
    return appleRead(call);
  });
}

const input = { version_string: "1.22.0", localizations: { "en-US": { name: "New Name" } } };
afterEach(() => vi.unstubAllGlobals());

describe("registered App Information route", () => {
  it("requires authentication, publisher on this app, and leaves Apple and operation tables untouched on denial", async () => {
    const h = await harness(); const asc = fakeApple();
    expect((await h.post(undefined, { ...input, mode: "dry_run" })).status).toBe(401);
    expect((await h.post(h.viewer, { ...input, mode: "dry_run" })).status).toBe(403);
    expect((await h.post(h.other, { ...input, mode: "dry_run" })).status).toBe(403);
    expect(asc.calls).toEqual([]);
    expect(h.sqlite.prepare("SELECT count(*) n FROM store_product_locks").get()).toEqual({ n: 0 });
    expect(h.sqlite.prepare("SELECT count(*) n FROM audit_logs").get()).toEqual({ n: 0 });
  });

  it("lets a publisher preview with GETs only, rejects legacy commit without commit_contract_version, and executes v1 commit through the registered route", async () => {
    const h = await harness();
    let name = "Old Name";
    const asc = installAscFake((call) => {
      if (call.method === "PATCH" && call.path === "/v1/appInfoLocalizations/loc-1") {
        name = "New Name";
        return { json: { data: call.body.data } };
      }
      return appleRead(call, name);
    });
    const preview = await h.post(h.publisher, { ...input, mode: "dry_run" });
    expect(preview.status).toBe(200);
    expect(await preview.json()).toMatchObject({ outcome: "planned", writes: 0, app_info: { id: "info-1" }, localizations: [{ locale: "en-US", before: { name: "Old Name" }, after: { name: "New Name" } }] });
    expect(asc.calls.length).toBeGreaterThan(0);
    expect(asc.calls.every((call) => call.method === "GET")).toBe(true);
    const count = asc.calls.length;
    const legacyCommit = await h.post(h.publisher, { ...input, mode: "commit" });
    expect(legacyCommit.status).toBe(409);
    expect(await legacyCommit.json()).toMatchObject({ code: "APP_INFO_CLIENT_UPGRADE_REQUIRED" });
    expect(asc.calls).toHaveLength(count);
    expect(h.sqlite.prepare("SELECT count(*) n FROM store_product_locks").get()).toEqual({ n: 0 });
    expect(h.sqlite.prepare("SELECT count(*) n FROM audit_logs").get()).toEqual({ n: 0 });
    const invalid = await h.post(h.publisher, { ...input, mode: "commit", bad: true });
    expect(invalid.status).toBe(400);
    expect((await invalid.json() as any).code).toBe("INVALID_REQUEST");
    expect(asc.calls).toHaveLength(count);
    for (const bad of [
      { ...input },
      { ...input, mode: "unexpected" },
      { ...input, mode: "commit", commit_contract_version: 2 },
      { ...input, mode: "commit", commit_contract_version: "1" },
      { ...input, mode: "dry_run", version_string: undefined },
      { ...input, mode: "dry_run", version_string: "" },
      { ...input, mode: "dry_run", version_string: " " },
    ]) expect((await h.post(h.publisher, bad)).status).toBe(400);
    expect(asc.calls).toHaveLength(count);
    const commit = await h.post(h.publisher, { ...input, mode: "commit", commit_contract_version: 1 });
    expect(commit.status).toBe(200);
    expect(await commit.json()).toMatchObject({ outcome: "committed", recovery_required: false, results: [{ target: "en-US", action: "update", status: "written" }] });
    expect(h.sqlite.prepare("SELECT count(*) n FROM store_product_locks").get()).toEqual({ n: 0 });
    expect(h.sqlite.prepare("SELECT count(*) n FROM audit_logs").get()).toEqual({ n: 2 });
  });

  it("documents required mode, version, and commit contract version in the generated machine contract", () => {
    const schema = (openApiDocument.components?.schemas as any).AppStoreAppInfoInput;
    expect(schema.required).toEqual(expect.arrayContaining(["mode", "version_string"]));
    expect(schema.properties.mode.enum).toEqual(["dry_run", "commit"]);
    expect(schema.properties.mode.default).toBeUndefined();
    expect(schema.properties.commit_contract_version).toMatchObject({ enum: [1] });
    expect(schema.properties.version_string).toMatchObject({ type: "string", minLength: 1, maxLength: 100 });
    const operation = (openApiDocument.paths as any)["/api/apps/{appId}/app-store/versions/{versionId}/app-info"].post;
    expect(operation.requestBody.required).toBe(true);
    expect(operation.description).toContain("APP_INFO_CLIENT_UPGRADE_REQUIRED");
    expect(operation.responses["409"]).toBeDefined();
  });
});

describe("operation locking and audit trail", () => {
  it("serializes two operations on the same Apple app and persists only fingerprints in the audit", async () => {
    const h = await harness();
    let started!: () => void, release!: () => void;
    const writing = new Promise<void>((resolve) => { started = resolve; });
    const wait = new Promise<void>((resolve) => { release = resolve; });
    let name = "Old Name";
    const asc = installAscFake(async (call) => {
      if (call.method === "PATCH" && call.path === "/v1/appInfoLocalizations/loc-1") {
        started(); await wait; name = "New Name"; return { json: { data: call.body.data } };
      }
      return appleRead(call, name);
    });
    const context = () => {
      const { c } = makeContext({ params: { appId: APP, versionId: "ver-1" } });
      c.env = h.env;
      return c;
    };
    const request = normalizeAppInfoInput({ ...input, mode: "commit" });
    const first = pushAppInfoCandidate(context(), request);
    await writing;
    try {
      const second = await pushAppInfoCandidate(context(), request);
      expect(second.status).toBe(409);
      expect((await second.json() as any).code).toBe("APP_INFO_LOCKED");
      expect(asc.writes()).toHaveLength(1);
      expect(h.sqlite.prepare("SELECT count(*) n FROM store_product_locks").get()).toEqual({ n: 1 });
    } finally { release(); }
    const result = await first;
    expect(result.status).toBe(200);
    expect((await result.json() as any).outcome).toBe("committed");
    expect(h.sqlite.prepare("SELECT count(*) n FROM store_product_locks").get()).toEqual({ n: 0 });
    const audit = JSON.stringify(h.sqlite.prepare("SELECT action, payload FROM audit_logs ORDER BY created_at").all());
    expect(audit).toContain("app_store.app_info.attempt");
    expect(audit).toContain("app_store.app_info.result");
    expect(audit).toContain("sha256");
    expect(audit).not.toContain("Old Name");
    expect(audit).not.toContain("New Name");
  });

  it("reports a successful create and later uncertain failure, retaining its lock and blocking retry", async () => {
    const h = await harness(); let created = false;
    const asc = installAscFake((call) => {
      if (call.method === "POST" && call.path === "/v1/appInfoLocalizations") {
        created = true; return { status: 201, json: { data: { type: "appInfoLocalizations", id: "loc-ja" } } };
      }
      if (call.method === "PATCH" && call.path === "/v1/appInfoLocalizations/loc-1") throw new Error("response lost after dispatch");
      if (call.method === "GET" && call.path.startsWith("/v1/appInfos/info-1/appInfoLocalizations?")) return { json: { data: [
        { type: "appInfoLocalizations", id: "loc-1", attributes: { locale: "en-US", name: "Old Name", subtitle: "Old subtitle" } },
        ...(created ? [{ type: "appInfoLocalizations", id: "loc-ja", attributes: { locale: "ja", name: "新しい名前", subtitle: "副題" } }] : []),
      ], links: { self: call.url } } };
      if (call.method === "GET" && call.path.startsWith("/v1/appStoreVersions/ver-1/appStoreVersionLocalizations?")) return { json: { data: ["en-US", "ja"].map((locale) => ({ type: "appStoreVersionLocalizations", id: `version-${locale}`, attributes: { locale } })), links: { self: call.url } } };
      return appleRead(call);
    });
    const context = () => { const { c } = makeContext({ params: { appId: APP, versionId: "ver-1" } }); c.env = h.env; return c; };
    const request = normalizeAppInfoInput({ mode: "commit", version_string: "1.22.0", localizations: { ja: { name: "新しい名前", subtitle: "副題" }, "en-US": { name: "New Name" } } });
    const first = await pushAppInfoCandidate(context(), request); const body = await first.json() as any;
    expect(first.status).toBe(502);
    expect(body).toMatchObject({ recovery_required: true, results: [{ target: "ja", status: "written", localization_id: "loc-ja" }, { target: "en-US", status: "unknown" }] });
    expect(body.mismatches).toEqual([]);
    expect(h.sqlite.prepare("SELECT provider, operation_id FROM store_product_locks").get()).toEqual({ provider: "apple_app_info", operation_id: body.operation_id });
    expect((await (await pushAppInfoCandidate(context(), request)).json() as any).code).toBe("APP_INFO_LOCKED");
    expect(asc.writes().map((call) => `${call.method} ${call.path}`)).toEqual(["POST /v1/appInfoLocalizations", "PATCH /v1/appInfoLocalizations/loc-1"]);
  });

  it.each(["before", "after"] as const)("reports recovery if lock deletion fails %s the delete", async (deleteFailure) => {
    const h = await harness(); let name = "Old Name", deleteAttempts = 0;
    const asc = installAscFake((call) => {
      if (call.method === "PATCH" && call.path === "/v1/appInfoLocalizations/loc-1") {
        name = "New Name"; return { json: { data: call.body.data } };
      }
      return appleRead(call, name);
    });
    const originalDB = h.env.DB;
    const faultyDB = { prepare(sql: string) {
      const statement = originalDB.prepare(sql);
      if (!sql.startsWith("DELETE FROM store_product_locks")) return statement;
      return { bind(...args: unknown[]) {
        const bound = statement.bind(...args);
        return { ...bound, async run() {
          deleteAttempts++;
          if (deleteFailure === "after") await bound.run();
          throw new Error("ambiguous D1 delete failure");
        } };
      } };
    } } as unknown as D1Database;
    const context = (db: D1Database) => { const { c } = makeContext({ params: { appId: APP, versionId: "ver-1" } }); c.env = { ...h.env, DB: db }; return c; };
    const request = normalizeAppInfoInput({ ...input, mode: "commit" });
    const first = await pushAppInfoCandidate(context(faultyDB), request); const body = await first.json() as any;
    expect(first.status).toBe(502);
    expect(body).toMatchObject({ ok: false, code: "APP_INFO_RECOVERY_REQUIRED", recovery_required: true, mutation_started: true, results: [{ target: "en-US", status: "written" }], prior_status: 200, prior_result: { outcome: "committed", readback: { localizations: [{ locale: "en-US", fields: { name: "New Name" } }] } } });
    expect(deleteAttempts).toBe(1);
    expect(name).toBe("New Name");
    const lock = h.sqlite.prepare("SELECT provider, operation_id FROM store_product_locks").get();
    if (deleteFailure === "before") expect(lock).toEqual({ provider: "apple_app_info", operation_id: body.operation_id });
    else expect(lock).toBeUndefined();
    // If the lock remains, a normal client retry is blocked; if the delete
    // actually committed before the error, the operator must still inspect it.
    if (deleteFailure === "before") {
      const retry = await pushAppInfoCandidate(context(originalDB), request);
      expect(retry.status).toBe(409);
      expect((await retry.json() as any).code).toBe("APP_INFO_LOCKED");
    }
    expect(asc.writes()).toHaveLength(1);
  });

  it("distinguishes a lock release failure before any write", async () => {
    const h = await harness(); const asc = fakeApple();
    const originalDB = h.env.DB;
    const faultyDB = { prepare(sql: string) {
      if (sql.startsWith("DELETE FROM store_product_locks")) return { bind: () => ({ run: async () => { throw new Error("D1 unavailable"); } }) };
      return originalDB.prepare(sql);
    } } as unknown as D1Database;
    const { c } = makeContext({ params: { appId: APP, versionId: "ver-1" } }); c.env = { ...h.env, DB: faultyDB };
    const request = normalizeAppInfoInput({ ...input, mode: "commit", version_string: "1.22.1" });
    const result = await pushAppInfoCandidate(c, request); const body = await result.json() as any;
    expect(result.status).toBe(502);
    expect(body).toMatchObject({ code: "APP_INFO_RECOVERY_REQUIRED", recovery_required: true, mutation_started: false, results: [], prior_status: 409, prior_result: { code: "VERSION_CHANGED" } });
    expect(body.error).toContain("no write was dispatched");
    expect(h.sqlite.prepare("SELECT provider, operation_id FROM store_product_locks").get()).toEqual({ provider: "apple_app_info", operation_id: body.operation_id });
    expect(asc.writes()).toHaveLength(0);
  });

  it.each(["before", "after"] as const)("retains the operation ID if lock acquisition fails %s the insert", async (failure) => {
    const h = await harness(); const asc = fakeApple();
    const originalDB = h.env.DB;
    const faultyDB = { prepare(sql: string) {
      const statement = originalDB.prepare(sql);
      if (!sql.startsWith("INSERT OR IGNORE INTO store_product_locks")) return statement;
      return { bind(...args: unknown[]) {
        const bound = statement.bind(...args);
        return { ...bound, async run() {
          if (failure === "after") await bound.run();
          throw new Error("ambiguous D1 insert failure");
        } };
      } };
    } } as unknown as D1Database;
    const { c } = makeContext({ params: { appId: APP, versionId: "ver-1" } }); c.env = { ...h.env, DB: faultyDB };
    const request = normalizeAppInfoInput({ ...input, mode: "commit" });
    const response = await pushAppInfoCandidate(c, request); const body = await response.json() as any;
    expect(response.status).toBe(502);
    expect(body).toMatchObject({ code: "APP_INFO_RECOVERY_REQUIRED", recovery_required: true, mutation_started: false, results: [] });
    expect(body.error).toContain("no write was dispatched");
    const lock = h.sqlite.prepare("SELECT provider, operation_id FROM store_product_locks").get();
    if (failure === "after") expect(lock).toEqual({ provider: "apple_app_info", operation_id: body.operation_id });
    else expect(lock).toBeUndefined();
    expect(asc.calls).toHaveLength(0);
  });

  it.each([
    ["failed success flag", { success: false, meta: { changes: 1 } }],
    ["missing success flag", { meta: { changes: 1 } }],
    ["missing change count", { success: true, meta: {} }],
    ["unexpected change count", { success: true, meta: { changes: 2 } }],
  ])("treats %s on lock acquisition as uncertain", async (_label, reply) => {
    const h = await harness(); const asc = fakeApple(); const originalDB = h.env.DB;
    const faultyDB = { prepare(sql: string) {
      const statement = originalDB.prepare(sql);
      if (!sql.startsWith("INSERT OR IGNORE INTO store_product_locks")) return statement;
      return { bind(...args: unknown[]) {
        const bound = statement.bind(...args);
        return { ...bound, async run() { await bound.run(); return reply; } };
      } };
    } } as unknown as D1Database;
    const { c } = makeContext({ params: { appId: APP, versionId: "ver-1" } }); c.env = { ...h.env, DB: faultyDB };
    const response = await pushAppInfoCandidate(c, normalizeAppInfoInput({ ...input, mode: "commit" }));
    const body = await response.json() as any;
    expect(response.status).toBe(502);
    expect(body).toMatchObject({ code: "APP_INFO_RECOVERY_REQUIRED", recovery_required: true, mutation_started: false, results: [] });
    expect(h.sqlite.prepare("SELECT provider, operation_id FROM store_product_locks").get()).toEqual({ provider: "apple_app_info", operation_id: body.operation_id });
    expect(asc.calls).toHaveLength(0);
  });

  it.each([
    ["failed success flag", { success: false, meta: { changes: 1 } }],
    ["missing success flag", { meta: { changes: 1 } }],
    ["missing change count", { success: true, meta: {} }],
    ["unexpected change count", { success: true, meta: { changes: 2 } }],
  ])("treats %s on lock release as uncertain", async (_label, reply) => {
    const h = await harness(); let name = "Old Name";
    const asc = installAscFake((call) => {
      if (call.method === "PATCH") { name = "New Name"; return { json: { data: call.body.data } }; }
      return appleRead(call, name);
    });
    const originalDB = h.env.DB;
    const faultyDB = { prepare(sql: string) {
      const statement = originalDB.prepare(sql);
      if (!sql.startsWith("DELETE FROM store_product_locks")) return statement;
      return { bind(...args: unknown[]) {
        const bound = statement.bind(...args);
        return { ...bound, async run() { await bound.run(); return reply; } };
      } };
    } } as unknown as D1Database;
    const { c } = makeContext({ params: { appId: APP, versionId: "ver-1" } }); c.env = { ...h.env, DB: faultyDB };
    const response = await pushAppInfoCandidate(c, normalizeAppInfoInput({ ...input, mode: "commit" }));
    const body = await response.json() as any;
    expect(response.status).toBe(502);
    expect(body).toMatchObject({ code: "APP_INFO_RECOVERY_REQUIRED", recovery_required: true, mutation_started: true, results: [{ target: "en-US", status: "written" }], prior_status: 200, prior_result: { outcome: "committed" } });
    expect(h.sqlite.prepare("SELECT count(*) n FROM store_product_locks").get()).toEqual({ n: 0 });
    expect(asc.writes()).toHaveLength(1);
  });

  it("reports the operation if execution and pre-write lock release both fail", async () => {
    const h = await harness(); const asc = fakeApple(); const originalDB = h.env.DB;
    const faultyDB = { prepare(sql: string) {
      if (sql.startsWith("DELETE FROM store_product_locks")) return { bind: () => ({ run: async () => { throw new Error("delete response lost"); } }) };
      return originalDB.prepare(sql);
    } } as unknown as D1Database;
    const { c } = makeContext({ params: { appId: APP, versionId: "ver-1" } }); c.env = { ...h.env, DB: faultyDB };
    const send = c.json.bind(c); let calls = 0;
    c.json = ((...args: Parameters<typeof send>) => { if (++calls === 1) throw new Error("response failed"); return send(...args); }) as typeof c.json;
    const response = await pushAppInfoCandidate(c, normalizeAppInfoInput({ ...input, mode: "commit", version_string: "1.22.1" }));
    const body = await response.json() as any;
    expect(response.status).toBe(502);
    expect(body).toMatchObject({ code: "APP_INFO_RECOVERY_REQUIRED", recovery_required: true, mutation_started: false, execution_failed: true, results: [], prior_status: null, prior_result: null });
    expect(h.sqlite.prepare("SELECT provider, operation_id FROM store_product_locks").get()).toEqual({ provider: "apple_app_info", operation_id: body.operation_id });
    expect(asc.writes()).toHaveLength(0);
  });

  it("propagates an execution error when pre-write lock release is confirmed", async () => {
    const h = await harness(); const asc = fakeApple();
    const { c } = makeContext({ params: { appId: APP, versionId: "ver-1" } }); c.env = h.env;
    c.json = (() => { throw new Error("response failed"); }) as typeof c.json;
    const request = normalizeAppInfoInput({ ...input, mode: "commit", version_string: "1.22.1" });
    await expect(pushAppInfoCandidate(c, request)).rejects.toThrow("response failed");
    expect(h.sqlite.prepare("SELECT count(*) n FROM store_product_locks").get()).toEqual({ n: 0 });
    expect(asc.writes()).toHaveLength(0);
  });

  it("reports unconfirmed lock release even if the recovery response formatter fails", async () => {
    const h = await harness(); let name = "Old Name";
    const asc = installAscFake((call) => {
      if (call.method === "PATCH") { name = "New Name"; return { json: { data: call.body.data } }; }
      return appleRead(call, name);
    });
    const originalDB = h.env.DB;
    const faultyDB = { prepare(sql: string) {
      if (sql.startsWith("DELETE FROM store_product_locks")) return { bind: () => ({ run: async () => { throw new Error("delete response lost"); } }) };
      return originalDB.prepare(sql);
    } } as unknown as D1Database;
    const { c } = makeContext({ params: { appId: APP, versionId: "ver-1" } }); c.env = { ...h.env, DB: faultyDB };
    const send = c.json.bind(c);
    c.json = ((data: any, ...args: any[]) => {
      if (data?.code === "APP_INFO_RECOVERY_REQUIRED") throw new Error("recovery response failed");
      return send(data, ...args);
    }) as typeof c.json;
    const response = await pushAppInfoCandidate(c, normalizeAppInfoInput({ ...input, mode: "commit" }));
    const body = await response.json() as any;
    expect(response.status).toBe(502);
    expect(body).toMatchObject({ code: "APP_INFO_RECOVERY_REQUIRED", mutation_started: true, recovery_required: true, prior_status: 200, prior_result: { outcome: "committed" } });
    expect(h.sqlite.prepare("SELECT provider, operation_id FROM store_product_locks").get()).toEqual({ provider: "apple_app_info", operation_id: body.operation_id });
    expect(asc.writes()).toHaveLength(1);
  });

  it("reports an uncertain acquisition even if building its response fails", async () => {
    const h = await harness(); const asc = fakeApple(); const originalDB = h.env.DB;
    const faultyDB = { prepare(sql: string) {
      const statement = originalDB.prepare(sql);
      if (!sql.startsWith("INSERT OR IGNORE INTO store_product_locks")) return statement;
      return { bind(...args: unknown[]) { const bound = statement.bind(...args); return { ...bound, async run() { await bound.run(); throw new Error("insert response lost"); } }; } };
    } } as unknown as D1Database;
    const { c } = makeContext({ params: { appId: APP, versionId: "ver-1" } }); c.env = { ...h.env, DB: faultyDB };
    c.json = (() => { throw new Error("response failed"); }) as typeof c.json;
    const response = await pushAppInfoCandidate(c, normalizeAppInfoInput({ ...input, mode: "commit" }));
    const body = await response.json() as any;
    expect(response.status).toBe(502);
    expect(body).toMatchObject({ code: "APP_INFO_RECOVERY_REQUIRED", recovery_required: true, mutation_started: false, execution_failed: true });
    expect(h.sqlite.prepare("SELECT provider, operation_id FROM store_product_locks").get()).toEqual({ provider: "apple_app_info", operation_id: body.operation_id });
    expect(asc.calls).toHaveLength(0);
  });

  it("retains the lock and operation ID if success and recovery response construction both fail after a write", async () => {
    const h = await harness(); let name = "Old Name";
    const asc = installAscFake((call) => {
      if (call.method === "PATCH") { name = "New Name"; return { json: { data: call.body.data } }; }
      return appleRead(call, name);
    });
    const { c } = makeContext({ params: { appId: APP, versionId: "ver-1" } }); c.env = h.env;
    c.json = (() => { throw new Error("response failed"); }) as typeof c.json;
    const response = await pushAppInfoCandidate(c, normalizeAppInfoInput({ ...input, mode: "commit" }));
    const body = await response.json() as any;
    expect(response.status).toBe(502);
    expect(body).toMatchObject({ code: "APP_INFO_RECOVERY_REQUIRED", recovery_required: true, mutation_started: true, execution_failed: true, results: [{ target: "en-US", status: "written" }] });
    expect(h.sqlite.prepare("SELECT provider, operation_id FROM store_product_locks").get()).toEqual({ provider: "apple_app_info", operation_id: body.operation_id });
    expect(asc.writes()).toHaveLength(1);
  });

  it("does not report success if the owned lock vanished before the delete", async () => {
    const h = await harness(); const asc = fakeApple(); const originalDB = h.env.DB;
    const faultyDB = { prepare(sql: string) {
      const statement = originalDB.prepare(sql);
      if (!sql.startsWith("DELETE FROM store_product_locks")) return statement;
      return { bind(...args: unknown[]) {
        const bound = statement.bind(...args);
        return { ...bound, async run() {
          h.sqlite.prepare("DELETE FROM store_product_locks WHERE operation_id = ?").run(args[2]);
          return bound.run();
        } };
      } };
    } } as unknown as D1Database;
    const { c } = makeContext({ params: { appId: APP, versionId: "ver-1" } }); c.env = { ...h.env, DB: faultyDB };
    const request = normalizeAppInfoInput({ mode: "commit", version_string: "1.22.0", localizations: { "en-US": { name: "Old Name" } } });
    const response = await pushAppInfoCandidate(c, request); const body = await response.json() as any;
    expect(response.status).toBe(502);
    expect(body).toMatchObject({ code: "APP_INFO_RECOVERY_REQUIRED", mutation_started: false, recovery_required: true, prior_result: { outcome: "no_changes" } });
    expect(h.sqlite.prepare("SELECT count(*) n FROM store_product_locks").get()).toEqual({ n: 0 });
    expect(asc.writes()).toEqual([]);
  });

  it("keeps the exact lock if an accepted category write cannot be read back", async () => {
    const h = await harness(); let written = false;
    const asc = installAscFake((call) => {
      if (call.method === "PATCH" && call.path === "/v1/appInfos/info-1") { written = true; return { json: { data: call.body.data } }; }
      if (written && call.method === "GET" && call.path === "/v1/appInfos/info-1/relationships/primaryCategory") return { status: 500, json: { errors: [{ title: "readback unavailable" }] } };
      if (call.method === "GET" && /\/relationships\/primarySubcategory(One|Two)$/.test(call.path)) return { json: { data: null } };
      if (call.method === "GET" && call.path.startsWith("/v1/appCategories?")) return { json: { data: [{ type: "appCategories", id: "UTILITIES" }, { type: "appCategories", id: "PRODUCTIVITY" }], links: { self: call.url } } };
      return appleRead(call);
    });
    const context = () => { const { c } = makeContext({ params: { appId: APP, versionId: "ver-1" } }); c.env = h.env; return c; };
    const request = normalizeAppInfoInput({ mode: "commit", version_string: "1.22.0", primary_category: "PRODUCTIVITY" });
    const first = await pushAppInfoCandidate(context(), request); const body = await first.json() as any;
    expect(first.status).toBe(502);
    expect(body).toMatchObject({ code: "APP_INFO_RECOVERY_REQUIRED", recovery_required: true, results: [{ target: "primary_category", status: "written" }] });
    expect(h.sqlite.prepare("SELECT provider, operation_id FROM store_product_locks").get()).toEqual({ provider: "apple_app_info", operation_id: body.operation_id });
    expect((await (await pushAppInfoCandidate(context(), request)).json() as any).code).toBe("APP_INFO_LOCKED");
    expect(asc.writes()).toHaveLength(1);
  });

  it("keeps the exact lock if a structured conflict follows an applied write", async () => {
    const h = await harness(); let name = "Old Name";
    const asc = installAscFake((call) => {
      if (call.method === "PATCH" && call.path === "/v1/appInfoLocalizations/loc-1") {
        name = "New Name";
        return { status: 409, json: { errors: [{ status: "409", code: "ENTITY_ERROR.ATTRIBUTE.INVALID.DUPLICATE", title: "Name is not available" }] } };
      }
      return appleRead(call, name);
    });
    const context = () => { const { c } = makeContext({ params: { appId: APP, versionId: "ver-1" } }); c.env = h.env; return c; };
    const request = normalizeAppInfoInput({ ...input, mode: "commit" });
    const first = await pushAppInfoCandidate(context(), request); const body = await first.json() as any;
    expect(name).toBe("New Name");
    expect(first.status).toBe(502);
    expect(body).toMatchObject({ code: "APP_INFO_WRITE_FAILED", recovery_required: true, results: [{ target: "en-US", status: "unknown" }] });
    expect(h.sqlite.prepare("SELECT provider, operation_id FROM store_product_locks").get()).toEqual({ provider: "apple_app_info", operation_id: body.operation_id });
    const retry = await pushAppInfoCandidate(context(), request);
    expect(retry.status).toBe(409);
    expect((await retry.json() as any).code).toBe("APP_INFO_LOCKED");
    expect(asc.writes()).toHaveLength(1);
  });

  it("keeps the exact lock after an uncertain provider response, preventing a retry", async () => {
    const h = await harness();
    const asc = installAscFake((call) => {
      if (call.method === "PATCH") throw new Error("connection lost after request");
      return appleRead(call);
    });
    const context = () => {
      const { c } = makeContext({ params: { appId: APP, versionId: "ver-1" } }); c.env = h.env; return c;
    };
    const request = normalizeAppInfoInput({ ...input, mode: "commit" });
    const first = await pushAppInfoCandidate(context(), request);
    const body = await first.json() as any;
    expect(first.status).toBe(502);
    expect(body).toMatchObject({ recovery_required: true, results: [{ status: "unknown" }] });
    expect(h.sqlite.prepare("SELECT provider, operation_id FROM store_product_locks").get()).toEqual({ provider: "apple_app_info", operation_id: body.operation_id });
    const retry = await pushAppInfoCandidate(context(), request);
    expect((await retry.json() as any).code).toBe("APP_INFO_LOCKED");
    expect(asc.writes()).toHaveLength(1);
  });
});
