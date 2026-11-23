import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  PLAY_RELEASES_LIST, UPSTREAM_QUOTAS, markExhausted, pruneQuotaUsage, quotaWindow, record, status, take, tierCeiling,
} from "../src/lib/upstream_quota";

const migration = fileURLToPath(new URL("../../migrations/sql/0110_upstream_quota_usage.sql", import.meta.url));

/** better-sqlite3 behind the slice of the D1 API the ledger uses. */
function d1(sqlite: Database.Database): D1Database {
  const prepare = (sql: string) => {
    const indexes: number[] = [];
    const statement = sqlite.prepare(sql.replace(/\?(\d+)/g, (_m, index) => { indexes.push(Number(index)); return "?"; }));
    const bind = (...parameters: unknown[]) => {
      const expanded = indexes.map((index) => parameters[index - 1]);
      return {
        run: async () => ({ success: true, meta: { changes: statement.run(...expanded).changes } }),
        all: async () => ({ success: true, results: statement.all(...expanded) }),
        first: async () => (statement.get(...expanded) as Record<string, unknown> | undefined) ?? null,
      };
    };
    return { bind };
  };
  return { prepare } as unknown as D1Database;
}

function ledger() {
  const sqlite = new Database(":memory:");
  sqlite.exec(readFileSync(migration, "utf8"));
  return { sqlite, db: d1(sqlite) };
}

const PKG = "build.raft.app";
// 2026-11-22 13:20 UTC: inside the window that started at 13:10.
const T = Date.UTC(2026, 10, 22, 13, 20);
const W = Date.UTC(2026, 10, 22, 13, 10);
const HOUR = 3_600_000;

describe("quota registry", () => {
  it("registers Google Play's release listing with its measured limit and reserves", () => {
    expect(UPSTREAM_QUOTAS[PLAY_RELEASES_LIST]).toEqual({
      service: "google_play", operation: "tracks.releases.list", limit: 12,
      window: { kind: "hourly", resetMinute: 10 }, scope: "package", source: "measured 2026-11-22",
      reserve: { gate: 4, interactive: 4 },
    });
    const def = UPSTREAM_QUOTAS[PLAY_RELEASES_LIST]!;
    expect([tierCeiling(def, "gate"), tierCeiling(def, "interactive"), tierCeiling(def, "background")]).toEqual([12, 8, 4]);
  });
});

describe("hourly window around minute :10", () => {
  const window = { kind: "hourly" as const, resetMinute: 10 };
  it("puts :09:59.999 in the previous window and :10:00 in the next", () => {
    expect(quotaWindow(window, W - 1)).toEqual({ start: W - HOUR, reset_at: W });
    expect(quotaWindow(window, W)).toEqual({ start: W, reset_at: W + HOUR });
    expect(quotaWindow(window, W + HOUR - 1)).toEqual({ start: W, reset_at: W + HOUR });
    expect(quotaWindow(window, Date.UTC(2026, 10, 22, 0, 5))).toEqual({
      start: Date.UTC(2026, 10, 21, 23, 10), reset_at: Date.UTC(2026, 10, 22, 0, 10) });
  });

  it("starts a fresh count when the window rolls over at :10", async () => {
    const { db } = ledger();
    expect(await take(db, PLAY_RELEASES_LIST, PKG, "gate", 12, W - 1)).toMatchObject({ ok: true, used: 12, reset_at: W });
    expect(await take(db, PLAY_RELEASES_LIST, PKG, "gate", 1, W - 1)).toMatchObject({ ok: false, reason: "budget", used: 12 });
    expect(await take(db, PLAY_RELEASES_LIST, PKG, "gate", 1, W)).toEqual({ ok: true, used: 1, limit: 12, reset_at: W + HOUR });
  });
});

describe("take", () => {
  it("lets each tier spend only up to its ceiling, and a refused take spends nothing", async () => {
    const { db, sqlite } = ledger();
    expect(await take(db, PLAY_RELEASES_LIST, PKG, "background", 4, T)).toEqual({ ok: true, used: 4, limit: 12, reset_at: W + HOUR });
    expect(await take(db, PLAY_RELEASES_LIST, PKG, "background", 1, T)).toEqual(
      { ok: false, used: 4, limit: 12, reset_at: W + HOUR, reason: "budget" });
    expect(await take(db, PLAY_RELEASES_LIST, PKG, "interactive", 3, T)).toMatchObject({ ok: true, used: 7 });
    // 7 + 2 would pass the interactive ceiling of 8: nothing is spent.
    expect(await take(db, PLAY_RELEASES_LIST, PKG, "interactive", 2, T)).toMatchObject({ ok: false, used: 7, reason: "budget" });
    expect(await take(db, PLAY_RELEASES_LIST, PKG, "interactive", 1, T)).toMatchObject({ ok: true, used: 8 });
    expect(await take(db, PLAY_RELEASES_LIST, PKG, "gate", 4, T)).toMatchObject({ ok: true, used: 12 });
    expect(await take(db, PLAY_RELEASES_LIST, PKG, "gate", 1, T)).toMatchObject({ ok: false, used: 12, reason: "budget" });
    expect(sqlite.prepare("SELECT used FROM upstream_quota_usage").all()).toEqual([{ used: 12 }]);
  });

  it("refuses a first take larger than the tier allows without creating a row", async () => {
    const { db, sqlite } = ledger();
    expect(await take(db, PLAY_RELEASES_LIST, PKG, "background", 5, T)).toMatchObject({ ok: false, used: 0, reason: "budget" });
    expect(sqlite.prepare("SELECT count(*) n FROM upstream_quota_usage").get()).toEqual({ n: 0 });
  });

  it("keeps packages apart", async () => {
    const { db } = ledger();
    await take(db, PLAY_RELEASES_LIST, PKG, "gate", 12, T);
    expect(await take(db, PLAY_RELEASES_LIST, "com.other.app", "background", 4, T)).toMatchObject({ ok: true, used: 4 });
  });

  it("never lets concurrent takes pass the ceiling", async () => {
    const { db } = ledger();
    const results = await Promise.all(Array.from({ length: 10 }, () => take(db, PLAY_RELEASES_LIST, PKG, "interactive", 1, T)));
    expect(results.filter((r) => r.ok)).toHaveLength(8);
    expect((await status(db, PKG, T))[0]!.used).toBe(8);
  });

  it("refuses every tier once Google said the quota is used up, until the window resets", async () => {
    const { db } = ledger();
    await take(db, PLAY_RELEASES_LIST, PKG, "background", 2, T);
    expect(await markExhausted(db, PLAY_RELEASES_LIST, PKG, T)).toBe(W + HOUR);
    for (const tier of ["gate", "interactive", "background"] as const) {
      expect(await take(db, PLAY_RELEASES_LIST, PKG, tier, 1, T + 60_000)).toEqual(
        { ok: false, used: 2, limit: 12, reset_at: W + HOUR, reason: "exhausted" });
    }
    expect(await take(db, PLAY_RELEASES_LIST, PKG, "background", 1, W + HOUR)).toMatchObject({ ok: true, used: 1 });
  });

  it("rejects an unknown key", async () => {
    const { db } = ledger();
    await expect(take(db, "nope:op", PKG, "gate", 1, T)).rejects.toThrow("unknown upstream quota");
  });
});

describe("record, status and pruning", () => {
  it("records calls Hands could not gate, even past the ceiling, and reports what is left per tier", async () => {
    const { db } = ledger();
    await record(db, PLAY_RELEASES_LIST, PKG, 2, T);
    await take(db, PLAY_RELEASES_LIST, PKG, "background", 1, T);
    expect(await status(db, PKG, T)).toEqual([{
      key: PLAY_RELEASES_LIST, service: "google_play", operation: "tracks.releases.list", scope: "package",
      limit: 12, used: 3, remaining: { gate: 9, interactive: 5, background: 1 }, reset_at: W + HOUR,
      exhausted_until: null, source: "measured 2026-11-22",
    }]);
    await record(db, PLAY_RELEASES_LIST, PKG, 11, T);
    expect((await status(db, PKG, T))[0]).toMatchObject({ used: 14, remaining: { gate: 0, interactive: 0, background: 0 } });
  });

  it("reports nothing left while exhausted, and a fresh window after the reset", async () => {
    const { db } = ledger();
    await markExhausted(db, PLAY_RELEASES_LIST, PKG, T);
    expect((await status(db, PKG, T))[0]).toMatchObject({
      used: 0, exhausted_until: W + HOUR, remaining: { gate: 0, interactive: 0, background: 0 } });
    expect((await status(db, PKG, W + HOUR))[0]).toMatchObject({
      used: 0, exhausted_until: null, reset_at: W + 2 * HOUR, remaining: { gate: 12, interactive: 8, background: 4 } });
  });

  it("prunes windows older than two days", async () => {
    const { db, sqlite } = ledger();
    await record(db, PLAY_RELEASES_LIST, PKG, 1, T - 3 * 24 * HOUR);
    await record(db, PLAY_RELEASES_LIST, PKG, 1, T - HOUR);
    await pruneQuotaUsage(db, T);
    expect(sqlite.prepare("SELECT window_start FROM upstream_quota_usage").all()).toEqual([{ window_start: W - HOUR }]);
  });
});
