import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { exportPKCS8, generateKeyPair } from "jose";
import { ascRequest, parseAscRateLimit } from "../src/lib/asc_api";
import { ascQuotaAllows, ascQuotaObservation, recordAscRateLimit, resetAscQuotaWrites, withAscQuota } from "../src/lib/asc_quota";

const migration = fileURLToPath(new URL("../../migrations/sql/0113_upstream_quota_observations.sql", import.meta.url));

function d1(sqlite: Database.Database): D1Database {
  const prepare = (sql: string) => {
    const indexes: number[] = [];
    const statement = sqlite.prepare(sql.replace(/\?(\d+)/g, (_m, index) => { indexes.push(Number(index)); return "?"; }));
    const bind = (...parameters: unknown[]) => {
      const expanded = indexes.map((index) => parameters[index - 1]);
      return {
        run: async () => ({ success: true, meta: { changes: statement.run(...expanded).changes } }),
        first: async () => (statement.get(...expanded) as Record<string, unknown> | undefined) ?? null,
      };
    };
    return { bind };
  };
  return { prepare } as unknown as D1Database;
}

function store() {
  const sqlite = new Database(":memory:");
  sqlite.exec(readFileSync(migration, "utf8"));
  return d1(sqlite);
}

const T = Date.UTC(2026, 10, 23, 20, 0);
const MIN = 60_000;

beforeEach(() => resetAscQuotaWrites());
afterEach(() => vi.unstubAllGlobals());

describe("App Store Connect quota", () => {
  it("parses Apple's X-Rate-Limit header", () => {
    expect(parseAscRateLimit("user-hour-lim:3600;user-hour-rem:3599;", T)).toEqual({ limit: 3600, remaining: 3599, observed_at: T });
    expect(parseAscRateLimit(" user-hour-rem: 12 ; user-hour-lim: 3600 ", T)).toEqual({ limit: 3600, remaining: 12, observed_at: T });
    expect(parseAscRateLimit("user-hour-lim:3600;", T)).toBeNull();
    expect(parseAscRateLimit(null, T)).toBeNull();
  });

  it("records what Apple reports, at most every 30 seconds unless it is low", async () => {
    const db = store();
    await recordAscRateLimit(db, "KEY", { limit: 3600, remaining: 3000, observed_at: T }, false);
    await recordAscRateLimit(db, "KEY", { limit: 3600, remaining: 2990, observed_at: T + 1000 }, false);
    expect(await ascQuotaObservation(db, "KEY")).toEqual({ limit: 3600, remaining: 3000, observed_at: T, exhausted_until: null });
    await recordAscRateLimit(db, "KEY", { limit: 3600, remaining: 300, observed_at: T + 2000 }, false);
    expect((await ascQuotaObservation(db, "KEY"))?.remaining).toBe(300);
    await recordAscRateLimit(db, "KEY", { limit: 3600, remaining: 2900, observed_at: T + 33_000 }, false);
    expect((await ascQuotaObservation(db, "KEY"))?.remaining).toBe(2900);
  });

  it("holds background callers back when little is left, and everyone but gates after a 429", async () => {
    const db = store();
    await recordAscRateLimit(db, "KEY", { limit: 3600, remaining: 200, observed_at: T }, false);
    const low = await ascQuotaObservation(db, "KEY");
    expect(ascQuotaAllows(low, "background", T + MIN)).toEqual({ ok: false, reason: "low", retry_at: T + 60 * MIN });
    expect(ascQuotaAllows(low, "interactive", T + MIN)).toEqual({ ok: true });
    // The rolling hour has passed: the old report says nothing.
    expect(ascQuotaAllows(low, "background", T + 61 * MIN)).toEqual({ ok: true });

    await recordAscRateLimit(db, "KEY", { limit: 0, remaining: 0, observed_at: T + 2 * MIN }, true);
    const refused = await ascQuotaObservation(db, "KEY");
    expect(refused).toMatchObject({ limit: 3600, remaining: 0, exhausted_until: T + 7 * MIN });
    expect(ascQuotaAllows(refused, "interactive", T + 3 * MIN)).toEqual({ ok: false, reason: "exhausted", retry_at: T + 7 * MIN });
    expect(ascQuotaAllows(refused, "gate", T + 3 * MIN)).toEqual({ ok: true });
    expect(ascQuotaAllows(null, "background", T)).toEqual({ ok: true });
  });

  it("ascRequest reports every response's quota, and a 429", async () => {
    const db = store();
    const { privateKey } = await generateKeyPair("ES256", { extractable: true });
    const creds = withAscQuota(db, { key_id: "KEY", issuer_id: "ISS", p8: await exportPKCS8(privateKey) });
    const responses = [
      new Response(JSON.stringify({ data: [] }), { status: 200, headers: { "x-rate-limit": "user-hour-lim:3600;user-hour-rem:3500;" } }),
      new Response(JSON.stringify({ errors: [{ status: "429", code: "RATE_LIMIT_EXCEEDED", title: "The request rate limit has been reached.", detail: "We've received too many requests for this API." }] }),
        { status: 429, headers: { "x-rate-limit": "user-hour-lim:3600;user-hour-rem:0;" } }),
    ];
    vi.stubGlobal("fetch", async () => responses.shift()!);
    await ascRequest(creds, "GET", "/v1/apps");
    expect((await ascQuotaObservation(db, "KEY"))?.remaining).toBe(3500);
    const error = await ascRequest(creds, "GET", "/v1/apps").catch((e: unknown) => e as { status: number; code: string; message: string });
    expect(error).toMatchObject({ status: 429, code: "RATE_LIMIT_EXCEEDED", message: "The request rate limit has been reached." });
    expect(await ascQuotaObservation(db, "KEY")).toMatchObject({ remaining: 0 });
    expect((await ascQuotaObservation(db, "KEY"))?.exhausted_until).toBeGreaterThan(Date.now());
  });
});
