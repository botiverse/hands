import type { Context } from "hono";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";
import { currentActor, type AdminEnv } from "../middleware/auth";
import { requestOrigin } from "../lib/origin";
import { presignR2DownloadUrl, presignR2UploadUrl } from "../lib/r2_presign";
import { createBuild, createBuildAsset, resolveChannelId } from "./builds";

type AdminContext = Context<AdminEnv & { Bindings: Env }>;
type JsonObject = Record<string, unknown>;

export const IOS_SIMULATOR_QA_PRODUCT_TYPE = "ios-simulator-qa";
export const IOS_SIMULATOR_ARTIFACT_KIND = "ios-simulator-app";
const IOS_SIMULATOR_SCHEMA = "hands.qa-artifact.ios-simulator.v1";
const MAX_ARTIFACT_BYTES = 500 * 1024 * 1024;
const UPLOAD_TTL_SECONDS = 3600;

interface CreateIosSimulatorArtifactInput {
  channel_id?: string;
  filename: string;
  size_bytes: number;
  sha256: string;
  source_commit: string;
  version_name: string;
  build_number: string | number;
  bundle_id: string;
  github_run_id: string | number;
  github_artifact_id?: string | number | null;
  github_repository?: string | null;
  github_job_id?: string | number | null;
  source_ref?: string | null;
  metadata_json?: JsonObject;
}

interface IosSimulatorArtifactRow {
  app_id: string;
  app_slug: string;
  build_id: string;
  asset_id: string;
  channel_id: string | null;
  channel: string | null;
  build_status: string;
  version_name: string;
  version_code: number;
  build_metadata_json: string;
  provenance_json: string;
  artifact_kind: string;
  platform: string;
  arch: string | null;
  variant: string | null;
  filetype: string;
  r2_key: string;
  file_hash: string;
  size_bytes: number;
  asset_metadata_json: string;
  download_count: number;
  created_at: number;
  completed_at: number | null;
}

function asTrimmedString(value: unknown, field: string, maxLength = 512): string {
  const normalized = String(value ?? "").trim();
  if (!normalized) throw new Error(`${field} required`);
  if (normalized.length > maxLength) throw new Error(`${field} is too long`);
  return normalized;
}

function normalizeFilename(value: unknown): string {
  const filename = asTrimmedString(value, "filename", 255);
  if (!/^[A-Za-z0-9][A-Za-z0-9._ -]*\.app\.zip$/i.test(filename)) {
    throw new Error("filename must be a safe basename ending with .app.zip");
  }
  return filename;
}

function normalizeSha256(value: unknown): string {
  const digest = asTrimmedString(value, "sha256", 64).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error("sha256 must be a 64-character hex digest");
  return digest;
}

function normalizeSourceCommit(value: unknown): string {
  const commit = asTrimmedString(value, "source_commit", 64).toLowerCase();
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit)) {
    throw new Error("source_commit must be a full 40- or 64-character git object id");
  }
  return commit;
}

function normalizeSize(value: unknown): number {
  const size = Number(value);
  if (!Number.isSafeInteger(size) || size <= 0) throw new Error("size_bytes must be a positive integer");
  if (size > MAX_ARTIFACT_BYTES) throw new Error("size_bytes exceeds the 500 MiB QA artifact limit");
  return size;
}

function normalizeBuildNumber(value: unknown): string {
  const buildNumber = asTrimmedString(value, "build_number", 128);
  if (!/^[A-Za-z0-9._+-]+$/.test(buildNumber)) {
    throw new Error("build_number contains unsupported characters");
  }
  return buildNumber;
}

function numericVersionCode(buildNumber: string): number {
  if (!/^\d+$/.test(buildNumber)) return 0;
  const value = Number(buildNumber);
  return Number.isSafeInteger(value) ? value : 0;
}

function normalizeInput(input: CreateIosSimulatorArtifactInput) {
  const filename = normalizeFilename(input.filename);
  const buildNumber = normalizeBuildNumber(input.build_number);
  const bundleId = asTrimmedString(input.bundle_id, "bundle_id", 255);
  if (!/^[A-Za-z0-9][A-Za-z0-9.-]+$/.test(bundleId) || !bundleId.includes(".")) {
    throw new Error("bundle_id must be a reverse-DNS identifier");
  }
  return {
    channel: input.channel_id ? asTrimmedString(input.channel_id, "channel_id", 128) : null,
    filename,
    sizeBytes: normalizeSize(input.size_bytes),
    sha256: normalizeSha256(input.sha256),
    sourceCommit: normalizeSourceCommit(input.source_commit),
    versionName: asTrimmedString(input.version_name, "version_name", 128),
    buildNumber,
    bundleId,
    githubRunId: asTrimmedString(input.github_run_id, "github_run_id", 128),
    githubArtifactId:
      input.github_artifact_id === undefined || input.github_artifact_id === null
        ? null
        : asTrimmedString(input.github_artifact_id, "github_artifact_id", 128),
    githubRepository: input.github_repository
      ? asTrimmedString(input.github_repository, "github_repository", 255)
      : null,
    githubJobId:
      input.github_job_id === undefined || input.github_job_id === null
        ? null
        : asTrimmedString(input.github_job_id, "github_job_id", 128),
    sourceRef: input.source_ref ? asTrimmedString(input.source_ref, "source_ref", 255) : null,
    metadata: input.metadata_json && typeof input.metadata_json === "object" && !Array.isArray(input.metadata_json)
      ? input.metadata_json
      : {},
  };
}

async function resolveQaChannel(db: D1Database, appId: string, requested: string | null): Promise<string | null> {
  if (requested) return resolveChannelId(db, appId, requested);
  const app = await db
    .prepare("SELECT default_channel_id FROM apps WHERE id = ?1")
    .bind(appId)
    .first<{ default_channel_id: string | null }>();
  if (!app) return null;
  if (app.default_channel_id) return app.default_channel_id;
  const channel = await db
    .prepare(
      `SELECT id FROM channels
       WHERE app_id = ?1
       ORDER BY CASE slug WHEN 'main' THEN 0 ELSE 1 END, created_at ASC
       LIMIT 1`,
    )
    .bind(appId)
    .first<{ id: string }>();
  return channel?.id ?? null;
}

function safeR2Filename(filename: string): string {
  return filename.replace(/[^A-Za-z0-9._-]+/g, "-");
}

function parseJsonObject(value: string): JsonObject {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

type ArtifactState = "pending_upload" | "verifying" | "ready" | "failed";

function artifactState(row: IosSimulatorArtifactRow): ArtifactState {
  const metadata = parseJsonObject(row.asset_metadata_json);
  if (metadata.upload_state === "verifying") return "verifying";
  if (metadata.upload_state === "ready") return "ready";
  if (metadata.upload_state === "failed") return "failed";
  return "pending_upload";
}

function completionConflict(c: Context<any>, state: ArtifactState) {
  if (state === "ready") {
    return c.json({ error: "QA artifact is already complete", code: "QA_ARTIFACT_ALREADY_COMPLETED" }, 409);
  }
  if (state === "failed") {
    return c.json({ error: "QA artifact verification has already failed", code: "QA_ARTIFACT_VERIFICATION_FAILED" }, 409);
  }
  return c.json({ error: "QA artifact verification is already in progress", code: "QA_ARTIFACT_VERIFICATION_IN_PROGRESS" }, 409);
}

function artifactResponse(c: Context<any>, row: IosSimulatorArtifactRow) {
  const origin = requestOrigin(c);
  const basePath = `/api/apps/${row.app_id}/qa-artifacts/ios-simulator/${row.asset_id}`;
  const provenance = parseJsonObject(row.provenance_json);
  const buildMetadata = parseJsonObject(row.build_metadata_json);
  const assetMetadata = parseJsonObject(row.asset_metadata_json);
  return {
    schema: IOS_SIMULATOR_SCHEMA,
    app_id: row.app_id,
    app_slug: row.app_slug,
    build_id: row.build_id,
    asset_id: row.asset_id,
    kind: row.artifact_kind,
    artifact_kind: row.artifact_kind,
    qa_only: true,
    release_offer_eligible: false,
    status: artifactState(row),
    channel_id: row.channel_id,
    channel: row.channel,
    filename: assetMetadata.filename,
    content_type: assetMetadata.content_type ?? "application/zip",
    size_bytes: row.size_bytes,
    sha256: row.file_hash,
    server_sha256: assetMetadata.verified_sha256 ?? null,
    source_commit: provenance.source_commit,
    source_ref: provenance.source_ref ?? null,
    version_name: row.version_name,
    version: row.version_name,
    version_code: row.version_code,
    build_number: buildMetadata.build_number,
    build_run_id: provenance.github_run_id,
    bundle_id: buildMetadata.bundle_id,
    github: {
      repository: provenance.github_repository ?? null,
      run_id: provenance.github_run_id,
      artifact_id: provenance.github_artifact_id ?? null,
      job_id: provenance.github_job_id ?? null,
    },
    verification: {
      verified_at: assetMetadata.verified_at ?? null,
      verified_sha256: assetMetadata.verified_sha256 ?? null,
      verified_size_bytes: assetMetadata.verified_size_bytes ?? null,
    },
    metadata: assetMetadata.metadata ?? {},
    created_at: row.created_at,
    completed_at: row.completed_at,
    download_count: row.download_count,
    artifact_api: `${origin}${basePath}`,
    download_api: `${origin}${basePath}/download`,
  };
}

async function getArtifactRow(
  db: D1Database,
  appId: string,
  assetId: string,
): Promise<IosSimulatorArtifactRow | null> {
  return db
    .prepare(
      `SELECT a.id AS app_id, a.slug AS app_slug,
              b.id AS build_id, ba.id AS asset_id,
              b.channel_id, c.slug AS channel, b.status AS build_status,
              b.version_name, b.version_code, b.build_metadata_json, b.provenance_json,
              ba.artifact_kind, ba.platform, ba.arch, ba.variant, ba.filetype,
              ba.r2_key, ba.file_hash, ba.size_bytes,
              ba.metadata_json AS asset_metadata_json,
              ba.download_count, ba.created_at, b.completed_at
       FROM build_assets ba
       JOIN builds b ON b.id = ba.build_id
       JOIN apps a ON a.id = b.app_id
       LEFT JOIN channels c ON c.id = b.channel_id
       WHERE a.id = ?1 AND ba.id = ?2
         AND b.product_type = ?3
         AND ba.artifact_kind = ?4
       LIMIT 1`,
    )
    .bind(appId, assetId, IOS_SIMULATOR_QA_PRODUCT_TYPE, IOS_SIMULATOR_ARTIFACT_KIND)
    .first<IosSimulatorArtifactRow>();
}

async function insertAuditLog(
  db: D1Database,
  appId: string,
  action: string,
  actor: string,
  payload: unknown,
) {
  await db
    .prepare(
      "INSERT INTO audit_logs (id, app_id, action, actor, payload, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
    )
    .bind(crypto.randomUUID(), appId, action, actor, JSON.stringify(payload), Date.now())
    .run();
}

export async function handleCreateIosSimulatorArtifact(c: AdminContext) {
  const appId = c.req.param("appId") ?? "";
  let input: ReturnType<typeof normalizeInput>;
  try {
    input = normalizeInput((await c.req.json()) as CreateIosSimulatorArtifactInput);
  } catch (error) {
    return c.json({ error: (error as Error).message, code: "INVALID_QA_ARTIFACT" }, 400);
  }

  const app = await c.env.DB
    .prepare("SELECT id, slug FROM apps WHERE id = ?1")
    .bind(appId)
    .first<{ id: string; slug: string }>();
  if (!app) return c.json({ error: "app not found" }, 404);

  const channelId = await resolveQaChannel(c.env.DB, appId, input.channel);
  if (!channelId) {
    return c.json(
      { error: input.channel ? "channel_id not found for app" : "app has no channel", code: "QA_CHANNEL_REQUIRED" },
      400,
    );
  }

  const buildId = crypto.randomUUID();
  const assetId = crypto.randomUUID();
  const safeFilename = safeR2Filename(input.filename);
  const stagingR2Key = `apps/${appId}/qa/ios-simulator/pending/${buildId}/${assetId}/${safeFilename}`;
  const finalR2Key = `apps/${appId}/qa/ios-simulator/verified/${buildId}/${assetId}/${safeFilename}`;
  const uploadUrl = await presignR2UploadUrl(c.env, stagingR2Key, "application/zip", UPLOAD_TTL_SECONDS);
  if (!uploadUrl) {
    return c.json({ error: "direct artifact uploads are unavailable", code: "QA_UPLOAD_UNAVAILABLE" }, 503);
  }

  const provenance = {
    schema: IOS_SIMULATOR_SCHEMA,
    source_commit: input.sourceCommit,
    source_ref: input.sourceRef,
    github_repository: input.githubRepository,
    github_run_id: input.githubRunId,
    github_artifact_id: input.githubArtifactId,
    github_job_id: input.githubJobId,
  };
  const buildMetadata = {
    schema: IOS_SIMULATOR_SCHEMA,
    qa_only: true,
    release_offer_eligible: false,
    bundle_id: input.bundleId,
    build_number: input.buildNumber,
  };
  const assetMetadata = {
    schema: IOS_SIMULATOR_SCHEMA,
    upload_state: "pending_upload",
    filename: input.filename,
    content_type: "application/zip",
    final_r2_key: finalR2Key,
    metadata: input.metadata,
  };

  try {
    await createBuild(
      c.env.DB,
      appId,
      {
        channel_id: channelId,
        product_type: IOS_SIMULATOR_QA_PRODUCT_TYPE,
        release_type: "qa",
        version_name: input.versionName,
        version_code: numericVersionCode(input.buildNumber),
        source: "qa-artifact",
        status: "pending",
        build_metadata_json: buildMetadata,
        provenance_json: provenance,
      },
      currentActor(c),
      buildId,
    );
    await createBuildAsset(
      c.env.DB,
      appId,
      buildId,
      {
        artifact_kind: IOS_SIMULATOR_ARTIFACT_KIND,
        platform: "ios-simulator",
        arch: "universal",
        variant: "app-bundle",
        filetype: "zip",
        r2_key: stagingR2Key,
        file_hash: input.sha256,
        size_bytes: input.sizeBytes,
        metadata_json: assetMetadata,
      },
      currentActor(c),
      assetId,
    );
  } catch (error) {
    await c.env.DB.prepare("DELETE FROM builds WHERE id = ?1 AND app_id = ?2").bind(buildId, appId).run();
    return c.json({ error: (error as Error).message, code: "QA_ARTIFACT_CREATE_FAILED" }, 400);
  }

  const row = await getArtifactRow(c.env.DB, appId, assetId);
  if (!row) return c.json({ error: "artifact creation failed" }, 500);
  return c.json(
    {
      ...artifactResponse(c, row),
      upload: {
        method: "PUT",
        url: uploadUrl,
        headers: { "content-type": "application/zip" },
        expires_in_seconds: UPLOAD_TTL_SECONDS,
      },
      complete_api: `${requestOrigin(c)}/api/apps/${appId}/qa-artifacts/ios-simulator/${assetId}/complete`,
    },
    201,
  );
}

async function hashObjectBody(body: ReadableStream<Uint8Array>): Promise<{ sha256: string; size: number }> {
  const digest = sha256.create();
  let size = 0;
  const reader = body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    size += value.byteLength;
    digest.update(value);
  }
  return { sha256: bytesToHex(digest.digest()), size };
}

function limitObjectBody(
  body: ReadableStream<Uint8Array>,
  maxBytes: number,
): ReadableStream<Uint8Array> {
  let seen = 0;
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        seen += chunk.byteLength;
        if (seen > maxBytes || seen > MAX_ARTIFACT_BYTES) {
          throw new Error("QA artifact stream exceeds the declared or maximum byte limit");
        }
        controller.enqueue(chunk);
      },
    }),
  );
}

async function transitionToVerifying(
  db: D1Database,
  row: IosSimulatorArtifactRow,
): Promise<boolean> {
  const metadata = {
    ...parseJsonObject(row.asset_metadata_json),
    upload_state: "verifying",
    verifying_started_at: Date.now(),
  };
  const result = await db
    .prepare(
      `UPDATE build_assets
       SET metadata_json = ?1
       WHERE id = ?2 AND build_id = ?3
         AND json_extract(metadata_json, '$.upload_state') = 'pending_upload'`,
    )
    .bind(JSON.stringify(metadata), row.asset_id, row.build_id)
    .run();
  return Number(result.meta?.changes ?? 0) === 1;
}

async function transitionFromVerifying(
  db: D1Database,
  row: IosSimulatorArtifactRow,
  state: "ready" | "failed",
  metadata: JsonObject,
  finalR2Key?: string,
): Promise<boolean> {
  const now = Date.now();
  const assetUpdate = state === "ready"
    ? db.prepare(
        `UPDATE build_assets
         SET r2_key = ?1, metadata_json = ?2
         WHERE id = ?3 AND build_id = ?4
           AND json_extract(metadata_json, '$.upload_state') = 'verifying'`,
      ).bind(finalR2Key, JSON.stringify(metadata), row.asset_id, row.build_id)
    : db.prepare(
        `UPDATE build_assets
         SET metadata_json = ?1
         WHERE id = ?2 AND build_id = ?3
           AND json_extract(metadata_json, '$.upload_state') = 'verifying'`,
      ).bind(JSON.stringify(metadata), row.asset_id, row.build_id);
  const buildUpdate = db.prepare(
    `UPDATE builds
     SET status = ?1, updated_at = ?2, completed_at = ?2
     WHERE id = ?3 AND app_id = ?4
       AND EXISTS (
         SELECT 1 FROM build_assets
         WHERE id = ?5 AND build_id = ?3
           AND json_extract(metadata_json, '$.upload_state') = ?6
       )`,
  ).bind(state === "ready" ? "succeeded" : "failed", now, row.build_id, row.app_id, row.asset_id, state);
  const results = await db.batch([assetUpdate, buildUpdate]);
  return Number(results[0]?.meta?.changes ?? 0) === 1 && Number(results[1]?.meta?.changes ?? 0) === 1;
}

async function failVerification(
  c: AdminContext,
  row: IosSimulatorArtifactRow,
  details: JsonObject,
  keysToDelete: string[],
) {
  await Promise.all(keysToDelete.map((key) => c.env.APK_BUCKET.delete(key).catch(() => {})));
  const metadata = {
    ...parseJsonObject(row.asset_metadata_json),
    upload_state: "failed",
    ...details,
    verified_at: Date.now(),
  };
  const changed = await transitionFromVerifying(c.env.DB, row, "failed", metadata);
  if (changed) {
    await insertAuditLog(c.env.DB, row.app_id, "qa_artifact.verify_failed", currentActor(c), {
      build_id: row.build_id,
      asset_id: row.asset_id,
      ...details,
    });
  }
}

export async function handleCompleteIosSimulatorArtifact(c: AdminContext) {
  const appId = c.req.param("appId") ?? "";
  const assetId = c.req.param("assetId") ?? "";
  const row = await getArtifactRow(c.env.DB, appId, assetId);
  if (!row) return c.json({ error: "QA artifact not found" }, 404);
  if (artifactState(row) !== "pending_upload") return completionConflict(c, artifactState(row));
  if (!(await transitionToVerifying(c.env.DB, row))) {
    const latest = await getArtifactRow(c.env.DB, appId, assetId);
    return completionConflict(c, latest ? artifactState(latest) : "verifying");
  }

  const head = await c.env.APK_BUCKET.head(row.r2_key);
  if (!head) {
    await failVerification(c, row, { verification_error: "upload_not_found" }, []);
    return c.json({ error: "uploaded object not found", code: "QA_UPLOAD_NOT_FOUND" }, 409);
  }
  if (head.size !== row.size_bytes || head.size > MAX_ARTIFACT_BYTES) {
    await failVerification(
      c,
      row,
      {
        verification_error: head.size > MAX_ARTIFACT_BYTES ? "object_too_large" : "size_mismatch",
        expected_size_bytes: row.size_bytes,
        actual_size_bytes: head.size,
      },
      [row.r2_key],
    );
    return c.json(
      {
        error: "uploaded artifact size does not match the declaration",
        code: "QA_ARTIFACT_INTEGRITY_MISMATCH",
        expected: { sha256: row.file_hash, size_bytes: row.size_bytes },
        actual: { sha256: null, size_bytes: head.size },
      },
      422,
    );
  }

  const object = await c.env.APK_BUCKET.get(row.r2_key);
  if (!object) {
    await failVerification(c, row, { verification_error: "upload_disappeared" }, []);
    return c.json({ error: "uploaded object disappeared", code: "QA_UPLOAD_NOT_FOUND" }, 409);
  }
  if (object.size !== row.size_bytes || object.size > MAX_ARTIFACT_BYTES) {
    await failVerification(
      c,
      row,
      {
        verification_error: object.size > MAX_ARTIFACT_BYTES ? "object_too_large" : "size_mismatch",
        expected_size_bytes: row.size_bytes,
        actual_size_bytes: object.size,
      },
      [row.r2_key],
    );
    return c.json(
      {
        error: "uploaded artifact size changed before verification",
        code: "QA_ARTIFACT_INTEGRITY_MISMATCH",
        expected: { sha256: row.file_hash, size_bytes: row.size_bytes },
        actual: { sha256: null, size_bytes: object.size },
      },
      422,
    );
  }

  const existingMetadata = parseJsonObject(row.asset_metadata_json);
  const finalR2Key = typeof existingMetadata.final_r2_key === "string"
    ? existingMetadata.final_r2_key
    : null;
  if (!finalR2Key || !finalR2Key.startsWith(`apps/${appId}/qa/ios-simulator/verified/${row.build_id}/${assetId}/`)) {
    await failVerification(c, row, { verification_error: "invalid_final_storage_key" }, [row.r2_key]);
    return c.json({ error: "QA artifact final storage key is invalid", code: "QA_ARTIFACT_STORAGE_INVALID" }, 500);
  }
  if (await c.env.APK_BUCKET.head(finalR2Key)) {
    await failVerification(c, row, { verification_error: "immutable_key_conflict" }, [row.r2_key]);
    return c.json({ error: "QA artifact immutable storage key already exists", code: "QA_ARTIFACT_IMMUTABLE_CONFLICT" }, 409);
  }

  // Hash and seal the exact same R2 object-body snapshot. `tee()` duplicates
  // one byte stream; we never re-read the mutable staging key after hashing,
  // so a still-valid presigned PUT cannot create a hash/copy TOCTOU window.
  const limitedBody = limitObjectBody(object.body, row.size_bytes);
  const [hashStream, sealStream] = limitedBody.tee();
  const [hashResult, sealResult] = await Promise.allSettled([
    hashObjectBody(hashStream),
    c.env.APK_BUCKET.put(finalR2Key, sealStream, {
      httpMetadata: { contentType: "application/zip" },
      customMetadata: {
        sha256: row.file_hash,
        build_id: row.build_id,
        asset_id: assetId,
      },
    }),
  ]);
  if (hashResult.status === "rejected" || sealResult.status === "rejected") {
    await failVerification(
      c,
      row,
      {
        verification_error: "stream_or_seal_failed",
        detail: hashResult.status === "rejected"
          ? String(hashResult.reason)
          : String((sealResult as PromiseRejectedResult).reason),
      },
      [row.r2_key, finalR2Key],
    );
    return c.json({ error: "failed to verify and seal QA artifact", code: "QA_ARTIFACT_SEAL_FAILED" }, 422);
  }

  const actual = hashResult.value;
  if (actual.size !== row.size_bytes || actual.sha256 !== row.file_hash.toLowerCase()) {
    await failVerification(
      c,
      row,
      {
        verification_error: actual.size !== row.size_bytes ? "size_mismatch" : "sha256_mismatch",
        expected_sha256: row.file_hash,
        actual_sha256: actual.sha256,
        expected_size_bytes: row.size_bytes,
        actual_size_bytes: actual.size,
        verified_size_bytes: actual.size,
        verified_sha256: actual.sha256,
      },
      [row.r2_key, finalR2Key],
    );
    return c.json(
      {
        error: "uploaded artifact does not match the declared exact bytes",
        code: "QA_ARTIFACT_INTEGRITY_MISMATCH",
        expected: { sha256: row.file_hash, size_bytes: row.size_bytes },
        actual: { sha256: actual.sha256, size_bytes: actual.size },
      },
      422,
    );
  }

  const now = Date.now();
  const finalHead = await c.env.APK_BUCKET.head(finalR2Key);
  if (!finalHead || finalHead.size !== actual.size) {
    await failVerification(
      c,
      row,
      {
        verification_error: "sealed_size_mismatch",
        expected_size_bytes: actual.size,
        actual_size_bytes: finalHead?.size ?? null,
      },
      [row.r2_key, finalR2Key],
    );
    return c.json({ error: "failed to seal immutable QA artifact", code: "QA_ARTIFACT_SEAL_FAILED" }, 500);
  }
  const metadata = {
    ...existingMetadata,
    upload_state: "ready",
    verified_size_bytes: actual.size,
    verified_sha256: actual.sha256,
    verified_at: now,
  };
  const ready = await transitionFromVerifying(c.env.DB, row, "ready", metadata, finalR2Key);
  if (!ready) {
    await Promise.all([c.env.APK_BUCKET.delete(row.r2_key), c.env.APK_BUCKET.delete(finalR2Key)]);
    return c.json({ error: "QA artifact verification state changed unexpectedly", code: "QA_ARTIFACT_STATE_CONFLICT" }, 409);
  }
  await c.env.APK_BUCKET.delete(row.r2_key);
  await insertAuditLog(c.env.DB, appId, "qa_artifact.complete", currentActor(c), {
    build_id: row.build_id,
    asset_id: assetId,
    sha256: actual.sha256,
    size_bytes: actual.size,
  });
  const completed = await getArtifactRow(c.env.DB, appId, assetId);
  return c.json(artifactResponse(c, completed!));
}

export async function handleGetIosSimulatorArtifact(c: Context<{ Bindings: Env }>) {
  const row = await getArtifactRow(
    c.env.DB,
    c.req.param("appId") ?? "",
    c.req.param("assetId") ?? "",
  );
  if (!row) return c.json({ error: "QA artifact not found" }, 404);
  return c.json(artifactResponse(c, row));
}

export async function handleListIosSimulatorArtifacts(c: Context<{ Bindings: Env }>) {
  const appId = c.req.param("appId") ?? "";
  const conditions = ["a.id = ?1", "b.product_type = ?2", "ba.artifact_kind = ?3"];
  const binds: Array<string | number> = [appId, IOS_SIMULATOR_QA_PRODUCT_TYPE, IOS_SIMULATOR_ARTIFACT_KIND];
  const sourceCommit = c.req.query("source_commit")?.trim().toLowerCase();
  const githubRunId = c.req.query("github_run_id")?.trim();
  const declaredSha = c.req.query("sha256")?.trim().toLowerCase();
  if (sourceCommit) {
    conditions.push(`json_extract(b.provenance_json, '$.source_commit') = ?${binds.length + 1}`);
    binds.push(sourceCommit);
  }
  if (githubRunId) {
    conditions.push(`json_extract(b.provenance_json, '$.github_run_id') = ?${binds.length + 1}`);
    binds.push(githubRunId);
  }
  if (declaredSha) {
    conditions.push(`ba.file_hash = ?${binds.length + 1}`);
    binds.push(declaredSha);
  }
  const { results } = await c.env.DB
    .prepare(
      `SELECT a.id AS app_id, a.slug AS app_slug,
              b.id AS build_id, ba.id AS asset_id,
              b.channel_id, c.slug AS channel, b.status AS build_status,
              b.version_name, b.version_code, b.build_metadata_json, b.provenance_json,
              ba.artifact_kind, ba.platform, ba.arch, ba.variant, ba.filetype,
              ba.r2_key, ba.file_hash, ba.size_bytes,
              ba.metadata_json AS asset_metadata_json,
              ba.download_count, ba.created_at, b.completed_at
       FROM build_assets ba
       JOIN builds b ON b.id = ba.build_id
       JOIN apps a ON a.id = b.app_id
       LEFT JOIN channels c ON c.id = b.channel_id
       WHERE ${conditions.join(" AND ")}
       ORDER BY ba.created_at DESC
       LIMIT 100`,
    )
    .bind(...binds)
    .all<IosSimulatorArtifactRow>();
  return c.json({ artifacts: results.map((row) => artifactResponse(c, row)) });
}

export async function handleDownloadIosSimulatorArtifact(c: Context<{ Bindings: Env }>) {
  const appId = c.req.param("appId") ?? "";
  const assetId = c.req.param("assetId") ?? "";
  const row = await getArtifactRow(c.env.DB, appId, assetId);
  if (!row) return c.json({ error: "QA artifact not found" }, 404);
  if (artifactState(row) !== "ready") {
    return c.json({ error: "QA artifact is not ready", code: "QA_ARTIFACT_NOT_READY" }, 409);
  }
  const metadata = parseJsonObject(row.asset_metadata_json);
  const filename = typeof metadata.filename === "string" ? metadata.filename : `${assetId}.app.zip`;
  const disposition = `attachment; filename="${filename.replace(/["\\]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
  const objectHead = await c.env.APK_BUCKET.head(row.r2_key);
  if (!objectHead) return c.json({ error: "stored object not found" }, 404);

  if (c.req.query("presign") === "1") {
    const ttl = Number(c.env.R2_PRESIGNED_DOWNLOAD_TTL_SECONDS ?? c.env.SIGNED_URL_TTL_SECONDS ?? "3600");
    const url = await presignR2DownloadUrl(c.env, {
      key: row.r2_key,
      filetype: "zip",
      contentDisposition: disposition,
    }, ttl);
    if (!url) return c.json({ error: "presigned downloads are unavailable" }, 503);
    return c.json({
      build_id: row.build_id,
      asset_id: row.asset_id,
      filename,
      size_bytes: row.size_bytes,
      sha256: row.file_hash,
      download_url: url,
    });
  }

  const object = await c.env.APK_BUCKET.get(row.r2_key);
  if (!object) return c.json({ error: "stored object not found" }, 404);
  await c.env.DB
    .prepare("UPDATE build_assets SET download_count = download_count + 1 WHERE id = ?1")
    .bind(assetId)
    .run();
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("content-type", "application/zip");
  headers.set("content-length", String(row.size_bytes));
  headers.set("content-disposition", disposition);
  headers.set("cache-control", "private, max-age=0, no-store");
  headers.set("etag", object.httpEtag);
  return new Response(object.body, { headers });
}
