import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";
import type { Context } from "hono";
import { currentActor, type AdminEnv } from "../middleware/auth";
import { presignR2UploadUrl } from "../lib/r2_presign";

type AdminContext = Context<AdminEnv & { Bindings: Env }>;

const DIRECT_UPLOAD_PROTOCOL = 1;
const MAX_ASSET_BYTES = 5 * 1024 * 1024 * 1024;
const UPLOAD_TTL_SECONDS = 3600;
const VERIFY_LEASE_MS = 15 * 60 * 1000;
const CLEANED_SEAL_RETRY_MS = VERIFY_LEASE_MS;
const CLEANED_SEAL_FAST_WINDOW_MS = 24 * 60 * 60 * 1000;
const CLEANED_SEAL_MEDIUM_WINDOW_MS = 7 * CLEANED_SEAL_FAST_WINDOW_MS;
const CLEANED_SEAL_MEDIUM_RETRY_MS = 60 * 60 * 1000;
const CLEANED_SEAL_SLOW_RETRY_MS = 24 * 60 * 60 * 1000;

type CleanupReason = "aborted" | "upload_expired";

export interface DirectBuildAssetUploadInput {
  idempotency_key: string;
  artifact_kind?: string;
  platform: string;
  arch?: string | null;
  variant?: string | null;
  filetype: string;
  sha256: string;
  size_bytes: number;
  filename: string;
  content_type?: string;
  metadata_json?: Record<string, unknown>;
}

interface DirectUploadRow {
  app_id: string;
  build_id: string;
  build_status: string;
  artifact_mode: string;
  asset_id: string;
  artifact_kind: string;
  platform: string;
  arch: string | null;
  variant: string | null;
  filetype: string;
  r2_key: string;
  file_hash: string;
  size_bytes: number;
  metadata_json: string;
  attempt: number;
  staging_key: string;
  upload_expires_at: number;
  state: "pending" | "verifying" | "ready" | "failed" | "expired";
  committed_final_key: string | null;
  verifier_lease_expires_at: number | null;
}

interface HostedMigrationBeginInput {
  expected: {
    source: string;
    version_name: string;
    version_code: number;
    artifact_mode: "external";
    status: "succeeded";
  };
  required_asset_slots_json: RequiredAssetSlot[];
}

interface RequiredAssetSlot {
  artifact_kind?: unknown;
  platform?: unknown;
  arch?: unknown;
  variant?: unknown;
  filetype?: unknown;
}

function requiredString(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string") throw new Error(`${field} required`);
  const normalized = value.trim();
  if (!normalized) throw new Error(`${field} required`);
  if (normalized.length > maxLength) throw new Error(`${field} is too long`);
  return normalized;
}

function nullableSlotValue(value: unknown, field: string): string | null {
  if (value === undefined || value === null || value === "") return null;
  const normalized = requiredString(value, field, 100);
  if (normalized === "-") throw new Error(`${field} cannot be '-'`);
  return normalized;
}

function safeFilename(value: unknown): string {
  const normalized = requiredString(value, "filename", 255);
  const safe = normalized.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "");
  if (!safe) throw new Error("filename has no safe characters");
  return safe.slice(0, 180);
}

function sha256Digest(value: unknown): string {
  const normalized = requiredString(value, "sha256", 64).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(normalized)) {
    throw new Error("sha256 must be a 64-character hexadecimal digest");
  }
  return normalized;
}

function normalizedInput(value: DirectBuildAssetUploadInput) {
  const sizeBytes = Number(value.size_bytes);
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 1 || sizeBytes > MAX_ASSET_BYTES) {
    throw new Error(`size_bytes must be 1-${MAX_ASSET_BYTES}`);
  }
  const idempotencyKey = requiredString(value.idempotency_key, "idempotency_key", 200);
  if (!/^[A-Za-z0-9._:-]+$/.test(idempotencyKey)) {
    throw new Error("idempotency_key contains unsupported characters");
  }
  const metadata = value.metadata_json && typeof value.metadata_json === "object"
    ? value.metadata_json
    : {};
  return {
    idempotencyKey,
    artifactKind: requiredString(value.artifact_kind ?? "installable", "artifact_kind", 100),
    platform: requiredString(value.platform, "platform", 100),
    arch: nullableSlotValue(value.arch, "arch"),
    variant: nullableSlotValue(value.variant, "variant"),
    filetype: requiredString(value.filetype, "filetype", 100),
    sha256: sha256Digest(value.sha256),
    sizeBytes,
    filename: safeFilename(value.filename),
    contentType: requiredString(value.content_type ?? "application/octet-stream", "content_type", 150),
    metadata,
  };
}

function slotKey(slot: {
  artifactKind: string;
  platform: string;
  arch: string | null;
  variant: string | null;
  filetype: string;
}): string {
  return JSON.stringify([
    slot.artifactKind,
    slot.platform,
    slot.arch,
    slot.variant,
    slot.filetype,
  ]);
}

function requiredSlotKeys(raw: string | null): Set<string> {
  if (!raw) return new Set();
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) throw new Error("required_asset_slots_json must be an array");
  return new Set(parsed.map((entry) => {
    const slot = (entry ?? {}) as RequiredAssetSlot;
    return slotKey({
      artifactKind: requiredString(slot.artifact_kind ?? "installable", "artifact_kind", 100),
      platform: requiredString(slot.platform, "platform", 100),
      arch: nullableSlotValue(slot.arch, "arch"),
      variant: nullableSlotValue(slot.variant, "variant"),
      filetype: requiredString(slot.filetype, "filetype", 100),
    });
  }));
}

function normalizedRequiredSlots(value: unknown): { json: string; keys: Set<string> } {
  if (!Array.isArray(value) || value.length === 0) throw new Error("required_asset_slots_json must contain at least one slot");
  const slots = value.map((entry) => {
    const slot = (entry ?? {}) as RequiredAssetSlot;
    return {
      artifact_kind: requiredString(slot.artifact_kind ?? "installable", "artifact_kind", 100),
      platform: requiredString(slot.platform, "platform", 100),
      arch: nullableSlotValue(slot.arch, "arch"),
      variant: nullableSlotValue(slot.variant, "variant"),
      filetype: requiredString(slot.filetype, "filetype", 100),
    };
  });
  const keys = new Set(slots.map((slot) => slotKey({
    artifactKind: slot.artifact_kind,
    platform: slot.platform,
    arch: slot.arch,
    variant: slot.variant,
    filetype: slot.filetype,
  })));
  if (keys.size !== slots.length) throw new Error("required_asset_slots_json contains a duplicate slot");
  return { json: JSON.stringify(slots), keys };
}

function requestDigest(input: ReturnType<typeof normalizedInput>): string {
  return bytesToHex(sha256(new TextEncoder().encode(JSON.stringify({
    artifact_kind: input.artifactKind,
    platform: input.platform,
    arch: input.arch,
    variant: input.variant,
    filetype: input.filetype,
    sha256: input.sha256,
    size_bytes: input.sizeBytes,
    filename: input.filename,
    content_type: input.contentType,
    metadata_json: input.metadata,
  }))));
}

function uploadResponse(
  c: AdminContext,
  row: DirectUploadRow,
  uploadUrl: string | null,
  replayed: boolean,
) {
  const ready = row.state === "ready";
  const metadata = JSON.parse(row.metadata_json) as Record<string, unknown>;
  return c.json({
    asset_id: row.asset_id,
    attempt: row.attempt,
    state: row.state,
    replayed,
    upload: ready || row.state !== "pending" || !uploadUrl ? null : {
      method: "PUT",
      url: uploadUrl,
      headers: { "content-type": String(metadata.content_type ?? "application/octet-stream") },
      expires_at: row.upload_expires_at,
    },
    complete_url: `${new URL(c.req.url).origin}/api/apps/${row.app_id}/builds/${row.build_id}/assets/${row.asset_id}/upload/complete`,
  }, replayed ? 200 : 201);
}

async function findUploadByReplay(
  db: D1Database,
  appId: string,
  buildId: string,
  idempotencyKey: string,
): Promise<(DirectUploadRow & { request_digest: string }) | null> {
  return await db.prepare(
    `SELECT b.app_id, b.id AS build_id, b.status AS build_status, b.artifact_mode,
            a.id AS asset_id, a.artifact_kind, a.platform, a.arch, a.variant,
            a.filetype, a.r2_key, a.file_hash, a.size_bytes, a.metadata_json,
            i.attempt, i.staging_key, i.upload_expires_at, i.state,
            i.committed_final_key, i.verifier_lease_expires_at,
            r.request_digest
       FROM build_asset_ingest_replay r
       JOIN builds b ON b.app_id = r.app_id AND b.id = r.build_id
       JOIN build_assets a ON a.build_id = r.build_id AND a.id = r.asset_id
       JOIN build_asset_ingest_attempt i ON i.asset_id = a.id
      WHERE r.app_id = ?1 AND r.build_id = ?2 AND r.idempotency_key = ?3
      ORDER BY i.attempt DESC LIMIT 1`,
  ).bind(appId, buildId, idempotencyKey).first<DirectUploadRow & { request_digest: string }>();
}

export async function handleDeclareBuildAssetUpload(c: AdminContext) {
  const appId = c.req.param("appId") ?? "";
  const buildId = c.req.param("buildId") ?? "";
  let input: ReturnType<typeof normalizedInput>;
  try {
    input = normalizedInput(await c.req.json() as DirectBuildAssetUploadInput);
  } catch (error) {
    return c.json({ error: (error as Error).message, code: "INVALID_ASSET_UPLOAD" }, 400);
  }
  const digest = requestDigest(input);
  const replay = await findUploadByReplay(c.env.DB, appId, buildId, input.idempotencyKey);
  if (replay) {
    if (replay.request_digest !== digest) {
      return c.json({ error: "idempotency_key was already used for a different upload", code: "ASSET_UPLOAD_REPLAY_CONFLICT" }, 409);
    }
    if (replay.state === "pending" && replay.upload_expires_at <= Date.now()) {
      return c.json({ error: "asset upload expired", code: "ASSET_UPLOAD_EXPIRED", asset_id: replay.asset_id }, 410);
    }
    const contentType = String((JSON.parse(replay.metadata_json) as Record<string, unknown>).content_type ?? "application/octet-stream");
    const uploadUrl = replay.state !== "pending"
      ? null
      : await presignR2UploadUrl(c.env, replay.staging_key, contentType, Math.max(1, Math.floor((replay.upload_expires_at - Date.now()) / 1000)));
    if (replay.state === "pending" && !uploadUrl) {
      return c.json({ error: "direct uploads are unavailable", code: "ASSET_UPLOAD_UNAVAILABLE" }, 503);
    }
    return uploadResponse(c, replay, uploadUrl, true);
  }

  const build = await c.env.DB.prepare(
    `SELECT id, status, artifact_mode, asset_ingest_protocol_version, required_asset_slots_json
       FROM builds WHERE app_id = ?1 AND id = ?2`,
  ).bind(appId, buildId).first<{
    id: string;
    status: string;
    artifact_mode: string;
    asset_ingest_protocol_version: number | null;
    required_asset_slots_json: string | null;
  }>();
  if (!build) return c.json({ error: "build not found", code: "BUILD_NOT_FOUND" }, 404);
  const newBuildUpload = build.status === "pending" && build.artifact_mode === "hands_r2";
  const migrationUpload = build.status === "succeeded" && build.artifact_mode === "external";
  if (!newBuildUpload && !migrationUpload) {
    return c.json({ error: "direct asset uploads require a pending Hands-hosted build or an initialized external-build migration", code: "BUILD_NOT_UPLOADABLE" }, 409);
  }
  if (build.asset_ingest_protocol_version !== DIRECT_UPLOAD_PROTOCOL) {
    return c.json({ error: "build does not use direct asset ingest protocol v1", code: "ASSET_INGEST_PROTOCOL_REQUIRED" }, 409);
  }
  let required: Set<string>;
  try {
    required = requiredSlotKeys(build.required_asset_slots_json);
  } catch (error) {
    return c.json({ error: (error as Error).message, code: "INVALID_REQUIRED_ASSET_SLOTS" }, 500);
  }
  const declaredSlot = slotKey(input);
  if (!required.has(declaredSlot)) {
    return c.json({ error: "asset slot was not declared when the build was created", code: "ASSET_SLOT_NOT_REQUIRED" }, 409);
  }

  const assetId = crypto.randomUUID();
  const attempt = 1;
  const now = Date.now();
  const uploadExpiresAt = now + UPLOAD_TTL_SECONDS * 1000;
  const stagingKey = `apps/${appId}/build-ingest/pending/${buildId}/${assetId}/${attempt}/${input.filename}`;
  const uploadUrl = await presignR2UploadUrl(c.env, stagingKey, input.contentType, UPLOAD_TTL_SECONDS);
  if (!uploadUrl) {
    return c.json({ error: "direct uploads are unavailable", code: "ASSET_UPLOAD_UNAVAILABLE" }, 503);
  }
  const metadata = JSON.stringify({
    ...input.metadata,
    filename: input.filename,
    content_type: input.contentType,
    upload_state: "pending_upload",
  });
  try {
    await c.env.DB.batch([
      c.env.DB.prepare(
        `INSERT INTO build_assets
         (id, build_id, artifact_kind, platform, arch, variant, filetype, r2_key,
          file_hash, size_bytes, metadata_json, download_count, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 0, ?12)`,
      ).bind(
        assetId, buildId, input.artifactKind, input.platform, input.arch, input.variant,
        input.filetype, stagingKey, input.sha256, input.sizeBytes, metadata, now,
      ),
      c.env.DB.prepare(
        `INSERT INTO build_asset_ingest_attempt
         (asset_id, attempt, declared_sha256, declared_size, staging_key,
          upload_expires_at, state, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'pending', ?7)`,
      ).bind(assetId, attempt, input.sha256, input.sizeBytes, stagingKey, uploadExpiresAt, now),
      c.env.DB.prepare(
        `INSERT INTO build_asset_ingest_replay
         (app_id, build_id, idempotency_key, asset_id, request_digest, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
      ).bind(appId, buildId, input.idempotencyKey, assetId, digest, now),
      c.env.DB.prepare(
        `INSERT INTO audit_logs (id, app_id, action, actor, payload, created_at)
         VALUES (?1, ?2, 'build_asset.upload.declare', ?3, ?4, ?5)`,
      ).bind(
        crypto.randomUUID(), appId, currentActor(c),
        JSON.stringify({ build_id: buildId, asset_id: assetId, attempt, slot: JSON.parse(declaredSlot), size_bytes: input.sizeBytes, sha256: input.sha256 }),
        now,
      ),
    ]);
  } catch (error) {
    const concurrent = await findUploadByReplay(c.env.DB, appId, buildId, input.idempotencyKey);
    if (concurrent && concurrent.request_digest === digest) {
      const concurrentMetadata = JSON.parse(concurrent.metadata_json) as Record<string, unknown>;
      const concurrentUploadUrl = concurrent.state !== "pending"
        ? null
        : await presignR2UploadUrl(
            c.env,
            concurrent.staging_key,
            String(concurrentMetadata.content_type ?? "application/octet-stream"),
            Math.max(1, Math.floor((concurrent.upload_expires_at - Date.now()) / 1000)),
          );
      if (concurrent.state === "pending" && !concurrentUploadUrl) {
        return c.json({ error: "direct uploads are unavailable", code: "ASSET_UPLOAD_UNAVAILABLE" }, 503);
      }
      return uploadResponse(c, concurrent, concurrentUploadUrl, true);
    }
    return c.json({ error: (error as Error).message, code: "ASSET_UPLOAD_DECLARE_FAILED" }, 409);
  }
  return uploadResponse(c, {
    app_id: appId,
    build_id: buildId,
    build_status: build.status,
    artifact_mode: build.artifact_mode,
    asset_id: assetId,
    artifact_kind: input.artifactKind,
    platform: input.platform,
    arch: input.arch,
    variant: input.variant,
    filetype: input.filetype,
    r2_key: stagingKey,
    file_hash: input.sha256,
    size_bytes: input.sizeBytes,
    metadata_json: metadata,
    attempt,
    staging_key: stagingKey,
    upload_expires_at: uploadExpiresAt,
    state: "pending",
    committed_final_key: null,
    verifier_lease_expires_at: null,
  }, uploadUrl, false);
}

async function loadUpload(db: D1Database, appId: string, buildId: string, assetId: string) {
  return await db.prepare(
    `SELECT b.app_id, b.id AS build_id, b.status AS build_status, b.artifact_mode,
            a.id AS asset_id, a.artifact_kind, a.platform, a.arch, a.variant,
            a.filetype, a.r2_key, a.file_hash, a.size_bytes, a.metadata_json,
            i.attempt, i.staging_key, i.upload_expires_at, i.state,
            i.committed_final_key, i.verifier_lease_expires_at
       FROM builds b
       JOIN build_assets a ON a.build_id = b.id
       JOIN build_asset_ingest_attempt i ON i.asset_id = a.id
      WHERE b.app_id = ?1 AND b.id = ?2 AND a.id = ?3
      ORDER BY i.attempt DESC LIMIT 1`,
  ).bind(appId, buildId, assetId).first<DirectUploadRow>();
}

async function claimUploadCleanup(
  db: D1Database,
  assetId: string,
  attempt: number,
  now: number,
  reason: CleanupReason,
): Promise<string | null> {
  const receipt = `${reason}:${crypto.randomUUID()}`;
  const claim = await db.prepare(
    `UPDATE build_asset_ingest_attempt
        SET state = 'expired', cleanup_state = 'tombstoned', cleanup_receipt = ?1,
            verifier_lease_id = NULL, verifier_lease_expires_at = NULL
      WHERE asset_id = ?2 AND attempt = ?3 AND cleanup_state = 'live'
        AND state <> 'ready'
        AND NOT (state = 'verifying' AND verifier_lease_expires_at >= ?4)`,
  ).bind(receipt, assetId, attempt, now).run();
  return (claim.meta?.changes ?? 0) === 1 ? receipt : null;
}

async function deleteClaimedUploadObjects(
  env: Env,
  row: { asset_id: string; attempt: number; staging_key: string },
  receipt: string,
  now: number,
): Promise<{ prepared: boolean; deleted: boolean }> {
  // Persist every exact key before deleting anything. Generation zero is reserved
  // for the staging object; verifier generations start at one. These `cleaned`
  // rows intentionally outlive the asset, so a PUT that was already in flight
  // when cleanup won remains discoverable after the attempt graph is removed.
  await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO build_asset_ingest_seal
       (asset_id, attempt, lease_generation, final_key, intent_at, sealed_at, outcome, cleanup_receipt)
       SELECT asset_id, attempt, 0, staging_key, ?1, ?1, 'cleaned', ?2
         FROM build_asset_ingest_attempt
        WHERE asset_id = ?3 AND attempt = ?4
          AND cleanup_state = 'tombstoned' AND cleanup_receipt = ?2`,
    ).bind(now, receipt, row.asset_id, row.attempt),
    env.DB.prepare(
      `UPDATE build_asset_ingest_seal
          SET outcome = 'cleaned', cleanup_receipt = ?1, sealed_at = ?2
        WHERE asset_id = ?3 AND attempt = ?4 AND outcome IS NULL
          AND EXISTS (
            SELECT 1 FROM build_asset_ingest_attempt i
             WHERE i.asset_id = ?3 AND i.attempt = ?4
               AND i.cleanup_state = 'tombstoned' AND i.cleanup_receipt = ?1
          )`,
    ).bind(receipt, now, row.asset_id, row.attempt),
  ]);
  const seals = await env.DB.prepare(
    `SELECT s.final_key
       FROM build_asset_ingest_seal s
      WHERE s.asset_id = ?1 AND s.attempt = ?2
        AND s.outcome = 'cleaned' AND s.cleanup_receipt = ?3
        AND EXISTS (
          SELECT 1 FROM build_asset_ingest_attempt i
           WHERE i.asset_id = ?1 AND i.attempt = ?2
             AND i.cleanup_state = 'tombstoned' AND i.cleanup_receipt = ?3
        )`,
  ).bind(row.asset_id, row.attempt, receipt).all<{ final_key: string }>();
  const deletions = await Promise.allSettled([
    ...seals.results.map((seal) => env.APK_BUCKET.delete(seal.final_key)),
  ]);
  const prepared = seals.results.some((seal) => seal.final_key === row.staging_key);
  return {
    prepared,
    deleted: prepared && deletions.every((result) => result.status === "fulfilled"),
  };
}

async function finalizeClaimedUploadCleanup(
  env: Env,
  row: { app_id: string; build_id: string; asset_id: string; attempt: number },
  receipt: string,
  reason: CleanupReason,
  actor: string,
  now: number,
): Promise<boolean> {
  const action = reason === "aborted" ? "build_asset.upload.abort" : "build_asset.upload.expire";
  const results = await env.DB.batch([
    env.DB.prepare(
      `UPDATE build_asset_ingest_attempt
          SET cleanup_state = 'expired'
        WHERE asset_id = ?1 AND attempt = ?2
          AND cleanup_state = 'tombstoned' AND cleanup_receipt = ?3`,
    ).bind(row.asset_id, row.attempt, receipt),
    env.DB.prepare(
      `INSERT INTO audit_logs (id, app_id, action, actor, payload, created_at)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6
        WHERE EXISTS (
          SELECT 1 FROM build_asset_ingest_attempt i
           WHERE i.asset_id = ?7 AND i.attempt = ?8
             AND i.cleanup_state = 'expired' AND i.cleanup_receipt = ?9
        )`,
    ).bind(
      crypto.randomUUID(), row.app_id, action, actor,
      JSON.stringify({ build_id: row.build_id, asset_id: row.asset_id, attempt: row.attempt }),
      now, row.asset_id, row.attempt, receipt,
    ),
    env.DB.prepare(
      `DELETE FROM build_assets
        WHERE id = ?1 AND build_id = ?2
          AND EXISTS (
            SELECT 1 FROM build_asset_ingest_attempt i
             WHERE i.asset_id = ?1 AND i.attempt = ?3
               AND i.cleanup_state = 'expired' AND i.cleanup_receipt = ?4
          )`,
    ).bind(row.asset_id, row.build_id, row.attempt, receipt),
  ]);
  return (results[0]?.meta?.changes ?? 0) === 1 && (results[2]?.meta?.changes ?? 0) === 1;
}

async function sweepCleanedSealObjects(env: Env, now: number): Promise<void> {
  // A presigned PUT may start before its signature expires and finish after the
  // Worker that initiated or cleaned it has gone away. There is no local proof
  // of a finite completion bound, so cleaned tombstones remain sweepable forever.
  // Back off old rows while ordering by their last sweep keeps every row fair.
  const { results } = await env.DB.prepare(
    `SELECT asset_id, attempt, lease_generation, final_key, cleanup_receipt
       FROM build_asset_ingest_seal
      WHERE outcome = 'cleaned'
        AND (sealed_at IS NULL OR sealed_at <= ?1 - CASE
          WHEN intent_at >= ?1 - ?2 THEN ?3
          WHEN intent_at >= ?1 - ?4 THEN ?5
          ELSE ?6
        END)
      ORDER BY COALESCE(sealed_at, intent_at) ASC
      LIMIT 50`,
  ).bind(
    now,
    CLEANED_SEAL_FAST_WINDOW_MS,
    CLEANED_SEAL_RETRY_MS,
    CLEANED_SEAL_MEDIUM_WINDOW_MS,
    CLEANED_SEAL_MEDIUM_RETRY_MS,
    CLEANED_SEAL_SLOW_RETRY_MS,
  ).all<{
    asset_id: string; attempt: number; lease_generation: number;
    final_key: string; cleanup_receipt: string | null;
  }>();
  for (const seal of results) {
    try {
      await env.APK_BUCKET.delete(seal.final_key);
    } catch {
      continue;
    }
    await env.DB.prepare(
      `UPDATE build_asset_ingest_seal SET sealed_at = ?1
        WHERE asset_id = ?2 AND attempt = ?3 AND lease_generation = ?4
          AND final_key = ?5 AND outcome = 'cleaned'
          AND cleanup_receipt IS ?6`,
    ).bind(
      now, seal.asset_id, seal.attempt, seal.lease_generation,
      seal.final_key, seal.cleanup_receipt,
    ).run();
  }
}

async function finalizeFailedVerificationCleanup(
  env: Env,
  row: { build_id: string; asset_id: string; attempt: number },
  receipt: string,
  reason: string,
): Promise<void> {
  const asset = await env.DB.prepare(
    "SELECT metadata_json FROM build_assets WHERE id = ?1 AND build_id = ?2",
  ).bind(row.asset_id, row.build_id).first<{ metadata_json: string }>();
  if (!asset) return;
  const metadata = { ...JSON.parse(asset.metadata_json), upload_state: "failed", verification_error: reason };
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE build_assets SET metadata_json = ?1 WHERE id = ?2 AND build_id = ?3
        AND EXISTS (
          SELECT 1 FROM build_asset_ingest_attempt i
           WHERE i.asset_id = ?2 AND i.attempt = ?4 AND i.state = 'failed'
             AND i.cleanup_state = 'tombstoned' AND i.cleanup_receipt = ?5
        )`,
    ).bind(JSON.stringify(metadata), row.asset_id, row.build_id, row.attempt, receipt),
    env.DB.prepare(
      `UPDATE build_asset_ingest_attempt SET cleanup_state = 'expired'
        WHERE asset_id = ?1 AND attempt = ?2 AND state = 'failed'
          AND cleanup_state = 'tombstoned' AND cleanup_receipt = ?3`,
    ).bind(row.asset_id, row.attempt, receipt),
  ]);
}

function limitObjectBody(body: ReadableStream<Uint8Array>, expectedBytes: number) {
  let seen = 0;
  return body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      seen += chunk.byteLength;
      if (seen > expectedBytes) throw new Error("object exceeds declared size while streaming");
      controller.enqueue(chunk);
    },
    flush() {
      if (seen !== expectedBytes) throw new Error("object ended before declared size");
    },
  }));
}

async function hashBody(body: ReadableStream<Uint8Array>) {
  const hasher = sha256.create();
  let size = 0;
  const reader = body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    size += value.byteLength;
    hasher.update(value);
  }
  return { sha256: bytesToHex(hasher.digest()), size };
}

function fixedLengthBody(body: ReadableStream<Uint8Array>, length: number) {
  if (typeof FixedLengthStream === "undefined") return { readable: body, pump: Promise.resolve() };
  const fixed = new FixedLengthStream(length);
  return { readable: fixed.readable, pump: body.pipeTo(fixed.writable) };
}

async function failVerification(
  c: AdminContext,
  row: DirectUploadRow,
  leaseId: string,
  reason: string,
): Promise<boolean> {
  const now = Date.now();
  const receipt = `verification_failed:${reason}:${crypto.randomUUID()}`;
  const failed = await c.env.DB.prepare(
    `UPDATE build_asset_ingest_attempt
        SET state = 'failed', cleanup_state = 'tombstoned', cleanup_receipt = ?1,
            verifier_lease_id = NULL, verifier_lease_expires_at = NULL
      WHERE asset_id = ?2 AND attempt = ?3 AND verifier_lease_id = ?4`,
  ).bind(receipt, row.asset_id, row.attempt, leaseId).run();
  if ((failed.meta?.changes ?? 0) !== 1) return false;
  // The tombstone claim is durable before any R2 delete. Persist both the
  // staging key and every verifier generation into the permanent cleaned
  // ledger; a transient delete failure or crash is then repaired by cron.
  const cleanup = await deleteClaimedUploadObjects(c.env, row, receipt, now);
  if (!cleanup.prepared) return true;
  await finalizeFailedVerificationCleanup(c.env, row, receipt, reason);
  return true;
}

export async function handleCompleteBuildAssetUpload(c: AdminContext) {
  const appId = c.req.param("appId") ?? "";
  const buildId = c.req.param("buildId") ?? "";
  const assetId = c.req.param("assetId") ?? "";
  const row = await loadUpload(c.env.DB, appId, buildId, assetId);
  if (!row) return c.json({ error: "asset upload not found", code: "ASSET_UPLOAD_NOT_FOUND" }, 404);
  if (row.state === "ready" && row.committed_final_key) {
    return c.json({ asset_id: assetId, state: "ready", r2_key: row.committed_final_key, file_hash: row.file_hash, size_bytes: row.size_bytes, replayed: true });
  }
  const newBuildUpload = row.build_status === "pending" && row.artifact_mode === "hands_r2";
  const migrationUpload = row.build_status === "succeeded" && row.artifact_mode === "external";
  if (!newBuildUpload && !migrationUpload) {
    return c.json({ error: "build is no longer uploadable", code: "BUILD_NOT_UPLOADABLE" }, 409);
  }
  const now = Date.now();
  if (row.upload_expires_at <= now) {
    const receipt = await claimUploadCleanup(c.env.DB, assetId, row.attempt, now, "upload_expired");
    if (!receipt) {
      return c.json({ error: "asset upload verification is already in progress or terminal", code: "ASSET_UPLOAD_BUSY" }, 409);
    }
    const cleanup = await deleteClaimedUploadObjects(c.env, row, receipt, now);
    if (cleanup.deleted) {
      await finalizeClaimedUploadCleanup(c.env, row, receipt, "upload_expired", currentActor(c), now);
    }
    return c.json({ error: "asset upload expired", code: "ASSET_UPLOAD_EXPIRED" }, 410);
  }
  const leaseId = crypto.randomUUID();
  const lease = await c.env.DB.prepare(
    `UPDATE build_asset_ingest_attempt
        SET state = 'verifying', verifier_lease_id = ?1, verifier_lease_expires_at = ?2
      WHERE asset_id = ?3 AND attempt = ?4
        AND cleanup_state = 'live'
        AND (state = 'pending' OR (state = 'verifying' AND verifier_lease_expires_at < ?5))`,
  ).bind(leaseId, now + VERIFY_LEASE_MS, assetId, row.attempt, now).run();
  if ((lease.meta?.changes ?? 0) !== 1) {
    return c.json({ error: "asset upload verification is already in progress or terminal", code: "ASSET_UPLOAD_BUSY" }, 409);
  }

  const generationRow = await c.env.DB.prepare(
    "SELECT COALESCE(MAX(lease_generation), 0) + 1 AS generation FROM build_asset_ingest_seal WHERE asset_id = ?1 AND attempt = ?2",
  ).bind(assetId, row.attempt).first<{ generation: number }>();
  const generation = Number(generationRow?.generation ?? 1);
  const filename = safeFilename((JSON.parse(row.metadata_json) as Record<string, unknown>).filename ?? assetId);
  const finalKey = `apps/${appId}/build-ingest/verified/${buildId}/${assetId}/g${generation}/${filename}`;
  try {
    await c.env.DB.prepare(
      `INSERT INTO build_asset_ingest_seal
       (asset_id, attempt, lease_generation, final_key, intent_at)
       VALUES (?1, ?2, ?3, ?4, ?5)`,
    ).bind(assetId, row.attempt, generation, finalKey, now).run();
  } catch (error) {
    await c.env.DB.prepare(
      `UPDATE build_asset_ingest_attempt
          SET state = 'pending', verifier_lease_id = NULL, verifier_lease_expires_at = NULL
        WHERE asset_id = ?1 AND attempt = ?2 AND verifier_lease_id = ?3`,
    ).bind(assetId, row.attempt, leaseId).run();
    return c.json({ error: (error as Error).message, code: "ASSET_UPLOAD_SEAL_INTENT_FAILED" }, 409);
  }

  const head = await c.env.APK_BUCKET.head(row.staging_key);
  if (!head || head.size !== row.size_bytes) {
    if (!await failVerification(c, row, leaseId, head ? "size_mismatch" : "upload_missing")) {
      return c.json({ error: "asset verification lease was lost", code: "ASSET_UPLOAD_LEASE_LOST" }, 409);
    }
    return c.json({ error: "uploaded asset size does not match the declaration", code: "ASSET_UPLOAD_INTEGRITY_MISMATCH" }, 422);
  }
  if (await c.env.APK_BUCKET.head(finalKey)) {
    if (!await failVerification(c, row, leaseId, "immutable_key_conflict")) {
      return c.json({ error: "asset verification lease was lost", code: "ASSET_UPLOAD_LEASE_LOST" }, 409);
    }
    return c.json({ error: "verified asset key already exists", code: "ASSET_UPLOAD_IMMUTABLE_CONFLICT" }, 409);
  }
  const object = await c.env.APK_BUCKET.get(row.staging_key);
  if (!object?.body || object.size !== row.size_bytes) {
    if (!await failVerification(c, row, leaseId, "upload_changed_before_verification")) {
      return c.json({ error: "asset verification lease was lost", code: "ASSET_UPLOAD_LEASE_LOST" }, 409);
    }
    return c.json({ error: "uploaded asset changed before verification", code: "ASSET_UPLOAD_INTEGRITY_MISMATCH" }, 422);
  }

  const limited = limitObjectBody(object.body, row.size_bytes);
  const [hashStream, sealStream] = limited.tee();
  const fixed = fixedLengthBody(sealStream, row.size_bytes);
  const contentType = String((JSON.parse(row.metadata_json) as Record<string, unknown>).content_type ?? "application/octet-stream");
  const [hashResult, pumpResult, putResult] = await Promise.allSettled([
    hashBody(hashStream),
    fixed.pump,
    c.env.APK_BUCKET.put(finalKey, fixed.readable, {
      httpMetadata: { contentType },
      customMetadata: { sha256: row.file_hash, build_id: buildId, asset_id: assetId },
    }),
  ]);
  if (hashResult.status === "rejected" || pumpResult.status === "rejected" || putResult.status === "rejected") {
    if (!await failVerification(c, row, leaseId, "stream_or_seal_failed")) {
      return c.json({ error: "asset verification lease was lost", code: "ASSET_UPLOAD_LEASE_LOST" }, 409);
    }
    return c.json({ error: "failed to verify and seal asset", code: "ASSET_UPLOAD_SEAL_FAILED" }, 422);
  }
  const actual = hashResult.value;
  if (actual.size !== row.size_bytes || actual.sha256 !== row.file_hash.toLowerCase()) {
    if (!await failVerification(c, row, leaseId, actual.size !== row.size_bytes ? "size_mismatch" : "sha256_mismatch")) {
      return c.json({ error: "asset verification lease was lost", code: "ASSET_UPLOAD_LEASE_LOST" }, 409);
    }
    return c.json({
      error: "uploaded asset does not match the declared exact bytes",
      code: "ASSET_UPLOAD_INTEGRITY_MISMATCH",
      expected: { sha256: row.file_hash, size_bytes: row.size_bytes },
      actual: { sha256: actual.sha256, size_bytes: actual.size },
    }, 422);
  }
  const finalHead = await c.env.APK_BUCKET.head(finalKey);
  if (!finalHead || finalHead.size !== row.size_bytes) {
    if (!await failVerification(c, row, leaseId, "sealed_size_mismatch")) {
      return c.json({ error: "asset verification lease was lost", code: "ASSET_UPLOAD_LEASE_LOST" }, 409);
    }
    return c.json({ error: "verified asset readback failed", code: "ASSET_UPLOAD_SEAL_FAILED" }, 422);
  }

  const readyAt = Date.now();
  const readyCleanupReceipt = `ready:${leaseId}`;
  const metadata = {
    ...JSON.parse(row.metadata_json),
    upload_state: "ready",
    verified_sha256: actual.sha256,
    verified_size_bytes: actual.size,
    verified_at: readyAt,
  };
  const readyResults = await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT OR IGNORE INTO build_asset_ingest_seal
       (asset_id, attempt, lease_generation, final_key, intent_at, sealed_at, outcome, cleanup_receipt)
       SELECT asset_id, attempt, 0, staging_key, ?1, ?1, 'cleaned', ?2
         FROM build_asset_ingest_attempt
        WHERE asset_id = ?3 AND attempt = ?4 AND verifier_lease_id = ?5`,
    ).bind(readyAt, readyCleanupReceipt, assetId, row.attempt, leaseId),
    c.env.DB.prepare(
      `UPDATE build_assets SET r2_key = ?1, metadata_json = ?2
        WHERE id = ?3 AND build_id = ?4
          AND EXISTS (
            SELECT 1 FROM build_asset_ingest_attempt i
             WHERE i.asset_id = ?3 AND i.attempt = ?5 AND i.verifier_lease_id = ?6
          )`,
    ).bind(finalKey, JSON.stringify(metadata), assetId, buildId, row.attempt, leaseId),
    c.env.DB.prepare(
      `UPDATE build_asset_ingest_attempt
          SET state = 'ready', committed_final_key = ?1,
              verifier_lease_id = NULL, verifier_lease_expires_at = NULL
        WHERE asset_id = ?2 AND attempt = ?3 AND verifier_lease_id = ?4`,
    ).bind(finalKey, assetId, row.attempt, leaseId),
    c.env.DB.prepare(
      `UPDATE build_asset_ingest_seal SET sealed_at = ?1, outcome = 'committed'
        WHERE asset_id = ?2 AND attempt = ?3 AND lease_generation = ?4
          AND EXISTS (
            SELECT 1 FROM build_asset_ingest_attempt i
             WHERE i.asset_id = ?2 AND i.attempt = ?3
               AND i.state = 'ready' AND i.committed_final_key = final_key
          )`,
    ).bind(readyAt, assetId, row.attempt, generation),
    c.env.DB.prepare(
      `UPDATE build_asset_ingest_seal
          SET sealed_at = ?1, outcome = 'cleaned', cleanup_receipt = ?2
        WHERE asset_id = ?3 AND attempt = ?4 AND lease_generation <> ?5
          AND outcome IS NULL
          AND EXISTS (
            SELECT 1 FROM build_asset_ingest_attempt i
             WHERE i.asset_id = ?3 AND i.attempt = ?4
               AND i.state = 'ready' AND i.committed_final_key = ?6
          )`,
    ).bind(readyAt, readyCleanupReceipt, assetId, row.attempt, generation, finalKey),
    c.env.DB.prepare(
      `INSERT INTO audit_logs (id, app_id, action, actor, payload, created_at)
       SELECT ?1, ?2, 'build_asset.upload.complete', ?3, ?4, ?5
        WHERE EXISTS (
          SELECT 1 FROM build_asset_ingest_attempt i
           WHERE i.asset_id = ?6 AND i.attempt = ?7
             AND i.state = 'ready' AND i.committed_final_key = ?8
        )`,
    ).bind(
      crypto.randomUUID(), appId, currentActor(c),
      JSON.stringify({ build_id: buildId, asset_id: assetId, attempt: row.attempt, lease_generation: generation, size_bytes: actual.size, sha256: actual.sha256 }),
      readyAt, assetId, row.attempt, finalKey,
    ),
  ]);
  if ((readyResults[2]?.meta?.changes ?? 0) !== 1) {
    await c.env.APK_BUCKET.delete(finalKey).catch(() => {});
    return c.json({ error: "asset verification lease was lost", code: "ASSET_UPLOAD_LEASE_LOST" }, 409);
  }
  await c.env.APK_BUCKET.delete(row.staging_key).catch(() => {});
  return c.json({ asset_id: assetId, state: "ready", r2_key: finalKey, file_hash: actual.sha256, size_bytes: actual.size, replayed: false });
}

export async function handleAbortBuildAssetUpload(c: AdminContext) {
  const appId = c.req.param("appId") ?? "";
  const buildId = c.req.param("buildId") ?? "";
  const assetId = c.req.param("assetId") ?? "";
  const row = await loadUpload(c.env.DB, appId, buildId, assetId);
  if (!row) return c.json({ aborted: true, replayed: true });
  if (row.state === "ready") {
    return c.json({ error: "verified assets cannot be aborted", code: "ASSET_UPLOAD_ALREADY_READY" }, 409);
  }
  if (row.state === "verifying" && (row.verifier_lease_expires_at ?? 0) >= Date.now()) {
    return c.json({ error: "asset verification is in progress", code: "ASSET_UPLOAD_BUSY" }, 409);
  }
  const now = Date.now();
  const receipt = await claimUploadCleanup(c.env.DB, assetId, row.attempt, now, "aborted");
  if (!receipt) {
    return c.json({ error: "asset upload verification is in progress or terminal", code: "ASSET_UPLOAD_BUSY" }, 409);
  }
  const cleanup = await deleteClaimedUploadObjects(c.env, row, receipt, now);
  if (!cleanup.deleted) {
    return c.json({ error: "asset cleanup will be retried", code: "ASSET_UPLOAD_CLEANUP_RETRY" }, 503);
  }
  if (!await finalizeClaimedUploadCleanup(c.env, row, receipt, "aborted", currentActor(c), now)) {
    return c.json({ error: "asset cleanup ownership was lost", code: "ASSET_UPLOAD_CLEANUP_LOST" }, 409);
  }
  return c.json({ aborted: true, replayed: false });
}

export async function handleBeginHostedBuildMigration(c: AdminContext) {
  const appId = c.req.param("appId") ?? "";
  const buildId = c.req.param("buildId") ?? "";
  let input: HostedMigrationBeginInput;
  let required: ReturnType<typeof normalizedRequiredSlots>;
  try {
    input = await c.req.json() as HostedMigrationBeginInput;
    required = normalizedRequiredSlots(input.required_asset_slots_json);
    if (!input.expected || input.expected.artifact_mode !== "external" || input.expected.status !== "succeeded") {
      throw new Error("expected external succeeded build identity is required");
    }
    requiredString(input.expected.source, "expected.source", 100);
    requiredString(input.expected.version_name, "expected.version_name", 200);
    if (!Number.isSafeInteger(Number(input.expected.version_code))) throw new Error("expected.version_code must be an integer");
  } catch (error) {
    return c.json({ error: (error as Error).message, code: "INVALID_HOSTED_MIGRATION" }, 400);
  }

  const existing = await c.env.DB.prepare(
    `SELECT source, version_name, version_code, status, artifact_mode,
            asset_ingest_protocol_version, required_asset_slots_json
       FROM builds WHERE app_id = ?1 AND id = ?2`,
  ).bind(appId, buildId).first<{
    source: string; version_name: string; version_code: number; status: string; artifact_mode: string;
    asset_ingest_protocol_version: number | null; required_asset_slots_json: string | null;
  }>();
  if (!existing) return c.json({ error: "build not found", code: "BUILD_NOT_FOUND" }, 404);
  const identityMatches = existing.source === input.expected.source
    && existing.version_name === input.expected.version_name
    && existing.version_code === Number(input.expected.version_code)
    && existing.status === "succeeded"
    && existing.artifact_mode === "external";
  if (!identityMatches) {
    return c.json({ error: "build identity changed before hosted migration", code: "HOSTED_MIGRATION_IDENTITY_MISMATCH" }, 409);
  }
  if (existing.asset_ingest_protocol_version === DIRECT_UPLOAD_PROTOCOL) {
    if (existing.required_asset_slots_json !== required.json) {
      return c.json({ error: "hosted migration was already initialized with a different slot set", code: "HOSTED_MIGRATION_REPLAY_CONFLICT" }, 409);
    }
    await c.env.DB.prepare(
      `INSERT OR IGNORE INTO audit_logs (id, app_id, action, actor, payload, created_at)
       VALUES (?1, ?2, 'build.hosted_migration.begin', ?3, ?4, ?5)`,
    ).bind(
      `hosted-migration-begin:${buildId}`, appId, currentActor(c),
      JSON.stringify({ build_id: buildId, source: input.expected.source, version_name: input.expected.version_name, version_code: input.expected.version_code, required_asset_slots_json: JSON.parse(required.json) }),
      Date.now(),
    ).run();
    return c.json({ build_id: buildId, state: "uploading", asset_ingest_protocol_version: DIRECT_UPLOAD_PROTOCOL, required_asset_slots_json: JSON.parse(required.json), replayed: true });
  }
  if (existing.asset_ingest_protocol_version !== null) {
    return c.json({ error: "build uses an unsupported asset ingest protocol", code: "HOSTED_MIGRATION_PROTOCOL_CONFLICT" }, 409);
  }
  const now = Date.now();
  const result = await c.env.DB.prepare(
    `UPDATE builds
        SET asset_ingest_protocol_version = ?1, required_asset_slots_json = ?2
      WHERE app_id = ?3 AND id = ?4 AND source = ?5 AND version_name = ?6 AND version_code = ?7
        AND status = 'succeeded' AND artifact_mode = 'external'
        AND asset_ingest_protocol_version IS NULL`,
  ).bind(
    DIRECT_UPLOAD_PROTOCOL, required.json, appId, buildId, input.expected.source,
    input.expected.version_name, Number(input.expected.version_code),
  ).run();
  if ((result.meta?.changes ?? 0) !== 1) {
    return c.json({ error: "build changed before hosted migration initialization", code: "HOSTED_MIGRATION_CONFLICT" }, 409);
  }
  await c.env.DB.prepare(
    `INSERT OR IGNORE INTO audit_logs (id, app_id, action, actor, payload, created_at)
     VALUES (?1, ?2, 'build.hosted_migration.begin', ?3, ?4, ?5)`,
  ).bind(
    `hosted-migration-begin:${buildId}`, appId, currentActor(c),
    JSON.stringify({ build_id: buildId, source: input.expected.source, version_name: input.expected.version_name, version_code: input.expected.version_code, required_asset_slots_json: JSON.parse(required.json) }),
    now,
  ).run();
  return c.json({ build_id: buildId, state: "uploading", asset_ingest_protocol_version: DIRECT_UPLOAD_PROTOCOL, required_asset_slots_json: JSON.parse(required.json), replayed: false }, 201);
}

export async function handleCompleteHostedBuildMigration(c: AdminContext) {
  const appId = c.req.param("appId") ?? "";
  const buildId = c.req.param("buildId") ?? "";
  const body = await c.req.json().catch(() => ({})) as { asset_ids?: unknown };
  if (!Array.isArray(body.asset_ids) || body.asset_ids.length === 0 || body.asset_ids.some((id) => typeof id !== "string" || !id)) {
    return c.json({ error: "asset_ids must be a non-empty string array", code: "INVALID_HOSTED_MIGRATION" }, 400);
  }
  const assetIds = body.asset_ids as string[];
  if (new Set(assetIds).size !== assetIds.length) {
    return c.json({ error: "asset_ids contains a duplicate", code: "INVALID_HOSTED_MIGRATION" }, 400);
  }
  const build = await c.env.DB.prepare(
    `SELECT source, version_name, version_code, status, artifact_mode,
            asset_ingest_protocol_version, required_asset_slots_json
       FROM builds WHERE app_id = ?1 AND id = ?2`,
  ).bind(appId, buildId).first<{
    source: string; version_name: string; version_code: number; status: string; artifact_mode: string;
    asset_ingest_protocol_version: number | null; required_asset_slots_json: string | null;
  }>();
  if (!build) return c.json({ error: "build not found", code: "BUILD_NOT_FOUND" }, 404);
  if (build.artifact_mode === "hands_r2" && build.asset_ingest_protocol_version === DIRECT_UPLOAD_PROTOCOL) {
    await c.env.DB.prepare(
      `INSERT OR IGNORE INTO audit_logs (id, app_id, action, actor, payload, created_at)
       VALUES (?1, ?2, 'build.hosted_migration.complete', ?3, ?4, ?5)`,
    ).bind(
      `hosted-migration-complete:${buildId}`, appId, currentActor(c),
      JSON.stringify({ build_id: buildId, source: build.source, version_name: build.version_name, version_code: build.version_code }),
      Date.now(),
    ).run();
    return c.json({ build_id: buildId, state: "hosted", artifact_mode: "hands_r2", replayed: true });
  }
  if (build.status !== "succeeded" || build.artifact_mode !== "external" || build.asset_ingest_protocol_version !== DIRECT_UPLOAD_PROTOCOL) {
    return c.json({ error: "hosted migration is not initialized for this build", code: "HOSTED_MIGRATION_NOT_READY" }, 409);
  }
  let required: Set<string>;
  try {
    required = requiredSlotKeys(build.required_asset_slots_json);
  } catch (error) {
    return c.json({ error: (error as Error).message, code: "INVALID_REQUIRED_ASSET_SLOTS" }, 500);
  }
  if (assetIds.length !== required.size) {
    return c.json({ error: "asset_ids must name every frozen required slot exactly once", code: "HOSTED_MIGRATION_ASSETS_INCOMPLETE" }, 409);
  }
  const placeholders = assetIds.map((_, index) => `?${index + 2}`).join(", ");
  const { results } = await c.env.DB.prepare(
    `SELECT a.id AS asset_id, a.artifact_kind, a.platform, a.arch, a.variant, a.filetype,
            a.file_hash, a.size_bytes, a.metadata_json, i.state, i.committed_final_key
       FROM build_assets a
       JOIN build_asset_ingest_attempt i ON i.asset_id = a.id
      WHERE a.build_id = ?1 AND a.id IN (${placeholders})`,
  ).bind(buildId, ...assetIds).all<{
    asset_id: string; artifact_kind: string; platform: string; arch: string | null; variant: string | null;
    filetype: string; file_hash: string; size_bytes: number; metadata_json: string; state: string; committed_final_key: string | null;
  }>();
  const actualKeys = new Set<string>();
  const expectedAssets: Array<Record<string, unknown>> = [];
  for (const asset of results) {
    const metadata = JSON.parse(asset.metadata_json) as Record<string, unknown>;
    if (asset.state !== "ready" || !asset.committed_final_key
      || metadata.upload_state !== "ready"
      || metadata.verified_sha256 !== asset.file_hash
      || metadata.verified_size_bytes !== asset.size_bytes) {
      return c.json({ error: "hosted migration assets are not exactly verified", code: "HOSTED_MIGRATION_ASSETS_INCOMPLETE" }, 409);
    }
    actualKeys.add(slotKey({ artifactKind: asset.artifact_kind, platform: asset.platform, arch: asset.arch, variant: asset.variant, filetype: asset.filetype }));
    expectedAssets.push({
      asset_id: asset.asset_id, artifact_kind: asset.artifact_kind, platform: asset.platform,
      arch: asset.arch, variant: asset.variant, filetype: asset.filetype,
      sha256: asset.file_hash, size_bytes: asset.size_bytes, final_key: asset.committed_final_key,
    });
  }
  if (results.length !== assetIds.length || actualKeys.size !== required.size || [...required].some((key) => !actualKeys.has(key))) {
    return c.json({ error: "hosted migration assets do not match the frozen slot set", code: "HOSTED_MIGRATION_ASSETS_INCOMPLETE" }, 409);
  }

  const expectedJson = JSON.stringify(expectedAssets);
  const finalized = await c.env.DB.prepare(
    `UPDATE builds SET artifact_mode = 'hands_r2'
      WHERE app_id = ?1 AND id = ?2 AND status = 'succeeded' AND artifact_mode = 'external'
        AND asset_ingest_protocol_version = ?3
        AND NOT EXISTS (
          SELECT 1 FROM json_each(?4) expected
           WHERE NOT EXISTS (
             SELECT 1 FROM build_assets a
             JOIN build_asset_ingest_attempt i ON i.asset_id = a.id
              WHERE a.build_id = ?2
                AND a.id = json_extract(expected.value, '$.asset_id')
                AND a.artifact_kind = json_extract(expected.value, '$.artifact_kind')
                AND a.platform = json_extract(expected.value, '$.platform')
                AND a.slot_arch = COALESCE(json_extract(expected.value, '$.arch'), '-')
                AND a.slot_variant = COALESCE(json_extract(expected.value, '$.variant'), '-')
                AND a.filetype = json_extract(expected.value, '$.filetype')
                AND a.file_hash = json_extract(expected.value, '$.sha256')
                AND a.size_bytes = json_extract(expected.value, '$.size_bytes')
                AND a.r2_key = json_extract(expected.value, '$.final_key')
                AND i.state = 'ready' AND i.committed_final_key = a.r2_key
                AND json_extract(a.metadata_json, '$.upload_state') = 'ready'
                AND json_extract(a.metadata_json, '$.verified_sha256') = a.file_hash
                AND json_extract(a.metadata_json, '$.verified_size_bytes') = a.size_bytes
           )
        )`,
  ).bind(appId, buildId, DIRECT_UPLOAD_PROTOCOL, expectedJson).run();
  if ((finalized.meta?.changes ?? 0) !== 1) {
    return c.json({ error: "build or verified assets changed before hosted migration finalized", code: "HOSTED_MIGRATION_CONFLICT" }, 409);
  }
  const now = Date.now();
  await c.env.DB.prepare(
    `INSERT OR IGNORE INTO audit_logs (id, app_id, action, actor, payload, created_at)
     VALUES (?1, ?2, 'build.hosted_migration.complete', ?3, ?4, ?5)`,
  ).bind(
    `hosted-migration-complete:${buildId}`, appId, currentActor(c),
    JSON.stringify({ build_id: buildId, source: build.source, version_name: build.version_name, version_code: build.version_code, assets: expectedAssets }),
    now,
  ).run();
  return c.json({ build_id: buildId, state: "hosted", artifact_mode: "hands_r2", asset_ids: assetIds, replayed: false });
}

export async function cleanupExpiredBuildAssetUploads(env: Env, now = Date.now()): Promise<void> {
  await sweepCleanedSealObjects(env, now);
  const { results } = await env.DB.prepare(
    `SELECT b.app_id, a.build_id, i.asset_id, i.attempt, i.staging_key, i.state,
            i.cleanup_state, i.cleanup_receipt
       FROM build_asset_ingest_attempt i
       JOIN build_assets a ON a.id = i.asset_id
       JOIN builds b ON b.id = a.build_id
      WHERE i.cleanup_state = 'tombstoned'
         OR (i.upload_expires_at <= ?1 AND i.cleanup_state = 'live'
             AND NOT (i.state = 'verifying' AND i.verifier_lease_expires_at >= ?1))
      ORDER BY i.upload_expires_at ASC LIMIT 50`,
  ).bind(now).all<{
    app_id: string; build_id: string; asset_id: string; attempt: number; staging_key: string;
    state: string; cleanup_state: string; cleanup_receipt: string | null;
  }>();
  for (const row of results) {
    const receipt = row.cleanup_state === "tombstoned"
      ? row.cleanup_receipt
      : await claimUploadCleanup(env.DB, row.asset_id, row.attempt, now, "upload_expired");
    if (!receipt) continue;
    const cleanup = await deleteClaimedUploadObjects(env, row, receipt, now);
    if (row.state === "failed" && receipt.startsWith("verification_failed:")) {
      if (!cleanup.prepared) continue;
      const reason = receipt.slice("verification_failed:".length).split(":", 1)[0] || "verification_failed";
      await finalizeFailedVerificationCleanup(env, row, receipt, reason);
      continue;
    }
    if (!cleanup.deleted) continue;
    await finalizeClaimedUploadCleanup(env, row, receipt, "upload_expired", "system:cron", now);
  }
}
