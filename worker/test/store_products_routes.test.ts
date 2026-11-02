import { describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { requireAppRole } from "../src/lib/permissions";
import { handleApplyStoreProduct, performSubscriptionScreenshotUpload } from "../src/routes/store_products";
import { generateDeployToken, hashDeployToken, sha256Hex } from "../src/lib/deploy_tokens";
vi.mock("@cloudflare/containers", () => ({ Container: class {}, getRandom: async () => ({ fetch: async () => new Response() }) }));

vi.mock("../src/lib/google_play_bindings", () => ({
  getGooglePlayBinding: async () => ({ package_name: "build.raft.app", enabled: 1, verification_state: "verified", tracks: {}, credential: { type: "service_account", private_key: "private", client_email: "x@example.com" } }),
  hasGooglePlayConfiguration: () => true,
}));
const migrations = fileURLToPath(new URL("../../migrations/sql/", import.meta.url));
function d1(db: Database.Database): D1Database {
  const prepare = (sql: string) => {
    const indexes: number[] = [];
    const stmt = db.prepare(sql.replace(/\?(\d+)/g, (_m, i) => { indexes.push(Number(i)); return "?"; }));
    const bind = (...args: unknown[]) => {
      const p = indexes.length ? indexes.map(i => args[i - 1]) : args;
      const execute = () => stmt.reader ? { success: true, results: stmt.all(...p), meta: { changes: 0 } }
        : { success: true, results: [], meta: { changes: stmt.run(...p).changes } };
      return { _execute: execute, run: async () => execute(),
        first: async () => stmt.get(...p) ?? null, all: async () => execute() };
    };
    return { bind, run: () => bind().run(), first: () => bind().first(), all: () => bind().all() };
  };
  return { prepare, batch: async (items: Array<{ _execute: () => unknown }>) => db.transaction(() => items.map(item => item._execute()))() } as unknown as D1Database;
}
async function harness(role = "admin", adapter?: (input: any) => Promise<any>) {
  const sqlite = new Database(":memory:"); sqlite.pragma("foreign_keys = ON");
  for (const name of readdirSync(migrations).sort()) if (name.endsWith(".sql")) sqlite.exec(readFileSync(`${migrations}${name}`, "utf8"));
  const now = Date.now();
  sqlite.prepare("INSERT INTO apps (id, slug, name, platform, created_at) VALUES ('app', 'app', 'App', 'android', ?)").run(now);
  sqlite.prepare(`INSERT INTO raft_accounts (id, provider, provider_subject, server_id, server_slug, principal_type, server_role, username, display_name, avatar_url, raw_profile, created_at, updated_at, last_login_at) VALUES ('acct', 'raft', 'acct', 'srv', 'test', 'agent', 'member', 'acct', 'Acct', NULL, '{}', ?, ?, ?)`).run(now,now,now);
  sqlite.prepare("INSERT INTO app_members (id, app_id, account_id, app_role, joined_at) VALUES ('m', 'app', 'acct', ?, ?)").run(role, now);
  const calls: any[] = [];
  const env = { DB: d1(sqlite), PLAY_RELEASE_SERVICE: { applySubscriptionProduct: async (input: any) => { calls.push(input); return adapter ? adapter(input) : { ok: true, value: { product_id: input.product.productId, mode: input.mode, outcome: input.mode === "commit" ? "committed" : "planned", changes: [], completed: input.mode === "commit" ? ["create"] : [] } }; } } } as unknown as Env;
  const app = new Hono<{ Bindings: Env; Variables: { admin_account: any; admin_actor: string } }>();
  app.use("*", async (c, next) => { c.set("admin_account", { id: "acct", provider: "raft", provider_subject: "acct", server_id: "srv", server_slug: "test", principal_type: "agent", server_role: "member", username: "acct", display_name: "Acct", avatar_url: null, raw_profile: "{}", created_at: 1, updated_at: 1, last_login_at: 1 }); c.set("admin_actor", "raft:agent@test"); await next(); });
  app.post("/api/apps/:appId/store-products", requireAppRole("admin"), handleApplyStoreProduct);
  const push = (body: unknown) => app.fetch(new Request("https://hands.test/api/apps/app/store-products", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), env, { waitUntil() {} } as unknown as ExecutionContext);
  return { sqlite, calls, push, env };
}
const product = { productId: "raft.pro.tier1", listings: [{ languageCode: "en-US", title: "private-title" }], basePlans: [{ basePlanId: "monthly", billingPeriodDuration: "P1M" }] };
const req = (mode: string) => ({ store: "google", mode, product });

describe("store product route", () => {
  it("rejects non-admins and the wrong store before calling the adapter", async () => {
    const viewer = await harness("viewer"); expect((await viewer.push(req("commit"))).status).toBe(403); expect(viewer.calls).toHaveLength(0);
    const publisher = await harness("publisher"); expect((await publisher.push(req("commit"))).status).toBe(403); expect(publisher.calls).toHaveLength(0);
    const h = await harness(); expect((await h.push({ ...req("dry_run"), store: "apple" })).status).toBe(400); expect(h.calls).toHaveLength(0);
  });
  it("uses only the verified app binding and preview leaves no lock or audit", async () => {
    const h = await harness(); const res = await h.push(req("dry_run")); expect(res.status).toBe(200);
    expect(h.calls[0]).toMatchObject({ packageName: "build.raft.app", mode: "dry_run", regionsVersion: "2022/02" });
    expect(h.sqlite.prepare("SELECT count(*) n FROM store_product_locks").get()).toEqual({ n: 0 });
    expect(h.sqlite.prepare("SELECT count(*) n FROM audit_logs").get()).toEqual({ n: 0 });
  });
  it("reports only allowlisted Google failure categories and a bounded provider status", async () => {
    const h = await harness("admin", async () => ({ ok: false, error: {
      status: 403, code: "play_api_rejected", message: "sensitive provider message",
      cause: { provider_identifiers: { http_code: 403, reason: "private-reason" } },
    } }));
    const res = await h.push(req("dry_run"));
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ code: "play_api_rejected", message: "Store request failed; inspect provider state before retrying", provider_http_status: 403 });
    expect(h.sqlite.prepare("SELECT count(*) n FROM store_product_locks").get()).toEqual({ n: 0 });
    expect(h.sqlite.prepare("SELECT count(*) n FROM audit_logs").get()).toEqual({ n: 0 });
  });
  it("does not expose unknown adapter codes, provider details, or unbounded statuses", async () => {
    const h = await harness("admin", async () => ({ ok: false, error: {
      status: 403, code: "sensitive_code", message: "sensitive provider message",
      cause: { provider_identifiers: { http_code: 403 } },
    } }));
    const res = await h.push(req("dry_run"));
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ code: "google_subscription_failed", message: "Store request failed; inspect provider state before retrying" });
    const malformed = await harness("admin", async () => ({ ok: false, error: {
      status: 403, code: "play_api_rejected", message: "sensitive provider message",
      cause: { provider_identifiers: { http_code: 999 } },
    } }));
    expect(await (await malformed.push(req("dry_run"))).json()).toEqual({ code: "play_api_rejected", message: "Store request failed; inspect provider state before retrying" });
  });
  it("exposes only validated shape facts for a malformed Google success response", async () => {
    const h = await harness("admin", async () => ({ ok: false, error: {
      status: 502, code: "play_api_malformed", message: "sensitive provider text",
      cause: { response_shape: { status: 200, body_empty: true, json_parsed: false, body: "private-value" } },
    } }));
    const res = await h.push(req("dry_run"));
    expect(await res.json()).toEqual({ code: "play_api_malformed", message: "Store request failed; inspect provider state before retrying", provider_http_status: 200, provider_body_empty: true, provider_json_parsed: false });
    const invalid = await harness("admin", async () => ({ ok: false, error: {
      status: 502, code: "play_api_malformed", message: "sensitive provider text",
      cause: { response_shape: { status: 200, body_empty: "private-value", json_parsed: false } },
    } }));
    expect(await (await invalid.push(req("dry_run"))).json()).toEqual({ code: "play_api_malformed", message: "Store request failed; inspect provider state before retrying" });
  });
  it("keeps an uncertain commit locked even when an adapter failure has a safe category", async () => {
    const h = await harness("admin", async () => ({ ok: false, error: { status: 403, code: "play_api_rejected", message: "sensitive provider message" } }));
    const res = await h.push(req("commit"));
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ code: "STORE_PRODUCT_RECOVERY_REQUIRED", recovery_required: true });
    expect(h.sqlite.prepare("SELECT count(*) n FROM store_product_locks").get()).toEqual({ n: 1 });
  });
  it("records a commit without persisting supplied listing text or credentials", async () => {
    const h = await harness(); const res = await h.push(req("commit")); expect(res.status).toBe(200);
    expect(h.sqlite.prepare("SELECT count(*) n FROM store_product_locks").get()).toEqual({ n: 0 });
    const audit = JSON.stringify(h.sqlite.prepare("SELECT payload FROM audit_logs").all());
    expect(audit).not.toContain("private-title"); expect(audit).not.toContain("private_key"); expect(audit).toContain("raft.pro.tier1");
  });
  it("blocks a concurrent commit for the same package until the first finishes", async () => {
    let start!: () => void, finish!: () => void;
    const started = new Promise<void>(resolve => { start = resolve; });
    const wait = new Promise<void>(resolve => { finish = resolve; });
    const h = await harness("admin", async input => { start(); await wait; return { ok: true, value: { product_id: input.product.productId, mode: input.mode, outcome: "committed", changes: [], completed: ["create"] } }; });
    const first = h.push(req("commit")); await started;
    expect((await h.push(req("commit"))).status).toBe(409); expect(h.calls).toHaveLength(1);
    finish(); expect((await first).status).toBe(200);
    expect(h.sqlite.prepare("SELECT count(*) n FROM store_product_locks").get()).toEqual({ n: 0 });
  });
  it("retains a lock when a write may have succeeded despite a failed response", async () => {
    const h = await harness("admin", async input => ({ ok: true, value: { product_id: input.product.productId, mode: input.mode, outcome: "failed", changes: [], completed: [], error: { code: "timeout", message: "uncertain" } } }));
    const res = await h.push(req("commit")); expect(res.status).toBe(502); expect(await res.json()).toMatchObject({ outcome: "failed", recovery_required: true });
    expect(h.sqlite.prepare("SELECT count(*) n FROM store_product_locks").get()).toEqual({ n: 1 });
    expect((await h.push(req("commit"))).status).toBe(409);
  });
  it("releases the lock for an adapter input rejection before provider calls", async () => {
    const h = await harness("admin", async () => ({ ok: false, error: { status: 400, code: "subscription_request_invalid", message: "bad product" } }));
    const res = await h.push(req("commit")); expect(res.status).toBe(400);
    expect(h.sqlite.prepare("SELECT count(*) n FROM store_product_locks").get()).toEqual({ n: 0 });
  });
});


describe("Apple screenshot upload operation validation", () => {
  it("rejects overlapping ranges or non-HTTPS URLs before uploading any bytes", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 })); vi.stubGlobal("fetch", fetchMock);
    const op = { url: "https://uploads.example/part", method: "PUT", requestHeaders: [] };
    await expect(performSubscriptionScreenshotUpload([{ ...op, offset: 0, length: 2 }, { ...op, offset: 1, length: 2 }], new Uint8Array(4))).rejects.toThrow();
    await expect(performSubscriptionScreenshotUpload([{ ...op, url: "http://localhost/x", offset: 0, length: 4 }], new Uint8Array(4))).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
    await performSubscriptionScreenshotUpload([{ ...op, offset: 0, length: 2 }, { ...op, offset: 2, length: 2 }], new Uint8Array(4));
    expect(fetchMock).toHaveBeenCalledTimes(2); vi.unstubAllGlobals();
  });
});


it("the actual registered route enforces app admin for deploy tokens", async () => {
  const { admin } = await import("../src/index");
  const h = await harness();
  async function token(role: string) {
    const t = generateDeployToken();
    h.sqlite.prepare(`INSERT INTO app_deploy_tokens (id, app_id, name, token_prefix, token_hash, app_role, scopes_json, created_by_actor, created_at) VALUES (?, 'app', ?, ?, ?, ?, NULL, 'test', 1)`)
      .run(role, role, t.token_prefix, await hashDeployToken(t.token), role);
    return t.token;
  }
  const publisher = await token("publisher"), adminToken = "admin-session-token";
  h.sqlite.prepare("INSERT INTO raft_sessions (id, account_id, token_hash, created_at, expires_at, last_seen_at) VALUES ('s', 'acct', ?, 1, ?, 1)").run(await sha256Hex(adminToken), Date.now() + 60000);
  const call = (bearer: string) => admin.fetch(new Request("https://hands.test/api/apps/app/store-products", { method: "POST", headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" }, body: JSON.stringify(req("dry_run")) }), h.env, { waitUntil() {} } as unknown as ExecutionContext);
  expect((await call(publisher)).status).toBe(403);
  expect((await call(adminToken)).status).toBe(200);
  expect(h.calls).toHaveLength(1);
});
