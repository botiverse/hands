import Database from "better-sqlite3";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { handleListBuilds } from "../src/routes/builds";
import { googlePlayPackageOptions } from "../../admin/src/lib/googlePlayPackages";

describe("build list package discovery", () => {
  it.each([false, true])("feeds uploaded/inspected metadata to the Google Play dropdown (inspected=%s)", async (inspected) => {
    const db = new Database(":memory:");
    try {
      db.exec(`CREATE TABLE channels (id TEXT, slug TEXT);
        CREATE TABLE builds (
          id TEXT, app_id TEXT, channel_id TEXT, product_type TEXT, release_type TEXT,
          status TEXT, version_name TEXT, version_code INTEGER, changelog TEXT, source TEXT,
          should_force_update INTEGER, availability_at INTEGER, provenance_json TEXT,
          created_at INTEGER, updated_at INTEGER, completed_at INTEGER,
          build_metadata_json TEXT, parsed_metadata_json TEXT
        );
        INSERT INTO channels VALUES ('main-a', 'main');`);
      const parsed = inspected ? '{"package_id":"build.raft.app","version_code":10000980}' : "{}";
      const declared = '{"schema":"hands.android-release-artifacts.v1","package_name":"build.raft.app"}';
      for (const [id, owner] of [["build-a", "app-a"], ["build-other", "app-other"]]) {
        db.prepare(`INSERT INTO builds (id,app_id,channel_id,product_type,status,created_at,build_metadata_json,parsed_metadata_json)
          VALUES (?,?,'main-a','android-apk','succeeded',1,?,?)`).run(id, owner, declared, parsed);
      }
      const env = { DB: { prepare: (sql: string) => ({ bind: (...values: unknown[]) => ({
        all: async () => ({ results: db.prepare(sql.replace(/\?\d+/g, "?")).all(...values) }),
      }) }) } };
      const app = new Hono();
      app.get("/api/apps/:appId/builds", handleListBuilds);
      const res = await app.request("/api/apps/app-a/builds", undefined, env);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.builds).toHaveLength(1);
      expect(data.builds[0]).toMatchObject({ id: "build-a", build_metadata_json: declared, parsed_metadata_json: parsed });
      expect(googlePlayPackageOptions([{ id: "main-a", slug: "main", bundle_id: null }], data.builds)).toEqual([
        { packageName: "build.raft.app", source: inspected ? "parsed" : "declared", isMain: true },
      ]);
    } finally { db.close(); }
  });
});
