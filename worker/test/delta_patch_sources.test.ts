// Patch sources follow what a channel's devices actually run, not only the
// nearest version codes (which, with previews, are builds main never had).
import Database from "better-sqlite3";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

vi.mock("@cloudflare/containers", () => ({ Container: class {}, getRandom: () => { throw new Error("unused"); } }));
const { selectPatchSources } = await import("../src/routes/delta");

const MIGRATION_DIR = fileURLToPath(new URL("../../migrations/sql/", import.meta.url));
const NOW = 1_800_000_000_000;
const DAY = 86_400_000;

function d1(db: Database.Database) {
  return {
    prepare: (sql: string) => {
      const indexes: number[] = [];
      const statement = db.prepare(sql.replace(/\?(\d+)/g, (_m, i) => { indexes.push(Number(i)); return "?"; }));
      return {
        bind: (...input: unknown[]) => {
          const params = indexes.map((i) => input[i - 1] ?? null);
          return { all: async () => ({ results: statement.all(...params) }) };
        },
      };
    },
  };
}

function setup() {
  const db = new Database(":memory:");
  for (const name of readdirSync(MIGRATION_DIR).sort()) if (name.endsWith(".sql")) db.exec(readFileSync(`${MIGRATION_DIR}${name}`, "utf8"));
  db.prepare("INSERT INTO organizations (id, slug, name, external_provider, external_id, created_at) VALUES ('org','org','Org','raft','s',1)").run();
  db.prepare("INSERT INTO apps (id, org_id, slug, name, platform, created_at) VALUES ('app','org','raft-android','Raft','android',1)").run();
  db.prepare("INSERT INTO channels (id, app_id, slug, name, created_at) VALUES ('main','app','main','Main',1), ('preview','app','preview','Preview',1)").run();
  const release = (code: number, channel: string, status: string, arch: string | null = null) => {
    const build = `b${code}`;
    db.prepare("INSERT OR IGNORE INTO builds (id, app_id, version_name, version_code, created_at, updated_at) VALUES (?, 'app', ?, ?, 1, 1)").run(build, String(code), code);
    db.prepare("INSERT OR IGNORE INTO build_assets (id, build_id, artifact_kind, platform, arch, filetype, r2_key, file_hash, size_bytes, created_at) VALUES (?, ?, 'installable', 'android', ?, 'apk', ?, ?, 100, 1)")
      .run(`a${code}`, build, arch, `apk/${code}`, `h${code}`);
    db.prepare("INSERT INTO releases (id, app_id, build_id, channel_id, product_type, release_type, status, created_by, created_at, updated_at) VALUES (?, 'app', ?, ?, 'app', 'stable', ?, 't', 1, 1)")
      .run(`r${code}-${channel}`, build, channel, status);
  };
  const devices = (code: number, channel: string, count: number, lastSeen = NOW - DAY) => {
    for (let i = 0; i < count; i += 1) {
      db.prepare("INSERT INTO device_pings (app_id, device_id, version_code, channel, first_seen, last_seen) VALUES ('app', ?, ?, ?, 1, ?)")
        .run(`d${code}-${channel}-${i}`, code, channel, lastSeen);
    }
  };
  return { db, release, devices };
}

const target = (code: number) => ({ build_id: `b${code}`, version_code: code, arch: null, r2_key: `apk/${code}`, file_hash: `h${code}`, size_bytes: 100 });

describe("delta patch sources", () => {
  it("builds main's patches from the versions main's devices run, not from the previews just below", async () => {
    const { db, release, devices } = setup();
    for (const code of [126, 127, 128]) release(code, "main", "superseded");
    for (const code of [1291, 1294, 1297]) release(code, "preview", "superseded");
    release(1299, "main", "active");
    devices(126, "main", 48);
    devices(127, "main", 31);
    devices(128, "main", 26);
    devices(1297, "preview", 9);
    devices(125, "main", 40, NOW - 60 * DAY); // inactive for two months
    const sources = await selectPatchSources(d1(db) as never, "app", target(1299), 3, NOW);
    const codes = sources.map((s) => s.version_code);
    expect(codes.slice(0, 3)).toEqual([126, 127, 128]);
    expect(codes).not.toContain(125);
    expect(sources[0]).toEqual({ build_id: "b126", version_code: 126, arch: null, r2_key: "apk/126", file_hash: "h126", size_bytes: 100 });
  });

  it("uses the given channel for a build that has no release yet", async () => {
    // CI generates patches before the build is released. A 1.30 preview build
    // must diff against 1.29 on preview, not the 1.30 alphas just below it.
    const { db, release, devices } = setup();
    db.prepare("INSERT INTO channels (id, app_id, slug, name, created_at) VALUES ('alpha','app','alpha','Alpha',1)").run();
    release(12900010, "preview", "active");
    for (const code of [13000002, 13000003, 13000004]) release(code, "alpha", "superseded");
    devices(12900007, "preview", 2);
    release(12900007, "preview", "superseded");
    devices(13000004, "alpha", 5);
    const preview = await selectPatchSources(d1(db) as never, "app", target(13000005), 1, NOW, ["preview"]);
    expect(preview.map((s) => s.version_code)).toEqual([12900007, 12900010]);
    // Without a channel and with no release, the nearest earlier versions stand in.
    const none = await selectPatchSources(d1(db) as never, "app", target(13000005), 1, NOW);
    expect(none.map((s) => s.version_code)).toEqual([13000004, 13000003]);
  });

  it("falls back to the nearest earlier releases when no device has reported", async () => {
    const { db, release } = setup();
    for (const code of [10, 11, 12, 13]) release(code, "main", "superseded");
    release(14, "main", "active");
    const sources = await selectPatchSources(d1(db) as never, "app", target(14), 3, NOW);
    expect(sources.map((s) => s.version_code)).toEqual([13, 12, 11, 10]);
  });

  it("matches a universal APK stored with the literal arch `universal` to one stored with no arch", async () => {
    const { db, release } = setup();
    release(110, "main", "superseded", "universal");
    release(111, "main", "active", "universal");
    release(109, "main", "superseded", "arm64-v8a");
    const fromNoArch = await selectPatchSources(d1(db) as never, "app", target(112), 3, NOW, ["main"]);
    expect(fromNoArch.map((s) => s.version_code)).toEqual([111, 110]);
    const fromUniversal = await selectPatchSources(d1(db) as never, "app", { ...target(112), arch: "universal" }, 3, NOW, ["main"]);
    expect(fromUniversal.map((s) => s.version_code)).toEqual([111, 110]);
  });
  it("lets an arm64-v8a build patch from universal releases, preferring the same arch per version", async () => {
    // 1.29/1.30 shipped universal APKs; 1.31 ships arm64-v8a only. Devices on
    // 1.30 must still get a patch.
    const { db, release, devices } = setup();
    release(128, "main", "superseded", "arm64-v8a");
    release(129, "main", "superseded");
    release(130, "main", "active", "universal");
    release(127, "main", "superseded", "x86_64");
    devices(130, "main", 20);
    devices(129, "main", 10);
    const arm = await selectPatchSources(d1(db) as never, "app", { ...target(131), arch: "arm64-v8a" }, 3, NOW, ["main"]);
    expect(arm.map((s) => [s.version_code, s.arch])).toEqual([[130, "universal"], [129, null], [128, "arm64-v8a"]]);
    // A version with both a universal and an arm64 APK yields the arm64 one.
    db.prepare("INSERT INTO build_assets (id, build_id, artifact_kind, platform, arch, filetype, r2_key, file_hash, size_bytes, created_at) VALUES ('a130arm', 'b130', 'installable', 'android', 'arm64-v8a', 'apk', 'apk/130arm', 'h130arm', 90, 1)").run();
    const preferred = await selectPatchSources(d1(db) as never, "app", { ...target(131), arch: "arm64-v8a" }, 1, NOW, ["main"]);
    expect(preferred[0]).toMatchObject({ version_code: 130, arch: "arm64-v8a", r2_key: "apk/130arm" });
    // A universal target still takes universal sources only.
    const universal = await selectPatchSources(d1(db) as never, "app", target(131), 3, NOW, ["main"]);
    expect(universal.map((s) => s.version_code)).toEqual([130, 129]);
    expect(universal[0]?.arch).toBe("universal");
  });
});
