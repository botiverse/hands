/**
 * Notarization lane (broker-only, platform feature).
 *
 * POST /api/apps/:appId/builds/:buildId/notarize      [publisher]
 * GET  /api/apps/:appId/notarizations/:submissionId    [viewer]
 *
 * State-machine and ownership guarantees:
 *   B0: etagMatches (not etag); no build_id on asset; no undefined completed_at
 *   B1: DigestStream streaming SHA; second etagMatches GET → direct S3 PUT stream
 *   B2: Schema-valid SQL transitions only
 *   B3: CAS attempt ownership before Apple side-effect; loser rereads winner
 *   B4: Fail-closed on unknown; discriminated errors; 401/403/7000 distinct
 *   B5: Only active attempt CAS-projects into logical
 *   B6: Discriminated asset resolution (409/404/400)
 *   B7: D1 batch closure; no developerLogUrl leak
 */
import type { Context } from "hono";
import type { AdminEnv } from "../middleware/auth";
import { currentActor } from "../middleware/auth";
import { getAscCredentials } from "../lib/asc_credentials";
import { AscApiError } from "../lib/asc_api";
import type { AscApiCredentials } from "../lib/asc_api";
import {
  createNotarySubmission,
  listNotarySubmissions,
  getNotarySubmissionStatus,
  getNotarySubmissionLog,
  uploadArtifactToS3,
} from "../lib/notary_api";
import { updateOperation } from "./operations";
import { insertAuditLog } from "../lib/permissions";

type AdminContext = Context<AdminEnv & { Bindings: Env }>;

const ERR = {
  NO_ENC_KEY: "MISSING_ASC_CRED_ENC_KEY",
  NO_ASC_CREDS: "NO_ASC_CREDENTIALS",
  BUILD_NOT_FOUND: "BUILD_NOT_FOUND",
  NO_NOTARY_ASSET: "NO_NOTARIZABLE_ASSET",
  UNSUPPORTED_FILETYPE: "UNSUPPORTED_FILETYPE",
  AMBIGUOUS_ASSET: "AMBIGUOUS_ASSET",
  ASSET_INTEGRITY_MISMATCH: "ASSET_INTEGRITY_MISMATCH",
  AUTH_INVALID: "NOTARY_AUTH_INVALID",
  ROLE_INSUFFICIENT: "NOTARY_ROLE_INSUFFICIENT",
  TEAM_NOT_CONFIGURED: "NOTARY_TEAM_NOT_CONFIGURED",
  APPLE_REQUEST_FAILED: "APPLE_REQUEST_FAILED",
  S3_UPLOAD_FAILED: "S3_UPLOAD_FAILED",
  SHA_BINDING_MISMATCH: "SHA_BINDING_MISMATCH",
  UPLOAD_UNCERTAIN: "UPLOAD_UNCERTAIN",
  UNKNOWN: "UNKNOWN",
} as const;

const VALID_APPLE_STATUSES = new Set(["In Progress", "Accepted", "Invalid", "Rejected"]);
const FILETYPE_CONTENT_TYPE: Record<string, string> = {
  dmg: "application/x-apple-diskimage",
  zip: "application/zip",
  pkg: "application/octet-stream",
};
const MAX_NOTARY_LOG_BYTES = 1024 * 1024;

// ──────────── Asset resolution (B6: discriminated) ────────────

interface NotaryAsset {
  id: string;
  r2_key: string;
  file_hash: string;
  size_bytes: number;
  filetype: string;
  platform: string;
}

type AssetResult =
  | { ok: true; asset: NotaryAsset }
  | { ok: false; code: string; status: 400 | 404 | 409; message: string };

async function resolveNotaryAsset(db: D1Database, buildId: string, hintAssetId: string): Promise<AssetResult> {
  if (hintAssetId) {
    const asset = await db.prepare(
      `SELECT id, r2_key, file_hash, size_bytes, filetype, platform FROM build_assets
       WHERE id = ?1 AND build_id = ?2 AND artifact_kind = 'installable'`,
    ).bind(hintAssetId, buildId).first<NotaryAsset>();
    if (!asset) return { ok: false, code: "ASSET_NOT_FOUND", status: 404, message: "asset not found for this build" };
    if (asset.platform !== "darwin")
      return { ok: false, code: "UNSUPPORTED_PLATFORM", status: 400, message: `platform '${asset.platform}' not supported (accepted: darwin)` };
    if (!["dmg", "zip", "pkg"].includes(asset.filetype))
      return { ok: false, code: ERR.UNSUPPORTED_FILETYPE, status: 400, message: `filetype '${asset.filetype}' not supported (accepted: dmg, zip, pkg)` };
    return { ok: true, asset };
  }
  const { results } = await db.prepare(
    `SELECT id, r2_key, file_hash, size_bytes, filetype, platform FROM build_assets
     WHERE build_id = ?1 AND artifact_kind = 'installable'
       AND platform = 'darwin' AND filetype IN ('dmg','zip','pkg')`,
  ).bind(buildId).all<NotaryAsset>();
  if (results.length === 0) return { ok: false, code: ERR.NO_NOTARY_ASSET, status: 404, message: "no notarizable asset (accepted: dmg, zip, pkg)" };
  if (results.length > 1) return { ok: false, code: ERR.AMBIGUOUS_ASSET, status: 409, message: "multiple notarizable assets; specify asset_id" };
  return { ok: true, asset: results[0]! };
}

// ──────────── Streaming SHA via DigestStream (B1) ────────────

class SnapshotError extends Error {
  code: string;
  constructor(msg: string, code: string) { super(msg); this.code = code; }
}

interface SourceSnapshot {
  etag: string;
  size: number;
  computedSha: string;
}

/**
 * First etagMatches GET → pipeThrough DigestStream → streaming SHA.
 * Does NOT buffer the artifact. Returns etag/size/computedSha for ledger.
 * Caller does a SECOND etagMatches GET to get the upload body stream.
 */
async function snapshotAndVerify(env: Env, r2Key: string, expectedHash: string, expectedSize: number): Promise<SourceSnapshot> {
  const meta = await env.APK_BUCKET.head(r2Key);
  if (!meta) throw new SnapshotError("asset missing from R2", ERR.ASSET_INTEGRITY_MISMATCH);
  if (meta.size !== expectedSize)
    throw new SnapshotError(`R2 size ${meta.size} != DB size ${expectedSize}`, ERR.ASSET_INTEGRITY_MISMATCH);

  // First conditional read — pipe to DigestStream (streaming, no buffer).
  const obj = await env.APK_BUCKET.get(r2Key, { onlyIf: { etagMatches: meta.etag } });
  if (!obj || !("body" in obj) || !obj.body)
    throw new SnapshotError("R2 object changed during read", ERR.ASSET_INTEGRITY_MISMATCH);
  if (obj.etag !== meta.etag) throw new SnapshotError("R2 etag drift", ERR.ASSET_INTEGRITY_MISMATCH);

  const digestStream = new crypto.DigestStream("SHA-256");
  await obj.body.pipeTo(digestStream);
  const digest = await digestStream.digest;
  // Assert all expected bytes were hashed.
  if (Number(digestStream.bytesWritten) !== expectedSize)
    throw new SnapshotError(`bytesWritten ${digestStream.bytesWritten} != expected ${expectedSize}`, ERR.ASSET_INTEGRITY_MISMATCH);
  const computedSha = [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");

  if (computedSha !== expectedHash)
    throw new SnapshotError(`SHA mismatch: computed ${computedSha} != DB ${expectedHash}`, ERR.ASSET_INTEGRITY_MISMATCH);

  return { etag: meta.etag, size: meta.size, computedSha };
}

// ──────────── Apple parsers (B4) ────────────

function classifyError(e: unknown, phase: string): { code: string; detail: string; recoverable: boolean } {
  if (e instanceof AscApiError) {
    if (e.status === 401) return { code: ERR.AUTH_INVALID, detail: "ASC key auth failed", recoverable: false };
    if (e.status === 403) return { code: ERR.ROLE_INSUFFICIENT, detail: "ASC key role insufficient", recoverable: false };
    if (e.status >= 500) return { code: ERR.APPLE_REQUEST_FAILED, detail: `${e.message} (${e.status})`, recoverable: true };
    return { code: ERR.APPLE_REQUEST_FAILED, detail: e.message, recoverable: false };
  }
  if (e instanceof DOMException && e.name === "AbortError")
    return { code: ERR.APPLE_REQUEST_FAILED, detail: `${phase}: request aborted`, recoverable: true };
  if (e instanceof TypeError)
    return { code: ERR.APPLE_REQUEST_FAILED, detail: `${phase}: ${e.message}`, recoverable: true };
  return { code: ERR.UNKNOWN, detail: e instanceof Error ? e.message : String(e), recoverable: false };
}

// ──────────── POST /notarize ────────────

export async function handleNotarize(c: AdminContext) {
  const appId = c.req.param("appId") ?? "";
  const buildIdParam = c.req.param("buildId") ?? "";
  const encKey = c.env.ASC_CRED_ENC_KEY;
  if (!encKey) return c.json({ error: "missing ASC_CRED_ENC_KEY", code: ERR.NO_ENC_KEY }, 500);

  const build = await c.env.DB.prepare(
    `SELECT id, version_name FROM builds WHERE app_id = ?1 AND id LIKE ?2 || '%' LIMIT 2`,
  ).bind(appId, buildIdParam).all<{ id: string; version_name: string }>();
  if (!build.results || build.results.length !== 1)
    return c.json({ error: "build not found", code: ERR.BUILD_NOT_FOUND }, 404);
  const b = build.results[0]!;

  const body = (await c.req.json().catch(() => ({}))) as { asset_id?: unknown };
  const hintAssetId = typeof body.asset_id === "string" ? body.asset_id : "";
  const assetResult = await resolveNotaryAsset(c.env.DB, b.id, hintAssetId);
  if (!assetResult.ok) return c.json({ error: assetResult.message, code: assetResult.code }, assetResult.status);
  const asset = assetResult.asset;

  // B4: resolve local credentials BEFORE expensive snapshot/ledger mutation.
  const creds = await getAscCredentials(c.env.DB, encKey, appId);
  if (!creds) return c.json({ error: "no ASC credentials configured", code: ERR.NO_ASC_CREDS }, 400);

  // Snapshot identity before idempotency (B3: SHA is the identity key).
  let snapshot: SourceSnapshot;
  try {
    snapshot = await snapshotAndVerify(c.env, asset.r2_key, asset.file_hash, asset.size_bytes);
  } catch (e) {
    const code = e instanceof SnapshotError ? e.code : ERR.ASSET_INTEGRITY_MISMATCH;
    return c.json({ error: e instanceof Error ? e.message : "snapshot failed", code }, 409);
  }

  // Idempotency: find existing logical by (app_id, asset_id, computed_sha256).
  const existing = await c.env.DB.prepare(
    `SELECT n.id, n.state, n.ready_for_staple, n.active_attempt_id,
            a.apple_submission_id, a.status_state as attempt_status,
            a.reconcile_state, a.submission_name
     FROM app_notarizations n
     LEFT JOIN app_notarization_attempts a ON a.id = n.active_attempt_id
     WHERE n.app_id = ?1 AND n.asset_id = ?2 AND n.computed_sha256 = ?3`,
  ).bind(appId, asset.id, snapshot.computedSha).first<{
    id: string; state: string; ready_for_staple: number;
    active_attempt_id: string | null; apple_submission_id: string | null; attempt_status: string | null;
    reconcile_state: string | null; submission_name: string | null;
  }>();

  if (existing) {
    if (existing.state === "accepted") {
      return c.json({ notarization_id: existing.id, submission_id: existing.apple_submission_id, state: "accepted", ready_for_staple: existing.ready_for_staple === 1, idempotent: true });
    }
    if (existing.active_attempt_id && existing.attempt_status &&
        ["pending", "in_progress"].includes(existing.attempt_status)) {
      if (existing.reconcile_state === "needed" && existing.submission_name && !existing.apple_submission_id) {
        return await reconcileSubmissionIntent(c, creds, existing.id, existing.active_attempt_id, existing.submission_name);
      }
      return c.json({ notarization_id: existing.id, attempt_id: existing.active_attempt_id, submission_id: existing.apple_submission_id, state: "in_progress", ready_for_staple: false, idempotent: true });
    }
    if (existing.reconcile_state === "abandoned") {
      return c.json({ notarization_id: existing.id, attempt_id: existing.active_attempt_id, state: "error", ready_for_staple: false, idempotent: true, code: ERR.UNKNOWN, note: "automatic retry blocked; operator action required" }, 409);
    }
    // Terminal non-accepted → new attempt on same logical.
    return await startNewAttempt(c, creds, appId, existing.id, asset, b.version_name, snapshot);
  }

  // Create new logical (UNIQUE race → reread winner, B3).
  const logicalId = crypto.randomUUID();
  const now = Date.now();
  try {
    await c.env.DB.prepare(
      `INSERT INTO app_notarizations
         (id, app_id, build_id, asset_id, r2_key, r2_etag, source_size_bytes,
          computed_sha256, source_filetype, source_platform, state, ready_for_staple,
          created_by_actor, created_at, updated_at)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,'darwin','pending',0,?10,?11,?11)`,
    ).bind(logicalId, appId, b.id, asset.id, asset.r2_key, snapshot.etag,
           snapshot.size, snapshot.computedSha, asset.filetype, currentActor(c), now).run();
  } catch {
    // UNIQUE race — reread winner and route through same start-or-return-active flow.
    const winner = await c.env.DB.prepare(
      `SELECT n.id, n.state, n.ready_for_staple, n.active_attempt_id,
              a.apple_submission_id, a.status_state as attempt_status,
              a.reconcile_state, a.submission_name
       FROM app_notarizations n
       LEFT JOIN app_notarization_attempts a ON a.id = n.active_attempt_id
       WHERE n.app_id = ?1 AND n.asset_id = ?2 AND n.computed_sha256 = ?3`,
    ).bind(appId, asset.id, snapshot.computedSha).first<{
      id: string; state: string; ready_for_staple: number;
      active_attempt_id: string | null; apple_submission_id: string | null; attempt_status: string | null;
      reconcile_state: string | null; submission_name: string | null;
    }>();
    if (winner) {
      // Return same shape as idempotency check above.
      if (winner.state === "accepted") {
        return c.json({ notarization_id: winner.id, submission_id: winner.apple_submission_id, state: "accepted", ready_for_staple: winner.ready_for_staple === 1, idempotent: true, note: "concurrent create resolved" });
      }
      if (winner.active_attempt_id && winner.attempt_status && ["pending", "in_progress"].includes(winner.attempt_status)) {
        if (winner.reconcile_state === "needed" && winner.submission_name && !winner.apple_submission_id) {
          return await reconcileSubmissionIntent(c, creds, winner.id, winner.active_attempt_id, winner.submission_name);
        }
        return c.json({ notarization_id: winner.id, attempt_id: winner.active_attempt_id, submission_id: winner.apple_submission_id, state: "in_progress", ready_for_staple: false, idempotent: true, note: "concurrent create resolved" });
      }
      if (winner.reconcile_state === "abandoned") {
        return c.json({ notarization_id: winner.id, attempt_id: winner.active_attempt_id, state: "error", ready_for_staple: false, idempotent: true, code: ERR.UNKNOWN, note: "automatic retry blocked; operator action required" }, 409);
      }
      // Terminal non-accepted — start new attempt on the winner logical.
      return await startNewAttempt(c, creds, appId, winner.id, asset, b.version_name, snapshot);
    }
    return c.json({ error: "concurrent create conflict", code: "CONCURRENT" }, 409);
  }

  return await startNewAttempt(c, creds, appId, logicalId, asset, b.version_name, snapshot);
}

// ──────────── Attempt lifecycle (B3: CAS ownership before Apple side-effect) ────────────

async function startNewAttempt(
  c: AdminContext,
  creds: AscApiCredentials,
  appId: string,
  logicalId: string,
  asset: NotaryAsset,
  versionName: string,
  snapshot: SourceSnapshot,
) {
  const now = Date.now();
  const attemptId = crypto.randomUUID();
  const submissionName = `${versionName}-${asset.filetype}-${snapshot.computedSha.slice(0, 12)}-${attemptId}.${asset.filetype}`;

  // ── CAS: transactional batch — conditional INSERT + guarded active-pointer UPDATE ──
  // attempt_no is computed INSIDE the transaction, not from a stale pre-read.
  // Operation/audit/link are part of the same ownership transaction.
  // Conditional INSERT ... SELECT creates candidate ONLY when slot is empty/terminal.
  // Loser has no candidate row → reread winner. No orphan rows.

  const operationId = crypto.randomUUID();
  const auditId = crypto.randomUUID();
  const actor = currentActor(c);
  const operationInput = JSON.stringify({ logical_id: logicalId, asset_id: asset.id, sha: snapshot.computedSha });
  const auditPayload = JSON.stringify({ logical_id: logicalId, asset_id: asset.id, sha: snapshot.computedSha });

  // Batch: candidate attempt + operation + audit + operation link + active pointer.
  // Every dependent INSERT/UPDATE is conditional on this candidate attempt existing,
  // so a CAS loser creates no attempt, operation, audit, or link.
  const batchResults = await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO app_notarization_attempts
         (id, notarization_id, app_id, attempt_no, operation_id, submission_name,
          upload_state, status_state, reconcile_state, created_at)
       SELECT ?1, ?2, ?3,
              (SELECT COALESCE(MAX(attempt_no), 0) + 1 FROM app_notarization_attempts WHERE notarization_id = ?2),
              NULL, ?4, 'pending', 'pending', 'none', ?5
       WHERE EXISTS (
         SELECT 1 FROM app_notarizations n
         WHERE n.id = ?2 AND (
           n.active_attempt_id IS NULL OR
           n.active_attempt_id IN (
             SELECT id FROM app_notarization_attempts
             WHERE notarization_id = ?2 AND status_state IN ('accepted','invalid','rejected','error')
           )
         )
       )`,
    ).bind(attemptId, logicalId, appId, submissionName, now),
    c.env.DB.prepare(
      `INSERT INTO operation_logs
         (id, app_id, kind, status, parent_op_id, step_number, actor,
          input, output, error, progress, retry_count, created_at, updated_at, completed_at)
       SELECT ?1, ?2, 'notarize', 'in_progress', NULL, NULL, ?3,
              ?4, '{}', NULL, 10, 0, ?5, ?5, NULL
       WHERE EXISTS (SELECT 1 FROM app_notarization_attempts WHERE id = ?6)`,
    ).bind(operationId, appId, actor, operationInput, now, attemptId),
    c.env.DB.prepare(
      `INSERT INTO audit_logs (id, app_id, action, actor, payload, created_at)
       SELECT ?1, ?2, 'notarize.start', ?3, ?4, ?5
       WHERE EXISTS (SELECT 1 FROM app_notarization_attempts WHERE id = ?6)`,
    ).bind(auditId, appId, actor, auditPayload, now, attemptId),
    c.env.DB.prepare(
      `UPDATE app_notarization_attempts SET operation_id = ?1
       WHERE id = ?2`,
    ).bind(operationId, attemptId),
    c.env.DB.prepare(
      `UPDATE app_notarizations
       SET active_attempt_id = ?1, state = 'in_progress', updated_at = ?2
       WHERE id = ?3 AND (
         active_attempt_id IS NULL OR
         active_attempt_id IN (
           SELECT id FROM app_notarization_attempts
           WHERE notarization_id = ?3 AND status_state IN ('accepted','invalid','rejected','error')
         )
       )`,
    ).bind(attemptId, now, logicalId),
  ]);

  // Inspect batch result: did our candidate INSERT actually happen?
  const insertMeta = batchResults[0]?.meta;
  const inserted = insertMeta && insertMeta.changes > 0;

  if (!inserted) {
    // Lost the CAS — active slot was claimed by another. Reread winner.
    // No orphan row was created (conditional INSERT didn't fire).
    const winner = await c.env.DB.prepare(
      `SELECT a.id, a.apple_submission_id, a.status_state
       FROM app_notarization_attempts a
       JOIN app_notarizations n ON n.active_attempt_id = a.id
       WHERE n.id = ?1`,
    ).bind(logicalId).first<{ id: string; apple_submission_id: string | null; status_state: string }>();
    if (winner) return c.json({ notarization_id: logicalId, attempt_id: winner.id, submission_id: winner.apple_submission_id, state: winner.status_state, idempotent: true, note: "CAS lost, returning active attempt" });
    return c.json({ error: "CAS claim failed", code: "CONCURRENT" }, 409);
  }

  // Verify active pointer points to us (double-check after batch).
  const claimed = await c.env.DB.prepare(
    `SELECT active_attempt_id FROM app_notarizations WHERE id = ?1`,
  ).bind(logicalId).first<{ active_attempt_id: string | null }>();
  if (claimed?.active_attempt_id !== attemptId) {
    // Race: someone else won between our batch and this check.
    const winner = await c.env.DB.prepare(
      `SELECT a.id, a.apple_submission_id, a.status_state
       FROM app_notarization_attempts a WHERE a.id = ?1`,
    ).bind(claimed?.active_attempt_id).first<{ id: string; apple_submission_id: string | null; status_state: string }>();
    if (winner) return c.json({ notarization_id: logicalId, attempt_id: winner.id, submission_id: winner.apple_submission_id, state: winner.status_state, idempotent: true, note: "CAS lost after batch" });
    return c.json({ error: "CAS verification failed", code: "CONCURRENT" }, 409);
  }

  // ── Phase: create_submission (B1: external mutation boundary) ──
  // B1 fix: if createNotarySubmission fails with recoverable error (5xx/timeout),
  // Apple may have accepted the submission but we lost the response.
  // Mark attempt as upload_uncertain + reconcile_state=needed. The next POST
  // dedupes to this attempt (it's active + pending). Reconciliation should use
  // Apple's Get Previous Submissions endpoint to find the orphan submission.
  // We never create a second submission while outcome is uncertain.
  let submissionAttrs: { awsAccessKeyId: string; awsSecretAccessKey: string; awsSessionToken: string; bucket: string; object: string };
  let appleSubmissionId: string;
  let createResponse: Awaited<ReturnType<typeof createNotarySubmission>>;
  try {
    createResponse = await createNotarySubmission(creds, { submissionName, sha256: snapshot.computedSha });
  } catch (e) {
    const { code, detail, recoverable } = classifyError(e, "create_submission");
    if (recoverable) {
      await c.env.DB.prepare(
        `UPDATE app_notarization_attempts
         SET upload_state = 'upload_uncertain', error_class = ?1, error_detail = ?2,
             error_phase = 'create_submission', reconcile_state = 'needed'
         WHERE id = ?3`,
      ).bind(code, detail, attemptId).run();
      await updateOperation(c.env.DB, operationId, { status: "failed", error: JSON.stringify({ code, detail, note: "uncertain create outcome — needs reconcile" }), completed_at: Date.now() });
      return c.json({ notarization_id: logicalId, attempt_id: attemptId, ok: false, code: ERR.UPLOAD_UNCERTAIN, detail, note: "submission create uncertain — needs reconcile" }, 502);
    }
    await markError(c.env.DB, attemptId, code, detail, "create_submission", false);
    return c.json({ notarization_id: logicalId, attempt_id: attemptId, ok: false, code, detail }, 502);
  }

  const attrs = createResponse?.data?.attributes;
  const responseId = createResponse?.data?.id;
  if (!responseId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(responseId) ||
      !attrs || !attrs.awsAccessKeyId || !attrs.awsSecretAccessKey || !attrs.awsSessionToken || !attrs.bucket || !attrs.object) {
    await markError(c.env.DB, attemptId, ERR.UNKNOWN, "invalid Apple submission response shape", "create_submission", false);
    return c.json({ notarization_id: logicalId, attempt_id: attemptId, ok: false, code: ERR.UNKNOWN, detail: "invalid Apple submission response shape" }, 502);
  }
  appleSubmissionId = responseId;
  submissionAttrs = attrs;

  try {
    await c.env.DB.prepare(
      `UPDATE app_notarization_attempts
       SET apple_submission_id = ?1, upload_state = 'uploading', submitted_at = ?2
       WHERE id = ?3`,
    ).bind(appleSubmissionId, Date.now(), attemptId).run();
    await updateOperation(c.env.DB, operationId, { progress: 30 });
  } catch (e) {
    // The external ID is known even if D1 failed. The durable submission_name
    // lets the next POST reconcile the same Apple mutation before any retry.
    const detail = e instanceof Error ? e.message : String(e);
    return c.json({ notarization_id: logicalId, attempt_id: attemptId, submission_id: appleSubmissionId, ok: false, code: ERR.UPLOAD_UNCERTAIN, detail, note: "Apple submission created; ledger persistence needs reconcile" }, 503);
  }

  // ── Phase: s3_upload (second etagMatches GET → direct PUT stream, matrix 1.8) ──
  try {
    // Second conditional read — this body IS the S3 PUT body.
    const objForUpload = await c.env.APK_BUCKET.get(asset.r2_key, { onlyIf: { etagMatches: snapshot.etag } });
    if (!objForUpload || !("body" in objForUpload) || !objForUpload.body)
      throw new SnapshotError("R2 object changed between hash and upload", ERR.ASSET_INTEGRITY_MISMATCH);
    if (objForUpload.etag !== snapshot.etag) throw new SnapshotError("R2 etag drift before upload", ERR.ASSET_INTEGRITY_MISMATCH);
    if (objForUpload.size !== snapshot.size) throw new SnapshotError("R2 size drift before upload", ERR.ASSET_INTEGRITY_MISMATCH);

    const uploadResult = await uploadArtifactToS3(
      submissionAttrs,
      objForUpload.body,
      snapshot.computedSha,
      FILETYPE_CONTENT_TYPE[asset.filetype] ?? "application/octet-stream",
    );

    await c.env.DB.prepare(
      `UPDATE app_notarization_attempts
       SET upload_state = 'uploaded', s3_receipt_etag = ?1, uploaded_at = ?2
       WHERE id = ?3`,
    ).bind(uploadResult.etag, Date.now(), attemptId).run();
    await updateOperation(c.env.DB, operationId, { progress: 50 });
  } catch (e) {
    const isSnapshot = e instanceof SnapshotError;
    // B7: distinguish deterministic failure from uncertainty.
    // - SnapshotError / S3 4xx HTTP rejection = deterministic upload_failed
    // - Transport/timeout/abort (outcome unknown) = upload_uncertain
    const isAscError = e instanceof AscApiError;
    const isDeterministic = isSnapshot || (isAscError && e.status >= 400 && e.status < 500);
    const uploadState = isDeterministic ? "upload_failed" : "upload_uncertain";
    const code = isSnapshot ? ERR.ASSET_INTEGRITY_MISMATCH : (isDeterministic ? ERR.S3_UPLOAD_FAILED : ERR.UPLOAD_UNCERTAIN);
    const detail = e instanceof Error ? e.message : String(e);
    // Upload failure — but Apple submission already exists. Must reconcile same attempt.
    await c.env.DB.prepare(
      `UPDATE app_notarization_attempts
       SET upload_state = ?1, error_class = ?2, error_detail = ?3, error_phase = 's3_upload',
           reconcile_state = 'needed'
       WHERE id = ?4`,
    ).bind(uploadState, code, detail, attemptId).run();
    await updateOperation(c.env.DB, operationId, { status: "failed", error: JSON.stringify({ code, detail }), completed_at: Date.now() });
    return c.json({ notarization_id: logicalId, attempt_id: attemptId, submission_id: appleSubmissionId, ok: false, code, detail, note: "submission created; upload needs reconcile" }, 502);
  }

  // ── Phase: status_poll (first read) ──
  try {
    const statusResp = await getNotarySubmissionStatus(creds, appleSubmissionId);
    const rawStatus = statusResp.data.attributes.status;
    await c.env.DB.prepare(
      `UPDATE app_notarization_attempts SET last_polled_at = ?1, raw_apple_status = ?2 WHERE id = ?3`,
    ).bind(Date.now(), rawStatus ?? null, attemptId).run();

    // Fail-closed on null/unknown (B4, matrix 4.6).
    if (!rawStatus || !VALID_APPLE_STATUSES.has(rawStatus)) {
      await markError(c.env.DB, attemptId, ERR.UNKNOWN, `unknown Apple status: ${rawStatus}`, "status_poll", false);
      return c.json({ notarization_id: logicalId, attempt_id: attemptId, submission_id: appleSubmissionId, state: "error", code: ERR.UNKNOWN, raw_status: rawStatus }, 500);
    }

    if (rawStatus === "In Progress") {
      await setAttemptStatus(c.env.DB, attemptId, logicalId, "in_progress");
      return c.json({ notarization_id: logicalId, attempt_id: attemptId, submission_id: appleSubmissionId, state: "in_progress", ready_for_staple: false });
    }

    // Terminal (Accepted handled by GET closure; Invalid/Rejected here)
    if (rawStatus === "Accepted") {
      // Don't do closure in POST — return in_progress, caller polls GET for closure.
      await setAttemptStatus(c.env.DB, attemptId, logicalId, "accepted");
      return c.json({ notarization_id: logicalId, attempt_id: attemptId, submission_id: appleSubmissionId, state: "accepted", ready_for_staple: false, note: "poll GET for closure" });
    }

    const terminalState = rawStatus === "Invalid" ? "invalid" : "rejected";
    await setAttemptStatus(c.env.DB, attemptId, logicalId, terminalState);
    await completeTerminalOperation(c.env.DB, attemptId, terminalState, now);
    return c.json({ notarization_id: logicalId, attempt_id: attemptId, submission_id: appleSubmissionId, state: terminalState, ready_for_staple: false });
  } catch (e) {
    const { code, detail, recoverable } = classifyError(e, "status_poll");
    if (recoverable) {
      await c.env.DB.prepare(
        `UPDATE app_notarization_attempts SET error_class = ?1, error_phase = 'status_poll', error_detail = ?2, reconcile_state = 'needed', last_polled_at = ?3 WHERE id = ?4`,
      ).bind(code, detail, Date.now(), attemptId).run();
      return c.json({ notarization_id: logicalId, attempt_id: attemptId, submission_id: appleSubmissionId, state: "in_progress", ready_for_staple: false, note: "transient, will reconcile" }, 502);
    }
    await markError(c.env.DB, attemptId, code, detail, "status_poll", false);
    return c.json({ notarization_id: logicalId, attempt_id: attemptId, ok: false, code, detail }, 502);
  }
}

async function reconcileSubmissionIntent(
  c: AdminContext,
  creds: AscApiCredentials,
  logicalId: string,
  attemptId: string,
  submissionName: string,
) {
  try {
    const previous = await listNotarySubmissions(creds);
    const matches = Array.isArray(previous?.data)
      ? previous.data.filter((item) =>
          item && typeof item.id === "string" &&
          item.attributes && item.attributes.name === submissionName)
      : [];

    if (matches.length > 1) {
      await markError(c.env.DB, attemptId, ERR.UNKNOWN,
        `multiple Apple submissions matched durable intent '${submissionName}'`,
        "create_submission", false);
      return c.json({ notarization_id: logicalId, attempt_id: attemptId, state: "error", code: ERR.UNKNOWN, note: "ambiguous external reconciliation; operator action required" }, 409);
    }

    const match = matches[0];
    if (!match) {
      return c.json({ notarization_id: logicalId, attempt_id: attemptId, state: "in_progress", code: ERR.UPLOAD_UNCERTAIN, ready_for_staple: false, idempotent: true, note: "external create outcome still uncertain; retry remains blocked" }, 202);
    }

    const now = Date.now();
    await c.env.DB.batch([
      c.env.DB.prepare(
        `UPDATE app_notarization_attempts
         SET apple_submission_id = ?1, raw_apple_status = ?2,
             status_state = 'error', upload_state = 'upload_uncertain',
             error_class = ?3, error_phase = 'create_submission',
             error_detail = 'Apple submission recovered by durable intent; temporary upload credentials are no longer available',
             reconcile_state = 'abandoned', completed_at = ?4
         WHERE id = ?5 AND apple_submission_id IS NULL`,
      ).bind(match.id, match.attributes.status ?? null, ERR.UPLOAD_UNCERTAIN, now, attemptId),
      c.env.DB.prepare(
        `UPDATE app_notarizations
         SET state = 'error', completed_at = ?1, updated_at = ?1
         WHERE id = ?2 AND active_attempt_id = ?3`,
      ).bind(now, logicalId, attemptId),
      terminalOperationStatement(c.env.DB, attemptId, "error", now, ERR.UPLOAD_UNCERTAIN),
    ]);
    return c.json({ notarization_id: logicalId, attempt_id: attemptId, submission_id: match.id, state: "error", code: ERR.UPLOAD_UNCERTAIN, ready_for_staple: false, idempotent: true, note: "external submission recovered; automatic retry blocked pending operator action" }, 409);
  } catch (e) {
    const { code, detail, recoverable } = classifyError(e, "create_submission");
    if (recoverable) {
      return c.json({ notarization_id: logicalId, attempt_id: attemptId, state: "in_progress", code, ready_for_staple: false, idempotent: true, note: "reconciliation lookup transient; retry remains blocked" }, 502);
    }
    await markError(c.env.DB, attemptId, code, detail, "create_submission", false);
    return c.json({ notarization_id: logicalId, attempt_id: attemptId, state: "error", code, ready_for_staple: false }, 502);
  }
}

// ──────────── GET /notarizations/:submissionId ────────────

export async function handleNotarizationStatus(c: AdminContext) {
  const appId = c.req.param("appId") ?? "";
  const submissionIdParam = c.req.param("submissionId") ?? "";
  const encKey = c.env.ASC_CRED_ENC_KEY;
  if (!encKey) return c.json({ error: "missing ASC_CRED_ENC_KEY", code: ERR.NO_ENC_KEY }, 500);

  // App ownership from local ledger FIRST (B3/B5).
  const row = await c.env.DB.prepare(
    `SELECT a.id, a.notarization_id, a.apple_submission_id, a.status_state,
            a.upload_state, a.error_class, a.reconcile_state,
            a.log_fetched, a.log_sha256, a.log_job_id, a.last_polled_at,
            n.computed_sha256, n.state as logical_state, n.ready_for_staple,
            n.apple_log_sha256, n.apple_log_job_id, n.active_attempt_id
     FROM app_notarization_attempts a
     JOIN app_notarizations n ON n.id = a.notarization_id
     WHERE a.app_id = ?1 AND (a.id = ?2 OR a.apple_submission_id = ?2)
     LIMIT 1`,
  ).bind(appId, submissionIdParam).first<AttemptRow>();
  if (!row) return c.json({ error: "notarization not found" }, 404);

  const isActive = row.id === row.active_attempt_id;

  // B5: historical check BEFORE cached closure — old attempt must not get ready=true.
  if (!isActive) {
    return c.json({
      notarization_id: row.notarization_id, attempt_id: row.id,
      submission_id: row.apple_submission_id, state: row.status_state,
      ready_for_staple: false, note: "historical attempt (read-only)",
    });
  }

  // Cached terminal closure (only for active attempt).
  if (row.logical_state === "accepted" && row.ready_for_staple === 1) {
    return c.json({
      notarization_id: row.notarization_id, attempt_id: row.id,
      submission_id: row.apple_submission_id, state: "accepted",
      ready_for_staple: true, log_sha256: row.apple_log_sha256,
      source_sha256: row.computed_sha256,
    });
  }

  if (!row.apple_submission_id) {
    return c.json({ notarization_id: row.notarization_id, state: row.status_state, ready_for_staple: false });
  }

  const creds = await getAscCredentials(c.env.DB, encKey, appId);
  if (!creds) return c.json({ error: "no ASC credentials", code: ERR.NO_ASC_CREDS }, 400);

  try {
    const statusResp = await getNotarySubmissionStatus(creds, row.apple_submission_id);
    const rawStatus = statusResp.data.attributes.status;
    const now = Date.now();

    await c.env.DB.prepare(
      `UPDATE app_notarization_attempts SET last_polled_at = ?1, raw_apple_status = ?2 WHERE id = ?3`,
    ).bind(now, rawStatus ?? null, row.id).run();

    // Fail-closed on unknown (B4).
    if (!rawStatus || !VALID_APPLE_STATUSES.has(rawStatus)) {
      await markError(c.env.DB, row.id, ERR.UNKNOWN, `unknown: ${rawStatus}`, "status_poll", false);
      return c.json({ notarization_id: row.notarization_id, state: "error", code: ERR.UNKNOWN, raw_status: rawStatus, ready_for_staple: false }, 500);
    }

    if (rawStatus === "In Progress") {
      await setAttemptStatus(c.env.DB, row.id, row.notarization_id, "in_progress");
      return c.json({ notarization_id: row.notarization_id, submission_id: row.apple_submission_id, state: "in_progress", ready_for_staple: false });
    }

    if (rawStatus === "Accepted") {
      return await handleAcceptedClosure(c, creds, row, now);
    }

    // Invalid/Rejected — parse 7000 for classification (B4: 5.3/5.4 distinct).
    const terminalState = rawStatus === "Invalid" ? "invalid" : "rejected";
    let errorClass: string | null = null;
    let retainedLog: { key: string; size: number } | null = null;
    if (rawStatus === "Rejected") {
      try {
        const { log, rawText } = await getNotarySubmissionLog(creds, row.apple_submission_id);
        retainedLog = await retainNotaryLog(c.env, row.id, row.apple_submission_id, rawText);
        // B5: structured parse of Apple log issues — not string includes.
        // Error code 7000 = team not configured for notarization.
        const issues = Array.isArray(log.issues) ? log.issues : [];
        const has7000 = issues.some((i: unknown) => {
          if (!i || typeof i !== "object") return false;
          const code = (i as Record<string, unknown>).code;
          return code === 7000 || code === "7000";
        });
        errorClass = has7000 ? ERR.TEAM_NOT_CONFIGURED : null;
      } catch (logErr) {
        const classified = classifyError(logErr, "log_fetch");
        if (classified.recoverable) {
          await c.env.DB.prepare(
            `UPDATE app_notarization_attempts
             SET status_state = 'in_progress', raw_apple_status = 'Rejected',
                 error_class = ?1, error_phase = 'log_fetch', error_detail = ?2,
                 reconcile_state = 'needed', completed_at = NULL
             WHERE id = ?3`,
          ).bind(classified.code, classified.detail, row.id).run();
          return c.json({ notarization_id: row.notarization_id, state: "in_progress", ready_for_staple: false, code: classified.code, note: "rejected log fetch transient, will reconcile" }, 502);
        }
        await markError(c.env.DB, row.id, classified.code, classified.detail, "log_fetch", false);
        return c.json({ notarization_id: row.notarization_id, state: "error", ready_for_staple: false, code: classified.code }, 502);
      }
    }

    // Atomic D1 batch (B7): attempt + logical (CAS: only active attempt).
    await c.env.DB.batch([
      c.env.DB.prepare(
        `UPDATE app_notarization_attempts
         SET status_state = ?1, completed_at = ?2, error_class = ?3,
             error_phase = CASE WHEN ?3 IS NOT NULL THEN 'status_poll' ELSE error_phase END,
             log_r2_key = ?4, log_size_bytes = ?5,
             log_retained_at = CASE WHEN ?4 IS NOT NULL THEN ?2 ELSE NULL END
         WHERE id = ?6`,
      ).bind(terminalState, now, errorClass, retainedLog?.key ?? null, retainedLog?.size ?? null, row.id),
      c.env.DB.prepare(
        `UPDATE app_notarizations SET state = ?1, completed_at = ?2 WHERE id = ?3 AND active_attempt_id = ?4`,
      ).bind(terminalState, now, row.notarization_id, row.id),
      terminalOperationStatement(c.env.DB, row.id, terminalState, now, errorClass),
    ]);

    return c.json({ notarization_id: row.notarization_id, state: terminalState, ready_for_staple: false, code: errorClass });
  } catch (e) {
    const { code, detail, recoverable } = classifyError(e, "status_poll");
    if (recoverable) {
      await c.env.DB.prepare(
        `UPDATE app_notarization_attempts SET error_class = ?1, error_phase = 'status_poll', error_detail = ?2, reconcile_state = 'needed', last_polled_at = ?3 WHERE id = ?4`,
      ).bind(code, detail, Date.now(), row.id).run();
      return c.json({ notarization_id: row.notarization_id, state: row.status_state, ready_for_staple: false, note: "transient, will reconcile" }, 502);
    }
    await markError(c.env.DB, row.id, code, detail, "status_poll", false);
    return c.json({ notarization_id: row.notarization_id, state: "error", code, ready_for_staple: false }, 502);
  }
}

// ──────────── Accepted closure (B7: D1 batch, B5: active-only CAS) ────────────

async function handleAcceptedClosure(c: AdminContext, creds: AscApiCredentials, row: AttemptRow, now: number) {
  let logSha: string | null = null;
  let logJobId: string | null = null;
  let retainedLog: { key: string; size: number } | null = null;
  try {
    const { log, rawText } = await getNotarySubmissionLog(creds, row.apple_submission_id!);
    retainedLog = await retainNotaryLog(c.env, row.id, row.apple_submission_id!, rawText);
    logSha = log.sha256 ?? null;
    logJobId = log.jobId ?? null;
  } catch (logErr) {
    // B5: preserve typed error semantics instead of generic "log pending".
    const { code, detail, recoverable } = classifyError(logErr, "log_fetch");
    if (recoverable) {
      // Apple is Accepted, but normalized state remains in_progress until the
      // developer log completes the binding closure (migration C9.4).
      await c.env.DB.prepare(
        `UPDATE app_notarization_attempts
         SET status_state = 'in_progress', raw_apple_status = 'Accepted',
             error_class = ?1, error_phase = 'log_fetch', error_detail = ?2,
             reconcile_state = 'needed', completed_at = NULL
         WHERE id = ?3`,
      ).bind(code, detail, row.id).run();
      return c.json({ notarization_id: row.notarization_id, state: "in_progress", apple_status: "Accepted", ready_for_staple: false, note: "log fetch transient, will reconcile" }, 502);
    }
    // Non-recoverable (401/403) — typed error.
    await markError(c.env.DB, row.id, code, detail, "log_fetch", false);
    return c.json({ notarization_id: row.notarization_id, state: "error", code, ready_for_staple: false, note: "log fetch auth failure" }, 502);
  }

  // Triple closure: jobId == submission_id AND log sha256 == computed_sha256.
  const jobIdMatch = logJobId === row.apple_submission_id;
  const shaMatch = logSha === row.computed_sha256;

  if (!jobIdMatch || !shaMatch) {
    await markError(c.env.DB, row.id, ERR.SHA_BINDING_MISMATCH,
      `closure failed: jobIdMatch=${jobIdMatch}, shaMatch=${shaMatch}`, "sha_binding", false, logSha, logJobId);
    return c.json({ notarization_id: row.notarization_id, state: "error", code: ERR.SHA_BINDING_MISMATCH, ready_for_staple: false, log_sha256: logSha, source_sha256: row.computed_sha256 }, 500);
  }

  // Atomic batch: attempt closure + logical ready_for_staple + operation completion (B6).
  // B2: clear transient error fields when transitioning to accepted.
  await c.env.DB.batch([
    c.env.DB.prepare(
      `UPDATE app_notarization_attempts
       SET status_state = 'accepted', log_fetched = 1, log_sha256 = ?1, log_job_id = ?2,
           log_r2_key = ?3, log_size_bytes = ?4, log_retained_at = ?5,
           completed_at = ?5, error_class = NULL, error_detail = NULL, error_phase = NULL,
           reconcile_state = 'reconciled'
       WHERE id = ?6`,
    ).bind(logSha, logJobId, retainedLog!.key, retainedLog!.size, now, row.id),
    c.env.DB.prepare(
      `UPDATE app_notarizations
       SET state = 'accepted', ready_for_staple = 1, apple_log_sha256 = ?1, apple_log_job_id = ?2, completed_at = ?3
       WHERE id = ?4 AND active_attempt_id = ?5`,
    ).bind(logSha, logJobId, now, row.notarization_id, row.id),
    // B6: complete operation as faithful projection of attempt state.
    c.env.DB.prepare(
      `UPDATE operation_logs SET status = 'success', progress = 100, completed_at = ?1, updated_at = ?1,
           output = json_set(COALESCE(output, '{}'), '$.ready_for_staple', json('true'), '$.log_sha256', ?2),
           error = NULL
       WHERE id = (SELECT operation_id FROM app_notarization_attempts WHERE id = ?3)`,
    ).bind(now, logSha, row.id),
  ]);

  return c.json({
    notarization_id: row.notarization_id, attempt_id: row.id,
    submission_id: row.apple_submission_id, state: "accepted",
    ready_for_staple: true, log_sha256: logSha, source_sha256: row.computed_sha256,
  });
}

async function retainNotaryLog(
  env: Env,
  attemptId: string,
  submissionId: string,
  rawText: string,
): Promise<{ key: string; size: number }> {
  const bytes = new TextEncoder().encode(rawText);
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_NOTARY_LOG_BYTES) {
    throw new AscApiError(502, `notary developer log size ${bytes.byteLength} exceeds retention limit`);
  }
  const key = `private/notary-logs/${attemptId}/${submissionId}.json`;
  await env.APK_BUCKET.put(key, bytes, {
    httpMetadata: { contentType: "application/json" },
    customMetadata: { attempt_id: attemptId, submission_id: submissionId },
  });
  return { key, size: bytes.byteLength };
}

export async function handleNotarizationLog(c: AdminContext) {
  const appId = c.req.param("appId") ?? "";
  const submissionIdParam = c.req.param("submissionId") ?? "";
  const row = await c.env.DB.prepare(
    `SELECT a.id, a.apple_submission_id, a.log_r2_key, a.log_size_bytes
     FROM app_notarization_attempts a
     WHERE a.app_id = ?1 AND (a.id = ?2 OR a.apple_submission_id = ?2)
     LIMIT 1`,
  ).bind(appId, submissionIdParam).first<{
    id: string; apple_submission_id: string | null; log_r2_key: string | null; log_size_bytes: number | null;
  }>();
  if (!row) return c.json({ error: "notarization not found" }, 404);
  if (!row.log_r2_key) return c.json({ error: "developer log not retained yet" }, 404);

  const object = await c.env.APK_BUCKET.get(row.log_r2_key);
  if (!object || !("body" in object) || !object.body) return c.json({ error: "retained developer log missing" }, 500);
  const rawText = await object.text();
  await insertAuditLog(c.env.DB, c, {
    app_id: appId,
    action: "notarize.log.view",
    payload: { attempt_id: row.id, submission_id: row.apple_submission_id, size_bytes: row.log_size_bytes },
  });
  return new Response(rawText, {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "private, no-store" },
  });
}

// ──────────── DB helpers ────────────

interface AttemptRow {
  id: string; notarization_id: string; apple_submission_id: string | null;
  status_state: string; upload_state: string; error_class: string | null;
  reconcile_state: string; log_fetched: number; log_sha256: string | null;
  log_job_id: string | null; last_polled_at: number | null;
  computed_sha256: string; logical_state: string; ready_for_staple: number;
  apple_log_sha256: string | null; apple_log_job_id: string | null;
  active_attempt_id: string | null;
}

async function setAttemptStatus(db: D1Database, attemptId: string, logicalId: string, state: string): Promise<void> {
  const now = Date.now();
  const isTerminal = ["accepted", "invalid", "rejected", "error"].includes(state);
  // B2: only pass completed_at when terminal (never undefined).
  if (isTerminal) {
    await db.batch([
      db.prepare(`UPDATE app_notarization_attempts SET status_state = ?1, completed_at = ?2 WHERE id = ?3`).bind(state, now, attemptId),
      db.prepare(`UPDATE app_notarizations SET state = ?1, completed_at = ?2 WHERE id = ?3 AND active_attempt_id = ?4`).bind(state, now, logicalId, attemptId),
    ]);
  } else {
    await db.batch([
      db.prepare(`UPDATE app_notarization_attempts SET status_state = ?1 WHERE id = ?2`).bind(state, attemptId),
      db.prepare(`UPDATE app_notarizations SET state = ?1 WHERE id = ?2 AND active_attempt_id = ?3`).bind(state, logicalId, attemptId),
    ]);
  }
}

async function markError(
  db: D1Database, attemptId: string, code: string, detail: string,
  phase: string, recoverable: boolean,
  logSha: string | null = null, logJobId: string | null = null,
): Promise<void> {
  const now = Date.now();
  if (recoverable) {
    // Stay in current status (pending/in_progress) with reconcile (B2: schema-valid).
    await db.prepare(
      `UPDATE app_notarization_attempts SET error_class = ?1, error_detail = ?2, error_phase = ?3, reconcile_state = 'needed' WHERE id = ?4`,
    ).bind(code, detail, phase, attemptId).run();
  } else {
    await db.batch([
      db.prepare(
        `UPDATE app_notarization_attempts
         SET status_state = 'error', error_class = ?1, error_detail = ?2,
             error_phase = ?3, log_sha256 = ?4, log_job_id = ?5,
             reconcile_state = 'abandoned', completed_at = ?6
         WHERE id = ?7`,
      ).bind(code, detail, phase, logSha, logJobId, now, attemptId),
      db.prepare(
        `UPDATE app_notarizations
         SET state = 'error', ready_for_staple = 0, completed_at = ?1, updated_at = ?1
         WHERE active_attempt_id = ?2`,
      ).bind(now, attemptId),
      db.prepare(
        `UPDATE operation_logs
         SET status = 'failed', progress = 100, error = ?1,
             completed_at = ?2, updated_at = ?2
         WHERE id = (SELECT operation_id FROM app_notarization_attempts WHERE id = ?3)`,
      ).bind(JSON.stringify({ code, detail, phase }), now, attemptId),
    ]);
  }
}

function terminalOperationStatement(
  db: D1Database,
  attemptId: string,
  state: string,
  now: number,
  errorClass: string | null = null,
): D1PreparedStatement {
  const failed = state === "error";
  return db.prepare(
    `UPDATE operation_logs
     SET status = ?1, progress = 100, output = ?2, error = ?3,
         completed_at = ?4, updated_at = ?4
     WHERE id = (SELECT operation_id FROM app_notarization_attempts WHERE id = ?5)`,
  ).bind(
    failed ? "failed" : "success",
    JSON.stringify({ state, ready_for_staple: false, code: errorClass }),
    failed ? JSON.stringify({ code: errorClass ?? ERR.UNKNOWN }) : null,
    now,
    attemptId,
  );
}

async function completeTerminalOperation(db: D1Database, attemptId: string, state: string, now: number): Promise<void> {
  await terminalOperationStatement(db, attemptId, state, now).run();
}
