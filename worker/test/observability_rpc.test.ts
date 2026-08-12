import { afterEach, describe, expect, it, vi } from "vitest";
import { getHandsObservabilityOverview } from "../src/observability_data";
import { getCachedHandsObservabilityOverview, resetHandsObservabilityCacheForTest } from "../src/observability_rpc";

afterEach(() => {
  resetHandsObservabilityCacheForTest();
  vi.useRealTimers();
});

describe("Hands observability RPC", () => {
  it("returns only aggregate rows and measures all R2 pages", async () => {
    const firstRows = [
      { users: 4, organizations: 2, apps: 3, active_apps: 2, builds: 9, releases: 5 },
      [{ type: "human", count: 3 }, { type: "agent", count: 1 }],
      [{ type: "electron", count: 2 }, { type: "android", count: 1 }],
      [{ type: "electron-installer", count: 7 }],
      [{ status: "active", count: 4 }],
      [{ week: "2026-32", count: 2 }],
      { object_count: 2, size_bytes: 700 },
    ];
    let query = 0;
    const DB = {
      prepare: () => ({
        first: async () => firstRows[query++],
        all: async () => ({ results: firstRows[query++] }),
      }),
    };
    const APK_BUCKET = {
      list: async (options: { cursor?: string }) => options.cursor
        ? { objects: [{ key: "private/key-2", size: 9 }], truncated: false }
        : { objects: [{ key: "private/key-1", size: 5 }], truncated: true, cursor: "next" },
    };

    const result = await getHandsObservabilityOverview({ DB, APK_BUCKET } as never);
    expect(result.summary.users).toBe(4);
    expect(result.storage.r2).toEqual({ object_count: 2, size_bytes: 14 });
    expect(JSON.stringify(result)).not.toContain("private/key");
    expect(Object.keys(result)).toEqual([
      "measured_at", "summary", "users_by_type", "apps_by_platform",
      "builds_by_product_type", "releases_by_status", "releases_by_week", "storage",
    ]);
  });

  it("caches the expensive bucket measurement for a short TTL", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-12T15:00:00Z"));
    let query = 0;
    const rows = [
      { users: 1, organizations: 1, apps: 1, active_apps: 1, builds: 1, releases: 1 },
      [], [], [], [], [],
      { object_count: 1, size_bytes: 5 },
    ];
    const DB = {
      prepare: () => ({
        first: async () => rows[query++ % rows.length],
        all: async () => ({ results: rows[query++ % rows.length] }),
      }),
    };
    const list = vi.fn(async () => ({ objects: [{ key: "private/key", size: 5 }], truncated: false }));
    const env = { DB, APK_BUCKET: { list } } as never;

    const first = await getCachedHandsObservabilityOverview(env);
    const second = await getCachedHandsObservabilityOverview(env);
    expect(second).toBe(first);
    expect(list).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(60_001);
    await getCachedHandsObservabilityOverview(env);
    expect(list).toHaveBeenCalledTimes(2);
  });
});
