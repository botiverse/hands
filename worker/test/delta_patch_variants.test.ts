// Delta generation stores a gzip and an xz patch per source APK, side by
// side: neither variant's re-run may delete the other, and one failing keeps
// the other. Two source APKs of one version code get a patch each.
import Database from "better-sqlite3";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Reply = (compression: string) => Response;
const container = vi.hoisted(() => ({ reply: (() => new Response("unset", { status: 500 })) as (compression: string) => Response, calls: [] as string[], oldUrls: [] as string[] }));
vi.mock("@cloudflare/containers", () => ({
  Container: class {},
  getRandom: async () => ({
    fetch: async (request: Request) => {
      const body = (await request.json()) as { compression: string; old_url: string };
      container.calls.push(body.compression);
      container.oldUrls.push(body.old_url);
      return container.reply(body.compression);
    },
  }),
}));
const { createDeltaGenerationOp, runDeltaGeneration } = await import("../src/routes/delta");

const MIGRATION_DIR = fileURLToPath(new URL("../../migrations/sql/", import.meta.url));

function d1(db: Database.Database) {
  return {
    prepare: (sql: string) => {
      const indexes: number[] = [];
      const numbered = /\?\d+/.test(sql);
      const statement = db.prepare(numbered ? sql.replace(/\?(\d+)/g, (_m, i) => { indexes.push(Number(i)); return "?"; }) : sql);
      const bound = (params: unknown[]) => ({
        all: async () => ({ results: statement.reader ? statement.all(...params) : [] }),
        first: async () => (statement.reader ? statement.get(...params) ?? null : null),
        run: async () => { statement.run(...params); return { success: true }; },
      });
      return {
        bind: (...input: unknown[]) => bound(numbered ? indexes.map((i) => input[i - 1] ?? null) : input),
        ...bound([]),
      };
    },
  };
}

/** Stored APK hashes are 64 hex characters; the generator records nothing else. */
const H10 = "10".padStart(64, "a");
const U10 = "b".repeat(64);

function setup() {
  const db = new Database(":memory:");
  for (const name of readdirSync(MIGRATION_DIR).sort()) if (name.endsWith(".sql")) db.exec(readFileSync(`${MIGRATION_DIR}${name}`, "utf8"));
  db.prepare("INSERT INTO organizations (id, slug, name, external_provider, external_id, created_at) VALUES ('org','org','Org','raft','s',1)").run();
  db.prepare("INSERT INTO apps (id, org_id, slug, name, platform, created_at) VALUES ('app','org','raft-android','Raft','android',1)").run();
  db.prepare("INSERT INTO channels (id, app_id, slug, name, created_at) VALUES ('main','app','main','Main',1)").run();
  for (const [code, status] of [[10, "superseded"], [20, "active"]] as const) {
    db.prepare("INSERT INTO builds (id, app_id, version_name, version_code, created_at, updated_at) VALUES (?, 'app', ?, ?, 1, 1)").run(`b${code}`, String(code), code);
    db.prepare("INSERT INTO build_assets (id, build_id, artifact_kind, platform, arch, filetype, r2_key, file_hash, size_bytes, created_at) VALUES (?, ?, 'installable', 'android', 'arm64-v8a', 'apk', ?, ?, 1000, 1)")
      .run(`a${code}`, `b${code}`, `apk/${code}`, String(code).padStart(64, "a"));
    db.prepare("INSERT INTO releases (id, app_id, build_id, channel_id, product_type, release_type, status, created_by, created_at, updated_at) VALUES (?, 'app', ?, 'main', 'app', 'stable', ?, 't', 1, 1)")
      .run(`r${code}`, `b${code}`, status);
  }
  const puts = new Map<string, number>();
  const env = {
    DB: d1(db),
    APK_BUCKET: { put: async (key: string, bytes: ArrayBuffer) => { puts.set(key, bytes.byteLength); } },
    APK_PARSER: {},
    SIGNED_URL_SECRET: "test-secret",
  } as unknown as Env;
  const params = { appId: "app", buildId: "b20", actor: "test", keep: 1, origin: "https://hands.test" };
  const generate = async () => runDeltaGeneration(env, await createDeltaGenerationOp(env, params), params);
  const patches = () =>
    db.prepare(
      `SELECT r2_key, filetype, size_bytes, json_extract(metadata_json, '$.algorithm') AS algorithm,
              json_extract(metadata_json, '$.from_version_code') AS from_version_code
       FROM build_assets WHERE build_id = 'b20' AND artifact_kind = 'delta-patch' ORDER BY algorithm, r2_key`,
    ).all() as Array<{ r2_key: string; filetype: string; size_bytes: number; algorithm: string; from_version_code: number }>;
  const sources = () =>
    db.prepare(
      `SELECT json_extract(metadata_json, '$.algorithm') AS algorithm,
              json_extract(metadata_json, '$.from_sha256') AS from_sha256,
              json_extract(metadata_json, '$.from_arch') AS from_arch,
              json_type(metadata_json, '$.from_arch') AS from_arch_type,
              size_bytes
       FROM build_assets WHERE build_id = 'b20' AND artifact_kind = 'delta-patch' ORDER BY algorithm, from_sha256`,
    ).all() as Array<{ algorithm: string; from_sha256: string | null; from_arch: string | null; from_arch_type: string | null; size_bytes: number }>;
  return { db, generate, patches, sources, puts };
}

const sized = (sizes: Record<string, number>): Reply => (compression) =>
  sizes[compression] === undefined
    ? new Response("xz: not found", { status: 500 })
    : new Response(new Uint8Array(sizes[compression]!));

describe("delta patch variants", () => {
  beforeEach(() => {
    container.calls = [];
    container.oldUrls = [];
  });

  it("stores a gzip and an xz patch with their own keys and algorithms", async () => {
    const { generate, patches, puts } = setup();
    container.reply = sized({ gzip: 300, xz: 200 });
    const outcome = await generate();
    expect(container.calls).toEqual(["gzip", "xz"]);
    expect(outcome.results).toEqual([
      expect.objectContaining({ from_version_code: 10, algorithm: "archive-patcher-v1+gzip", status: "ok", size_bytes: 300 }),
      expect.objectContaining({ from_version_code: 10, algorithm: "archive-patcher-v1+xz", status: "ok", size_bytes: 200 }),
    ]);
    expect(patches()).toEqual([
      { r2_key: "delta/app/20/from-10-aaaaaaaaaaaaaaaa-arm64-v8a.patch", filetype: "patch", size_bytes: 300, algorithm: "archive-patcher-v1+gzip", from_version_code: 10 },
      { r2_key: "delta/app/20/from-10-aaaaaaaaaaaaaaaa-arm64-v8a.patch.xz", filetype: "patch.xz", size_bytes: 200, algorithm: "archive-patcher-v1+xz", from_version_code: 10 },
    ]);
    expect([...puts.keys()].sort()).toEqual(["delta/app/20/from-10-aaaaaaaaaaaaaaaa-arm64-v8a.patch", "delta/app/20/from-10-aaaaaaaaaaaaaaaa-arm64-v8a.patch.xz"]);

    // A re-run replaces each variant in place instead of clobbering the other.
    container.reply = sized({ gzip: 310, xz: 210 });
    await generate();
    expect(patches().map((p) => [p.algorithm, p.size_bytes])).toEqual([
      ["archive-patcher-v1+gzip", 310],
      ["archive-patcher-v1+xz", 210],
    ]);
  });

  it("keeps the gzip patch when the xz variant fails, and records each result", async () => {
    const { generate, patches } = setup();
    container.reply = sized({ gzip: 300 });
    const outcome = await generate();
    expect(outcome.error).toBeUndefined();
    expect(outcome.results).toEqual([
      expect.objectContaining({ algorithm: "archive-patcher-v1+gzip", status: "ok" }),
      expect.objectContaining({ algorithm: "archive-patcher-v1+xz", status: "fail:container-500" }),
    ]);
    expect(patches().map((p) => p.algorithm)).toEqual(["archive-patcher-v1+gzip"]);

    // A later successful xz run adds xz without touching gzip.
    container.reply = sized({ xz: 200 });
    await generate();
    expect(patches().map((p) => [p.algorithm, p.size_bytes])).toEqual([
      ["archive-patcher-v1+gzip", 300],
      ["archive-patcher-v1+xz", 200],
    ]);
  });

  it("stores a patch from each APK of a version code, recording the source, under distinct keys", async () => {
    const { db, generate, sources, puts } = setup();
    // Version 10 also shipped as a universal APK (another asset of the same build).
    db.prepare("INSERT INTO build_assets (id, build_id, artifact_kind, platform, arch, filetype, r2_key, file_hash, size_bytes, created_at) VALUES ('a10u', 'b10', 'installable', 'android', NULL, 'apk', 'apk/10u', 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB', 1100, 1)").run();
    container.reply = sized({ gzip: 300, xz: 200 });
    const outcome = await generate();
    // Exact arch first, then the universal APK.
    expect(container.oldUrls.map((url) => decodeURIComponent(url).includes("apk/10u") ? "universal" : "arm64")).toEqual(["arm64", "arm64", "universal", "universal"]);
    expect(outcome.results.map((r) => [r.from_version_code, r.from_sha256, r.from_arch, r.algorithm, r.status])).toEqual([
      [10, H10, "arm64-v8a", "archive-patcher-v1+gzip", "ok"],
      [10, H10, "arm64-v8a", "archive-patcher-v1+xz", "ok"],
      [10, U10, null, "archive-patcher-v1+gzip", "ok"],
      [10, U10, null, "archive-patcher-v1+xz", "ok"],
    ]);
    expect(sources()).toEqual([
      { algorithm: "archive-patcher-v1+gzip", from_sha256: H10, from_arch: "arm64-v8a", from_arch_type: "text", size_bytes: 300 },
      { algorithm: "archive-patcher-v1+gzip", from_sha256: U10, from_arch: null, from_arch_type: "null", size_bytes: 300 },
      { algorithm: "archive-patcher-v1+xz", from_sha256: H10, from_arch: "arm64-v8a", from_arch_type: "text", size_bytes: 200 },
      { algorithm: "archive-patcher-v1+xz", from_sha256: U10, from_arch: null, from_arch_type: "null", size_bytes: 200 },
    ]);
    expect(puts.size).toBe(4);

    // A re-run replaces each source's patch in place, keeping the other source's.
    container.reply = sized({ gzip: 310, xz: 210 });
    await generate();
    expect(sources().map((p) => [p.algorithm, p.from_sha256, p.size_bytes])).toEqual([
      ["archive-patcher-v1+gzip", H10, 310],
      ["archive-patcher-v1+gzip", U10, 310],
      ["archive-patcher-v1+xz", H10, 210],
      ["archive-patcher-v1+xz", U10, 210],
    ]);
  });

  it("replaces a patch stored before patches recorded their source", async () => {
    const { db, generate, sources } = setup();
    db.prepare(
      `INSERT INTO build_assets (id, build_id, artifact_kind, platform, arch, filetype, r2_key, file_hash, size_bytes, metadata_json, created_at)
       VALUES ('legacy', 'b20', 'delta-patch', 'android', 'arm64-v8a', 'patch', 'delta/app/20/from-10-arm64-v8a.patch', 'p', 999, ?, 1)`,
    ).run(JSON.stringify({ from_version_code: 10, to_version_code: 20, algorithm: "archive-patcher-v1+gzip", target_sha256: "h20" }));
    container.reply = sized({ gzip: 300, xz: 200 });
    await generate();
    expect(sources().map((p) => [p.algorithm, p.from_sha256, p.size_bytes])).toEqual([
      ["archive-patcher-v1+gzip", H10, 300],
      ["archive-patcher-v1+xz", H10, 200],
    ]);
  });

  it("keeps a patch stored before patches recorded their source when only another APK's patch succeeds", async () => {
    const { db, generate, sources } = setup();
    db.prepare("INSERT INTO build_assets (id, build_id, artifact_kind, platform, arch, filetype, r2_key, file_hash, size_bytes, created_at) VALUES ('a10u', 'b10', 'installable', 'android', NULL, 'apk', 'apk/10u', ?, 1100, 1)").run(U10);
    db.prepare(
      `INSERT INTO build_assets (id, build_id, artifact_kind, platform, arch, filetype, r2_key, file_hash, size_bytes, metadata_json, created_at)
       VALUES ('legacy', 'b20', 'delta-patch', 'android', 'arm64-v8a', 'patch', 'delta/app/20/from-10-arm64-v8a.patch', 'p', 999, ?, 1)`,
    ).run(JSON.stringify({ from_version_code: 10, to_version_code: 20, algorithm: "archive-patcher-v1+gzip", target_sha256: "h20" }));
    // The arm64-v8a APK (the one the legacy patch was made from) fails; the universal one succeeds.
    const ok = sized({ gzip: 300, xz: 200 });
    container.reply = (compression) =>
      decodeURIComponent(container.oldUrls.at(-1) ?? "").includes("apk/10u") ? ok(compression) : new Response("boom", { status: 500 });
    await generate();
    expect(sources().map((p) => [p.algorithm, p.from_sha256, p.size_bytes])).toEqual([
      ["archive-patcher-v1+gzip", null, 999],
      ["archive-patcher-v1+gzip", U10, 300],
      ["archive-patcher-v1+xz", U10, 200],
    ]);
  });
});

describe("delta patch canonical slot (migration 0125)", () => {
  it("admits two patches of one from-version that differ only in their source, and no duplicate source", () => {
    const { db } = setup();
    const insert = (id: string, metadata: Record<string, unknown>, kind = "delta-patch") =>
      db.prepare(
        `INSERT INTO build_assets (id, build_id, artifact_kind, platform, arch, filetype, r2_key, file_hash, size_bytes, metadata_json, created_at)
         VALUES (?, 'b20', ?, 'android', 'arm64-v8a', 'patch', ?, 'p', 1, ?, 1)`,
      ).run(id, kind, `k/${id}`, JSON.stringify(metadata));
    insert("legacy", { from_version_code: 10 });
    insert("from-arm", { from_version_code: 10, from_sha256: "aa" });
    insert("from-universal", { from_version_code: 10, from_sha256: "bb" });
    // The same source twice is still one slot, case-insensitively, as the reader compares it.
    expect(() => insert("dup", { from_version_code: 10, from_sha256: "AA" })).toThrow(/UNIQUE/);
    expect(() => insert("legacy-dup", { from_version_code: 10 })).toThrow(/UNIQUE/);
    // Only delta patches are told apart by from_sha256.
    insert("sym", { from_sha256: "aa" }, "native-symbols");
    expect(() => insert("sym2", { from_sha256: "bb" }, "native-symbols")).toThrow(/UNIQUE/);
  });
});
