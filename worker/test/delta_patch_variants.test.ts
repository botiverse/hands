// Delta generation stores a gzip and an xz patch per prior version, side by
// side: neither variant's re-run may delete the other, and one failing keeps
// the other.
import Database from "better-sqlite3";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Reply = (compression: string) => Response;
const container = vi.hoisted(() => ({ reply: (() => new Response("unset", { status: 500 })) as (compression: string) => Response, calls: [] as string[] }));
vi.mock("@cloudflare/containers", () => ({
  Container: class {},
  getRandom: async () => ({
    fetch: async (request: Request) => {
      const body = (await request.json()) as { compression: string };
      container.calls.push(body.compression);
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

function setup() {
  const db = new Database(":memory:");
  for (const name of readdirSync(MIGRATION_DIR).sort()) if (name.endsWith(".sql")) db.exec(readFileSync(`${MIGRATION_DIR}${name}`, "utf8"));
  db.prepare("INSERT INTO organizations (id, slug, name, external_provider, external_id, created_at) VALUES ('org','org','Org','raft','s',1)").run();
  db.prepare("INSERT INTO apps (id, org_id, slug, name, platform, created_at) VALUES ('app','org','raft-android','Raft','android',1)").run();
  db.prepare("INSERT INTO channels (id, app_id, slug, name, created_at) VALUES ('main','app','main','Main',1)").run();
  for (const [code, status] of [[10, "superseded"], [20, "active"]] as const) {
    db.prepare("INSERT INTO builds (id, app_id, version_name, version_code, created_at, updated_at) VALUES (?, 'app', ?, ?, 1, 1)").run(`b${code}`, String(code), code);
    db.prepare("INSERT INTO build_assets (id, build_id, artifact_kind, platform, arch, filetype, r2_key, file_hash, size_bytes, created_at) VALUES (?, ?, 'installable', 'android', 'arm64-v8a', 'apk', ?, ?, 1000, 1)")
      .run(`a${code}`, `b${code}`, `apk/${code}`, `h${code}`);
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
       FROM build_assets WHERE build_id = 'b20' AND artifact_kind = 'delta-patch' ORDER BY algorithm`,
    ).all() as Array<{ r2_key: string; filetype: string; size_bytes: number; algorithm: string; from_version_code: number }>;
  return { generate, patches, puts };
}

const sized = (sizes: Record<string, number>): Reply => (compression) =>
  sizes[compression] === undefined
    ? new Response("xz: not found", { status: 500 })
    : new Response(new Uint8Array(sizes[compression]!));

describe("delta patch variants", () => {
  beforeEach(() => {
    container.calls = [];
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
      { r2_key: "delta/app/20/from-10-arm64-v8a.patch", filetype: "patch", size_bytes: 300, algorithm: "archive-patcher-v1+gzip", from_version_code: 10 },
      { r2_key: "delta/app/20/from-10-arm64-v8a.patch.xz", filetype: "patch.xz", size_bytes: 200, algorithm: "archive-patcher-v1+xz", from_version_code: 10 },
    ]);
    expect([...puts.keys()].sort()).toEqual(["delta/app/20/from-10-arm64-v8a.patch", "delta/app/20/from-10-arm64-v8a.patch.xz"]);

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
});
