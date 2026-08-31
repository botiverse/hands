import type { Context } from "hono";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";
import { currentActor, type AdminEnv } from "../middleware/auth";
import { requestOrigin } from "../lib/origin";
import { presignR2UploadUrl } from "../lib/r2_presign";
import { autoParseInstallableAsset, createBuild, createBuildAsset, resolveChannelId } from "./builds";

type AdminContext = Context<AdminEnv & { Bindings: Env }>;
type JsonObject = Record<string, unknown>;
type ArtifactKind = "aab" | "apk";
type UploadState = "pending_upload" | "verifying" | "ready" | "failed";

const SCHEMA = "hands.android-release-artifacts.v1";
const MAX_ARTIFACT_BYTES = 4 * 1024 * 1024 * 1024;
const UPLOAD_TTL_SECONDS = 3600;

export interface AndroidReleaseArtifactInput {
  channel_id?: string;
  source: {
    repository: string;
    commit_sha: string;
    ci_run_id: string | number;
  };
  package_name: string;
  version_name: string;
  version_code: number;
  upload_key_cert_sha256: string;
  artifacts: Array<{
    kind: ArtifactKind;
    filename: string;
    size_bytes: number;
    sha256: string;
  }>;
}

interface NormalizedArtifact {
  kind: ArtifactKind;
  filename: string;
  sizeBytes: number;
  sha256: string;
  contentType: string;
}

export interface NormalizedAndroidReleaseArtifactInput {
  channel: string | null;
  source: { repository: string; commitSha: string; ciRunId: string };
  packageName: string;
  versionName: string;
  versionCode: number;
  uploadKeyCertSha256: string;
  artifacts: [NormalizedArtifact, NormalizedArtifact];
}

interface AndroidAssetRow {
  app_id: string;
  build_id: string;
  asset_id: string;
  package_name: string;
  version_name: string;
  version_code: number;
  source_repository: string;
  source_commit: string;
  ci_run_id: string;
  upload_key_cert_sha256: string;
  bundle_state: "uploading" | "ready" | "failed";
  bundle_created_at: number;
  bundle_completed_at: number | null;
  filetype: ArtifactKind;
  r2_key: string;
  file_hash: string;
  size_bytes: number;
  metadata_json: string;
  asset_created_at: number;
}

function requiredString(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string") throw new Error(`${field} required`);
  const normalized = value.trim();
  if (!normalized) throw new Error(`${field} required`);
  if (normalized.length > maxLength) throw new Error(`${field} is too long`);
  return normalized;
}

function digest(value: unknown, field: string): string {
  const normalized = requiredString(value, field, 64);
  if (!/^[0-9a-f]{64}$/.test(normalized)) {
    throw new Error(`${field} must be a 64-character lowercase hex digest`);
  }
  return normalized;
}

function filename(value: unknown, kind: ArtifactKind): string {
  const normalized = requiredString(value, `artifacts.${kind}.filename`, 255);
  if (!/^[A-Za-z0-9][A-Za-z0-9._ -]*$/.test(normalized) || !normalized.toLowerCase().endsWith(`.${kind}`)) {
    throw new Error(`artifacts.${kind}.filename must be a safe basename ending with .${kind}`);
  }
  return normalized;
}

function size(value: unknown, kind: ArtifactKind): number {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized <= 0 || normalized > MAX_ARTIFACT_BYTES) {
    throw new Error(`artifacts.${kind}.size_bytes must be a positive integer no larger than 4 GiB`);
  }
  return normalized;
}

export function normalizeAndroidReleaseArtifactInput(
  input: AndroidReleaseArtifactInput,
): NormalizedAndroidReleaseArtifactInput {
  if (!input || typeof input !== "object") throw new Error("request body required");
  if (!input.source || typeof input.source !== "object") throw new Error("source required");
  const commitSha = requiredString(input.source.commit_sha, "source.commit_sha", 40);
  if (!/^[0-9a-f]{40}$/.test(commitSha)) {
    throw new Error("source.commit_sha must be a full 40-character git object id");
  }
  const versionCode = Number(input.version_code);
  if (!Number.isSafeInteger(versionCode) || versionCode <= 0) {
    throw new Error("version_code must be a positive integer");
  }
  const packageName = requiredString(input.package_name, "package_name", 255);
  if (!/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/.test(packageName)) {
    throw new Error("package_name must be a reverse-DNS Android application id");
  }
  if (!Array.isArray(input.artifacts) || input.artifacts.length !== 2) {
    throw new Error("artifacts must contain exactly one AAB and one APK");
  }
  const byKind = new Map<ArtifactKind, AndroidReleaseArtifactInput["artifacts"][number]>();
  for (const artifact of input.artifacts) {
    if (!artifact || (artifact.kind !== "aab" && artifact.kind !== "apk")) {
      throw new Error("artifact kind must be aab or apk");
    }
    if (byKind.has(artifact.kind)) throw new Error(`duplicate ${artifact.kind} artifact`);
    byKind.set(artifact.kind, artifact);
  }
  if (!byKind.has("aab") || !byKind.has("apk")) {
    throw new Error("artifacts must contain exactly one AAB and one APK");
  }
  const artifacts = (["aab", "apk"] as const).map((kind) => {
    const artifact = byKind.get(kind)!;
    return {
      kind,
      filename: filename(artifact.filename, kind),
      sizeBytes: size(artifact.size_bytes, kind),
      sha256: digest(artifact.sha256, `artifacts.${kind}.sha256`),
      contentType: kind === "apk" ? "application/vnd.android.package-archive" : "application/octet-stream",
    };
  }) as [NormalizedArtifact, NormalizedArtifact];
  return {
    channel: input.channel_id ? requiredString(input.channel_id, "channel_id", 128) : null,
    source: {
      repository: requiredString(input.source.repository, "source.repository", 255),
      commitSha,
      ciRunId: requiredString(String(input.source.ci_run_id ?? ""), "source.ci_run_id", 128),
    },
    packageName,
    versionName: requiredString(input.version_name, "version_name", 128),
    versionCode,
    uploadKeyCertSha256: digest(input.upload_key_cert_sha256, "upload_key_cert_sha256"),
    artifacts,
  };
}

function parseObject(value: string): JsonObject {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function uploadState(row: AndroidAssetRow): UploadState {
  const state = parseObject(row.metadata_json).upload_state;
  return state === "verifying" || state === "ready" || state === "failed" ? state : "pending_upload";
}

function safeFilename(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "-");
}

async function resolveChannel(db: D1Database, appId: string, requested: string | null): Promise<string | null> {
  if (requested) return resolveChannelId(db, appId, requested);
  const row = await db.prepare(
    `SELECT id FROM channels WHERE app_id = ?1
     ORDER BY CASE slug WHEN 'main' THEN 0 ELSE 1 END, created_at ASC LIMIT 1`,
  ).bind(appId).first<{ id: string }>();
  return row?.id ?? null;
}

async function rowsForBuild(db: D1Database, appId: string, buildId: string): Promise<AndroidAssetRow[]> {
  const result = await db.prepare(
    `SELECT arb.app_id, arb.build_id, ba.id AS asset_id,
            arb.package_name, arb.version_name, arb.version_code,
            arb.source_repository, arb.source_commit, arb.ci_run_id,
            arb.upload_key_cert_sha256, arb.state AS bundle_state,
            arb.created_at AS bundle_created_at, arb.completed_at AS bundle_completed_at,
            ba.filetype, ba.r2_key, ba.file_hash, ba.size_bytes,
            ba.metadata_json, ba.created_at AS asset_created_at
     FROM android_release_artifact_bundles arb
     JOIN build_assets ba ON ba.build_id = arb.build_id
     WHERE arb.app_id = ?1 AND arb.build_id = ?2
       AND ba.artifact_kind = 'installable' AND ba.platform = 'android'
       AND ba.filetype IN ('aab', 'apk')
     ORDER BY CASE ba.filetype WHEN 'aab' THEN 0 ELSE 1 END`,
  ).bind(appId, buildId).all<AndroidAssetRow>();
  return result.results;
}

function bundleResponse(c: Context<any>, rows: AndroidAssetRow[]) {
  const first = rows[0]!;
  const origin = requestOrigin(c);
  return {
    schema: SCHEMA,
    build_id: first.build_id,
    status: first.bundle_state,
    source: {
      repository: first.source_repository,
      commit_sha: first.source_commit,
      ci_run_id: first.ci_run_id,
    },
    package_name: first.package_name,
    version_name: first.version_name,
    version_code: first.version_code,
    upload_key_cert_sha256: first.upload_key_cert_sha256,
    artifacts: rows.map((row) => {
      const metadata = parseObject(row.metadata_json);
      return {
        asset_id: row.asset_id,
        kind: row.filetype,
        filename: metadata.filename,
        status: uploadState(row) === "ready" ? "sealed" : uploadState(row),
        size_bytes: row.size_bytes,
        sha256: row.file_hash,
        verified_size_bytes: metadata.verified_size_bytes ?? null,
        verified_sha256: metadata.verified_sha256 ?? null,
        verified_at: metadata.verified_at ?? null,
        complete_url: `${origin}/api/apps/${row.app_id}/android-release-artifacts/${row.build_id}/assets/${row.asset_id}/complete`,
      };
    }),
    created_at: first.bundle_created_at,
    completed_at: first.bundle_completed_at,
  };
}

async function insertAudit(db: D1Database, appId: string, action: string, actor: string, payload: unknown) {
  await db.prepare(
    "INSERT INTO audit_logs (id, app_id, action, actor, payload, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
  ).bind(crypto.randomUUID(), appId, action, actor, JSON.stringify(payload), Date.now()).run();
}

export async function handleCreateAndroidReleaseArtifacts(c: AdminContext) {
  const appId = c.req.param("appId") ?? "";
  let input: NormalizedAndroidReleaseArtifactInput;
  try {
    input = normalizeAndroidReleaseArtifactInput((await c.req.json()) as AndroidReleaseArtifactInput);
  } catch (error) {
    return c.json({ error: (error as Error).message, code: "INVALID_RELEASE_ARTIFACTS" }, 400);
  }
  const app = await c.env.DB.prepare("SELECT id FROM apps WHERE id = ?1").bind(appId).first();
  if (!app) return c.json({ error: "app not found", code: "ARTIFACT_NOT_FOUND" }, 404);
  const channelId = await resolveChannel(c.env.DB, appId, input.channel);
  if (!channelId) {
    return c.json({ error: "app has no matching channel", code: "INVALID_RELEASE_ARTIFACTS" }, 400);
  }

  const buildId = crypto.randomUUID();
  const declared = input.artifacts.map((artifact) => {
    const assetId = crypto.randomUUID();
    const stagingKey = `apps/${appId}/android-release/pending/${buildId}/${assetId}/${safeFilename(artifact.filename)}`;
    const finalKey = `apps/${appId}/android-release/verified/${buildId}/${assetId}/${safeFilename(artifact.filename)}`;
    return { ...artifact, assetId, stagingKey, finalKey };
  });
  const uploadUrls = await Promise.all(
    declared.map((artifact) => presignR2UploadUrl(c.env, artifact.stagingKey, artifact.contentType, UPLOAD_TTL_SECONDS)),
  );
  if (uploadUrls.some((url) => !url)) {
    return c.json({ error: "direct artifact uploads are unavailable", code: "ARTIFACT_UPLOAD_UNAVAILABLE" }, 503);
  }

  const actor = currentActor(c);
  try {
    await createBuild(c.env.DB, appId, {
      channel_id: channelId,
      product_type: "android-apk",
      release_type: "stable",
      version_name: input.versionName,
      version_code: input.versionCode,
      source: "mobile-ci",
      status: "pending",
      build_metadata_json: {
        schema: SCHEMA,
        package_name: input.packageName,
        upload_key_cert_sha256: input.uploadKeyCertSha256,
        required_artifacts: ["aab", "apk"],
      },
      provenance_json: {
        schema: SCHEMA,
        source_repository: input.source.repository,
        source_commit: input.source.commitSha,
        ci_run_id: input.source.ciRunId,
      },
    }, actor, buildId);
    await c.env.DB.prepare(
      `INSERT INTO android_release_artifact_bundles
       (build_id, app_id, package_name, version_name, version_code,
        source_repository, source_commit, ci_run_id, upload_key_cert_sha256,
        state, created_by, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'uploading', ?10, ?11)`,
    ).bind(
      buildId, appId, input.packageName, input.versionName, input.versionCode,
      input.source.repository, input.source.commitSha, input.source.ciRunId,
      input.uploadKeyCertSha256, actor, Date.now(),
    ).run();
    for (const artifact of declared) {
      await createBuildAsset(c.env.DB, appId, buildId, {
        artifact_kind: "installable",
        platform: "android",
        arch: null,
        variant: "release",
        filetype: artifact.kind,
        r2_key: artifact.stagingKey,
        file_hash: artifact.sha256,
        size_bytes: artifact.sizeBytes,
        metadata_json: {
          schema: SCHEMA,
          upload_state: "pending_upload",
          filename: artifact.filename,
          content_type: artifact.contentType,
          final_r2_key: artifact.finalKey,
        },
      }, actor, artifact.assetId);
    }
  } catch (error) {
    await c.env.DB.prepare("DELETE FROM builds WHERE id = ?1 AND app_id = ?2").bind(buildId, appId).run();
    const message = (error as Error).message;
    const immutable = /UNIQUE constraint|immutable/i.test(message);
    return c.json(
      { error: message, code: immutable ? "IMMUTABLE_CONFLICT" : "INVALID_RELEASE_ARTIFACTS" },
      immutable ? 409 : 400,
    );
  }

  const rows = await rowsForBuild(c.env.DB, appId, buildId);
  const response = bundleResponse(c, rows);
  return c.json({
    ...response,
    artifacts: response.artifacts.map((artifact, index) => ({
      ...artifact,
      upload: {
        method: "PUT",
        url: uploadUrls[index],
        headers: { "content-type": declared[index]!.contentType },
        expires_at: Date.now() + UPLOAD_TTL_SECONDS * 1000,
      },
    })),
  }, 201);
}

async function hashBody(body: ReadableStream<Uint8Array>): Promise<{ sha256: string; size: number }> {
  const hasher = sha256.create();
  let total = 0;
  const reader = body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > MAX_ARTIFACT_BYTES) throw new Error("artifact exceeds maximum size");
    hasher.update(value);
  }
  return { sha256: bytesToHex(hasher.digest()), size: total };
}

function fixedLengthBody(body: ReadableStream<Uint8Array>, length: number) {
  if (typeof FixedLengthStream === "undefined") return { readable: body, pump: Promise.resolve() };
  const fixed = new FixedLengthStream(length);
  return { readable: fixed.readable, pump: body.pipeTo(fixed.writable) };
}

async function setFailed(c: AdminContext, row: AndroidAssetRow, reason: string, keys: string[]) {
  await Promise.all(keys.map((key) => c.env.APK_BUCKET.delete(key).catch(() => {})));
  const metadata = { ...parseObject(row.metadata_json), upload_state: "failed", verification_error: reason, verified_at: Date.now() };
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE build_assets SET metadata_json = ?1 WHERE id = ?2").bind(JSON.stringify(metadata), row.asset_id),
    c.env.DB.prepare("UPDATE android_release_artifact_bundles SET state = 'failed', completed_at = ?1 WHERE build_id = ?2").bind(Date.now(), row.build_id),
    c.env.DB.prepare("UPDATE builds SET status = 'failed', completed_at = ?1, updated_at = ?1 WHERE id = ?2").bind(Date.now(), row.build_id),
  ]);
}

export async function handleCompleteAndroidReleaseArtifact(c: AdminContext) {
  const appId = c.req.param("appId") ?? "";
  const buildId = c.req.param("buildId") ?? "";
  const assetId = c.req.param("assetId") ?? "";
  const rows = await rowsForBuild(c.env.DB, appId, buildId);
  const row = rows.find((candidate) => candidate.asset_id === assetId);
  if (!row) return c.json({ error: "artifact not found", code: "ARTIFACT_NOT_FOUND" }, 404);
  if (row.bundle_state === "failed" || uploadState(row) !== "pending_upload") {
    return c.json({ error: "artifact state does not allow completion", code: "STATE_CONFLICT" }, 409);
  }
  const verifying = { ...parseObject(row.metadata_json), upload_state: "verifying", verifying_started_at: Date.now() };
  const claimed = await c.env.DB.prepare(
    `UPDATE build_assets SET metadata_json = ?1
     WHERE id = ?2 AND build_id = ?3
       AND json_extract(metadata_json, '$.upload_state') = 'pending_upload'`,
  ).bind(JSON.stringify(verifying), assetId, buildId).run();
  if (Number(claimed.meta?.changes ?? 0) !== 1) {
    return c.json({ error: "artifact completion is already in progress", code: "STATE_CONFLICT" }, 409);
  }
  const head = await c.env.APK_BUCKET.head(row.r2_key);
  if (!head) {
    await setFailed(c, row, "upload_not_found", []);
    return c.json({ error: "uploaded object not found", code: "ARTIFACT_NOT_FOUND" }, 409);
  }
  if (head.size !== row.size_bytes) {
    await setFailed(c, row, "size_mismatch", [row.r2_key]);
    return c.json({ error: "uploaded size does not match declaration", code: "INTEGRITY_MISMATCH" }, 422);
  }
  const object = await c.env.APK_BUCKET.get(row.r2_key);
  if (!object || object.size !== row.size_bytes) {
    await setFailed(c, row, "upload_changed_before_verification", [row.r2_key]);
    return c.json({ error: "uploaded object changed before verification", code: "INTEGRITY_MISMATCH" }, 422);
  }
  const metadata = parseObject(row.metadata_json);
  const finalKey = typeof metadata.final_r2_key === "string" ? metadata.final_r2_key : "";
  const expectedPrefix = `apps/${appId}/android-release/verified/${buildId}/${assetId}/`;
  if (!finalKey.startsWith(expectedPrefix)) {
    await setFailed(c, row, "invalid_final_storage_key", [row.r2_key]);
    return c.json({ error: "final storage key is invalid", code: "STATE_CONFLICT" }, 500);
  }
  if (await c.env.APK_BUCKET.head(finalKey)) {
    await setFailed(c, row, "immutable_key_conflict", [row.r2_key]);
    return c.json({ error: "immutable artifact key already exists", code: "IMMUTABLE_CONFLICT" }, 409);
  }
  const [hashStream, sealStream] = object.body.tee();
  const fixed = fixedLengthBody(sealStream, row.size_bytes);
  const [hashResult, pumpResult, putResult] = await Promise.allSettled([
    hashBody(hashStream),
    fixed.pump,
    c.env.APK_BUCKET.put(finalKey, fixed.readable, {
      httpMetadata: { contentType: String(metadata.content_type ?? "application/octet-stream") },
      customMetadata: { sha256: row.file_hash, build_id: buildId, asset_id: assetId },
    }),
  ]);
  if (hashResult.status !== "fulfilled" || pumpResult.status !== "fulfilled" || putResult.status !== "fulfilled") {
    await setFailed(c, row, "stream_or_seal_failed", [row.r2_key, finalKey]);
    return c.json({ error: "failed to verify and seal artifact", code: "INTEGRITY_MISMATCH" }, 422);
  }
  const actual = hashResult.value;
  if (actual.size !== row.size_bytes || actual.sha256 !== row.file_hash) {
    await setFailed(c, row, "sha256_or_size_mismatch", [row.r2_key, finalKey]);
    return c.json({
      error: "uploaded artifact does not match declared exact bytes",
      code: "INTEGRITY_MISMATCH",
      expected: { sha256: row.file_hash, size_bytes: row.size_bytes },
      actual: { sha256: actual.sha256, size_bytes: actual.size },
    }, 422);
  }
  const readyMetadata = {
    ...metadata,
    upload_state: "ready",
    verified_sha256: actual.sha256,
    verified_size_bytes: actual.size,
    verified_at: Date.now(),
  };
  const updated = await c.env.DB.prepare(
    `UPDATE build_assets SET r2_key = ?1, metadata_json = ?2
     WHERE id = ?3 AND build_id = ?4
       AND json_extract(metadata_json, '$.upload_state') = 'verifying'`,
  ).bind(finalKey, JSON.stringify(readyMetadata), assetId, buildId).run();
  if (Number(updated.meta?.changes ?? 0) !== 1) {
    await c.env.APK_BUCKET.delete(finalKey);
    return c.json({ error: "artifact state changed during verification", code: "STATE_CONFLICT" }, 409);
  }
  await c.env.APK_BUCKET.delete(row.r2_key);
  const remaining = await c.env.DB.prepare(
    `SELECT COUNT(*) AS count FROM build_assets
     WHERE build_id = ?1 AND artifact_kind = 'installable' AND platform = 'android'
       AND filetype IN ('aab','apk')
       AND json_extract(metadata_json, '$.upload_state') <> 'ready'`,
  ).bind(buildId).first<{ count: number }>();
  if (Number(remaining?.count ?? 1) === 0) {
    const now = Date.now();
    await c.env.DB.batch([
      c.env.DB.prepare("UPDATE android_release_artifact_bundles SET state = 'ready', completed_at = ?1 WHERE build_id = ?2 AND state = 'uploading'").bind(now, buildId),
      c.env.DB.prepare("UPDATE builds SET status = 'succeeded', completed_at = ?1, updated_at = ?1 WHERE id = ?2 AND status = 'pending'").bind(now, buildId),
    ]);
  }
  await insertAudit(c.env.DB, appId, "android_release_artifact.complete", currentActor(c), {
    build_id: buildId,
    asset_id: assetId,
    kind: row.filetype,
    sha256: actual.sha256,
    size_bytes: actual.size,
  });
  if (row.filetype === "apk" && c.env.APK_PARSER) {
    try {
      c.executionCtx.waitUntil(autoParseInstallableAsset(c.env, appId, buildId, finalKey, "apk-aapt"));
    } catch {
      // Some unit or direct-handler callers have no execution context. Parsing
      // remains best-effort and never weakens the exact-byte seal.
      void autoParseInstallableAsset(c.env, appId, buildId, finalKey, "apk-aapt");
    }
  }
  return c.json(bundleResponse(c, await rowsForBuild(c.env.DB, appId, buildId)));
}

export async function handleGetAndroidReleaseArtifacts(c: Context<{ Bindings: Env }>) {
  const rows = await rowsForBuild(
    c.env.DB,
    c.req.param("appId") ?? "",
    c.req.param("buildId") ?? "",
  );
  if (rows.length !== 2) return c.json({ error: "artifact bundle not found", code: "ARTIFACT_NOT_FOUND" }, 404);
  return c.json(bundleResponse(c, rows));
}
