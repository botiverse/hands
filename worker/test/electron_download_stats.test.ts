/**
 * Request counting on the public Electron update route, against the real
 * migration chain: whole-file vs Range requests, distinct requesters, file
 * roles, and the stats endpoint that reads them back.
 */
import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { handleElectronGenericAsset } from "../src/routes/electron";
import { handleElectronDownloadStats } from "../src/routes/electron_download_stats";
import { electronFileRole, recordElectronRequest } from "../src/lib/electron_download_stats";

const migrationDir = fileURLToPath(new URL("../../migrations/sql/", import.meta.url));

function d1(sqlite: Database.Database): D1Database {
  const prepare = (sql: string) => {
    const indexes: number[] = [];
    const statement = sqlite.prepare(sql.replace(/\?(\d+)/g, (_m, index) => { indexes.push(Number(index)); return "?"; }));
    const bind = (...parameters: unknown[]) => {
      const expanded = indexes.length ? indexes.map((index) => parameters[index - 1]) : parameters;
      const run = () => ({ success: true, meta: { changes: statement.reader ? 0 : statement.run(...expanded).changes } });
      return {
        exec: run,
        run: async () => run(),
        all: async () => ({ success: true, results: statement.all(...expanded) }),
        first: async (column?: string) => {
          const row = statement.get(...expanded) as Record<string, unknown> | undefined;
          return column ? row?.[column] ?? null : row ?? null;
        },
      };
    };
    return { bind, run: () => bind().run(), all: () => bind().all(), first: () => bind().first() };
  };
  const batch = async (statements: Array<{ exec: () => unknown }>) => sqlite.transaction(() => statements.map((s) => s.exec()))();
  return { prepare, batch } as unknown as D1Database;
}

const FILES = {
  "Raft-1.42.0-arm64.zip": { id: "a-zip", filetype: "zip", kind: "installable" },
  "Raft-1.42.0-arm64-from-1.40.0.patch": { id: "a-patch", filetype: "patch", kind: "installable" },
  "Raft-1.42.0-arm64.zip.blockmap": { id: "a-blockmap", filetype: "blockmap", kind: "installable" },
  "latest-mac.yml": { id: "a-yml", filetype: "yml", kind: "electron-metadata" },
} as const;

function setup() {
  const sqlite = new Database(":memory:");
  for (const name of readdirSync(migrationDir).sort()) {
    if (name.endsWith(".sql")) sqlite.exec(readFileSync(migrationDir + name, "utf8"));
  }
  sqlite.exec(`
    INSERT INTO apps (id, slug, name, platform, created_at) VALUES ('app', 'raft-desktop', 'Raft', 'electron', 1);
    INSERT INTO channels (id, app_id, slug, name, created_at) VALUES ('ch', 'app', 'main', 'Main', 1);
    INSERT INTO builds (id, app_id, channel_id, product_type, version_name, version_code, status, created_at, updated_at)
      VALUES ('b1', 'app', 'ch', 'desktop-installer', '1.42.0', 142, 'succeeded', 1, 1);
    INSERT INTO releases (id, app_id, channel_id, build_id, product_type, release_type, status, created_by, activated_at, created_at, updated_at)
      VALUES ('r1', 'app', 'ch', 'b1', 'desktop-installer', 'stable', 'active', 'test', 1, 1, 1);
  `);
  const insertAsset = sqlite.prepare(
    `INSERT INTO build_assets (id, build_id, platform, arch, filetype, r2_key, file_hash, size_bytes, created_at, artifact_kind, variant, metadata_json)
     VALUES (?, 'b1', 'darwin', 'arm64', ?, ?, 'h', 1000, 1, ?, NULL, '{}')`,
  );
  for (const [name, a] of Object.entries(FILES)) insertAsset.run(a.id, a.filetype, `apps/app/b1/${name}`, a.kind);

  const env = {
    DB: d1(sqlite),
    SHARE_STATS_SALT: "salt",
    APK_BUCKET: {
      get: async () => ({
        body: new Uint8Array(1000),
        httpEtag: '"e"',
        writeHttpMetadata: () => {},
      }),
    },
  };
  const app = new Hono<{ Bindings: any }>();
  app.get("/electron/:slug/:channel/:file", handleElectronGenericAsset as any);
  app.get("/api/apps/:appId/stats/electron-downloads", handleElectronDownloadStats as any);
  const get = (file: string, headers: Record<string, string> = {}) =>
    app.request(`/electron/raft-desktop/main/${encodeURIComponent(file)}`, { headers }, env as any);
  return { sqlite, app, env, get };
}

const client = (ip: string) => ({ "cf-connecting-ip": ip, "user-agent": "electron-updater" });

describe("electron download stats", () => {
  it("classifies files by role", () => {
    expect(electronFileRole({ filetype: "patch" }, "x-from-1.0.0.patch", false)).toBe("patch");
    expect(electronFileRole({ filetype: "zip" }, "x.zip", false)).toBe("full");
    expect(electronFileRole({ filetype: "dmg" }, "x.dmg", false)).toBe("full");
    expect(electronFileRole({ filetype: "blockmap" }, "x.zip.blockmap", false)).toBe("blockmap");
    expect(electronFileRole({ filetype: "yml" }, "latest-mac.yml", true)).toBe("metadata");
  });

  it("counts whole-file and Range requests apart, and distinct requesters per file", async () => {
    const h = setup();
    // Client A: differential download (blockmap, then two ranges of the zip).
    expect((await h.get("latest-mac.yml", client("1.1.1.1"))).status).toBe(200);
    expect((await h.get("Raft-1.42.0-arm64.zip.blockmap", client("1.1.1.1"))).status).toBe(200);
    expect((await h.get("Raft-1.42.0-arm64.zip", { ...client("1.1.1.1"), range: "bytes=0-99" })).status).toBe(206);
    expect((await h.get("Raft-1.42.0-arm64.zip", { ...client("1.1.1.1"), range: "bytes=200-299" })).status).toBe(206);
    // Client B: full archive. Clients C and D: patch (D twice).
    await h.get("Raft-1.42.0-arm64.zip", client("2.2.2.2"));
    await h.get("Raft-1.42.0-arm64-from-1.40.0.patch", client("3.3.3.3"));
    await h.get("Raft-1.42.0-arm64-from-1.40.0.patch", client("4.4.4.4"));
    await h.get("Raft-1.42.0-arm64-from-1.40.0.patch", client("4.4.4.4"));
    // HEAD and unknown files are not counted.
    await h.app.request("/electron/raft-desktop/main/Raft-1.42.0-arm64.zip", { method: "HEAD" }, h.env as any);
    expect((await h.get("nope.zip", client("5.5.5.5"))).status).toBe(404);

    const res = await h.app.request("/api/apps/app/stats/electron-downloads?days=1", {}, h.env as any);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    const file = (name: string) => body.files.find((f: any) => f.file === name);
    expect(file("Raft-1.42.0-arm64.zip")).toMatchObject({ role: "full", version: "1.42.0", full_requests: 1, range_requests: 2, sources: 2 });
    expect(file("Raft-1.42.0-arm64-from-1.40.0.patch")).toMatchObject({ role: "patch", full_requests: 3, range_requests: 0, sources: 2 });
    expect(file("Raft-1.42.0-arm64.zip.blockmap")).toMatchObject({ role: "blockmap", full_requests: 1, sources: 1 });
    expect(file("latest-mac.yml")).toMatchObject({ role: "metadata", full_requests: 1, sources: 1 });
    expect(body.files).toHaveLength(4);
    const role = (r: string) => body.by_role.find((x: any) => x.role === r);
    expect(role("patch")).toMatchObject({ full_requests: 3, range_requests: 0, sources: 2 });
    expect(role("full")).toMatchObject({ full_requests: 1, range_requests: 2, sources: 2 });
  });

  it("does not store raw addresses", async () => {
    const h = setup();
    await h.get("Raft-1.42.0-arm64.zip", client("9.8.7.6"));
    const dump = JSON.stringify(h.sqlite.prepare("SELECT * FROM electron_download_day_sources").all());
    expect(dump).not.toContain("9.8.7.6");
    expect(dump).toMatch(/[0-9a-f]{64}/);
  });

  it("hashes the same client differently on different days", async () => {
    const h = setup();
    const c = { env: h.env, req: { header: (n: string) => (client("9.8.7.6") as Record<string, string>)[n] } } as any;
    const req = { appId: "app", buildId: "b1", assetId: "a-zip", file: "f.zip", role: "full" as const, ranged: false };
    await recordElectronRequest(c, req, Date.UTC(2026, 10, 1, 12));
    await recordElectronRequest(c, req, Date.UTC(2026, 10, 2, 12));
    const hashes = h.sqlite.prepare("SELECT source_hash FROM electron_download_day_sources ORDER BY day").all() as Array<{ source_hash: string }>;
    expect(hashes).toHaveLength(2);
    expect(hashes[0]?.source_hash).not.toBe(hashes[1]?.source_hash);
  });

  it("rejects an out-of-range window", async () => {
    const h = setup();
    expect((await h.app.request("/api/apps/app/stats/electron-downloads?days=0", {}, h.env as any)).status).toBe(400);
    expect((await h.app.request("/api/apps/app/stats/electron-downloads?days=91", {}, h.env as any)).status).toBe(400);
  });
});
