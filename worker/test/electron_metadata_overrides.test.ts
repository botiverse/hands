import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";

vi.mock("@cloudflare/containers", () => ({ Container: class {}, getRandom: async () => ({}) }));
import { admin } from "../src/index";
import { generateDeployToken, hashDeployToken } from "../src/lib/deploy_tokens";
import { checkReplacementMetadata } from "../src/lib/electron_metadata_overrides";
import { handleElectronGenericAsset } from "../src/routes/electron";
import {
  handleGetElectronMetadata,
  handleListElectronMetadata,
  handlePutElectronMetadata,
  handleRevertElectronMetadata,
} from "../src/routes/electron_metadata";

const MIGRATION_DIR = fileURLToPath(new URL("../../migrations/sql/", import.meta.url));

type BoundStatement = {
  _execute: () => { results: unknown[]; success: true; meta: { changes: number } };
  run: () => Promise<{ results: unknown[]; success: true; meta: { changes: number } }>;
  all: () => Promise<{ results: unknown[]; success: true; meta: { changes: number } }>;
  first: <T>() => Promise<T | null>;
};

/**
 * D1 shim that numbers placeholders the way SQLite does: `?N` is parameter N, and a bare `?`
 * is one more than the largest number used so far. Unbound parameters are NULL. This is what
 * made the old user-audit query silently match nothing, so the shim must reproduce it rather
 * than throw.
 */
function d1(db: Database.Database) {
  const prepare = (sql: string) => {
    const indexes: number[] = [];
    let largest = 0;
    const normalized = sql.replace(/\?(\d*)/g, (_match, digits: string) => {
      const index = digits ? Number(digits) : largest + 1;
      largest = Math.max(largest, index);
      indexes.push(index);
      return "?";
    });
    const statement = db.prepare(normalized);
    const bind = (...input: unknown[]): BoundStatement => {
      const params = indexes
        .map((index) => input[index - 1])
        .map((value) => value === undefined ? null : typeof value === "boolean" ? Number(value) : value);
      const execute = () => {
        if (statement.reader) {
          return { results: statement.all(...params), success: true as const, meta: { changes: 0 } };
        }
        const info = statement.run(...params);
        return { results: [], success: true as const, meta: { changes: info.changes } };
      };
      return {
        _execute: execute,
        run: async () => execute(),
        all: async () => execute(),
        first: async <T>() => (statement.get(...params) as T | undefined) ?? null,
      };
    };
    return { bind, run: () => bind().run(), all: () => bind().all(), first: <T>() => bind().first<T>() };
  };
  return {
    prepare,
    batch: async (statements: BoundStatement[]) =>
      db.transaction(() => statements.map((statement) => statement._execute()))(),
  };
}

function migratedDb() {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  for (const name of readdirSync(MIGRATION_DIR).sort()) {
    if (name.endsWith(".sql")) sqlite.exec(readFileSync(`${MIGRATION_DIR}${name}`, "utf8"));
  }
  return sqlite;
}


const ORIGINAL = `version: 1.35.0
files:
  - url: Raft-Desktop-1.35.0-arm64-mac.zip
    sha512: aaa
    size: 100
path: Raft-Desktop-1.35.0-arm64-mac.zip
sha512: aaa
releaseDate: '2026-11-22T00:00:00.000Z'
patches:
  - url: Raft-Desktop-1.35.0-arm64-from-1.34.0.patch
    from: 1.34.0
    sha512: ppp
`;

function bucket() {
  const objects = new Map<string, Uint8Array>();
  const encoder = new TextEncoder();
  const object = (bytes: Uint8Array) => ({
    body: new Response(bytes).body,
    size: bytes.byteLength,
    httpEtag: `"${bytes.byteLength}"`,
    text: async () => new TextDecoder().decode(bytes),
    writeHttpMetadata: () => {},
  });
  return {
    objects,
    seed: (key: string, text: string) => objects.set(key, encoder.encode(text)),
    binding: {
      get: async (key: string) => (objects.has(key) ? object(objects.get(key)!) : null),
      put: async (key: string, value: Uint8Array) => { objects.set(key, new Uint8Array(value)); },
    },
  };
}

function environment(status = "active") {
  const sqlite = migratedDb();
  sqlite.exec(`
    INSERT INTO organizations (id, slug, name, external_provider, external_id, created_at)
      VALUES ('org', 'org', 'Org', 'raft', 'srv', 1);
    INSERT INTO apps (id, org_id, slug, name, platform, created_at)
      VALUES ('app', 'org', 'raft-desktop', 'Desktop', 'electron', 1);
    INSERT INTO channels (id, app_id, slug, name, created_at) VALUES ('ch', 'app', 'main', 'Main', 1);
    INSERT INTO builds (id, app_id, channel_id, product_type, release_type, version_name, version_code,
                        source, status, build_metadata_json, parsed_metadata_json, provenance_json,
                        created_at, updated_at, artifact_mode)
      VALUES ('b1', 'app', 'ch', 'desktop-installer', 'stable', '1.35.0', 135, 'external', 'succeeded',
              '{}', '{}', '{}', 1, 1, 'external');
    INSERT INTO releases (id, app_id, build_id, channel_id, product_type, release_type, status,
                          hidden, provenance_json, created_by, created_at, updated_at, activated_at)
      VALUES ('r1', 'app', 'b1', 'ch', 'desktop-installer', 'stable', '${status}', 0, '{}', 'test', 1, 1, 1);
    INSERT INTO build_assets (id, build_id, platform, arch, filetype, r2_key, file_hash, size_bytes, created_at, artifact_kind)
      VALUES
        ('yml', 'b1', 'darwin', NULL, 'yml', 'builds/b1/latest-mac.yml', 'h', 10, 1, 'electron-metadata'),
        ('zip', 'b1', 'darwin', 'arm64', 'zip', 'builds/b1/Raft-Desktop-1.35.0-arm64-mac.zip', 'h', 100, 1, 'installable'),
        ('patch', 'b1', 'darwin', 'arm64', 'patch', 'builds/b1/Raft-Desktop-1.35.0-arm64-from-1.34.0.patch', 'h', 20, 1, 'update-patch');
  `);
  const r2 = bucket();
  r2.seed("builds/b1/latest-mac.yml", ORIGINAL);
  const env = { DB: d1(sqlite), APK_BUCKET: r2.binding } as unknown as Env;
  const router = new Hono<{ Bindings: Env }>();
  router.use("*", async (c, next) => { (c as any).set("admin_actor", "raft:artin@botiverse"); await next(); });
  const base = "/api/apps/:appId/releases/:releaseId/electron-metadata";
  router.get(base, handleListElectronMetadata as any);
  router.get(`${base}/:file`, handleGetElectronMetadata as any);
  router.put(`${base}/:file`, handlePutElectronMetadata as any);
  router.post(`${base}/:file/revert`, handleRevertElectronMetadata as any);
  router.get("/electron/:slug/:channel/:file", handleElectronGenericAsset as any);
  const url = (suffix = "") => `https://hands.test/api/apps/app/releases/r1/electron-metadata${suffix}`;
  const put = (text: string, file = "latest-mac.yml") =>
    router.request(url(`/${file}`), { method: "PUT", body: text, headers: { "content-type": "text/yaml" } }, env);
  const revert = () => router.request(url("/latest-mac.yml/revert"), { method: "POST" }, env);
  const served = async () => (await router.request("https://hands.test/electron/raft-desktop/main/latest-mac.yml", {}, env)).text();
  return { sqlite, env, router, url, put, revert, served };
}

const withoutPatches = ORIGINAL.replace(/patches:[\s\S]*$/, "patches: []\n");

describe("replacing a published Electron release's update metadata", () => {
  it("serves the replacement, keeps history, and reverts to the previous file", async () => {
    const h = environment();
    expect(await h.served()).toBe(ORIGINAL);

    const first = await h.put(withoutPatches);
    expect(first.status).toBe(200);
    expect(await h.served()).toBe(withoutPatches);

    const staged = withoutPatches + "stagingPercentage: 25\n";
    expect((await h.put(staged)).status).toBe(200);
    expect(await h.served()).toBe(staged);

    const list = await (await h.router.request(h.url(), {}, h.env)).json() as any;
    expect(list.files).toHaveLength(1);
    expect(list.files[0]).toMatchObject({ file: "latest-mac.yml", replaced: true });
    expect(list.files[0].history).toHaveLength(2);

    expect((await h.revert()).status).toBe(200);
    expect(await h.served()).toBe(withoutPatches);
    expect((await h.revert()).status).toBe(200);
    expect(await h.served()).toBe(ORIGINAL);
    expect((await h.revert()).status).toBe(409);

    const audit = h.sqlite.prepare("SELECT action, actor FROM audit_logs ORDER BY created_at, rowid").all();
    expect(audit.map((row: any) => row.action)).toEqual([
      "release.electron_metadata_replaced",
      "release.electron_metadata_replaced",
      "release.electron_metadata_reverted",
      "release.electron_metadata_reverted",
    ]);
    expect((audit[0] as any).actor).toBe("raft:artin@botiverse");
  });

  it("returns the served text for editing", async () => {
    const h = environment();
    await h.put(withoutPatches);
    const res = await h.router.request(h.url("/latest-mac.yml"), {}, h.env);
    expect(res.headers.get("x-hands-metadata-source")).toMatch(/^replacement:/);
    expect(await res.text()).toBe(withoutPatches);
  });

  it.each([
    ["a different version", ORIGINAL.replace("version: 1.35.0", "version: 1.35.1"), "version_changed"],
    ["a changed installer entry", ORIGINAL.replace("size: 100", "size: 101"), "installer_entries_changed"],
    ["a changed top-level sha512", ORIGINAL.replace("sha512: aaa\nreleaseDate", "sha512: bbb\nreleaseDate"), "installer_entries_changed"],
    ["a patch the build does not hold", ORIGINAL.replace("from-1.34.0.patch", "from-1.33.0.patch"), "patch_file_not_in_build"],
    ["something that is not a mapping", "- just\n- a list\n", "metadata_invalid"],
  ])("refuses %s and keeps serving the current file", async (_label, text, code) => {
    const h = environment();
    const res = await h.put(text);
    expect(res.status).toBe(422);
    expect(((await res.json()) as any).code).toBe(code);
    expect(await h.served()).toBe(ORIGINAL);
  });

  it("refuses a file that is not this release's metadata, and a cancelled release", async () => {
    expect((await environment().put(withoutPatches, "Raft-Desktop-1.35.0-arm64-mac.zip")).status).toBe(404);
    expect((await environment("cancelled").put(withoutPatches)).status).toBe(409);
  });

  it("requires the app admin role: a publisher deploy token is refused", async () => {
    const h = environment();
    const deploy = generateDeployToken();
    h.sqlite.prepare(
      `INSERT INTO app_deploy_tokens
         (id, app_id, name, token_prefix, token_hash, app_role, scopes_json, created_by_actor, created_at)
       VALUES ('dt', 'app', 'ci', ?, ?, 'publisher', NULL, 'test', 1)`,
    ).run(deploy.token_prefix, await hashDeployToken(deploy.token));
    const res = await admin.request(h.url("/latest-mac.yml"), {
      method: "PUT",
      body: withoutPatches,
      headers: { authorization: `Bearer ${deploy.token}` },
    }, h.env);
    expect(res.status).toBe(403);
    const read = await admin.request(h.url(), { headers: { authorization: `Bearer ${deploy.token}` } }, h.env);
    expect(read.status).toBe(200);
  });
});

describe("checkReplacementMetadata", () => {
  it("accepts rollout fields and patch references given as paths or strings", () => {
    const names = new Set(["Raft-Desktop-1.35.0-arm64-from-1.34.0.patch"]);
    const text = ORIGINAL + "stagingPercentage: 5\n";
    expect(checkReplacementMetadata(ORIGINAL, text, names)).toEqual({ ok: true });
    const asString = ORIGINAL.replace(/patches:[\s\S]*$/, "patches:\n  - Raft-Desktop-1.35.0-arm64-from-1.34.0.patch\n");
    expect(checkReplacementMetadata(ORIGINAL, asString, names)).toEqual({ ok: true });
  });

  it("refuses YAML aliases rather than expanding them", () => {
    const bomb = ORIGINAL + "a: &a [x]\nb: [*a, *a]\n";
    expect(checkReplacementMetadata(ORIGINAL, bomb, new Set())).toMatchObject({ ok: false, code: "metadata_invalid" });
  });
});
