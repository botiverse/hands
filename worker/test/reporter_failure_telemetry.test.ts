import { afterEach, describe, expect, it, vi } from "vitest";
import { reporterFailureDiagnostic, setReporterFailureStage } from "../src/lib/reporter_failure";
vi.mock("@cloudflare/containers", () => ({ Container: class {}, getRandom: () => { throw new Error("container not used"); } }));
const { default: worker } = await import("../src/index");
afterEach(() => vi.restoreAllMocks());
const appId = "11111111-1111-4111-8111-111111111111";
const ctx = { waitUntil() {}, passThroughOnException() {} };

describe("reporter failure telemetry", () => {
  it.each(["GET", "PUT"])("captures a real %s token-lookup failure without exception or credential text", async (method) => {
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const statement = { bind() { return this; } };
    const env = { DB: { prepare: () => statement, batch: async () => {
      throw new Error("D1_ERROR: request failed secret-token", { cause: new Error("Network connection lost secret-body") });
    } } } as unknown as Env;
    const r = await worker.fetch(new Request(`https://hands.test/api/apps/${appId}/reporter-feedback${method === "PUT" ? "/route-subject" : ""}`, {
      method, headers: { authorization: "Bearer qvdt_secret-token", "X-Hands-Reporter-Id": "secret-reporter-identity", "content-type": "application/json" },
      ...(method === "PUT" ? { body: JSON.stringify({ route_subject: "rfr_v1_secret_subject" }) } : {}),
    }), env, ctx as any);
    expect(r.status).toBe(500);
    const records = log.mock.calls.filter(call => call[0] === "hands_http_response").map(call => JSON.parse(call[1] as string));
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ status: 500, failure_stage: "token_lookup", failure_code: "d1_unavailable" });
    expect(JSON.stringify(records)).not.toContain("secret");
    expect(JSON.stringify(records)).not.toContain(appId);
  });
  it("distinguishes SQL failure classes and keeps arbitrary causes private", () => {
    const context = {};
    setReporterFailureStage(context, "list_query");
    for (const [message, code] of [["no such column: private_table.secret", "sqlite_schema"], ["SQLITE_CONSTRAINT private-id", "sqlite_constraint"], ["SQLITE_BUSY secret", "sqlite_busy"], ["D1_ERROR secret", "database_error"], ["private-token", "unknown"]]) {
      expect(reporterFailureDiagnostic(context, new Error(message))).toEqual({ failure_stage: "list_query", failure_code: code });
    }
  });
});
