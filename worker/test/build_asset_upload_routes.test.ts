import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanupExpiredBuildAssetUploads,
  handleAbortBuildAssetUpload,
  handleBeginHostedBuildMigration,
  handleCompleteBuildAssetUpload,
  handleCompleteHostedBuildMigration,
  handleDeclareBuildAssetUpload,
  handleGetBuildAssetUpload,
} from "../src/routes/build_asset_uploads";
import { handleUpdateBuild } from "../src/routes/builds";
import { openApiDocument } from "../src/openapi";

function d1(
  sqlite: Database.Database,
  afterRead?: (sql: string, kind: "all" | "first") => void,
  beforeWrite?: (sql: string) => void,
  afterWrite?: (sql: string, changes: number) => void,
) {
  return {
    batch: async (statements: Array<{ _runSync: () => unknown }>) =>
      sqlite.transaction(() => statements.map((statement) => statement._runSync()))(),
    prepare(sql: string) {
      const indexes: number[] = [];
      const statement = sqlite.prepare(sql.replace(/\?(\d+)/g, (_match, value) => {
        indexes.push(Number(value));
        return "?";
      }));
      const bind = (...params: unknown[]) => {
        const values = indexes.length ? indexes.map((index) => params[index - 1]) : params;
        const runSync = () => {
          beforeWrite?.(sql);
          const result = statement.run(...values);
          afterWrite?.(sql, result.changes);
          return { success: true, meta: { changes: result.changes } };
        };
        return {
          _runSync: () => statement.reader
            ? { success: true, results: statement.all(...values) }
            : runSync(),
          run: async () => runSync(),
          all: async () => {
            const results = statement.all(...values);
            afterRead?.(sql, "all");
            return { success: true, results };
          },
          first: async () => {
            const result = statement.all(...values)[0] ?? null;
            afterRead?.(sql, "first");
            return result;
          },
        };
      };
      return { bind, run: () => bind().run(), all: () => bind().all(), first: () => bind().first() };
    },
  };
}

class MemoryR2 {
  readonly objects = new Map<string, Uint8Array>();
  readonly deleted: string[] = [];
  readonly deleteFailures = new Set<string>();

  async head(key: string) {
    const bytes = this.objects.get(key);
    return bytes ? { key, size: bytes.byteLength } : null;
  }

  async get(key: string) {
    const bytes = this.objects.get(key);
    if (!bytes) return null;
    return {
      key,
      size: bytes.byteLength,
      body: new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); controller.close(); } }),
    };
  }

  async put(key: string, value: ReadableStream<Uint8Array>) {
    const reader = value.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const { done, value: chunk } = await reader.read();
      if (done) break;
      if (!chunk) continue;
      chunks.push(chunk);
      size += chunk.byteLength;
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    this.objects.set(key, bytes);
    return { key, size };
  }

  async delete(key: string) {
    this.deleted.push(key);
    if (this.deleteFailures.has(key)) throw new Error(`synthetic delete failure: ${key}`);
    this.objects.delete(key);
  }
}

function schema(sqlite: Database.Database) {
  sqlite.pragma("foreign_keys = ON");
  sqlite.exec(`
    CREATE TABLE builds (
      id TEXT PRIMARY KEY, app_id TEXT NOT NULL, status TEXT NOT NULL,
      artifact_mode TEXT NOT NULL, asset_ingest_protocol_version INTEGER,
      required_asset_slots_json TEXT, source TEXT NOT NULL DEFAULT 'cli',
      version_name TEXT NOT NULL DEFAULT '1.0.0', version_code INTEGER NOT NULL DEFAULT 1000000,
      updated_at INTEGER NOT NULL DEFAULT 0, completed_at INTEGER
    );
    CREATE UNIQUE INDEX idx_builds_app_scope ON builds(app_id, id);
    CREATE TABLE build_assets (
      id TEXT PRIMARY KEY, build_id TEXT NOT NULL REFERENCES builds(id) ON DELETE CASCADE,
      artifact_kind TEXT NOT NULL, platform TEXT NOT NULL, arch TEXT, variant TEXT,
      filetype TEXT NOT NULL, r2_key TEXT NOT NULL, file_hash TEXT NOT NULL,
      size_bytes INTEGER NOT NULL, metadata_json TEXT NOT NULL, download_count INTEGER NOT NULL,
      created_at INTEGER NOT NULL, slot_arch TEXT GENERATED ALWAYS AS (COALESCE(arch, '-')) VIRTUAL,
      slot_variant TEXT GENERATED ALWAYS AS (COALESCE(variant, '-')) VIRTUAL,
      UNIQUE(build_id, id), UNIQUE(build_id, artifact_kind, platform, slot_arch, slot_variant, filetype)
    );
    CREATE TABLE build_asset_ingest_attempt (
      asset_id TEXT NOT NULL REFERENCES build_assets(id) ON DELETE CASCADE, attempt INTEGER NOT NULL,
      declared_sha256 TEXT NOT NULL, declared_size INTEGER NOT NULL, staging_key TEXT NOT NULL,
      committed_final_key TEXT, upload_expires_at INTEGER NOT NULL, state TEXT NOT NULL,
      verifier_lease_id TEXT, verifier_lease_expires_at INTEGER,
      cleanup_state TEXT NOT NULL DEFAULT 'live', cleanup_receipt TEXT, created_at INTEGER NOT NULL,
      PRIMARY KEY(asset_id, attempt)
    );
    CREATE TABLE build_asset_ingest_seal (
      asset_id TEXT NOT NULL, attempt INTEGER NOT NULL, lease_generation INTEGER NOT NULL,
      final_key TEXT NOT NULL, intent_at INTEGER NOT NULL, sealed_at INTEGER,
      outcome TEXT, cleanup_receipt TEXT, PRIMARY KEY(asset_id, attempt, lease_generation)
    );
    CREATE TABLE build_asset_ingest_replay (
      app_id TEXT NOT NULL, build_id TEXT NOT NULL, idempotency_key TEXT NOT NULL,
      asset_id TEXT NOT NULL, request_digest TEXT NOT NULL, created_at INTEGER NOT NULL,
      PRIMARY KEY(app_id, build_id, idempotency_key),
      FOREIGN KEY(build_id, asset_id) REFERENCES build_assets(build_id, id) ON DELETE CASCADE
    );
    CREATE TABLE audit_logs (
      id TEXT PRIMARY KEY, app_id TEXT NOT NULL, action TEXT NOT NULL,
      actor TEXT NOT NULL, payload TEXT NOT NULL, created_at INTEGER NOT NULL
    );
  `);
}

describe("direct build asset upload routes", () => {
  let sqlite: Database.Database;
  let bucket: MemoryR2;
  let env: any;
  let app: Hono<any>;

  beforeEach(() => {
    sqlite = new Database(":memory:");
    schema(sqlite);
    bucket = new MemoryR2();
    env = {
      DB: d1(sqlite), APK_BUCKET: bucket,
      R2_S3_ENDPOINT: "https://r2.example.test", R2_BUCKET_NAME: "assets",
      R2_S3_ACCESS_KEY_ID: "test-access", R2_S3_SECRET_ACCESS_KEY: "test-secret",
    };
    app = new Hono<any>();
    app.use("*", async (c, next) => { c.set("admin_actor", "test:publisher"); await next(); });
    app.post("/api/apps/:appId/builds/:buildId/assets/uploads", handleDeclareBuildAssetUpload as any);
    app.get("/api/apps/:appId/builds/:buildId/assets/:assetId/upload", handleGetBuildAssetUpload as any);
    app.post("/api/apps/:appId/builds/:buildId/assets/:assetId/upload/complete", handleCompleteBuildAssetUpload as any);
    app.post("/api/apps/:appId/builds/:buildId/assets/:assetId/upload/abort", handleAbortBuildAssetUpload as any);
    app.post("/api/apps/:appId/builds/:buildId/hosted-migration", handleBeginHostedBuildMigration as any);
    app.post("/api/apps/:appId/builds/:buildId/hosted-migration/complete", handleCompleteHostedBuildMigration as any);
    app.patch("/api/apps/:appId/builds/:buildId", handleUpdateBuild as any);
    sqlite.prepare(
      "INSERT INTO builds (id, app_id, status, artifact_mode, asset_ingest_protocol_version, required_asset_slots_json) VALUES (?, ?, 'pending', 'hands_r2', 1, ?)",
    ).run("build-1", "app-1", JSON.stringify([{ artifact_kind: "installable", platform: "darwin", arch: "arm64", variant: null, filetype: "bin" }]));
  });

  async function declare(hash: string, size: number, idempotencyKey = "run-1") {
    return app.request("http://hands.test/api/apps/app-1/builds/build-1/assets/uploads", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        idempotency_key: idempotencyKey, artifact_kind: "installable", platform: "darwin",
        arch: "arm64", variant: null, filetype: "bin", sha256: hash,
        size_bytes: size, filename: "raft-computer", content_type: "application/octet-stream",
      }),
    }, env);
  }

  it("exposes a verifier deadline and takes over an expired lease on the same bytes", async () => {
    const bytes = Buffer.from("stale-verifier-recovery");
    const declared = await declare(createHash("sha256").update(bytes).digest("hex"), bytes.length);
    const body = await declared.json() as any;
    const attempt = sqlite.prepare("SELECT staging_key FROM build_asset_ingest_attempt WHERE asset_id = ?").get(body.asset_id) as any;
    bucket.objects.set(attempt.staging_key, bytes);
    const deadline = Date.now() + 60_000;
    sqlite.prepare("UPDATE build_asset_ingest_attempt SET state = 'verifying', verifier_lease_id = 'dead', verifier_lease_expires_at = ? WHERE asset_id = ?").run(deadline, body.asset_id);
    const url = `http://hands.test/api/apps/app-1/builds/build-1/assets/${body.asset_id}/upload`;
    const status = await app.request(url, {}, env);
    expect(status.headers.get("Cache-Control")).toBe("no-store");
    expect(await status.json()).toMatchObject({ state: "verifying", verifier_lease_expires_at: deadline, verification_started_at: deadline - 15 * 60_000, can_retry_complete: false });
    const busy = await app.request(`${url}/complete`, { method: "POST" }, env);
    expect(await busy.json()).toMatchObject({ code: "ASSET_UPLOAD_BUSY", verifier_lease_expires_at: deadline });
    sqlite.prepare("UPDATE build_asset_ingest_attempt SET verifier_lease_expires_at = ? WHERE asset_id = ?").run(Date.now() - 1, body.asset_id);
    expect(await (await app.request(url, {}, env)).json()).toMatchObject({ can_retry_complete: true });
    expect((await app.request(`${url}/complete`, { method: "POST" }, env)).status).toBe(200);
    expect(await (await app.request(url, {}, env)).json()).toMatchObject({ state: "ready", verifier_lease_expires_at: null });
    expect((await app.request(url.replace("app-1", "other-app"), {}, env)).status).toBe(404);
  });

  it.each(["staging_head", "staging_read", "seal_write", "seal_readback"])("preserves staging and retries after %s failure", async (phase) => {
    const bytes = Buffer.from("storage-retry");
    const body = await (await declare(createHash("sha256").update(bytes).digest("hex"), bytes.length)).json() as any;
    const attempt = sqlite.prepare("SELECT staging_key FROM build_asset_ingest_attempt WHERE asset_id = ?").get(body.asset_id) as any;
    bucket.objects.set(attempt.staging_key, bytes);
    const head = bucket.head.bind(bucket), get = bucket.get.bind(bucket), put = bucket.put.bind(bucket);
    let fail = true;
    bucket.head = async (key) => {
      if (fail && ((phase === "staging_head" && key === attempt.staging_key) || (phase === "seal_readback" && key.includes("/verified/") && bucket.objects.has(key)))) { fail = false; throw new Error("storage read failed"); }
      return head(key);
    };
    bucket.get = async (key) => { if (fail && phase === "staging_read") { fail = false; throw new Error("storage read failed"); } return get(key); };
    // Exercise the production fixed-length pump with a blocked consumer.
    vi.stubGlobal("FixedLengthStream", class extends TransformStream<Uint8Array, Uint8Array> { constructor(_length: number) { super(); } });
    bucket.put = async (key, stream) => { if (fail && phase === "seal_write") { fail = false; throw new Error("storage write failed"); } return put(key, stream); };
    try {
      const url = `http://hands.test/api/apps/app-1/builds/build-1/assets/${body.asset_id}/upload`;
      const failed = await app.request(`${url}/complete`, { method: "POST" }, env);
      expect(failed.status).toBe(503);
      expect(await failed.json()).toMatchObject({ code: "ASSET_UPLOAD_STORAGE_FAILED", phase, retryable: true, state: "pending" });
      expect(bucket.objects.has(attempt.staging_key)).toBe(true);
      expect(await (await app.request(url, {}, env)).json()).toMatchObject({ state: "pending", can_retry_complete: true });
      expect((await app.request(`${url}/complete`, { method: "POST" }, env)).status).toBe(200);
    } finally { vi.unstubAllGlobals(); }
  });

  it.each(["read_failure", "short_stream", "long_stream"])("distinguishes %s from a recoverable storage failure", async (mode) => {
    const bytes = Buffer.from("declared-bytes");
    const body = await (await declare(createHash("sha256").update(bytes).digest("hex"), bytes.length)).json() as any;
    const attempt = sqlite.prepare("SELECT staging_key FROM build_asset_ingest_attempt WHERE asset_id = ?").get(body.asset_id) as any;
    bucket.objects.set(attempt.staging_key, bytes);
    const streamBytes = mode === "short_stream" ? bytes.subarray(1) : Buffer.concat([bytes, bytes]);
    bucket.get = async (key) => ({ key, size: bytes.length, body: new ReadableStream<Uint8Array>({ start(controller) {
      if (mode === "read_failure") controller.error(new Error("storage stream disconnected"));
      else { controller.enqueue(streamBytes); controller.close(); }
    } }) });
    const response = await app.request(`http://hands.test/api/apps/app-1/builds/build-1/assets/${body.asset_id}/upload/complete`, { method: "POST" }, env);
    if (mode === "read_failure") {
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ phase: "staging_stream", retryable: true });
      expect(bucket.objects.has(attempt.staging_key)).toBe(true);
    } else {
      expect(response.status).toBe(422);
      expect(await response.json()).toMatchObject({ reason: "stream_size_mismatch", retryable: false, expected: { size_bytes: bytes.length }, actual: { size_bytes: streamBytes.length } });
      expect(bucket.objects.has(attempt.staging_key)).toBe(false);
    }
  });

  it("returns a durable hash failure reason in upload status", async () => {
    const bytes = Buffer.from("bad-hash");
    const body = await (await declare("1".repeat(64), bytes.length)).json() as any;
    const attempt = sqlite.prepare("SELECT staging_key FROM build_asset_ingest_attempt WHERE asset_id = ?").get(body.asset_id) as any;
    bucket.objects.set(attempt.staging_key, bytes);
    const url = `http://hands.test/api/apps/app-1/builds/build-1/assets/${body.asset_id}/upload`;
    const failure = await app.request(`${url}/complete`, { method: "POST" }, env);
    expect(await failure.json()).toMatchObject({ reason: "sha256_mismatch", retryable: false, expected: { sha256: "1".repeat(64) }, actual: { sha256: createHash("sha256").update(bytes).digest("hex") } });
    expect(await (await app.request(url, {}, env)).json()).toMatchObject({ state: "failed", verification_error: "sha256_mismatch", can_retry_complete: false });
  });

  it.each([
    [new Error("D1_ERROR: Network connection lost."), 503, true],
    [new Error("D1_ERROR", { cause: new Error("fetch failed") }), 503, true],
    [new Error("D1_ERROR: UNIQUE constraint failed: build_asset_ingest_seal.final_key"), 409, false],
  ])("classifies seal-intent failures and preserves bytes for retry (%s)", async (error, status, retryable) => {
    const bytes = Buffer.from("retry-exact-bytes");
    const hash = createHash("sha256").update(bytes).digest("hex");
    const body = await (await declare(hash, bytes.length)).json() as any;
    const attempt = sqlite.prepare("SELECT staging_key FROM build_asset_ingest_attempt WHERE asset_id = ?").get(body.asset_id) as any;
    bucket.objects.set(attempt.staging_key, bytes);
    let failOnce = true;
    env.DB = d1(sqlite, undefined, (sql) => {
      if (failOnce && sql.includes("INSERT INTO build_asset_ingest_seal")) {
        failOnce = false;
        throw error;
      }
    });
    const url = `http://hands.test/api/apps/app-1/builds/build-1/assets/${body.asset_id}/upload/complete`;
    const failed = await app.request(url, { method: "POST" }, env);
    expect(failed.status).toBe(status);
    expect(await failed.json()).toMatchObject({ code: "ASSET_UPLOAD_SEAL_INTENT_FAILED", retryable });
    expect(failed.headers.get("Retry-After")).toBe(retryable ? "5" : null);
    expect(sqlite.prepare("SELECT state, verifier_lease_id FROM build_asset_ingest_attempt WHERE asset_id = ?").get(body.asset_id))
      .toEqual({ state: "pending", verifier_lease_id: null });
    expect(bucket.objects.get(attempt.staging_key)).toEqual(bytes);
    expect(bucket.deleted).toEqual([]);
    if (retryable) {
      const completed = await app.request(url, { method: "POST" }, env);
      expect(completed.status).toBe(200);
      expect(await completed.json()).toMatchObject({ state: "ready", file_hash: hash, size_bytes: bytes.length });
    }
  });

  it("reports a concurrent verification as retryable and polls to ready without another PUT", async () => {
    const bytes = Buffer.from("slow-verification");
    const hash = createHash("sha256").update(bytes).digest("hex");
    const body = await (await declare(hash, bytes.length)).json() as any;
    const attempt = sqlite.prepare("SELECT staging_key FROM build_asset_ingest_attempt WHERE asset_id = ?").get(body.asset_id) as any;
    bucket.objects.set(attempt.staging_key, bytes);
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const entered = new Promise<void>((resolve) => { started = resolve; });
    const get = bucket.get.bind(bucket);
    bucket.get = async (key) => { started(); await gate; return get(key); };
    const url = `http://hands.test/api/apps/app-1/builds/build-1/assets/${body.asset_id}/upload/complete`;
    const first = app.request(url, { method: "POST" }, env);
    await entered;
    try {
      const poll = await declare(hash, bytes.length);
      expect(poll.status).toBe(200);
      expect(await poll.json()).toMatchObject({ asset_id: body.asset_id, state: "verifying", upload: null, replayed: true });
      const busy = await app.request(url, { method: "POST" }, env);
      expect(busy.status).toBe(409);
      expect(busy.headers.get("Retry-After")).toBe("5");
      expect(await busy.json()).toMatchObject({ code: "ASSET_UPLOAD_BUSY", state: "verifying", retryable: true });
    } finally {
      release();
    }
    expect((await first).status).toBe(200);
    expect(await (await declare(hash, bytes.length)).json()).toMatchObject({ state: "ready", upload: null });
    const replay = await app.request(url, { method: "POST" }, env);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ state: "ready", replayed: true });
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM build_asset_ingest_seal WHERE lease_generation > 0").get()).toEqual({ n: 1 });
  });

  it.each(["failed", "expired"])("does not label a terminal %s attempt as busy", async (state) => {
    const body = await (await declare("1".repeat(64), 1)).json() as any;
    sqlite.prepare("UPDATE build_asset_ingest_attempt SET state = ? WHERE asset_id = ?").run(state, body.asset_id);
    const response = await app.request(`http://hands.test/api/apps/app-1/builds/build-1/assets/${body.asset_id}/upload/complete`, { method: "POST" }, env);
    expect(response.status).toBe(409);
    expect(response.headers.get("Retry-After")).toBeNull();
    expect(await response.json()).toMatchObject({ code: "ASSET_UPLOAD_TERMINAL", state, retryable: false });
  });

  it("keeps a lease loser retryable when the competing verifier resets to pending before readback", async () => {
    const body = await (await declare("1".repeat(64), 1)).json() as any;
    env.DB = d1(sqlite, undefined, (sql) => {
      if (sql.includes("SET state = 'verifying'")) {
        sqlite.prepare("UPDATE build_asset_ingest_attempt SET state = 'verifying', verifier_lease_id = 'competitor', verifier_lease_expires_at = ? WHERE asset_id = ?")
          .run(Date.now() + 60_000, body.asset_id);
      }
    }, (sql, changes) => {
      if (sql.includes("SET state = 'verifying'") && changes === 0) {
        sqlite.prepare("UPDATE build_asset_ingest_attempt SET state = 'pending', verifier_lease_id = NULL, verifier_lease_expires_at = NULL WHERE asset_id = ?").run(body.asset_id);
      }
    });
    const response = await app.request(`http://hands.test/api/apps/app-1/builds/build-1/assets/${body.asset_id}/upload/complete`, { method: "POST" }, env);
    expect(response.status).toBe(409);
    expect(response.headers.get("Retry-After")).toBe("5");
    expect(await response.json()).toMatchObject({ code: "ASSET_UPLOAD_BUSY", state: "pending", retryable: true });
  });

  it("documents replay states and a nullable upload in the served OpenAPI", () => {
    const paths = openApiDocument.paths as any;
    const declaration = paths["/api/apps/{appId}/builds/{buildId}/assets/uploads"].post;
    expect(declaration.responses[200].content["application/json"].schema.$ref).toContain("DirectBuildAssetUploadResponse");
    const schemas = openApiDocument.components?.schemas as any;
    expect(schemas.DirectBuildAssetUploadResponse.properties.state.enum).toEqual(["pending", "verifying", "ready", "failed", "expired"]);
    expect(schemas.DirectBuildAssetUploadResponse.properties.upload.type).toContain("null");
    const complete = paths["/api/apps/{appId}/builds/{buildId}/assets/{assetId}/upload/complete"].post;
    expect(complete.responses[503].description).toContain("Retry-After");
  });

  it("binds a replay to one exact staging key and exposes only a single-key PUT URL", async () => {
    const bytes = Buffer.from("computer-bytes");
    const hash = createHash("sha256").update(bytes).digest("hex");
    const first = await declare(hash, bytes.length);
    const firstBody = await first.json() as any;
    const replay = await declare(hash, bytes.length);
    const replayBody = await replay.json() as any;

    expect(first.status).toBe(201);
    expect(replay.status).toBe(200);
    expect(replayBody.asset_id).toBe(firstBody.asset_id);
    expect(new URL(replayBody.upload.url).pathname).toBe(new URL(firstBody.upload.url).pathname);
    expect(firstBody.upload).toMatchObject({ method: "PUT", headers: { "content-type": "application/octet-stream" } });
    expect(firstBody.upload).not.toHaveProperty("access_key");

    const conflict = await declare("0".repeat(64), bytes.length, "run-1");
    expect(conflict.status).toBe(409);
    expect((await conflict.json() as any).code).toBe("ASSET_UPLOAD_REPLAY_CONFLICT");
  });

  it("marks ready only after exact size and SHA verification and deletes staging", async () => {
    const bytes = Buffer.from("computer-bytes");
    const hash = createHash("sha256").update(bytes).digest("hex");
    const declared = await declare(hash, bytes.length);
    const body = await declared.json() as any;
    const attempt = sqlite.prepare("SELECT staging_key FROM build_asset_ingest_attempt WHERE asset_id = ?").get(body.asset_id) as any;
    bucket.objects.set(attempt.staging_key, bytes);

    const prematureBuild = await app.request("http://hands.test/api/apps/app-1/builds/build-1", {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: "succeeded" }),
    }, env);
    expect(prematureBuild.status).toBe(409);

    const completed = await app.request(`http://hands.test/api/apps/app-1/builds/build-1/assets/${body.asset_id}/upload/complete`, { method: "POST" }, env);
    const completedBody = await completed.json() as any;
    expect(completed.status).toBe(200);
    expect(completedBody).toMatchObject({ state: "ready", file_hash: hash, size_bytes: bytes.length });
    expect(bucket.objects.has(attempt.staging_key)).toBe(false);
    expect(Buffer.from(bucket.objects.get(completedBody.r2_key)!)).toEqual(bytes);
    expect(sqlite.prepare("SELECT state FROM build_asset_ingest_attempt WHERE asset_id = ?").get(body.asset_id)).toEqual({ state: "ready" });
    const completedBuild = await app.request("http://hands.test/api/apps/app-1/builds/build-1", {
      method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: "succeeded" }),
    }, env);
    expect(completedBuild.status).toBe(200);
    expect(sqlite.prepare("SELECT status FROM builds WHERE id = 'build-1'").get()).toEqual({ status: "succeeded" });
  });

  it("rejects a SHA mismatch, deletes both objects, and never marks the asset ready", async () => {
    const bytes = Buffer.from("wrong-computer-bytes");
    const declared = await declare("1".repeat(64), bytes.length);
    const body = await declared.json() as any;
    const attempt = sqlite.prepare("SELECT staging_key FROM build_asset_ingest_attempt WHERE asset_id = ?").get(body.asset_id) as any;
    bucket.objects.set(attempt.staging_key, bytes);

    const completed = await app.request(`http://hands.test/api/apps/app-1/builds/build-1/assets/${body.asset_id}/upload/complete`, { method: "POST" }, env);
    expect(completed.status).toBe(422);
    expect((await completed.json() as any).code).toBe("ASSET_UPLOAD_INTEGRITY_MISMATCH");
    expect(sqlite.prepare("SELECT state FROM build_asset_ingest_attempt WHERE asset_id = ?").get(body.asset_id)).toEqual({ state: "failed" });
    expect([...bucket.objects.keys()]).toEqual([]);
    const metadata = JSON.parse((sqlite.prepare("SELECT metadata_json FROM build_assets WHERE id = ?").get(body.asset_id) as any).metadata_json);
    expect(metadata.upload_state).toBe("failed");
  });

  it("retries exact staging and final cleanup after verification delete failures", async () => {
    const bytes = Buffer.from("mismatch-delete-retry");
    const declared = await declare("1".repeat(64), bytes.length, "mismatch-delete-retry");
    const body = await declared.json() as any;
    const attempt = sqlite.prepare(
      "SELECT attempt, staging_key FROM build_asset_ingest_attempt WHERE asset_id = ?",
    ).get(body.asset_id) as any;
    const finalKey = `apps/app-1/build-ingest/verified/build-1/${body.asset_id}/g1/raft-computer`;
    bucket.objects.set(attempt.staging_key, bytes);
    bucket.deleteFailures.add(attempt.staging_key);
    bucket.deleteFailures.add(finalKey);

    const completed = await app.request(
      `http://hands.test/api/apps/app-1/builds/build-1/assets/${body.asset_id}/upload/complete`,
      { method: "POST" },
      env,
    );
    expect(completed.status).toBe(422);
    expect(bucket.objects.has(attempt.staging_key)).toBe(true);
    expect(bucket.objects.has(finalKey)).toBe(true);
    expect(sqlite.prepare(
      "SELECT state, cleanup_state FROM build_asset_ingest_attempt WHERE asset_id = ?",
    ).get(body.asset_id)).toEqual({ state: "failed", cleanup_state: "expired" });
    expect(sqlite.prepare(
      "SELECT lease_generation, outcome FROM build_asset_ingest_seal WHERE asset_id = ? ORDER BY lease_generation",
    ).all(body.asset_id)).toEqual([
      { lease_generation: 0, outcome: "cleaned" },
      { lease_generation: 1, outcome: "cleaned" },
    ]);

    bucket.deleteFailures.clear();
    await cleanupExpiredBuildAssetUploads(env, Date.now() + 2 * 60 * 60 * 1000);
    expect(bucket.objects.has(attempt.staging_key)).toBe(false);
    expect(bucket.objects.has(finalKey)).toBe(false);
  });

  it("recovers a crash after failed verification claimed cleanup ownership", async () => {
    const bytes = Buffer.from("failed-verification-crash");
    const declared = await declare("1".repeat(64), bytes.length, "failed-verification-crash");
    const body = await declared.json() as any;
    const attempt = sqlite.prepare(
      "SELECT attempt, staging_key FROM build_asset_ingest_attempt WHERE asset_id = ?",
    ).get(body.asset_id) as any;
    const finalKey = `apps/app-1/build-ingest/verified/build-1/${body.asset_id}/g1/raft-computer`;
    const receipt = "verification_failed:sha256_mismatch:crashed-worker";
    bucket.objects.set(attempt.staging_key, bytes);
    bucket.objects.set(finalKey, bytes);
    sqlite.prepare(
      `UPDATE build_asset_ingest_attempt
          SET state = 'failed', cleanup_state = 'tombstoned', cleanup_receipt = ?
        WHERE asset_id = ? AND attempt = ?`,
    ).run(receipt, body.asset_id, attempt.attempt);
    sqlite.prepare(
      `INSERT INTO build_asset_ingest_seal
       (asset_id, attempt, lease_generation, final_key, intent_at)
       VALUES (?, ?, 1, ?, ?)`,
    ).run(body.asset_id, attempt.attempt, finalKey, Date.now());

    await cleanupExpiredBuildAssetUploads(env, Date.now() + 1);

    expect(bucket.objects.has(attempt.staging_key)).toBe(false);
    expect(bucket.objects.has(finalKey)).toBe(false);
    expect(sqlite.prepare(
      "SELECT state, cleanup_state FROM build_asset_ingest_attempt WHERE asset_id = ?",
    ).get(body.asset_id)).toEqual({ state: "failed", cleanup_state: "expired" });
    expect(sqlite.prepare(
      "SELECT lease_generation, outcome FROM build_asset_ingest_seal WHERE asset_id = ? ORDER BY lease_generation",
    ).all(body.asset_id)).toEqual([
      { lease_generation: 0, outcome: "cleaned" },
      { lease_generation: 1, outcome: "cleaned" },
    ]);
  });

  it("keeps successful staging cleanup retryable without deleting the committed final", async () => {
    const bytes = Buffer.from("ready-staging-delete-retry");
    const hash = createHash("sha256").update(bytes).digest("hex");
    const declared = await declare(hash, bytes.length, "ready-staging-delete-retry");
    const body = await declared.json() as any;
    const attempt = sqlite.prepare(
      "SELECT staging_key FROM build_asset_ingest_attempt WHERE asset_id = ?",
    ).get(body.asset_id) as any;
    bucket.objects.set(attempt.staging_key, bytes);
    bucket.deleteFailures.add(attempt.staging_key);

    const completed = await app.request(
      `http://hands.test/api/apps/app-1/builds/build-1/assets/${body.asset_id}/upload/complete`,
      { method: "POST" },
      env,
    );
    const completedBody = await completed.json() as any;
    expect(completed.status).toBe(200);
    expect(bucket.objects.has(attempt.staging_key)).toBe(true);
    expect(bucket.objects.has(completedBody.r2_key)).toBe(true);
    expect(sqlite.prepare(
      "SELECT outcome FROM build_asset_ingest_seal WHERE asset_id = ? AND lease_generation = 0",
    ).get(body.asset_id)).toEqual({ outcome: "cleaned" });

    bucket.deleteFailures.clear();
    await cleanupExpiredBuildAssetUploads(env, Date.now() + 16 * 60 * 1000);
    expect(bucket.objects.has(attempt.staging_key)).toBe(false);
    expect(bucket.objects.has(completedBody.r2_key)).toBe(true);
  });

  it("reaps an older verifier generation after a newer verifier commits", async () => {
    const bytes = Buffer.from("newer-verifier-wins");
    const hash = createHash("sha256").update(bytes).digest("hex");
    const declared = await declare(hash, bytes.length, "newer-verifier-wins");
    const body = await declared.json() as any;
    const attempt = sqlite.prepare(
      "SELECT attempt, staging_key FROM build_asset_ingest_attempt WHERE asset_id = ?",
    ).get(body.asset_id) as any;
    const staleFinalKey = `apps/app-1/build-ingest/verified/build-1/${body.asset_id}/g1/raft-computer`;
    bucket.objects.set(attempt.staging_key, bytes);
    bucket.objects.set(staleFinalKey, bytes);
    sqlite.prepare(
      `INSERT INTO build_asset_ingest_seal
       (asset_id, attempt, lease_generation, final_key, intent_at)
       VALUES (?, ?, 1, ?, ?)`,
    ).run(body.asset_id, attempt.attempt, staleFinalKey, Date.now() - 60_000);

    const completed = await app.request(
      `http://hands.test/api/apps/app-1/builds/build-1/assets/${body.asset_id}/upload/complete`,
      { method: "POST" },
      env,
    );
    const completedBody = await completed.json() as any;
    expect(completed.status).toBe(200);
    expect(completedBody.r2_key).toContain("/g2/");
    expect(sqlite.prepare(
      "SELECT lease_generation, outcome FROM build_asset_ingest_seal WHERE asset_id = ? ORDER BY lease_generation",
    ).all(body.asset_id)).toEqual([
      { lease_generation: 0, outcome: "cleaned" },
      { lease_generation: 1, outcome: "cleaned" },
      { lease_generation: 2, outcome: "committed" },
    ]);

    await cleanupExpiredBuildAssetUploads(env, Date.now() + 16 * 60 * 1000);
    expect(bucket.objects.has(staleFinalKey)).toBe(false);
    expect(bucket.objects.has(completedBody.r2_key)).toBe(true);
  });

  it("expires abandoned staging uploads without leaving a publishable asset", async () => {
    const bytes = Buffer.from("abandoned");
    const hash = createHash("sha256").update(bytes).digest("hex");
    const declared = await declare(hash, bytes.length);
    const body = await declared.json() as any;
    const attempt = sqlite.prepare("SELECT staging_key FROM build_asset_ingest_attempt WHERE asset_id = ?").get(body.asset_id) as any;
    bucket.objects.set(attempt.staging_key, bytes);
    sqlite.prepare("UPDATE build_asset_ingest_attempt SET upload_expires_at = 1 WHERE asset_id = ?").run(body.asset_id);

    await cleanupExpiredBuildAssetUploads(env, 2);
    expect(bucket.objects.has(attempt.staging_key)).toBe(false);
    expect(sqlite.prepare("SELECT 1 FROM build_assets WHERE id = ?").get(body.asset_id)).toBeUndefined();
    expect(sqlite.prepare("SELECT action FROM audit_logs WHERE action = 'build_asset.upload.expire'").get()).toEqual({ action: "build_asset.upload.expire" });
  });

  it("reaps a verifier PUT that lands after cleanup won and the worker crashed", async () => {
    const bytes = Buffer.from("late-verifier-put");
    const hash = createHash("sha256").update(bytes).digest("hex");
    const declared = await declare(hash, bytes.length, "late-verifier-put");
    const body = await declared.json() as any;
    const attempt = sqlite.prepare(
      "SELECT attempt, staging_key FROM build_asset_ingest_attempt WHERE asset_id = ?",
    ).get(body.asset_id) as any;
    const finalKey = `apps/app-1/build-ingest/verified/build-1/${body.asset_id}/g1/raft-computer`;
    bucket.objects.set(attempt.staging_key, bytes);
    sqlite.prepare(
      `UPDATE build_asset_ingest_attempt
          SET upload_expires_at = 1, state = 'verifying',
              verifier_lease_id = 'expired-verifier', verifier_lease_expires_at = 1
        WHERE asset_id = ?`,
    ).run(body.asset_id);
    sqlite.prepare(
      `INSERT INTO build_asset_ingest_seal
       (asset_id, attempt, lease_generation, final_key, intent_at)
       VALUES (?, ?, 1, ?, 1)`,
    ).run(body.asset_id, attempt.attempt, finalKey);

    // Cleanup wins after the lease expires. The final object does not exist yet,
    // then both the asset and attempt graph disappear as if this Worker exited.
    await cleanupExpiredBuildAssetUploads(env, 2);
    expect(sqlite.prepare("SELECT 1 FROM build_assets WHERE id = ?").get(body.asset_id)).toBeUndefined();
    expect(sqlite.prepare(
      "SELECT outcome FROM build_asset_ingest_seal WHERE asset_id = ? AND lease_generation = 1",
    ).get(body.asset_id)).toEqual({ outcome: "cleaned" });

    // The expired verifier's already-started PUT lands after that deletion. A
    // later cron has only the permanent seal ledger, and must still converge it.
    bucket.objects.set(finalKey, bytes);
    bucket.objects.set(attempt.staging_key, bytes);
    expect(bucket.objects.has(finalKey)).toBe(true);
    expect(bucket.objects.has(attempt.staging_key)).toBe(true);
    await cleanupExpiredBuildAssetUploads(env, 15 * 60 * 1000 + 3);
    expect(bucket.objects.has(finalKey)).toBe(false);
    expect(bucket.objects.has(attempt.staging_key)).toBe(false);
    expect(sqlite.prepare(
      "SELECT outcome FROM build_asset_ingest_seal WHERE asset_id = ? AND lease_generation = 1",
    ).get(body.asset_id)).toEqual({ outcome: "cleaned" });

    // There is no asserted finite completion bound for a PUT begun before its
    // signature expired. Old tombstones back off, but remain sweepable.
    bucket.objects.set(finalKey, bytes);
    await cleanupExpiredBuildAssetUploads(env, 8 * 24 * 60 * 60 * 1000);
    expect(bucket.objects.has(finalKey)).toBe(false);
  });

  it("does not reap objects when a verifier wins after cleanup selection", async () => {
    const bytes = Buffer.from("cleanup-race");
    const hash = createHash("sha256").update(bytes).digest("hex");
    const declared = await declare(hash, bytes.length, "cleanup-race");
    const body = await declared.json() as any;
    const attempt = sqlite.prepare("SELECT attempt, staging_key FROM build_asset_ingest_attempt WHERE asset_id = ?").get(body.asset_id) as any;
    const finalKey = `apps/app-1/build-ingest/verified/build-1/${body.asset_id}/g1/raft-computer`;
    bucket.objects.set(attempt.staging_key, bytes);
    sqlite.prepare("UPDATE build_asset_ingest_attempt SET upload_expires_at = 1 WHERE asset_id = ?").run(body.asset_id);

    let verifierWon = false;
    env.DB = d1(sqlite, (sql, kind) => {
      if (verifierWon || kind !== "all" || !sql.includes("ORDER BY i.upload_expires_at ASC")) return;
      verifierWon = sqlite.prepare(
        `UPDATE build_asset_ingest_attempt
            SET state = 'verifying', verifier_lease_id = 'cleanup-race-lease', verifier_lease_expires_at = 1000
          WHERE asset_id = ? AND cleanup_state = 'live'`,
      ).run(body.asset_id).changes === 1;
      sqlite.prepare(
        `INSERT INTO build_asset_ingest_seal
         (asset_id, attempt, lease_generation, final_key, intent_at)
         VALUES (?, ?, 1, ?, 2)`,
      ).run(body.asset_id, attempt.attempt, finalKey);
      bucket.objects.set(finalKey, bytes);
    });

    await cleanupExpiredBuildAssetUploads(env, 2);

    expect(verifierWon).toBe(true);
    expect(bucket.objects.has(attempt.staging_key)).toBe(true);
    expect(bucket.objects.has(finalKey)).toBe(true);
    expect(sqlite.prepare("SELECT state, cleanup_state FROM build_asset_ingest_attempt WHERE asset_id = ?").get(body.asset_id))
      .toEqual({ state: "verifying", cleanup_state: "live" });
    expect(sqlite.prepare("SELECT 1 FROM build_assets WHERE id = ?").get(body.asset_id)).toEqual({ 1: 1 });
  });

  it("does not abort objects when a verifier wins after the abort load", async () => {
    const bytes = Buffer.from("abort-race");
    const hash = createHash("sha256").update(bytes).digest("hex");
    const declared = await declare(hash, bytes.length, "abort-race");
    const body = await declared.json() as any;
    const attempt = sqlite.prepare("SELECT attempt, staging_key FROM build_asset_ingest_attempt WHERE asset_id = ?").get(body.asset_id) as any;
    const finalKey = `apps/app-1/build-ingest/verified/build-1/${body.asset_id}/g1/raft-computer`;
    bucket.objects.set(attempt.staging_key, bytes);

    let verifierWon = false;
    env.DB = d1(sqlite, (sql, kind) => {
      if (verifierWon || kind !== "first" || !sql.includes("WHERE b.app_id = ?1 AND b.id = ?2 AND a.id = ?3")) return;
      verifierWon = sqlite.prepare(
        `UPDATE build_asset_ingest_attempt
            SET state = 'verifying', verifier_lease_id = 'abort-race-lease', verifier_lease_expires_at = ?
          WHERE asset_id = ? AND cleanup_state = 'live'`,
      ).run(Date.now() + 60_000, body.asset_id).changes === 1;
      sqlite.prepare(
        `INSERT INTO build_asset_ingest_seal
         (asset_id, attempt, lease_generation, final_key, intent_at)
         VALUES (?, ?, 1, ?, ?)`,
      ).run(body.asset_id, attempt.attempt, finalKey, Date.now());
      bucket.objects.set(finalKey, bytes);
    });

    const aborted = await app.request(
      `http://hands.test/api/apps/app-1/builds/build-1/assets/${body.asset_id}/upload/abort`,
      { method: "POST" },
      env,
    );

    expect(verifierWon).toBe(true);
    expect(aborted.status).toBe(409);
    expect((await aborted.json() as any).code).toBe("ASSET_UPLOAD_BUSY");
    expect(bucket.objects.has(attempt.staging_key)).toBe(true);
    expect(bucket.objects.has(finalKey)).toBe(true);
    expect(sqlite.prepare("SELECT state, cleanup_state FROM build_asset_ingest_attempt WHERE asset_id = ?").get(body.asset_id))
      .toEqual({ state: "verifying", cleanup_state: "live" });
    expect(sqlite.prepare("SELECT 1 FROM build_assets WHERE id = ?").get(body.asset_id)).toEqual({ 1: 1 });
  });

  it("migrates an existing external build without changing its identity or read path before exact finalize", async () => {
    sqlite.prepare(
      `INSERT INTO builds
       (id, app_id, status, artifact_mode, asset_ingest_protocol_version, required_asset_slots_json, source, version_name, version_code)
       VALUES ('legacy-build', 'app-1', 'succeeded', 'external', NULL, NULL, 'external-import', '1.0.32', 1000032)`,
    ).run();
    const slot = { artifact_kind: "installable", platform: "darwin", arch: "arm64", variant: null, filetype: "bin" };
    const begun = await app.request("http://hands.test/api/apps/app-1/builds/legacy-build/hosted-migration", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        expected: { source: "external-import", version_name: "1.0.32", version_code: 1000032, artifact_mode: "external", status: "succeeded" },
        required_asset_slots_json: [slot],
      }),
    }, env);
    expect(begun.status).toBe(201);
    expect(sqlite.prepare("SELECT artifact_mode, status FROM builds WHERE id = 'legacy-build'").get()).toEqual({ artifact_mode: "external", status: "succeeded" });

    const bytes = Buffer.from("legacy-computer-bytes");
    const hash = createHash("sha256").update(bytes).digest("hex");
    const declared = await app.request("http://hands.test/api/apps/app-1/builds/legacy-build/assets/uploads", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ idempotency_key: "legacy-run", ...slot, sha256: hash, size_bytes: bytes.length, filename: "raft-computer" }),
    }, env);
    const declaredBody = await declared.json() as any;
    expect(declared.status).toBe(201);

    const premature = await app.request("http://hands.test/api/apps/app-1/builds/legacy-build/hosted-migration/complete", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ asset_ids: [declaredBody.asset_id] }),
    }, env);
    expect(premature.status).toBe(409);
    expect(sqlite.prepare("SELECT artifact_mode FROM builds WHERE id = 'legacy-build'").get()).toEqual({ artifact_mode: "external" });

    const attempt = sqlite.prepare("SELECT staging_key FROM build_asset_ingest_attempt WHERE asset_id = ?").get(declaredBody.asset_id) as any;
    bucket.objects.set(attempt.staging_key, bytes);
    const completed = await app.request(`http://hands.test/api/apps/app-1/builds/legacy-build/assets/${declaredBody.asset_id}/upload/complete`, { method: "POST" }, env);
    expect(completed.status).toBe(200);
    expect(sqlite.prepare("SELECT artifact_mode FROM builds WHERE id = 'legacy-build'").get()).toEqual({ artifact_mode: "external" });

    const finalized = await app.request("http://hands.test/api/apps/app-1/builds/legacy-build/hosted-migration/complete", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ asset_ids: [declaredBody.asset_id] }),
    }, env);
    expect(finalized.status).toBe(200);
    expect(sqlite.prepare("SELECT artifact_mode, status, source, version_name, version_code FROM builds WHERE id = 'legacy-build'").get()).toEqual({
      artifact_mode: "hands_r2", status: "succeeded", source: "external-import", version_name: "1.0.32", version_code: 1000032,
    });
  });
});
