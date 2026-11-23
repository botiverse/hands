import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import {
  handleCompleteBuildAssetUpload,
  handleDeclareBuildAssetUpload,
} from "../src/routes/build_asset_uploads";
import { createBuildAsset, handleCreateBuild, handleUpdateBuild } from "../src/routes/builds";
import { handleCreateRelease } from "../src/routes/releases";
import { handleCreateApp, handleUpdateApp } from "../src/routes/apps";
import { handleDesktopFilesComplete, handleDesktopFilesMissing } from "../src/routes/desktop_files";
import { handlePublicDesktopFile, handlePublicDesktopUpdate } from "../src/routes/desktop_public";
import { handlePublicR2Download } from "../src/routes/public_v2";
import { validateDesktopManifest } from "../src/lib/desktop_manifest";
import { rolloutBucket } from "../src/lib/release_resolver";

const MIGRATIONS = fileURLToPath(new URL("../../migrations/sql/", import.meta.url));

function migratedDb(): Database.Database {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  for (const name of readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort()) {
    sqlite.exec(readFileSync(MIGRATIONS + name, "utf8"));
  }
  return sqlite;
}

/** D1 over better-sqlite3: numbered placeholders, batch as one transaction. */
function d1(sqlite: Database.Database) {
  return {
    batch: async (statements: Array<{ _runSync: () => unknown }>) =>
      sqlite.transaction(() => statements.map((statement) => statement._runSync()))(),
    prepare(sql: string) {
      // SQLite numbering: `?N` is parameter N, a bare `?` is one more than the largest
      // so far. handleUpdateApp mixes both.
      const indexes: number[] = [];
      let highest = 0;
      const statement = sqlite.prepare(sql.replace(/\?(\d*)/g, (_match, value: string) => {
        const index = value ? Number(value) : highest + 1;
        highest = Math.max(highest, index);
        indexes.push(index);
        return "?";
      }));
      const bind = (...params: unknown[]) => {
        const values = indexes.length ? indexes.map((index) => params[index - 1]) : params;
        const runSync = () => {
          const result = statement.run(...values);
          return { success: true, meta: { changes: result.changes } };
        };
        return {
          _runSync: () => statement.reader ? { success: true, results: statement.all(...values) } : runSync(),
          run: async () => runSync(),
          all: async () => ({ success: true, results: statement.all(...values) }),
          first: async () => statement.all(...values)[0] ?? null,
        };
      };
      return { bind, run: () => bind().run(), all: () => bind().all(), first: () => bind().first() };
    },
  };
}

class MemoryR2 {
  readonly objects = new Map<string, Uint8Array>();
  /** sha256 checksums R2 reports on head(), when the test sets one. */
  readonly checksums = new Map<string, string>();

  async head(key: string) {
    const bytes = this.objects.get(key);
    const digest = this.checksums.get(key);
    return bytes
      ? { key, size: bytes.byteLength, checksums: digest ? { sha256: Uint8Array.from(Buffer.from(digest, "hex")).buffer } : {} }
      : null;
  }

  async get(key: string) {
    const bytes = this.objects.get(key);
    if (!bytes) return null;
    return {
      key,
      size: bytes.byteLength,
      httpEtag: `"${key}"`,
      writeHttpMetadata() {},
      body: new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); controller.close(); } }),
    };
  }

  async put(key: string, value: ReadableStream<Uint8Array>, options?: { sha256?: string }) {
    const bytes = new Uint8Array(await new Response(value).arrayBuffer());
    if (options?.sha256 && sha(bytes) !== options.sha256.toLowerCase()) throw new Error("R2 sha256 mismatch");
    this.objects.set(key, bytes);
    return { key, size: bytes.byteLength };
  }

  async delete(key: string) {
    this.objects.delete(key);
  }
}

function sha(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

const APP = "app-desktop";
const OTHER_APP = "app-other";

function seed(sqlite: Database.Database) {
  sqlite.prepare(
    `INSERT INTO apps (id, slug, name, platform, runtime, created_at) VALUES
     (?, 'raft-desktop', 'Raft', 'desktop', 'jvm', 1), (?, 'other-desktop', 'Other', 'desktop', NULL, 1)`,
  ).run(APP, OTHER_APP);
  sqlite.prepare(
    `INSERT INTO channels (id, app_id, slug, name, created_at) VALUES
     ('ch-main', ?, 'main', 'Main', 1), ('ch-beta', ?, 'beta', 'Beta', 1), ('ch-other', ?, 'main', 'Main', 1)`,
  ).run(APP, APP, OTHER_APP);
}

describe("desktop apps", () => {
  let sqlite: Database.Database;
  let bucket: MemoryR2;
  let env: any;
  let app: Hono<any>;
  let principal: "none" | "human" | "token";

  beforeEach(() => {
    sqlite = migratedDb();
    seed(sqlite);
    bucket = new MemoryR2();
    env = {
      DB: d1(sqlite),
      APK_BUCKET: bucket,
      SIGNED_URL_SECRET: "test-secret",
      R2_S3_ENDPOINT: "https://r2.example.test",
      R2_BUCKET_NAME: "assets",
      R2_S3_ACCESS_KEY_ID: "test-access",
      R2_S3_SECRET_ACCESS_KEY: "test-secret",
    };
    app = new Hono<any>();
    principal = "none";
    app.use("*", async (c, next) => {
      c.set("admin_actor", "test:publisher");
      if (principal === "human") c.set("admin_account", { id: "acct-1", principal_type: "human" } as any);
      if (principal === "token") c.set("admin_deploy_token", { id: "tok-1", app_id: APP, name: "ci", app_role: "publisher", scopes: null } as any);
      await next();
    });
    app.post("/api/apps/:appId/builds", handleCreateBuild as any);
    app.patch("/api/apps/:appId/builds/:buildId", handleUpdateBuild as any);
    app.post("/api/apps/:appId/releases", handleCreateRelease as any);
    app.post("/api/apps", handleCreateApp as any);
    app.patch("/api/apps/:appId", handleUpdateApp as any);
    app.post("/api/apps/:appId/desktop/files/missing", handleDesktopFilesMissing as any);
    app.post("/api/apps/:appId/desktop/files/complete", handleDesktopFilesComplete as any);
    app.post("/api/apps/:appId/builds/:buildId/assets/uploads", handleDeclareBuildAssetUpload as any);
    app.post("/api/apps/:appId/builds/:buildId/assets/:assetId/upload/complete", handleCompleteBuildAssetUpload as any);
    app.get("/public/v2/apps/:slug/desktop/update", handlePublicDesktopUpdate as any);
    app.get("/public/v2/apps/:slug/files/:sha256", handlePublicDesktopFile as any);
    app.get("/public/r2/:key", handlePublicR2Download as any);
  });

  const executionCtx = { waitUntil: () => {}, passThroughOnException: () => {}, props: {} } as any;
  const send = (method: string, path: string, body: unknown) => app.request(`http://hands.test${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }, env, executionCtx);
  const post = (path: string, body: unknown) => send("POST", path, body);

  /** Upload content-addressed files the way the CLI does: /missing, PUT, /complete. */
  async function storeFiles(appId: string, contents: Array<Uint8Array | string>, putOverride?: (sha256: string) => Uint8Array) {
    const files = contents.map((content) => {
      const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
      return { sha256: sha(bytes), size: bytes.byteLength, bytes };
    });
    const missing = await post(`/api/apps/${appId}/desktop/files/missing`, { files: files.map(({ sha256, size }) => ({ sha256, size })) });
    expect(missing.status).toBe(200);
    const body = await missing.json() as any;
    for (const entry of body.missing) {
      const file = files.find((f) => f.sha256 === entry.sha256)!;
      // The presigned PUT lands on the staging key named in the URL.
      const key = decodeURIComponent(new URL(entry.upload_url).pathname.replace(/^\/assets\//, ""));
      bucket.objects.set(key, putOverride ? putOverride(entry.sha256) : file.bytes);
    }
    const complete = await post(`/api/apps/${appId}/desktop/files/complete`, { files: files.map(({ sha256, size }) => ({ sha256, size })) });
    return { files, missing: body, complete: await complete.json() as any, status: complete.status };
  }

  function manifestFor(target: string, files: Array<{ sha256: string; size: number }>, extra: unknown[] = []) {
    return {
      schema: 1,
      target,
      root: "Raft.app",
      files: [
        ...files.map((file, index) => ({ path: `Contents/MacOS/f${index}`, sha256: file.sha256, size: file.size, mode: "755", link: null })),
        ...extra,
      ],
      total_size: files.reduce((sum, file) => sum + file.size, 0),
    };
  }

  function createPendingBuild(buildId: string, slots: unknown[], versionCode = 100) {
    sqlite.prepare(
      `INSERT INTO builds (id, app_id, channel_id, product_type, version_name, version_code, status,
        created_at, updated_at, asset_ingest_protocol_version, required_asset_slots_json, artifact_mode)
       VALUES (?, ?, 'ch-main', 'desktop-installer', ?, ?, 'pending', 1, 1, 1, ?, 'hands_r2')`,
    ).run(buildId, APP, `1.0.${versionCode}`, versionCode, JSON.stringify(slots));
  }

  async function uploadAsset(buildId: string, kind: string, filetype: string, bytes: Uint8Array, target = "darwin-arm64") {
    const [platform, arch] = target.split("-");
    const declared = await post(`/api/apps/${APP}/builds/${buildId}/assets/uploads`, {
      idempotency_key: `${buildId}-${kind}-${filetype}-${target}-${sha(bytes).slice(0, 8)}`, artifact_kind: kind, platform, arch,
      filetype, sha256: sha(bytes), size_bytes: bytes.byteLength, filename: `asset.${filetype}`,
    });
    const declaredBody = await declared.json() as any;
    if (declared.status !== 201) return { declared, declaredBody };
    bucket.objects.set(`apps/${APP}/build-ingest/pending/${buildId}/${declaredBody.asset_id}/1/asset.${filetype}`, bytes);
    const completed = await post(`/api/apps/${APP}/builds/${buildId}/assets/${declaredBody.asset_id}/upload/complete`, {});
    return { declared, declaredBody, completed, completedBody: await completed.json() as any };
  }

  /** A succeeded build with a ready manifest/archive/installer for `target`, and an active release. */
  function publishRelease(opts: {
    id: string; versionCode: number; target?: string; channel?: string; hidden?: number;
    availabilityAt?: number | null; rollout?: number | null; status?: string; manifest?: boolean;
    manifestFiles?: string[]; activatedAt?: number; appId?: string; sealed?: boolean;
  }) {
    const appId = opts.appId ?? APP;
    const [platform, arch] = (opts.target ?? "darwin-arm64").split("-") as [string, string];
    const buildId = `build-${opts.id}`;
    sqlite.prepare(
      `INSERT INTO builds (id, app_id, channel_id, product_type, version_name, version_code, status, created_at, updated_at, completed_at)
       VALUES (?, ?, ?, 'desktop-installer', ?, ?, 'succeeded', 1, 1, 5)`,
    ).run(buildId, appId, opts.channel ?? "ch-main", `1.0.${opts.versionCode}`, opts.versionCode);
    const ready = JSON.stringify({ upload_state: "ready" });
    const insertAsset = sqlite.prepare(
      `INSERT INTO build_assets (id, build_id, artifact_kind, platform, arch, filetype, r2_key, file_hash, size_bytes, metadata_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
    );
    // Served assets must be sealed by the direct upload protocol, so seed the ingest row too.
    const sealed = sqlite.prepare(
      `INSERT INTO build_asset_ingest_attempt (asset_id, attempt, declared_sha256, declared_size, staging_key,
         committed_final_key, upload_expires_at, state, created_at)
       VALUES (?, 1, ?, ?, 'staging', ?, 0, 'ready', 1)`,
    );
    const asset = {
      run: (id: string, build: string, kind: string, p: string, a: string, filetype: string, key: string, hash: string, size: number, meta: string) => {
        insertAsset.run(id, build, kind, p, a, filetype, key, hash, size, meta);
        if (opts.sealed !== false) sealed.run(id, hash, size, key);
      },
    };
    if (opts.manifest !== false) {
      asset.run(`${buildId}-manifest`, buildId, "desktop-manifest", platform, arch, "json", `k/${buildId}/manifest.json`, "a".repeat(64), 10, ready);
      for (const digest of opts.manifestFiles ?? []) {
        sqlite.prepare("INSERT INTO desktop_manifest_files (app_id, build_asset_id, sha256) VALUES (?, ?, ?)").run(appId, `${buildId}-manifest`, digest);
      }
    }
    asset.run(`${buildId}-archive`, buildId, "desktop-archive", platform, arch, "zip", `k/${buildId}/app.zip`, "b".repeat(64), 20, ready);
    asset.run(`${buildId}-dmg`, buildId, "installable", platform, arch, "dmg", `k/${buildId}/app.dmg`, "c".repeat(64), 30, ready);
    sqlite.prepare(
      `INSERT INTO releases (id, app_id, build_id, channel_id, product_type, release_type, status, rollout_cohort_count,
        availability_at, hidden, created_by, created_at, updated_at, activated_at)
       VALUES (?, ?, ?, ?, 'desktop-installer', 'stable', ?, ?, ?, ?, 'test', 1, 1, ?)`,
    ).run(opts.id, appId, buildId, opts.channel ?? "ch-main", opts.status ?? "active", opts.rollout ?? null,
      opts.availabilityAt ?? null, opts.hidden ?? 0, opts.activatedAt ?? opts.versionCode);
    sqlite.prepare("INSERT INTO release_scopes (id, release_id, scope_type, scope_value, created_at) VALUES (?, ?, 'full', 'all', 1)")
      .run(`scope-${opts.id}`, opts.id);
    return buildId;
  }

  const check = (query: string, headers: Record<string, string> = {}) =>
    app.request(`http://hands.test/public/v2/apps/raft-desktop/desktop/update?${query}`, { headers }, env);

  describe("migration and app attributes", () => {
    it("adds apps.runtime and the content-addressed tables", () => {
      const columns = (table: string) => (sqlite.prepare(`SELECT name FROM pragma_table_info('${table}')`).all() as Array<{ name: string }>).map((r) => r.name);
      expect(columns("apps")).toContain("runtime");
      expect(columns("desktop_files")).toEqual(["app_id", "sha256", "size_bytes", "created_at"]);
      expect(columns("desktop_manifest_files")).toEqual(["app_id", "build_asset_id", "sha256"]);
      expect(() => sqlite.prepare("INSERT INTO desktop_files (app_id, sha256, size_bytes, created_at) VALUES (?, 'short', 1, 1)").run(APP)).toThrow();
    });

    it("creates a desktop app with a runtime and rejects an unknown runtime", async () => {
      const created = await post("/api/apps", { slug: "compose-app", name: "Compose", platform: "desktop", runtime: "jvm" });
      expect(created.status).toBe(201);
      expect(await created.json()).toMatchObject({ platform: "desktop", runtime: "jvm" });
      expect(sqlite.prepare("SELECT runtime FROM apps WHERE slug = 'compose-app'").get()).toEqual({ runtime: "jvm" });
      const bad = await post("/api/apps", { slug: "bad-runtime", name: "Bad", platform: "desktop", runtime: "flutterish" });
      expect(bad.status).toBe(400);
      expect((await bad.json() as any).code).toBe("UNSUPPORTED_APP_RUNTIME");
    });

    it("updates and clears the runtime", async () => {
      const patch = (body: unknown) => app.request(`http://hands.test/api/apps/${APP}`, {
        method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
      }, env);
      expect((await patch({ runtime: "tauri" })).status).toBe(200);
      expect(sqlite.prepare("SELECT runtime FROM apps WHERE id = ?").get(APP)).toEqual({ runtime: "tauri" });
      expect((await patch({ runtime: null })).status).toBe(200);
      expect(sqlite.prepare("SELECT runtime FROM apps WHERE id = ?").get(APP)).toEqual({ runtime: null });
      expect((await patch({ runtime: "x" })).status).toBe(400);
    });
  });

  describe("content-addressed upload API", () => {
    it("offers presigned PUTs only for absent files and stores verified ones", async () => {
      const first = await storeFiles(APP, ["runtime-lib", "app-binary"]);
      expect(first.missing.missing).toHaveLength(2);
      expect(first.missing.missing[0]).toMatchObject({ upload_url: expect.stringContaining("r2.example.test"), expires_at: expect.any(Number) });
      expect(first.complete).toMatchObject({ ok: true, stored: 2, present: 0, failed: 0 });
      for (const file of first.files) {
        expect(bucket.objects.get(`apps/${APP}/files/sha256/${file.sha256}`)).toEqual(file.bytes);
        expect(bucket.objects.has(`apps/${APP}/files/staging/${file.sha256}`)).toBe(false);
      }
      // A second version that keeps the runtime only uploads the changed binary.
      const second = await storeFiles(APP, ["runtime-lib", "app-binary-v2"]);
      expect(second.missing.missing.map((m: any) => m.sha256)).toEqual([sha("app-binary-v2")]);
      expect(second.missing.present_count).toBe(1);
      expect(second.complete).toMatchObject({ ok: true, stored: 1, present: 1 });
    });

    it("is idempotent: completing the same files again reports them present", async () => {
      const first = await storeFiles(APP, ["same"]);
      expect(first.complete.stored).toBe(1);
      const again = await post(`/api/apps/${APP}/desktop/files/complete`, { files: [{ sha256: sha("same"), size: 4 }] });
      expect(await again.json()).toMatchObject({ ok: true, stored: 0, present: 1, results: [{ status: "present" }] });
      expect((sqlite.prepare("SELECT COUNT(*) AS n FROM desktop_files").get() as any).n).toBe(1);
    });

    it("refuses bytes whose sha256 differs from the declared digest", async () => {
      const result = await storeFiles(APP, ["genuine"], () => new TextEncoder().encode("tamper!"));
      expect(result.complete).toMatchObject({ ok: false, failed: 1, results: [{ status: "sha256_mismatch", retryable: false }] });
      expect(bucket.objects.has(`apps/${APP}/files/sha256/${sha("genuine")}`)).toBe(false);
      expect(bucket.objects.has(`apps/${APP}/files/staging/${sha("genuine")}`)).toBe(false);
      expect((sqlite.prepare("SELECT COUNT(*) AS n FROM desktop_files").get() as any).n).toBe(0);
    });

    it("refuses an upload whose size differs from the declaration", async () => {
      const result = await storeFiles(APP, ["exact"], () => new TextEncoder().encode("exact plus more"));
      expect(result.complete.results[0]).toMatchObject({ status: "size_mismatch", actual_size: 15 });
      expect((sqlite.prepare("SELECT COUNT(*) AS n FROM desktop_files").get() as any).n).toBe(0);
    });

    it("reports a file that was never uploaded as missing_upload", async () => {
      const res = await post(`/api/apps/${APP}/desktop/files/complete`, { files: [{ sha256: sha("nothing"), size: 7 }] });
      expect(await res.json()).toMatchObject({ ok: false, results: [{ status: "missing_upload" }] });
    });

    it("recovers a sealed object only when R2's recorded digest matches", async () => {
      const digest = sha("recovered");
      bucket.objects.set(`apps/${APP}/files/sha256/${digest}`, new TextEncoder().encode("recovered"));
      bucket.checksums.set(`apps/${APP}/files/sha256/${digest}`, sha("something else"));
      const bad = await post(`/api/apps/${APP}/desktop/files/complete`, { files: [{ sha256: digest, size: 9 }] });
      expect((await bad.json() as any).results[0].status).toBe("missing_upload");
      bucket.checksums.set(`apps/${APP}/files/sha256/${digest}`, digest);
      const good = await post(`/api/apps/${APP}/desktop/files/complete`, { files: [{ sha256: digest, size: 9 }] });
      expect((await good.json() as any).results[0].status).toBe("stored");
    });

    it("accepts empty files", async () => {
      const result = await storeFiles(APP, [new Uint8Array(0)]);
      expect(result.complete).toMatchObject({ ok: true, stored: 1 });
    });

    it("validates the request body and bounds batch sizes", async () => {
      expect((await post(`/api/apps/${APP}/desktop/files/missing`, { files: [{ sha256: "xyz", size: 1 }] })).status).toBe(400);
      expect((await post(`/api/apps/${APP}/desktop/files/missing`, { files: [] })).status).toBe(400);
      const many = Array.from({ length: 101 }, (_, i) => ({ sha256: sha(`f${i}`), size: 1 }));
      expect((await post(`/api/apps/${APP}/desktop/files/complete`, { files: many })).status).toBe(400);
      expect((await post(`/api/apps/${APP}/desktop/files/missing`, { files: many })).status).toBe(200);
      const tooMany = Array.from({ length: 1001 }, (_, i) => ({ sha256: sha(`m${i}`), size: 1 }));
      expect((await post(`/api/apps/${APP}/desktop/files/missing`, { files: tooMany })).status).toBe(400);
      expect((await post(`/api/apps/nope/desktop/files/missing`, { files: [{ sha256: sha("a"), size: 1 }] })).status).toBe(404);
    });

    it("keeps apps apart: another app's stored file is still missing here", async () => {
      await storeFiles(OTHER_APP, ["shared-bytes"]);
      const res = await post(`/api/apps/${APP}/desktop/files/missing`, { files: [{ sha256: sha("shared-bytes"), size: 12 }] });
      expect((await res.json() as any).missing).toHaveLength(1);
    });
  });

  describe("manifest validation", () => {
    const file = { sha256: "a".repeat(64), size: 3 };
    const base = (files: unknown[], extra: Record<string, unknown> = {}) => ({ schema: 1, target: "darwin-arm64", root: "Raft.app", files, ...extra });

    it("accepts files and in-bundle symlinks", () => {
      const parsed = validateDesktopManifest(base([
        { path: "Contents/MacOS/Raft", ...file, mode: "755", link: null },
        { path: "Contents/Frameworks/X.framework/X", link: "Versions/Current/X" },
        { path: "Contents/Frameworks/X.framework/Versions/Current", link: "A" },
      ], { total_size: 3 }), "darwin-arm64");
      expect(parsed.files).toHaveLength(1);
      expect(parsed.links).toHaveLength(2);
      expect([...parsed.digests]).toEqual([[file.sha256, 3]]);
    });

    it.each([
      ["absolute path", { path: "/etc/passwd", ...file, mode: "644" }],
      ["parent segment", { path: "Contents/../../x", ...file, mode: "644" }],
      ["backslash", { path: "Contents\\x", ...file, mode: "644" }],
      ["empty segment", { path: "Contents//x", ...file, mode: "644" }],
      ["drive letter", { path: "C:/x", ...file, mode: "644" }],
      ["bad mode", { path: "x", ...file, mode: "rwx" }],
      ["bad sha", { path: "x", sha256: "ABC", size: 1, mode: "644" }],
      ["absolute link", { path: "x", link: "/usr/lib/x" }],
      ["escaping link", { path: "a/x", link: "../../outside" }],
    ])("rejects %s", (_label, entry) => {
      expect(() => validateDesktopManifest(base([entry]), "darwin-arm64")).toThrow();
    });

    it("follows link chains: a link that leaves the root through another link is refused", () => {
      expect(() => validateDesktopManifest(base([
        { path: "a", ...file, mode: "644" },
        { path: "d/up", link: ".." },
        { path: "l", link: "d/up/../.." },
      ]), "darwin-arm64")).toThrow(/outside the bundle root/);
      expect(() => validateDesktopManifest(base([
        { path: "a", ...file, mode: "644" },
        { path: "loop1", link: "loop2/x" },
        { path: "loop2", link: "loop1" },
      ]), "darwin-arm64")).toThrow(/too long or loops/);
      // A chain that stays inside is fine.
      expect(() => validateDesktopManifest(base([
        { path: "a", ...file, mode: "644" },
        { path: "d/up", link: ".." },
        { path: "l", link: "d/up/a" },
      ]), "darwin-arm64")).not.toThrow();
    });

    it("compares paths the way the target filesystem does", () => {
      const f = (path: string) => ({ path, ...file, mode: "644" });
      expect(() => validateDesktopManifest(base([f("Readme"), f("README")]), "darwin-arm64")).toThrow(/same path/);
      expect(() => validateDesktopManifest(base([f("caf\u00e9"), f("cafe\u0301")]), "darwin-arm64")).toThrow(/same path/);
      expect(() => validateDesktopManifest(base([f("Lib"), f("lib/x")]), "darwin-arm64")).toThrow(/nested/);
      const linux = { ...base([f("Readme"), f("README")]), target: "linux-x64" };
      expect(() => validateDesktopManifest(linux, "linux-x64")).not.toThrow();
    });

    it.each(["CON", "nul.txt", "Com1.dll", "LPT9", "a:b", "name.", "name ", "tab\there"])("rejects %j on a Windows target", (name) => {
      const doc = { ...base([{ path: `dir/${name}`, ...file, mode: "644" }]), target: "win32-x64" };
      expect(() => validateDesktopManifest(doc, "win32-x64")).toThrow();
    });

    it("accepts those names on macOS except control characters, and only three-digit modes", () => {
      expect(() => validateDesktopManifest(base([{ path: "CON", ...file, mode: "644" }]), "darwin-arm64")).not.toThrow();
      expect(() => validateDesktopManifest(base([{ path: "a\u0001", ...file, mode: "644" }]), "darwin-arm64")).toThrow(/control/);
      expect(() => validateDesktopManifest(base([{ path: "a", ...file, mode: "4755" }]), "darwin-arm64")).toThrow(/three octal digits/);
    });

    it("rejects duplicates, nesting under a file or link, a wrong target and a wrong total", () => {
      const f = (path: string) => ({ path, ...file, mode: "644" });
      expect(() => validateDesktopManifest(base([f("a"), f("a")]), "darwin-arm64")).toThrow(/duplicate/);
      expect(() => validateDesktopManifest(base([f("a"), f("a/b")]), "darwin-arm64")).toThrow(/nested/);
      expect(() => validateDesktopManifest(base([{ path: "lib", link: "real" }, f("lib/x")]), "darwin-arm64")).toThrow(/nested/);
      expect(() => validateDesktopManifest(base([f("a")]), "win32-x64")).toThrow(/does not match/);
      expect(() => validateDesktopManifest(base([f("a")], { total_size: 99 }), "darwin-arm64")).toThrow(/total_size/);
      expect(() => validateDesktopManifest(base([f("a")], { schema: 2 }), "darwin-arm64")).toThrow(/schema/);
      expect(() => validateDesktopManifest(base([f("a")], { root: "../x" }), "darwin-arm64")).toThrow();
    });

    const manifestSlots = [
      { artifact_kind: "desktop-manifest", platform: "darwin", arch: "arm64", variant: null, filetype: "json" },
    ];

    it("seals a manifest whose files are all stored and indexes its files", async () => {
      const stored = await storeFiles(APP, ["one", "two"]);
      createPendingBuild("b-ok", manifestSlots);
      const bytes = new TextEncoder().encode(JSON.stringify(manifestFor("darwin-arm64", stored.files)));
      const result = await uploadAsset("b-ok", "desktop-manifest", "json", bytes);
      expect(result.completed?.status).toBe(200);
      expect(result.completedBody.state).toBe("ready");
      const indexed = (sqlite.prepare("SELECT sha256 FROM desktop_manifest_files WHERE build_asset_id = ? ORDER BY sha256").all(result.declaredBody.asset_id) as any[]).map((r) => r.sha256);
      expect(indexed).toEqual(stored.files.map((f) => f.sha256).sort());
    });

    it("fails closed when the manifest references a file that is not stored", async () => {
      const stored = await storeFiles(APP, ["one"]);
      createPendingBuild("b-missing", manifestSlots);
      const unknown = { sha256: sha("never uploaded"), size: 14 };
      const bytes = new TextEncoder().encode(JSON.stringify(manifestFor("darwin-arm64", [...stored.files, unknown])));
      const result = await uploadAsset("b-missing", "desktop-manifest", "json", bytes);
      expect(result.completed?.status).toBe(422);
      expect(result.completedBody).toMatchObject({ code: "DESKTOP_MANIFEST_FILES_MISSING", missing_count: 1, missing: [{ sha256: unknown.sha256 }] });
      expect((sqlite.prepare("SELECT COUNT(*) AS n FROM desktop_manifest_files").get() as any).n).toBe(0);
      expect(sqlite.prepare("SELECT state FROM build_asset_ingest_attempt WHERE asset_id = ?").get(result.declaredBody.asset_id)).toEqual({ state: "failed" });
    });

    it("fails closed when a stored file has a different size than the manifest says", async () => {
      const stored = await storeFiles(APP, ["one"]);
      createPendingBuild("b-size", manifestSlots);
      const bytes = new TextEncoder().encode(JSON.stringify(manifestFor("darwin-arm64", [{ sha256: stored.files[0]!.sha256, size: 999 }])));
      const result = await uploadAsset("b-size", "desktop-manifest", "json", bytes);
      expect(result.completedBody.code).toBe("DESKTOP_MANIFEST_FILES_MISSING");
    });

    it("fails closed on a manifest with an escaping path", async () => {
      const stored = await storeFiles(APP, ["one"]);
      createPendingBuild("b-path", manifestSlots);
      const doc = manifestFor("darwin-arm64", []);
      doc.files = [{ path: "../evil", sha256: stored.files[0]!.sha256, size: 3, mode: "644", link: null }];
      doc.total_size = 3;
      const result = await uploadAsset("b-path", "desktop-manifest", "json", new TextEncoder().encode(JSON.stringify(doc)));
      expect(result.completed?.status).toBe(422);
      expect(result.completedBody.code).toBe("DESKTOP_MANIFEST_INVALID");
    });

    it("refuses a manifest declaration that is not json or not for a desktop target", async () => {
      createPendingBuild("b-decl", manifestSlots);
      const bad = await uploadAsset("b-decl", "desktop-manifest", "txt", new TextEncoder().encode("{}"));
      expect(bad.declared.status).toBe(400);
      const wrongTarget = await uploadAsset("b-decl", "desktop-manifest", "json", new TextEncoder().encode("{}"), "android-arm64");
      expect(wrongTarget.declared.status).toBe(400);
    });

    it.each(["desktop-manifest", "desktop-archive"])("refuses to register a %s through the legacy key path", async (kind) => {
      createPendingBuild("b-legacy", manifestSlots);
      await expect(createBuildAsset(env.DB, APP, "b-legacy", {
        artifact_kind: kind, platform: "darwin", arch: "arm64", filetype: kind === "desktop-manifest" ? "json" : "zip",
        r2_key: "k", file_hash: "a".repeat(64), size_bytes: 2, metadata_json: { upload_state: "ready" },
      } as any, "test")).rejects.toThrow(/direct asset upload/);
    });
  });

  describe("one version, every target", () => {
    const slots = (target: string) => {
      const [platform, arch] = target.split("-");
      return [
        { artifact_kind: "desktop-archive", platform, arch, variant: null, filetype: "zip" },
        { artifact_kind: "desktop-manifest", platform, arch, variant: null, filetype: "json" },
      ];
    };

    /** Upload a target's archive and manifest (manifest last) to a build, through the real routes. */
    async function uploadTarget(buildId: string, target: string, content: string) {
      const stored = await storeFiles(APP, [`${target}-${content}`]);
      const archive = await uploadAsset(buildId, "desktop-archive", "zip", new TextEncoder().encode(`zip-${target}-${content}`), target);
      const manifest = await uploadAsset(buildId, "desktop-manifest", "json",
        new TextEncoder().encode(JSON.stringify(manifestFor(target, stored.files))), target);
      return { archive, manifest };
    }

    beforeEach(() => { principal = "human"; });

    async function publishFirstTarget(target: string, status: "active" | "draft") {
      const created = await post(`/api/apps/${APP}/builds`, {
        channel_id: "ch-main", product_type: "desktop-installer", version_name: "2.0.0", version_code: 2000000,
        source: "cli", status: "pending", asset_ingest_protocol_version: 1, required_asset_slots_json: slots(target),
      });
      expect(created.status).toBe(201);
      const buildId = (await created.json() as any).id as string;
      const first = await uploadTarget(buildId, target, "v2");
      expect(first.manifest.completed?.status).toBe(200);
      expect((await send("PATCH", `/api/apps/${APP}/builds/${buildId}`, { status: "succeeded" })).status).toBe(200);
      const release = await post(`/api/apps/${APP}/releases`, {
        build_id: buildId, channel_id: "ch-main", product_type: "desktop-installer", release_type: "stable",
        status, scopes: [{ scope_type: "full", scope_value: "all" }],
      });
      expect(release.status).toBe(201);
      return { buildId, releaseId: (await release.json() as any).id as string };
    }

    it("serves darwin-arm64 and win32-x64 from one release published through the real routes", async () => {
      const { buildId, releaseId } = await publishFirstTarget("darwin-arm64", "active");
      // The second CI job adds its target to the same, already published build.
      const second = await uploadTarget(buildId, "win32-x64", "v2");
      expect(second.archive.declared.status).toBe(201);
      expect(second.manifest.completed?.status).toBe(200);
      expect(second.manifest.completedBody.state).toBe("ready");
      expect((sqlite.prepare("SELECT COUNT(*) AS n FROM releases WHERE app_id = ?").get(APP) as any).n).toBe(1);
      for (const target of ["darwin-arm64", "win32-x64"]) {
        const body = await (await check(`target=${target}&current_version_code=1`)).json() as any;
        expect(body).toMatchObject({ update_available: true, target, release: { id: releaseId, version_code: 2000000 } });
        expect(body.full_archive).not.toBeNull();
      }
    });

    it("refuses to change a target the build already publishes", async () => {
      const { buildId } = await publishFirstTarget("darwin-arm64", "active");
      const again = await uploadAsset(buildId, "desktop-archive", "zip", new TextEncoder().encode("other-zip"), "darwin-arm64");
      expect(again.declared.status).toBe(409);
      expect(again.declaredBody.code).toBe("DESKTOP_TARGET_EXISTS");
    });

    it("lets a deploy token add a target to a draft release but not to an active one", async () => {
      principal = "token";
      const draft = await publishFirstTarget("darwin-arm64", "draft");
      const added = await uploadTarget(draft.buildId, "win32-x64", "v2");
      expect(added.manifest.completed?.status).toBe(200);
      sqlite.prepare("UPDATE releases SET status = 'active', activated_at = 1 WHERE id = ?").run(draft.releaseId);
      const refused = await uploadAsset(draft.buildId, "desktop-archive", "zip", new TextEncoder().encode("linux-zip"), "linux-x64");
      expect(refused.declared.status).toBe(403);
      expect(refused.declaredBody.code).toBe("AGENT_ACTIVE_RELEASE_FORBIDDEN");
    });

    it("refuses a target append on a superseded release and on a non-desktop app's build", async () => {
      const { buildId, releaseId } = await publishFirstTarget("darwin-arm64", "active");
      sqlite.prepare("UPDATE releases SET status = 'superseded' WHERE id = ?").run(releaseId);
      const late = await uploadAsset(buildId, "desktop-archive", "zip", new TextEncoder().encode("late"), "win32-x64");
      expect(late.declaredBody.code).toBe("DESKTOP_RELEASE_NOT_APPENDABLE");
      sqlite.prepare("UPDATE apps SET platform = 'electron' WHERE id = ?").run(APP);
      const electron = await uploadAsset(buildId, "desktop-archive", "zip", new TextEncoder().encode("late2"), "linux-x64");
      expect(electron.declaredBody.code).toBe("BUILD_NOT_UPLOADABLE");
    });
  });

  describe("public update endpoint", () => {
    it("offers a newer release with signed manifest, archive and installer URLs", async () => {
      publishRelease({ id: "r1", versionCode: 100 });
      const res = await check("target=darwin-arm64&channel=main&current_version_code=50");
      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body).toMatchObject({
        update_available: true,
        release: { id: "r1", version: "1.0.100", version_code: 100, force_update: false, released_at: 5 },
        manifest: { sha256: "a".repeat(64), size: 10 },
        full_archive: { sha256: "b".repeat(64), size: 20 },
        installer: { sha256: "c".repeat(64), size: 30, filetype: "dmg" },
      });
      expect(body.release.notes_url).toBe("https://hands.test/apps/raft-desktop/v/1.0.100");
      expect(body.manifest.url).toMatch(/^https:\/\/hands\.test\/public\/r2\/.+\?expires=\d+&sig=[0-9a-f]+$/);
      // The signed URL resolves: /public/r2 accepts the desktop artifact kinds.
      bucket.objects.set("k/build-r1/manifest.json", new TextEncoder().encode("{}"));
      const download = await app.request(body.manifest.url, {}, env);
      expect(download.status).toBe(302);
    });

    it("ignores assets that were not sealed by the direct upload protocol", async () => {
      // Metadata claiming upload_state=ready is caller-supplied; only a sealed ingest counts.
      publishRelease({ id: "r-unsealed", versionCode: 100, sealed: false });
      expect(await (await check("target=darwin-arm64&current_version_code=1")).json()).toMatchObject({ update_available: false, latest_version_code: null });
    });

    it("treats an empty product_type as the default", async () => {
      publishRelease({ id: "r1", versionCode: 100 });
      const res = await check("target=darwin-arm64&current_version_code=1&product_type=");
      expect(res.status).toBe(200);
      expect((await res.json() as any).release.id).toBe("r1");
    });

    it("answers update_available false when the client is current or ahead", async () => {
      publishRelease({ id: "r1", versionCode: 100 });
      expect(await (await check("target=darwin-arm64&current_version_code=100")).json()).toMatchObject({ update_available: false, latest_version_code: 100 });
      expect(await (await check("target=darwin-arm64&current_version_code=200")).json()).toMatchObject({ update_available: false, latest_version_code: 100 });
    });

    it("answers update_available false with no latest version when nothing is eligible", async () => {
      expect(await (await check("target=darwin-arm64&current_version_code=1")).json()).toMatchObject({ update_available: false, latest_version_code: null });
    });

    it("skips hidden and not-yet-available releases", async () => {
      publishRelease({ id: "r1", versionCode: 100 });
      publishRelease({ id: "r-hidden", versionCode: 300, hidden: 1 });
      publishRelease({ id: "r-future", versionCode: 400, availabilityAt: Date.now() + 86_400_000 });
      const body = await (await check("target=darwin-arm64&current_version_code=1")).json() as any;
      expect(body.release.id).toBe("r1");
    });

    it("selects by target and requires a manifest for it", async () => {
      publishRelease({ id: "r-mac", versionCode: 100, target: "darwin-arm64" });
      publishRelease({ id: "r-win", versionCode: 200, target: "win32-x64" });
      publishRelease({ id: "r-nomanifest", versionCode: 300, target: "darwin-arm64", manifest: false });
      expect((await (await check("target=darwin-arm64&current_version_code=1")).json() as any).release.id).toBe("r-mac");
      expect((await (await check("target=win32-x64&current_version_code=1")).json() as any).release.id).toBe("r-win");
      expect(await (await check("target=linux-x64&current_version_code=1")).json()).toMatchObject({ update_available: false, latest_version_code: null });
      expect((await check("target=darwin-universal&current_version_code=1")).status).toBe(400);
      expect((await check("target=darwin-arm64")).status).toBe(400);
    });

    it("gates a staged rollout by device id", async () => {
      publishRelease({ id: "r1", versionCode: 100 });
      publishRelease({ id: "r-staged", versionCode: 200, rollout: 50 });
      let inside = "";
      let outside = "";
      for (let i = 0; i < 200 && (!inside || !outside); i += 1) {
        const id = `device-${i}`;
        if (rolloutBucket("r-staged", id) < 50) inside ||= id;
        else outside ||= id;
      }
      const forDevice = async (deviceId: string) =>
        (await (await check("target=darwin-arm64&current_version_code=1", { "X-Hands-Device-Id": deviceId })).json() as any).release.id;
      expect(await forDevice(inside)).toBe("r-staged");
      expect(await forDevice(outside)).toBe("r1");
      // No device id: a staged release is not offered.
      expect((await (await check("target=darwin-arm64&current_version_code=1")).json() as any).release.id).toBe("r1");
    });

    it("resolves the public `latest` alias to main and 404s an unknown channel", async () => {
      publishRelease({ id: "r1", versionCode: 100 });
      expect((await (await check("target=darwin-arm64&channel=latest&current_version_code=1")).json() as any).release.id).toBe("r1");
      expect((await check("target=darwin-arm64&channel=nope&current_version_code=1")).status).toBe(404);
      publishRelease({ id: "r-beta", versionCode: 500, channel: "ch-beta" });
      expect((await (await check("target=darwin-arm64&channel=beta&current_version_code=1")).json() as any).release.id).toBe("r-beta");
    });
  });

  describe("public file endpoint", () => {
    const file = (slug: string, digest: string) => app.request(`http://hands.test/public/v2/apps/${slug}/files/${digest}`, {}, env);

    it("redirects to a signed URL for a file referenced by a published manifest", async () => {
      const stored = await storeFiles(APP, ["published"]);
      publishRelease({ id: "r1", versionCode: 100, manifestFiles: [stored.files[0]!.sha256] });
      const res = await file("raft-desktop", stored.files[0]!.sha256);
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toContain(`r2.example.test/assets/apps/${APP}/files/sha256/${stored.files[0]!.sha256}`);
    });

    it("falls back to the HMAC-signed Worker route when presigning is not configured", async () => {
      const stored = await storeFiles(APP, ["published"]);
      publishRelease({ id: "r1", versionCode: 100, manifestFiles: [stored.files[0]!.sha256] });
      delete env.R2_S3_ACCESS_KEY_ID;
      const res = await file("raft-desktop", stored.files[0]!.sha256);
      expect(res.status).toBe(302);
      const location = res.headers.get("location")!;
      expect(location).toMatch(/\/public\/r2\//);
      const body = await app.request(location, {}, env);
      expect(body.status).toBe(200);
      expect(new Uint8Array(await body.arrayBuffer())).toEqual(stored.files[0]!.bytes);
    });

    it("404s a stored file that no published manifest references", async () => {
      const stored = await storeFiles(APP, ["unpublished"]);
      expect((await file("raft-desktop", stored.files[0]!.sha256)).status).toBe(404);
      // Referenced only by a draft or hidden release: still not public.
      publishRelease({ id: "r-draft", versionCode: 100, status: "draft", manifestFiles: [stored.files[0]!.sha256] });
      publishRelease({ id: "r-hidden", versionCode: 200, hidden: 1, manifestFiles: [stored.files[0]!.sha256] });
      expect((await file("raft-desktop", stored.files[0]!.sha256)).status).toBe(404);
    });

    it("404s a file whose only release is not yet available", async () => {
      const stored = await storeFiles(APP, ["scheduled"]);
      const digest = stored.files[0]!.sha256;
      publishRelease({ id: "r-future", versionCode: 100, availabilityAt: Date.now() + 86_400_000, manifestFiles: [digest] });
      expect((await file("raft-desktop", digest)).status).toBe(404);
      sqlite.prepare("UPDATE releases SET availability_at = NULL WHERE id = 'r-future'").run();
      expect((await file("raft-desktop", digest)).status).toBe(302);
    });

    it("serves a superseded release's files", async () => {
      const stored = await storeFiles(APP, ["old"]);
      publishRelease({ id: "r-old", versionCode: 100, status: "superseded", manifestFiles: [stored.files[0]!.sha256] });
      expect((await file("raft-desktop", stored.files[0]!.sha256)).status).toBe(302);
    });

    it("404s a file of another app and a malformed digest", async () => {
      const stored = await storeFiles(OTHER_APP, ["theirs"]);
      publishRelease({ id: "r-other", versionCode: 100, appId: OTHER_APP, channel: "ch-other", manifestFiles: [stored.files[0]!.sha256] });
      expect((await file("other-desktop", stored.files[0]!.sha256)).status).toBe(302);
      expect((await file("raft-desktop", stored.files[0]!.sha256)).status).toBe(404);
      expect((await file("raft-desktop", "nothex")).status).toBe(404);
    });
  });
});
