import { describe, expect, it } from "vitest";
import { STAGING_ABANDONED_MS, sweepAbandonedDesktopStaging } from "../src/routes/desktop_files";

const NOW = Date.UTC(2026, 10, 23, 20, 0);

function env(objects: Array<{ key: string; age: number }>, apps = ["app-d"]) {
  const store = new Map(objects.map((o) => [o.key, new Date(NOW - o.age)]));
  const deleted: string[] = [];
  return {
    deleted,
    store,
    env: {
      DB: { prepare: () => ({ bind: () => ({ all: async () => ({ results: apps.map((id) => ({ id })) }) }) }) },
      APK_BUCKET: {
        list: async ({ prefix, cursor }: { prefix: string; cursor?: string }) => {
          const keys = [...store.keys()].filter((k) => k.startsWith(prefix)).sort();
          const start = cursor ? Number(cursor) : 0;
          const page = keys.slice(start, start + 2);
          return {
            objects: page.map((key) => ({ key, uploaded: store.get(key)! })),
            truncated: start + 2 < keys.length,
            cursor: String(start + 2),
          };
        },
        delete: async (keys: string[]) => { for (const k of keys) { deleted.push(k); store.delete(k); } },
      },
    } as unknown as Env,
  };
}

describe("sweepAbandonedDesktopStaging", () => {
  it("deletes staged files older than a day across pages, and keeps fresh ones and stored files", async () => {
    const day = STAGING_ABANDONED_MS;
    const h = env([
      { key: "apps/app-d/files/staging/aaa", age: day + 1 },
      { key: "apps/app-d/files/staging/bbb", age: 60_000 },
      { key: "apps/app-d/files/staging/ccc", age: 2 * day },
      { key: "apps/app-d/files/staging/ddd", age: day },
      { key: "apps/app-d/files/sha256/eee", age: 10 * day },
      { key: "apps/app-x/files/staging/fff", age: 10 * day },
    ]);
    const result = await sweepAbandonedDesktopStaging(h.env, NOW);
    expect(h.deleted.sort()).toEqual([
      "apps/app-d/files/staging/aaa", "apps/app-d/files/staging/ccc", "apps/app-d/files/staging/ddd",
    ]);
    expect(result).toEqual({ deleted: 3 });
    expect(h.store.has("apps/app-d/files/sha256/eee")).toBe(true);
    expect(h.store.has("apps/app-x/files/staging/fff")).toBe(true); // not a desktop app
  });
});
