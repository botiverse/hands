import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("@cloudflare/containers", () => ({ Container: class {}, getRandom: () => { throw new Error("container not used"); } }));
const { default: worker } = await import("../src/index");
afterEach(() => vi.restoreAllMocks());
const appId = "11111111-1111-4111-8111-111111111111";
const ctx = { waitUntil() {}, passThroughOnException() {} };
function fixture(failures: number, error = new Error("D1_ERROR: backend request failed", { cause: new Error("Network connection lost") }), revoked = false, rateError?: Error) {
  const calls = { lookup: 0, rate: 0, business: 0, touches: [] as unknown[][] };
  const row = { id: "token", app_id: appId, app_slug: "test", name: "reporter", token_prefix: "qvdt", app_role: null, scopes_json: JSON.stringify(["feedback:read", "feedback:route"]), reporter_integration_id: "integration", reporter_integration_active: 1, revoked_at: null, expires_at: null };
  const result = (results: unknown[] = [], changes = 0) => ({ success: true, results, meta: { changes } });
  const DB = {
    prepare(sql: string) { return { sql, params: [] as unknown[], bind(...params: unknown[]) { this.params = params; return this; }, async first() { return { route_subject: "rfr_v1_test_subject" }; } }; },
    async batch(statements: { sql: string; params: unknown[] }[]) {
      const first = statements[0]!.sql;
      if (first.includes("FROM app_deploy_tokens")) {
        calls.lookup++; calls.touches.push(statements[1]!.params);
        if (calls.lookup <= failures) throw error;
        return [result(revoked ? [] : [row]), result()];
      }
      if (first.includes("INSERT INTO feedback_reporter_rate_windows")) { calls.rate++; if (rateError && calls.rate === 1) throw rateError; return [result([{ request_count: 1 }]), result([{ request_count: 1 }])]; }
      calls.business++;
      return statements.map((_, index) => result([], first.includes("INSERT OR IGNORE INTO app_reporter_routes") && index === 0 ? 1 : 0));
    },
  };
  const env = { DB, FEEDBACK_AUDIT_HMAC_KEY: "test-audit-key".repeat(4), FEEDBACK_AUDIT_KEY_VERSION: "v1" } as unknown as Env;
  return { env, calls };
}
function request(method: string) {
  return new Request(`https://hands.test/api/apps/${appId}/reporter-feedback${method === "PUT" ? "/route-subject" : ""}`, { method,
    headers: { authorization: "Bearer qvdt_test-token", "X-Hands-Reporter-Id": "test_reporter_identity", "content-type": "application/json" },
    ...(method === "PUT" ? { body: JSON.stringify({ route_subject: "rfr_v1_test_subject" }) } : {}),
  });
}
describe("reporter token lookup outage recovery", () => {
  it.each(["GET", "PUT"])("recovers one transient %s lookup failure without replaying downstream writes", async method => {
    vi.spyOn(console, "info").mockImplementation(() => {}); vi.spyOn(console, "error").mockImplementation(() => {});
    const { env, calls } = fixture(1);
    const response = await worker.fetch(request(method), env, ctx as any);
    expect(response.status).toBe(method === "GET" ? 200 : 201);
    expect(calls.lookup).toBe(2); expect(calls.rate).toBe(method === "GET" ? 1 : 0); expect(calls.business).toBe(1);
    // Even an ambiguous commit can only repeat the identical last_used_at set.
    expect(calls.touches[0]).toEqual(calls.touches[1]);
  });
  it.each(["GET", "PUT"])("fails closed with a bounded %s outage and actionable retry response", async method => {
    const log = vi.spyOn(console, "info").mockImplementation(() => {}); vi.spyOn(console, "error").mockImplementation(() => {});
    const { env, calls } = fixture(10);
    const response = await worker.fetch(request(method), env, ctx as any);
    expect(response.status).toBe(503); expect(response.headers.get("Retry-After")).toBe("1");
    expect(await response.json()).toMatchObject({ code: "REPORTER_BACKEND_UNAVAILABLE" });
    expect(calls.lookup).toBe(2); expect(calls.rate).toBe(0); expect(calls.business).toBe(0);
    expect(log.mock.calls.filter(call => call[0] === "hands_reporter_failure_detail")).toHaveLength(1);
  });
  it("rechecks revocation on recovery rather than accepting the failed lookup", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {}); vi.spyOn(console, "error").mockImplementation(() => {});
    const { env, calls } = fixture(1, undefined, true);
    const response = await worker.fetch(request("GET"), env, ctx as any);
    expect(response.status).toBe(401); expect(calls.lookup).toBe(2); expect(calls.business).toBe(0); expect(calls.rate).toBe(0);
  });
  it.each(["SQLITE_CONSTRAINT foreign key", "no such column: private", "unknown database failure"])("does not retry a deterministic or unknown error: %s", async message => {
    vi.spyOn(console, "info").mockImplementation(() => {}); vi.spyOn(console, "error").mockImplementation(() => {});
    const { env, calls } = fixture(10, new Error(message));
    const response = await worker.fetch(request("GET"), env, ctx as any);
    expect(response.status).toBe(500); expect(calls.lookup).toBe(1); expect(calls.business).toBe(0);
  });
});


describe("reporter rate batch outage handling", () => {
  it("fails closed without replaying an ambiguous increment, then allows a fresh request", async () => {
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const { env, calls } = fixture(0, undefined, false, new Error("D1_ERROR: Network connection lost", { cause: new Error("Network connection lost") }));
    const response = await worker.fetch(request("GET"), env, ctx as any);
    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("1");
    expect(await response.json()).toEqual({ error: "reporter backend temporarily unavailable", code: "REPORTER_BACKEND_UNAVAILABLE" });
    expect(calls.lookup).toBe(1); expect(calls.rate).toBe(1); expect(calls.business).toBe(0);
    expect(errorLog).not.toHaveBeenCalled();
    const sealed = log.mock.calls.filter(call => call[0] === "hands_reporter_failure_detail");
    expect(sealed).toHaveLength(1);
    expect(JSON.parse(sealed[0]![1] as string)).toMatchObject({ failure_stage: "rate_limit" });
    expect(JSON.stringify(sealed)).not.toContain("Network connection lost");
    const second = await worker.fetch(request("GET"), env, ctx as any);
    expect(second.status).toBe(200);
    expect(calls.lookup).toBe(2); expect(calls.rate).toBe(2); expect(calls.business).toBe(1);
  });
  it.each(["SQLITE_CONSTRAINT foreign key", "no such column: private", "unknown database failure"])("keeps a deterministic or unknown rate failure visible: %s", async message => {
    vi.spyOn(console, "info").mockImplementation(() => {}); vi.spyOn(console, "error").mockImplementation(() => {});
    const { env, calls } = fixture(0, undefined, false, new Error(message));
    const response = await worker.fetch(request("GET"), env, ctx as any);
    expect(response.status).toBe(500); expect(response.headers.get("Retry-After")).toBeNull();
    expect(calls.lookup).toBe(1); expect(calls.rate).toBe(1); expect(calls.business).toBe(0);
  });
});
