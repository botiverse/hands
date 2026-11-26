import Database from "better-sqlite3";
import { readFileSync, readdirSync } from "node:fs";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import {
  parseBuildNumber,
  recordExternalBuildState,
  recordExternalBuildStateBestEffort,
} from "../src/lib/testflight_latest";
import { handlePublicTestflightLatest } from "../src/routes/public_testflight";
import { handleGetApp, handleListApps, handleUpdateApp } from "../src/routes/apps";

/** The full production migration chain behind a minimal D1 adapter. */
function setup() {
  const sql = new Database(":memory:");
  sql.pragma("foreign_keys = ON");
  const directory = new URL("../../migrations/sql/", import.meta.url);
  for (const file of readdirSync(directory).sort())
    if (file.endsWith(".sql")) sql.exec(readFileSync(new URL(file, directory), "utf8"));
  sql.exec(`INSERT INTO apps(id,slug,name,platform,created_at) VALUES
    ('app','raft-ios','Raft iOS','ios',0),
    ('other','other-ios','Other','ios',0);`);
  const prepare = (query: string) => {
    // D1 numbering: `?N` is parameter N, a bare `?` is one past the largest so far.
    const indexes: number[] = [];
    let highest = 0;
    const stmt = sql.prepare(query.replace(/\?(\d*)/g, (_, n: string) => {
      const index = n ? Number(n) : highest + 1;
      highest = Math.max(highest, index);
      indexes.push(index);
      return "?";
    }));
    const bind = (...args: unknown[]) => {
      const values = indexes.map((n) => args[n - 1]);
      return {
        run: async () => ({ meta: { changes: stmt.run(...values).changes }, success: true }),
        first: async () => (stmt.reader ? stmt.get(...values) ?? null : null),
        all: async () => ({ results: stmt.all(...values) }),
      };
    };
    return { bind, ...bind() };
  };
  const db = { prepare } as unknown as D1Database;
  const row = (appId = "app") =>
    sql.prepare("SELECT * FROM testflight_latest_builds WHERE app_id = ?").get(appId) as
      | Record<string, unknown>
      | undefined;
  return { sql, db, row };
}

const observe = (overrides: Partial<Parameters<typeof recordExternalBuildState>[1]> = {}) => ({
  appId: "app",
  ascBuildId: "asc-b1",
  versionName: "1.31.0",
  buildNumber: "13000003",
  externalBuildState: "IN_BETA_TESTING",
  now: 1000,
  ...overrides,
});

describe("testflight_latest helper", () => {
  it("accepts only plain integer build numbers", () => {
    expect(parseBuildNumber("13000003")).toBe(13000003);
    expect(parseBuildNumber(13000003)).toBe(13000003);
    expect(parseBuildNumber("1.2.3")).toBeNull();
    expect(parseBuildNumber("12a")).toBeNull();
    expect(parseBuildNumber("")).toBeNull();
    expect(parseBuildNumber(" 12")).toBeNull();
    expect(parseBuildNumber("1234567890123456")).toBeNull();
    expect(parseBuildNumber(-1)).toBeNull();
    expect(parseBuildNumber(null)).toBeNull();
  });

  it("stores the first IN_BETA_TESTING build", async () => {
    const { db, row } = setup();
    expect(await recordExternalBuildState(db, observe())).toBe("upserted");
    expect(row()).toEqual({
      app_id: "app",
      version_name: "1.31.0",
      version_code: 13000003,
      asc_build_id: "asc-b1",
      external_build_state: "IN_BETA_TESTING",
      updated_at: 1000,
    });
  });

  it("replaces the stored build with a newer one and refreshes the same one", async () => {
    const { db, row } = setup();
    await recordExternalBuildState(db, observe());
    expect(await recordExternalBuildState(db, observe({
      ascBuildId: "asc-b2", versionName: "1.32.0", buildNumber: "13100001", now: 2000,
    }))).toBe("upserted");
    expect(row()).toMatchObject({ asc_build_id: "asc-b2", version_code: 13100001, version_name: "1.32.0", updated_at: 2000 });
    // Equal build number (a readback of the same build) refreshes updated_at.
    expect(await recordExternalBuildState(db, observe({
      ascBuildId: "asc-b2", versionName: "1.32.0", buildNumber: "13100001", now: 3000,
    }))).toBe("upserted");
    expect(row()).toMatchObject({ asc_build_id: "asc-b2", updated_at: 3000 });
  });

  it("ignores an older build and compares numerically, not as strings", async () => {
    const { db, row } = setup();
    await recordExternalBuildState(db, observe({ buildNumber: "100", ascBuildId: "asc-100" }));
    // "99" > "100" as strings; numerically it is older and must not win.
    expect(await recordExternalBuildState(db, observe({ buildNumber: "99", ascBuildId: "asc-99" }))).toBe("ignored");
    expect(row()).toMatchObject({ asc_build_id: "asc-100", version_code: 100 });
  });

  it("ignores builds whose number is not a plain integer", async () => {
    const { db, row } = setup();
    expect(await recordExternalBuildState(db, observe({ buildNumber: "1.31.0.3" }))).toBe("ignored");
    expect(row()).toBeUndefined();
    expect(await recordExternalBuildState(db, observe({ versionName: "  " }))).toBe("ignored");
    expect(await recordExternalBuildState(db, observe({ ascBuildId: null }))).toBe("ignored");
    expect(row()).toBeUndefined();
  });

  it("removes the stored build when that same build leaves IN_BETA_TESTING", async () => {
    const { db, row } = setup();
    await recordExternalBuildState(db, observe());
    expect(await recordExternalBuildState(db, observe({ externalBuildState: "EXPIRED" }))).toBe("removed");
    expect(row()).toBeUndefined();
  });

  it("keeps the stored build when a different build leaves testing", async () => {
    const { db, row } = setup();
    await recordExternalBuildState(db, observe());
    expect(await recordExternalBuildState(db, observe({
      ascBuildId: "asc-old", buildNumber: "12000000", externalBuildState: "EXPIRED",
    }))).toBe("ignored");
    // A non-testing state for another build never inserts either.
    expect(await recordExternalBuildState(db, observe({
      appId: "other", externalBuildState: "BETA_APPROVED",
    }))).toBe("ignored");
    expect(row()).toMatchObject({ asc_build_id: "asc-b1" });
    expect(row("other")).toBeUndefined();
  });

  it("scopes rows per app", async () => {
    const { db, row } = setup();
    await recordExternalBuildState(db, observe());
    await recordExternalBuildState(db, observe({ appId: "other", buildNumber: "5", ascBuildId: "asc-o" }));
    expect(row()).toMatchObject({ version_code: 13000003 });
    expect(row("other")).toMatchObject({ version_code: 5 });
  });

  it("best-effort wrapper swallows storage failures", async () => {
    const { db, sql } = setup();
    sql.exec("DROP TABLE testflight_latest_builds");
    await expect(recordExternalBuildStateBestEffort(db, observe(), "test")).resolves.toBeNull();
  });
});

describe("GET /public/v2/apps/:slug/testflight/latest", () => {
  function route(db: D1Database) {
    const app = new Hono<any>();
    app.get("/public/v2/apps/:slug/testflight/latest", handlePublicTestflightLatest as any);
    return (slug: string) => app.request(`/public/v2/apps/${slug}/testflight/latest`, {}, { DB: db } as any);
  }

  it("returns exactly the version identity of the stored build when opted in", async () => {
    const { db, sql } = setup();
    sql.exec("UPDATE apps SET public_testflight_latest = 1 WHERE id = 'app'");
    await recordExternalBuildState(db, observe({ now: 1795651200000 }));
    const res = await route(db)("raft-ios");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      version_name: "1.31.0",
      version_code: 13000003,
      external_build_state: "IN_BETA_TESTING",
      updated_at: 1795651200000,
    });
    // Nothing that identifies the build at Apple leaks.
    expect(JSON.stringify(body)).not.toContain("asc-b1");
  });

  it("answers no_external_build when nothing is stored", async () => {
    const { db, sql } = setup();
    sql.exec("UPDATE apps SET public_testflight_latest = 1 WHERE id = 'app'");
    const res = await route(db)("raft-ios");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "no external TestFlight build", code: "no_external_build" });
  });

  it("answers the same 404 for an unknown, archived, or not-opted-in app, even with a stored build", async () => {
    const { db, sql } = setup();
    await recordExternalBuildState(db, observe());
    const get = route(db);
    const notOptedIn = await get("raft-ios");
    expect(notOptedIn.status).toBe(404);
    const notOptedInBody = await notOptedIn.json();
    expect(notOptedInBody).toEqual({ error: "not found" });

    const unknown = await get("no-such-app");
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual(notOptedInBody);

    sql.exec("UPDATE apps SET public_testflight_latest = 1, archived = 1 WHERE id = 'app'");
    const archived = await get("raft-ios");
    expect(archived.status).toBe(404);
    expect(await archived.json()).toEqual(notOptedInBody);
  });
});

describe("apps API exposes public_testflight_latest", () => {
  it("PATCH writes the flag and GET / list read it back", async () => {
    const { db, sql } = setup();
    const app = new Hono<any>();
    app.patch("/api/apps/:appId", handleUpdateApp as any);
    app.get("/api/apps/:appId", handleGetApp as any);
    app.get("/api/apps", handleListApps as any);
    const env = { DB: db } as any;
    const read = async () => ((await (await app.request("/api/apps/app", {}, env)).json()) as any).public_testflight_latest;
    expect(await read()).toBe(0);

    const on = await app.request("/api/apps/app", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ public_testflight_latest: true }),
    }, env);
    expect(on.status).toBe(200);
    expect(await read()).toBe(1);
    const list = (await (await app.request("/api/apps", {}, env)).json()) as any;
    expect(list.apps.find((a: any) => a.id === "app").public_testflight_latest).toBe(1);
    // Independent of public_history: turning one on does not turn on the other.
    expect(sql.prepare("SELECT public_history FROM apps WHERE id='app'").pluck().get()).toBe(0);

    await app.request("/api/apps/app", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ public_testflight_latest: false }),
    }, env);
    expect(await read()).toBe(0);
  });
});
