// Patch sources follow what a channel's devices actually run, not only the
// nearest version codes (which, with previews, are builds main never had).
import Database from "better-sqlite3";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

vi.mock("@cloudflare/containers", () => ({ Container: class {}, getRandom: () => { throw new Error("unused"); } }));
const { selectPatchSources, handleDeltaSources, MAX_SOURCE_APKS_PER_VERSION } = await import("../src/routes/delta");

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
  /**
   * Another APK of an existing version code: a second asset of the same build, or
   * a second build. A channel releases a version code once, so a second build of
   * it is released on another channel (preview by default).
   */
  const apk = (id: string, code: number, arch: string | null, opts: { build?: string; channel?: string } = {}) => {
    const build = opts.build ?? `b${code}`;
    if (build !== `b${code}`) {
      db.prepare("INSERT INTO builds (id, app_id, version_name, version_code, created_at, updated_at) VALUES (?, 'app', ?, ?, 1, 1)").run(build, String(code), code);
      db.prepare("INSERT INTO releases (id, app_id, build_id, channel_id, product_type, release_type, status, created_by, created_at, updated_at) VALUES (?, 'app', ?, ?, 'app', 'stable', 'superseded', 't', 1, 1)")
        .run(`r-${build}`, build, opts.channel ?? "preview");
    }
    db.prepare("INSERT INTO build_assets (id, build_id, artifact_kind, platform, arch, filetype, r2_key, file_hash, size_bytes, created_at) VALUES (?, ?, 'installable', 'android', ?, 'apk', ?, ?, 100, 1)")
      .run(id, build, arch, `apk/${id}`, `h${id}`);
  };
  return { db, release, devices, apk };
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
    expect(fromNoArch.map((s) => [s.version_code, s.arch])).toEqual([[111, "universal"], [110, "universal"], [109, "arm64-v8a"]]);
    const fromUniversal = await selectPatchSources(d1(db) as never, "app", { ...target(112), arch: "universal" }, 3, NOW, ["main"]);
    expect(fromUniversal).toEqual(fromNoArch);
    // An arm64-v8a target sees the `universal` APKs as universal sources too.
    const fromArm = await selectPatchSources(d1(db) as never, "app", { ...target(112), arch: "arm64-v8a" }, 3, NOW, ["main"]);
    expect(fromArm.map((s) => [s.version_code, s.arch])).toEqual([[111, "universal"], [110, "universal"], [109, "arm64-v8a"]]);
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
    // A version with both a universal and an arm64 APK yields both, the arm64 one first:
    // a device may run either.
    db.prepare("INSERT INTO build_assets (id, build_id, artifact_kind, platform, arch, filetype, r2_key, file_hash, size_bytes, created_at) VALUES ('a130arm', 'b130', 'installable', 'android', 'arm64-v8a', 'apk', 'apk/130arm', 'h130arm', 90, 1)").run();
    const preferred = await selectPatchSources(d1(db) as never, "app", { ...target(131), arch: "arm64-v8a" }, 1, NOW, ["main"]);
    expect(preferred.slice(0, 2).map((s) => [s.version_code, s.arch, s.r2_key])).toEqual([
      [130, "arm64-v8a", "apk/130arm"],
      [130, "universal", "apk/130"],
    ]);
    // A universal target takes sources of every ABI (a device on an arm64-v8a or
    // x86_64 APK can move to the universal one), its own arch first per version.
    const universal = await selectPatchSources(d1(db) as never, "app", target(131), 3, NOW, ["main"]);
    expect(universal.map((s) => [s.version_code, s.arch])).toEqual([
      [130, "universal"], [130, "arm64-v8a"], [129, null], [128, "arm64-v8a"], [127, "x86_64"],
    ]);
  });

  it("never patches an ABI-specific target from a different ABI", async () => {
    const { db, release, apk } = setup();
    release(200, "main", "superseded", "x86_64");
    release(201, "main", "active", "arm64-v8a");
    apk("a201x86", 201, "x86_64");
    const x86 = await selectPatchSources(d1(db) as never, "app", { ...target(202), arch: "x86_64" }, 3, NOW, ["main"]);
    expect(x86.map((s) => [s.version_code, s.arch])).toEqual([[201, "x86_64"], [200, "x86_64"]]);
    const arm = await selectPatchSources(d1(db) as never, "app", { ...target(202), arch: "arm64-v8a" }, 3, NOW, ["main"]);
    expect(arm.map((s) => [s.version_code, s.arch])).toEqual([[201, "arm64-v8a"]]);
  });

  it("keeps every APK of a version code shipped by two builds, and counts `keep` in versions", async () => {
    // Raft Android published 1.40 twice: a universal build and an arm64-v8a build
    // with the same version code (on different channels). Devices on either need
    // a patch.
    const { db, release, devices, apk } = setup();
    release(139, "main", "superseded");
    release(140, "main", "active");
    apk("a140arm", 140, "arm64-v8a", { build: "b140arm" });
    release(141, "main", "superseded");
    devices(140, "main", 30);
    const sources = await selectPatchSources(d1(db) as never, "app", { ...target(142), arch: "arm64-v8a" }, 1, NOW, ["main"]);
    // keep = 1 version from activity (140, both APKs) + the nearest one (141).
    expect(sources.map((s) => [s.version_code, s.arch, s.build_id])).toEqual([
      [140, "arm64-v8a", "b140arm"],
      [140, null, "b140"],
      [141, null, "b141"],
    ]);
  });

  it("lists an APK released on two channels once", async () => {
    const { db, release } = setup();
    release(300, "main", "superseded");
    release(300, "preview", "superseded");
    release(301, "main", "active");
    const sources = await selectPatchSources(d1(db) as never, "app", target(302), 5, NOW, ["main"]);
    expect(sources.map((s) => s.r2_key)).toEqual(["apk/301", "apk/300"]);
  });

  it("keeps at most 3 distinct APKs per version code, exact arch first", async () => {
    expect(MAX_SOURCE_APKS_PER_VERSION).toBe(3);
    const { db, release, apk } = setup();
    release(400, "main", "active", "x86_64");
    apk("a400arm", 400, "arm64-v8a");
    apk("a400armv7", 400, "armeabi-v7a");
    apk("a400uni", 400, null, { build: "b400uni" });
    db.prepare("INSERT INTO build_assets (id, build_id, artifact_kind, platform, arch, filetype, r2_key, file_hash, size_bytes, created_at) VALUES ('a400x86', 'b400uni', 'installable', 'android', 'x86', 'apk', 'apk/a400x86', 'ha400x86', 100, 1)").run();
    const universal = await selectPatchSources(d1(db) as never, "app", target(401), 3, NOW, ["main"]);
    expect(universal).toHaveLength(3);
    expect(universal[0]).toMatchObject({ version_code: 400, arch: null, r2_key: "apk/a400uni" });
    expect(new Set(universal.map((s) => s.file_hash)).size).toBe(3);
  });

  it("delta-sources returns every source APK of the last N version codes with arch and sha256", async () => {
    const { db, release, apk } = setup();
    for (const code of [500, 501]) release(code, "main", "superseded");
    release(502, "main", "active", "arm64-v8a");
    apk("a502uni", 502, null, { build: "b502uni" });
    apk("a501arm", 501, "arm64-v8a");
    const sources = async (query: Record<string, string>) => {
      const c = {
        env: { DB: d1(db), SIGNED_URL_SECRET: "test-secret" },
        req: {
          url: "https://hands.test/api/apps/app/delta-sources",
          param: () => "app",
          query: (name: string) => ({ before: "503", limit: "2", ...query } as Record<string, string>)[name],
          header: () => undefined,
        },
        json: (data: unknown, status = 200) => Response.json(data, { status }),
      };
      const res = await handleDeltaSources(c as never);
      return (await res.json()) as { arch: string | null; sources: Array<{ from_version_code: number; arch: string | null; sha256: string; url: string }> };
    };
    const body = await sources({ per_version: "3" });
    expect(body.arch).toBeNull();
    // A universal target: both APKs of 502 and of 501, universal first; 500 is past the limit.
    expect(body.sources.map((s) => [s.from_version_code, s.arch, s.sha256])).toEqual([
      [502, null, "ha502uni"],
      [502, "arm64-v8a", "h502"],
      [501, null, "h501"],
      [501, "arm64-v8a", "ha501arm"],
    ]);
    expect(body.sources[0]!.url).toContain("https://hands.test/");
    // A CLI that does not ask for more gets one APK per version: it names its
    // work files and patches by version code alone.
    expect((await sources({})).sources.map((s) => [s.from_version_code, s.arch])).toEqual([[502, null], [501, null]]);
    expect((await sources({ per_version: "9" })).sources).toHaveLength(4);
  });
});
