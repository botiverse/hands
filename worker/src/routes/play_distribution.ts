import type { Context } from "hono";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";
import { currentActor, currentActorInfo, type AdminEnv } from "../middleware/auth";
import { getGooglePlayBinding } from "../lib/google_play_bindings";

type AdminContext = Context<AdminEnv & { Bindings: Env }>;
type PlayTrack = "internal" | "closed" | "production";

export interface PlayPromotionInput {
  track: PlayTrack;
  rollout_percent?: number;
  expected_revision: number;
  approval: { note: string };
}

interface ReleaseArtifactRow {
  release_id: string;
  release_revision: number;
  release_status: string;
  build_id: string;
  package_name: string;
  version_name: string;
  version_code: number;
  source_repository: string;
  source_commit: string;
  ci_run_id: string;
  upload_key_cert_sha256: string;
  bundle_state: string;
  asset_id: string;
  filetype: string;
  r2_key: string;
  file_hash: string;
  size_bytes: number;
  metadata_json: string;
}

interface PlayReadback {
  edit_id: string;
  package_name: string;
  version_code: number;
  track: PlayTrack;
  sha256: string;
  rollout_percent?: number | null;
}

interface GateFailure {
  code: "gate_failed" | "edit_conflict" | "version_conflict" | "play_api_error" | "hold_active" | "forbidden";
  gate: "immutable_binding" | "acceptance_receipt" | "channel" | "version_code" | "edit_lock" | "live_hold" | "permission" | null;
  message: string;
  receipt_id?: string | null;
}

function fail(c: Context<any>, status: 400 | 403 | 409 | 502, failure: GateFailure) {
  return c.json({ error: { receipt_id: null, ...failure } }, status);
}

function jsonObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function positiveRevision(value: unknown): number | null {
  const revision = Number(value);
  return Number.isSafeInteger(revision) && revision >= 0 ? revision : null;
}

export function normalizePlayPromotionInput(input: PlayPromotionInput): PlayPromotionInput {
  if (!input || typeof input !== "object") throw new Error("request body required");
  if (input.track !== "internal" && input.track !== "closed" && input.track !== "production") {
    throw new Error("track must be internal, closed, or production");
  }
  const expectedRevision = positiveRevision(input.expected_revision);
  if (expectedRevision === null) throw new Error("expected_revision must be a non-negative integer");
  const note = typeof input.approval?.note === "string" ? input.approval.note.trim() : "";
  if (!note) throw new Error("approval.note required");
  const rollout = input.rollout_percent;
  if (rollout !== undefined && (!Number.isInteger(rollout) || rollout < 1 || rollout > 100)) {
    throw new Error("rollout_percent must be an integer from 1 to 100");
  }
  if (input.track !== "production" && rollout !== undefined && rollout !== 100) {
    throw new Error("partial rollout is supported only for production");
  }
  return { track: input.track, expected_revision: expectedRevision, approval: { note }, ...(rollout === undefined ? {} : { rollout_percent: rollout }) };
}

export function playReadbackMatches(
  artifact: Pick<ReleaseArtifactRow, "package_name" | "version_code" | "file_hash">,
  requestedTrack: PlayTrack,
  readback: PlayReadback,
): boolean {
  return typeof readback?.sha256 === "string"
    && readback.package_name === artifact.package_name
    && readback.version_code === artifact.version_code
    && readback.track === requestedTrack
    && readback.sha256.toLowerCase() === artifact.file_hash.toLowerCase();
}

async function getReleaseArtifact(db: D1Database, appId: string, releaseId: string): Promise<ReleaseArtifactRow | null> {
  return db.prepare(
    `SELECT r.id AS release_id, r.revision AS release_revision, r.status AS release_status,
            b.id AS build_id, arb.package_name, arb.version_name, arb.version_code,
            arb.source_repository, arb.source_commit, arb.ci_run_id,
            arb.upload_key_cert_sha256,
            arb.state AS bundle_state, ba.id AS asset_id, ba.filetype,
            ba.r2_key, ba.file_hash, ba.size_bytes, ba.metadata_json
     FROM releases r
     JOIN builds b ON b.id = r.build_id AND b.app_id = r.app_id
     JOIN android_release_artifact_bundles arb ON arb.build_id = b.id AND arb.app_id = r.app_id
     JOIN build_assets ba ON ba.build_id = b.id
     WHERE r.app_id = ?1 AND r.id = ?2
       AND ba.artifact_kind = 'installable' AND ba.platform = 'android' AND ba.filetype = 'aab'
     LIMIT 1`,
  ).bind(appId, releaseId).first<ReleaseArtifactRow>();
}

async function getReleaseArtifactById(
  db: D1Database,
  appId: string,
  releaseId: string,
  assetId: string,
): Promise<ReleaseArtifactRow | null> {
  return db.prepare(
    `SELECT r.id AS release_id, r.revision AS release_revision, r.status AS release_status,
            b.id AS build_id, arb.package_name, arb.version_name, arb.version_code,
            arb.source_repository, arb.source_commit, arb.ci_run_id,
            arb.upload_key_cert_sha256, arb.state AS bundle_state,
            ba.id AS asset_id, ba.filetype, ba.r2_key, ba.file_hash,
            ba.size_bytes, ba.metadata_json
     FROM releases r
     JOIN builds b ON b.id = r.build_id AND b.app_id = r.app_id
     JOIN android_release_artifact_bundles arb ON arb.build_id = b.id AND arb.app_id = r.app_id
     JOIN build_assets ba ON ba.build_id = b.id
     WHERE r.app_id = ?1 AND r.id = ?2 AND ba.id = ?3
       AND ba.artifact_kind = 'installable' AND ba.platform = 'android'
       AND ba.filetype IN ('aab', 'apk')
     LIMIT 1`,
  ).bind(appId, releaseId, assetId).first<ReleaseArtifactRow>();
}

function receiptArtifact(artifact: ReleaseArtifactRow) {
  return {
    type: artifact.filetype,
    sha256: artifact.file_hash,
    size_bytes: artifact.size_bytes,
    package: artifact.package_name,
    version_name: artifact.version_name,
    version_code: artifact.version_code,
  };
}

function receiptSource(artifact: ReleaseArtifactRow) {
  return {
    repo: artifact.source_repository,
    sha: artifact.source_commit,
    ci_run_id: artifact.ci_run_id,
  };
}

async function latestAcceptance(db: D1Database, appId: string, releaseId: string, assetId: string) {
  return db.prepare(
    `SELECT id, verdict, artifact_sha256, artifact_size, package_name, source_commit, version_code
     FROM release_receipts
     WHERE app_id = ?1 AND release_id = ?2 AND kind = 'acceptance' AND artifact_id = ?3
     ORDER BY created_at DESC, rowid DESC LIMIT 1`,
  ).bind(appId, releaseId, assetId).first<{
    id: string;
    verdict: string;
    artifact_sha256: string;
    artifact_size: number;
    package_name: string;
    source_commit: string;
    version_code: number;
  }>();
}

function acceptanceMatches(row: ReleaseArtifactRow, receipt: Awaited<ReturnType<typeof latestAcceptance>>): boolean {
  return Boolean(receipt
    && receipt.verdict === "pass"
    && receipt.artifact_sha256 === row.file_hash
    && receipt.artifact_size === row.size_bytes
    && receipt.package_name === row.package_name
    && receipt.source_commit === row.source_commit
    && receipt.version_code === row.version_code);
}

async function insertReceipt(
  db: D1Database,
  args: {
    id: string;
    appId: string;
    releaseId: string;
    kind: "acceptance" | "play-promotion";
    verdict: "pass" | "fail" | "success" | "failed-closed";
    artifact: ReleaseArtifactRow;
    action?: string | null;
    track?: PlayTrack | null;
    editId?: string | null;
    payload: unknown;
    actor: string;
  },
) {
  await db.prepare(
    `INSERT INTO release_receipts
     (id, app_id, release_id, kind, verdict, artifact_id, artifact_sha256,
      artifact_size, package_name, source_commit, version_code, action, track,
      play_edit_id, payload_json, created_by, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)`,
  ).bind(
    args.id, args.appId, args.releaseId, args.kind, args.verdict,
    args.artifact.asset_id, args.artifact.file_hash, args.artifact.size_bytes,
    args.artifact.package_name, args.artifact.source_commit, args.artifact.version_code,
    args.action ?? null, args.track ?? null, args.editId ?? null,
    JSON.stringify(args.payload), args.actor, Date.now(),
  ).run();
}

export async function handleCreateAcceptanceReceipt(c: AdminContext) {
  const appId = c.req.param("appId") ?? "";
  const releaseId = c.req.param("releaseId") ?? "";
  let body: {
    artifact_id: string;
    verdict: "pass" | "fail";
    matrix_ref: string;
    note?: string;
    expected_revision: number;
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "valid JSON body required", code: "INVALID_ACCEPTANCE_RECEIPT" }, 400);
  }
  const expectedRevision = positiveRevision(body.expected_revision);
  if (!body.artifact_id || (body.verdict !== "pass" && body.verdict !== "fail") || !body.matrix_ref?.trim() || expectedRevision === null) {
    return c.json({ error: "artifact_id, verdict, matrix_ref, expected_revision required", code: "INVALID_ACCEPTANCE_RECEIPT" }, 400);
  }
  const artifact = await getReleaseArtifactById(c.env.DB, appId, releaseId, body.artifact_id);
  if (!artifact) {
    return c.json({ error: "release artifact not found", code: "ARTIFACT_NOT_FOUND" }, 404);
  }
  const metadata = jsonObject(artifact.metadata_json);
  if (artifact.bundle_state !== "ready" || metadata.upload_state !== "ready") {
    return c.json({ error: "artifact is not sealed and ready", code: "STATE_CONFLICT" }, 409);
  }
  if (artifact.release_revision !== expectedRevision) {
    return c.json({ error: "release revision conflict", code: "VERSION_CONFLICT", current_revision: artifact.release_revision }, 409);
  }
  const receiptId = crypto.randomUUID();
  const actor = currentActor(c);
  const createdAt = Date.now();
  const receipt = {
    schema_version: 1,
    kind: "acceptance",
    receipt_id: receiptId,
    created_at: new Date(createdAt).toISOString(),
    artifact: receiptArtifact(artifact),
    source: receiptSource(artifact),
    signing: { upload_key_cert_sha256: artifact.upload_key_cert_sha256 },
    hands_acceptance: {
      verdict: body.verdict,
      matrix_ref: body.matrix_ref.trim(),
      verifier: actor,
    },
    actor,
    action: "accept",
    result: {
      status: body.verdict === "pass" ? "success" : "failed-closed",
      ...(body.verdict === "fail" ? { failure_reason: body.note?.trim() || "acceptance failed" } : {}),
    },
  };
  const inserted = await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO release_receipts
       (id, app_id, release_id, kind, verdict, artifact_id, artifact_sha256,
        artifact_size, package_name, source_commit, version_code, payload_json,
        created_by, created_at)
       SELECT ?1, ?2, ?3, 'acceptance', ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13
       FROM releases WHERE app_id = ?2 AND id = ?3 AND revision = ?14`,
    ).bind(
      receiptId, appId, releaseId, body.verdict, artifact.asset_id, artifact.file_hash,
      artifact.size_bytes, artifact.package_name, artifact.source_commit, artifact.version_code,
      JSON.stringify(receipt), actor, createdAt, expectedRevision,
    ),
    c.env.DB.prepare(
      `UPDATE releases SET revision = revision + 1, updated_at = ?1
       WHERE app_id = ?2 AND id = ?3 AND revision = ?4
         AND EXISTS (SELECT 1 FROM release_receipts WHERE id = ?5)`,
    ).bind(Date.now(), appId, releaseId, expectedRevision, receiptId),
  ]);
  if (Number(inserted[0]?.meta?.changes ?? 0) !== 1 || Number(inserted[1]?.meta?.changes ?? 0) !== 1) {
    return c.json({ error: "release revision conflict", code: "VERSION_CONFLICT" }, 409);
  }
  return c.json({ receipt_id: receiptId, kind: "acceptance", verdict: body.verdict, release_id: releaseId, artifact_id: artifact.asset_id }, 201);
}

export async function handleListReleaseReceipts(c: Context<{ Bindings: Env }>) {
  const appId = c.req.param("appId") ?? "";
  const releaseId = c.req.param("releaseId") ?? "";
  const result = await c.env.DB.prepare(
    `SELECT id, kind, verdict, artifact_id, artifact_sha256, artifact_size,
            package_name, source_commit, version_code, action, track,
            play_edit_id, payload_json, created_by, created_at
     FROM release_receipts WHERE app_id = ?1 AND release_id = ?2
     ORDER BY created_at ASC, rowid ASC`,
  ).bind(appId, releaseId).all();
  return c.json({ receipts: result.results.map((row) => ({ ...row, payload: jsonObject(String(row.payload_json)), payload_json: undefined })) });
}

async function hashStream(body: ReadableStream<Uint8Array>) {
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
  return { size, sha256: bytesToHex(hasher.digest()) };
}

async function takeLock(db: D1Database, appId: string, row: ReleaseArtifactRow, operationId: string, actor: string) {
  try {
    await db.prepare(
      `INSERT INTO play_edit_locks
       (app_id, package_name, release_id, operation_id, acquired_by, acquired_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
    ).bind(appId, row.package_name, row.release_id, operationId, actor, Date.now()).run();
    return true;
  } catch {
    return false;
  }
}

async function releaseLock(db: D1Database, operationId: string) {
  await db.prepare("DELETE FROM play_edit_locks WHERE operation_id = ?1").bind(operationId).run();
}

async function failedPromotionReceipt(
  c: AdminContext,
  artifact: ReleaseArtifactRow,
  actor: string,
  track: PlayTrack,
  approvalNote: string,
  reason: string,
  details: unknown,
) {
  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  await insertReceipt(c.env.DB, {
    id, appId: c.req.param("appId") ?? "", releaseId: artifact.release_id,
    kind: "play-promotion", verdict: "failed-closed", artifact,
    action: "promote", track, payload: {
      schema_version: 1,
      kind: "play-promotion",
      receipt_id: id,
      created_at: createdAt,
      artifact: receiptArtifact(artifact),
      source: receiptSource(artifact),
      signing: { upload_key_cert_sha256: artifact.upload_key_cert_sha256 },
      actor,
      action: "promote",
      approvals: [{ approver: actor, at: createdAt, scope: `${track}: ${approvalNote}` }],
      play: {
        edit_id: "failed-closed",
        track,
        play_version_code: artifact.version_code,
        api_readback: {
          package: artifact.package_name,
          version_code: artifact.version_code,
          track,
          sha256_match: false,
        },
      },
      result: {
        status: "failed-closed",
        failure_reason: `${reason}: ${JSON.stringify(details)}`,
      },
    }, actor,
  });
  return id;
}

export async function handlePromotePlayDistribution(c: AdminContext) {
  const appId = c.req.param("appId") ?? "";
  const releaseId = c.req.param("releaseId") ?? "";
  let input: PlayPromotionInput;
  try {
    input = normalizePlayPromotionInput(await c.req.json<PlayPromotionInput>());
  } catch (error) {
    return fail(c, 400, { code: "gate_failed", gate: "permission", message: (error as Error).message });
  }
  if (currentActorInfo(c).type !== "human") {
    return fail(c, 403, { code: "forbidden", gate: "permission", message: "Play promotion requires approval by an authenticated human publisher" });
  }
  const artifact = await getReleaseArtifact(c.env.DB, appId, releaseId);
  if (!artifact) return fail(c, 400, { code: "gate_failed", gate: "channel", message: "release does not contain an Android AAB" });
  if (artifact.release_revision !== input.expected_revision) {
    return fail(c, 409, { code: "version_conflict", gate: null, message: `release revision is ${artifact.release_revision}, not ${input.expected_revision}` });
  }
  const metadata = jsonObject(artifact.metadata_json);
  if (artifact.filetype !== "aab") return fail(c, 400, { code: "gate_failed", gate: "channel", message: "Google Play promotion accepts AAB only" });
  if (artifact.bundle_state !== "ready" || metadata.upload_state !== "ready" || metadata.verified_sha256 !== artifact.file_hash || metadata.verified_size_bytes !== artifact.size_bytes) {
    return fail(c, 400, { code: "gate_failed", gate: "immutable_binding", message: "AAB is not sealed to its declared exact bytes" });
  }
  const acceptance = await latestAcceptance(c.env.DB, appId, releaseId, artifact.asset_id);
  if (!acceptanceMatches(artifact, acceptance)) {
    return fail(c, 400, { code: "gate_failed", gate: "acceptance_receipt", message: "latest Hands acceptance receipt does not pass for the exact AAB" });
  }
  const hold = await c.env.DB.prepare(
    "SELECT id FROM release_distribution_holds WHERE app_id = ?1 AND release_id = ?2 AND closed_at IS NULL LIMIT 1",
  ).bind(appId, releaseId).first();
  if (hold) return fail(c, 403, { code: "hold_active", gate: "live_hold", message: "release has an active distribution hold" });
  if (!c.env.PLAY_RELEASE_SERVICE) {
    return fail(c, 502, { code: "play_api_error", gate: null, message: "Google Play release service is not configured" });
  }
  let binding;
  try {
    binding = await getGooglePlayBinding(c.env.DB, appId, c.env.PLAY_CRED_ENC_KEYS);
  } catch {
    return fail(c, 502, { code: "play_api_error", gate: "permission", message: "Google Play credentials are unavailable for this app" });
  }
  if (!binding || binding.enabled !== 1 || binding.verification_state !== "verified") {
    return fail(c, 403, { code: "forbidden", gate: "permission", message: "Google Play must be bound, verified, and enabled for this app" });
  }
  if (binding.package_name !== artifact.package_name) {
    return fail(c, 400, { code: "gate_failed", gate: "immutable_binding", message: "AAB package does not match this app's Google Play binding" });
  }

  const actor = currentActor(c);
  const operationId = crypto.randomUUID();
  if (!(await takeLock(c.env.DB, appId, artifact, operationId, actor))) {
    return fail(c, 409, { code: "edit_conflict", gate: "edit_lock", message: "another Play edit is active for this package" });
  }
  try {
    let trackResult;
    try {
      trackResult = await c.env.PLAY_RELEASE_SERVICE.readTrackMaximum({
        credential: binding.credential,
        packageName: binding.package_name,
        tracks: binding.tracks,
        handsTrack: input.track,
      });
    } catch {
      return fail(c, 502, { code: "play_api_error", gate: null, message: "Play track read request failed" });
    }
    if (!trackResult?.ok) {
      return fail(c, 502, { code: "play_api_error", gate: null, message: trackResult?.error?.message ?? "Play track read failed" });
    }
    const maxVersionCode = Number(trackResult.value.max_version_code);
    if (!Number.isSafeInteger(maxVersionCode) || maxVersionCode < 0) {
      return fail(c, 502, { code: "play_api_error", gate: null, message: "Play track read returned an invalid max_version_code" });
    }
    const requiredVersionCode = maxVersionCode + 1;
    if (artifact.version_code !== requiredVersionCode) {
      return fail(c, 409, { code: "version_conflict", gate: "version_code", message: `artifact versionCode ${artifact.version_code} must equal Play ${input.track} max + 1 (${requiredVersionCode})` });
    }
    const reserved = await c.env.DB.prepare(
      `UPDATE releases SET revision = revision + 1, updated_at = ?1
       WHERE app_id = ?2 AND id = ?3 AND revision = ?4`,
    ).bind(Date.now(), appId, releaseId, input.expected_revision).run();
    if (Number(reserved.meta?.changes ?? 0) !== 1) {
      return fail(c, 409, { code: "version_conflict", gate: null, message: "release changed before the Play edit was reserved" });
    }
    let object: R2ObjectBody | null;
    try {
      object = await c.env.APK_BUCKET.get(artifact.r2_key);
    } catch {
      const receiptId = await failedPromotionReceipt(c, artifact, actor, input.track, input.approval.note, "immutable_binding", { object_read: "failed" });
      return fail(c, 400, { code: "gate_failed", gate: "immutable_binding", message: "stored AAB could not be read", receipt_id: receiptId });
    }
    if (!object || object.size !== artifact.size_bytes) {
      const receiptId = await failedPromotionReceipt(c, artifact, actor, input.track, input.approval.note, "immutable_binding", { object_size: object?.size ?? null });
      return fail(c, 400, { code: "gate_failed", gate: "immutable_binding", message: "stored AAB size changed", receipt_id: receiptId });
    }
    const [hashBranch, uploadBranch] = object.body.tee();
    const uploadResponsePromise = Promise.resolve().then(() => c.env.PLAY_RELEASE_SERVICE!.promote({
      credential: binding.credential,
      packageName: binding.package_name,
      tracks: binding.tracks,
      handsTrack: input.track,
      versionCode: artifact.version_code,
      expectedSha256: artifact.file_hash,
      expectedSize: artifact.size_bytes,
      rolloutPercent: input.rollout_percent ?? 100,
      operationId,
    }, uploadBranch));
    const [localResult, uploadResult] = await Promise.allSettled([hashStream(hashBranch), uploadResponsePromise]);
    if (localResult.status === "rejected") {
      const receiptId = await failedPromotionReceipt(c, artifact, actor, input.track, input.approval.note, "immutable_binding", { stream_read: "failed" });
      return fail(c, 400, { code: "gate_failed", gate: "immutable_binding", message: "stored AAB stream could not be verified", receipt_id: receiptId });
    }
    if (uploadResult.status === "rejected") {
      const receiptId = await failedPromotionReceipt(c, artifact, actor, input.track, input.approval.note, "play_api_error", { request: "failed" });
      return fail(c, 502, { code: "play_api_error", gate: null, message: "Play edit request failed", receipt_id: receiptId });
    }
    const local = localResult.value;
    const uploadResponse = uploadResult.value;
    if (local.sha256 !== artifact.file_hash || local.size !== artifact.size_bytes) {
      const receiptId = await failedPromotionReceipt(c, artifact, actor, input.track, input.approval.note, "immutable_binding", { actual: local });
      return fail(c, 400, { code: "gate_failed", gate: "immutable_binding", message: "streamed AAB did not match the accepted artifact", receipt_id: receiptId });
    }
    if (!uploadResponse?.ok) {
      const receiptId = await failedPromotionReceipt(c, artifact, actor, input.track, input.approval.note, "play_api_error", { code: uploadResponse?.error?.code ?? "unknown" });
      return fail(c, 502, { code: "play_api_error", gate: null, message: uploadResponse?.error?.message ?? "Play edit failed", receipt_id: receiptId });
    }
    const readback: PlayReadback = uploadResponse.value;
    if (!playReadbackMatches(artifact, input.track, readback)) {
      const receiptId = await failedPromotionReceipt(c, artifact, actor, input.track, input.approval.note, "play_readback_mismatch", { readback });
      return fail(c, 502, { code: "play_api_error", gate: "immutable_binding", message: "Play readback did not match package/version/track/SHA-256", receipt_id: receiptId });
    }
    const receiptId = crypto.randomUUID();
    await insertReceipt(c.env.DB, {
      id: receiptId, appId, releaseId, kind: "play-promotion", verdict: "success",
      artifact, action: "promote", track: input.track, editId: readback.edit_id,
      payload: {
        schema_version: 1,
        kind: "play-promotion",
        receipt_id: receiptId,
        created_at: new Date().toISOString(),
        artifact: receiptArtifact(artifact),
        source: receiptSource(artifact),
        signing: { upload_key_cert_sha256: artifact.upload_key_cert_sha256 },
        actor,
        action: "promote",
        approvals: [{ approver: actor, at: new Date().toISOString(), scope: input.track }],
        play: {
          edit_id: readback.edit_id,
          track: input.track,
          rollout_percent: input.rollout_percent ?? 100,
          play_version_code: artifact.version_code,
          api_readback: {
            package: readback.package_name,
            version_code: readback.version_code,
            track: readback.track,
            sha256_match: true,
          },
        },
        result: { status: "success" },
      },
      actor,
    });
    await c.env.DB.prepare(
      `INSERT INTO play_distribution_state
       (app_id, release_id, package_name, track, version_code, rollout_percent,
        state, last_edit_id, last_receipt_id, revision, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'active', ?7, ?8, 1, ?9)
       ON CONFLICT(app_id, release_id) DO UPDATE SET
         package_name = excluded.package_name, track = excluded.track,
         version_code = excluded.version_code, rollout_percent = excluded.rollout_percent,
         state = excluded.state, last_edit_id = excluded.last_edit_id,
         last_receipt_id = excluded.last_receipt_id,
         revision = play_distribution_state.revision + 1, updated_at = excluded.updated_at`,
    ).bind(
      appId, releaseId, artifact.package_name, input.track, artifact.version_code,
      input.rollout_percent ?? 100, readback.edit_id, receiptId, Date.now(),
    ).run();
    return c.json({ receipt_id: receiptId, edit_id: readback.edit_id, track: input.track, version_code: artifact.version_code, revision: input.expected_revision + 1 });
  } finally {
    await releaseLock(c.env.DB, operationId);
  }
}

export async function handleGetPlayDistribution(c: Context<{ Bindings: Env }>) {
  const row = await c.env.DB.prepare(
    `SELECT package_name, track, version_code, rollout_percent, state,
            last_edit_id, last_receipt_id, revision, updated_at
     FROM play_distribution_state WHERE app_id = ?1 AND release_id = ?2`,
  ).bind(c.req.param("appId") ?? "", c.req.param("releaseId") ?? "").first();
  return c.json({ play: row ?? null });
}

export async function handleListDistributions(c: Context<{ Bindings: Env }>) {
  const appId = c.req.param("appId") ?? "";
  const releaseId = c.req.param("releaseId") ?? "";
  const play = await c.env.DB.prepare(
    "SELECT track, version_code, rollout_percent, state, last_receipt_id, updated_at FROM play_distribution_state WHERE app_id = ?1 AND release_id = ?2",
  ).bind(appId, releaseId).first();
  const accepted = await c.env.DB.prepare(
    `SELECT verdict FROM release_receipts
     WHERE app_id = ?1 AND release_id = ?2 AND kind = 'acceptance'
     ORDER BY created_at DESC, rowid DESC LIMIT 1`,
  ).bind(appId, releaseId).first<{ verdict: string }>();
  return c.json({
    distributions: [
      { provider: "hands", state: accepted?.verdict === "pass" ? "accepted" : "not-accepted" },
      { provider: "google-play", ...(play ?? { state: "not-promoted" }) },
    ],
  });
}

async function unsupportedPlayMutation(c: AdminContext, action: "halt" | "rollback-republish") {
  const actor = currentActorInfo(c);
  let body: {
    expected_revision?: number;
    approval?: { note?: string };
    to_version_code?: number;
  };
  try {
    body = await c.req.json();
  } catch {
    return fail(c, 403, { code: "forbidden", gate: "permission", message: `${action} requires a valid JSON approval body` });
  }
  if (actor.type !== "human" || positiveRevision(body.expected_revision) === null || !body.approval?.note?.trim()) {
    return fail(c, 403, { code: "forbidden", gate: "permission", message: `${action} requires expected_revision and authenticated human approval` });
  }
  if (action === "rollback-republish") {
    const toVersionCode = Number(body.to_version_code);
    if (!Number.isSafeInteger(toVersionCode) || toVersionCode <= 0) {
      return fail(c, 400, { code: "gate_failed", gate: "version_code", message: "rollback-republish requires a positive to_version_code" });
    }
  }
  return fail(c, 502, { code: "play_api_error", gate: null, message: `${action} is fail-closed until the Google Play release service implements this operation` });
}

export async function handleHaltPlayDistribution(c: AdminContext) {
  return unsupportedPlayMutation(c, "halt");
}

export async function handleRollbackPlayDistribution(c: AdminContext) {
  return unsupportedPlayMutation(c, "rollback-republish");
}
