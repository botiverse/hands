import { enqueueDueDeliveries } from "./webhooks";
import { playDeliveryStatement } from "../lib/play_notifications";
import type { Context } from "hono";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";
import { currentActor, currentActorInfo, type AdminEnv } from "../middleware/auth";
import { getGooglePlayBinding, hasGooglePlayConfiguration } from "../lib/google_play_bindings";
import { PlayReleaseNotesError, playCharCount, playReleaseNotesFromChangelog, type PlayReleaseNotesResult } from "../lib/play_release_notes";

type AdminContext = Context<AdminEnv & { Bindings: Env }>;
type PlayTrack = "internal" | "closed" | "production";

export interface PlayPromotionInput {
  track: PlayTrack;
  rollout_percent?: number;
  expected_revision: number;
  approval: { note: string };
  /**
   * Commit with Google's changesNotSentForReview=true: bundle, track release, notes
   * and deobfuscation files are saved on Play but not sent for review. Send them
   * later with the send-for-review action (or Play Console). Default false.
   */
  changes_not_sent_for_review?: boolean;
}

export interface PlaySendForReviewInput {
  track: PlayTrack;
  expected_revision: number;
  approval: { note: string };
}

interface ReleaseArtifactRow {
  release_id: string;
  release_revision: number;
  release_status: string;
  /** The release's changelog (plain text or a JSON language -> text object). */
  release_changelog?: string | null;
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
  code: "gate_failed" | "edit_conflict" | "version_conflict" | "play_api_error" | "hold_active" | "forbidden"
    | "edit_in_review" | "edit_state_unknown";
  gate: "immutable_binding" | "acceptance_receipt" | "channel" | "version_code" | "edit_lock" | "live_hold" | "permission" | "release_notes" | null;
  message: string;
  receipt_id?: string | null;
  /** Specific, stable reason within the gate (e.g. play_release_notes_too_long). */
  failure_code?: string;
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
  const notSent = input.changes_not_sent_for_review;
  if (notSent !== undefined && typeof notSent !== "boolean") {
    throw new Error("changes_not_sent_for_review must be a boolean");
  }
  return {
    track: input.track,
    expected_revision: expectedRevision,
    approval: { note },
    ...(rollout === undefined ? {} : { rollout_percent: rollout }),
    // Only carried when true: a request without it is normalized exactly as before.
    ...(notSent === true ? { changes_not_sent_for_review: true } : {}),
  };
}

export function normalizePlaySendForReviewInput(input: PlaySendForReviewInput): PlaySendForReviewInput {
  if (!input || typeof input !== "object") throw new Error("request body required");
  if (input.track !== "internal" && input.track !== "closed" && input.track !== "production") {
    throw new Error("track must be internal, closed, or production");
  }
  const expectedRevision = positiveRevision(input.expected_revision);
  if (expectedRevision === null) throw new Error("expected_revision must be a non-negative integer");
  const note = typeof input.approval?.note === "string" ? input.approval.note.trim() : "";
  if (!note) throw new Error("approval.note required");
  return { track: input.track, expected_revision: expectedRevision, approval: { note } };
}

/**
 * Receipt `review` block for a promotion: whether this operation's commit asks
 * Google to review (the commit mode, independent of the outcome in `result`).
 *   no flag                      {requested:true,  changes_not_sent_for_review:false}
 *   flag, adapter acknowledged   {requested:false, changes_not_sent_for_review:true}
 *   flag, adapter did not echo   {requested:null,  changes_not_sent_for_review:true, reason:"not_acknowledged"}
 *     (an adapter older than the flag ignores it and commits WITHOUT it -- i.e. it
 *     may have sent the release for review; the receipt does not pretend otherwise).
 */
function promotionReview(input: PlayPromotionInput, acknowledged?: unknown) {
  if (input.changes_not_sent_for_review !== true) return { requested: true, changes_not_sent_for_review: false };
  if (acknowledged === undefined) return { requested: false, changes_not_sent_for_review: true };
  return acknowledged === true
    ? { requested: false, changes_not_sent_for_review: true }
    : { requested: null, changes_not_sent_for_review: true, reason: "not_acknowledged" };
}

/** Google release lifecycle identifiers only (RELEASE_LIFECYCLE_STATE_*); anything else is dropped. */
function lifecycleState(value: unknown): string | null {
  return typeof value === "string" && /^[A-Z][A-Z0-9_]{0,80}$/.test(value) ? value : null;
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

interface ReleaseSymbolsRow {
  asset_id: string;
  bundle_state: string;
  r2_key: string;
  file_hash: string;
  size_bytes: number;
  metadata_json: string;
}

/**
 * Google Play mediaUpload.maxSize for edits.deobfuscationfiles.upload (v3
 * discovery document), for either symbolType. Mirrors the adapter's bound so an
 * oversized mapping fails before the edit lock is taken.
 */
const PLAY_DEOBFUSCATION_MAX_BYTES = 2_097_152_000;

/**
 * Optional sealed R8/ProGuard mapping attached to the release's build (via
 * `hands builds publish-android --mapping` or `hands builds attach-symbols`).
 * It is a different asset kind from the native symbols zip below, which is why
 * the native-only query never found it and receipts said `symbols: null`.
 */
async function getReleaseMapping(db: D1Database, appId: string, releaseId: string): Promise<ReleaseSymbolsRow | null> {
  return db.prepare(
    `SELECT ba.id AS asset_id, 'ready' AS bundle_state,
            ba.r2_key, ba.file_hash, ba.size_bytes, ba.metadata_json
     FROM releases r
     JOIN builds b ON b.id = r.build_id AND b.app_id = r.app_id
     JOIN build_assets ba ON ba.build_id = b.id
     WHERE r.app_id = ?1 AND r.id = ?2
       AND ba.artifact_kind = 'proguard-mapping' AND ba.platform = 'android' AND ba.filetype = 'mapping.txt'
     ORDER BY ba.created_at DESC LIMIT 1`,
  ).bind(appId, releaseId).first<ReleaseSymbolsRow>();
}

function sealed(asset: ReleaseSymbolsRow): boolean {
  const metadata = jsonObject(asset.metadata_json);
  return asset.bundle_state === "ready"
    && metadata.upload_state === "ready"
    && metadata.verified_sha256 === asset.file_hash
    && metadata.verified_size_bytes === asset.size_bytes;
}

interface AdapterDeobfuscationFile {
  symbol_type?: string;
  sha256?: string;
  size_bytes?: number;
  uploaded?: boolean;
  edit?: string;
  attempt?: string;
  stage?: string;
  error_code?: string;
  http_status?: number;
  provider_reason?: string;
  provider_cause?: string;
}

/** Adapter-derived identifiers only; anything else is dropped, never persisted. */
const REJECTION_FIELD_RE = /^[A-Za-z][A-Za-z0-9._,]{0,120}$/;

/**
 * Receipt entry for one declared deobfuscation file, from what the adapter
 * reported -- never assumed. Exactly one of:
 *   uploaded:true                       Google acknowledged the symbolType;
 *   uploaded:false, attempt:"rejected"  Hands tried, Google refused (bundle was
 *                                       already on Play, so the promote went on);
 *   uploaded:false, attempt:"not_acknowledged"  the adapter reported nothing
 *                                       usable (e.g. an older adapter deploy).
 * An absent asset is recorded by the caller as skipped_reason.
 */
function receiptDeobfuscationFile(
  asset: ReleaseSymbolsRow,
  symbolType: "nativeCode" | "proguard",
  reported: AdapterDeobfuscationFile[] | undefined,
) {
  const entry = (reported ?? []).find((item) => item?.symbol_type === symbolType);
  const uploaded = entry?.uploaded === true && entry.sha256 === asset.file_hash && entry.size_bytes === asset.size_bytes;
  const edit = entry?.edit === "promotion" || entry?.edit === "existing_bundle" ? { edit: entry.edit } : {};
  const base = { present: true, sha256: asset.file_hash, size_bytes: asset.size_bytes, ...edit };
  if (uploaded) {
    return { ...base, uploaded: true, provider_ack: `deobfuscationFile.symbolType=${symbolType}`, post_commit_get: false };
  }
  if (entry?.attempt === "rejected") {
    const pick = (value: unknown) => typeof value === "string" && REJECTION_FIELD_RE.test(value) ? value : undefined;
    const httpStatus = Number.isInteger(entry.http_status) && entry.http_status! >= 100 && entry.http_status! <= 599
      ? entry.http_status : undefined;
    const fields = {
      stage: pick(entry.stage),
      error_code: pick(entry.error_code),
      http_status: httpStatus,
      provider_reason: pick(entry.provider_reason),
      provider_cause: pick(entry.provider_cause),
    };
    return {
      ...base,
      uploaded: false,
      attempt: "rejected",
      ...Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)),
      provider_ack: null,
      post_commit_get: false,
    };
  }
  return { ...base, uploaded: false, attempt: "not_acknowledged", provider_ack: null, post_commit_get: false };
}

function receiptReleaseNotes(result: PlayReleaseNotesResult, acknowledged: unknown) {
  if (!result.present) return { present: false, reason: result.reason };
  const acked = Array.isArray(acknowledged) ? acknowledged.filter((item): item is string => typeof item === "string") : [];
  const requested = result.notes.map((note) => note.language);
  // `sent` is what the adapter confirms it put on the track release, never assumed.
  const sent = requested.filter((language) => acked.includes(language));
  return {
    present: true,
    sent,
    // Original changelog keys with no Play language mapping: not sent, not fatal.
    skipped: result.skipped,
    requested,
    ...(sent.length === requested.length ? {} : { reason: "not_acknowledged" }),
    chars: Object.fromEntries(result.notes.map((note) => [note.language, playCharCount(note.text)])),
    format: "plain_text_markdown_bold_stripped",
  };
}

/** Optional sealed native debug symbols zip stored alongside the AAB/APK bundle. */
async function getReleaseSymbols(db: D1Database, appId: string, releaseId: string): Promise<ReleaseSymbolsRow | null> {
  return db.prepare(
    `SELECT ba.id AS asset_id, arb.state AS bundle_state,
            ba.r2_key, ba.file_hash, ba.size_bytes, ba.metadata_json
     FROM releases r
     JOIN builds b ON b.id = r.build_id AND b.app_id = r.app_id
     JOIN android_release_artifact_bundles arb ON arb.build_id = b.id AND arb.app_id = r.app_id
     JOIN build_assets ba ON ba.build_id = b.id
     WHERE r.app_id = ?1 AND r.id = ?2
       AND ba.artifact_kind = 'debug-symbols' AND ba.platform = 'android' AND ba.filetype = 'symbols'
     LIMIT 1`,
  ).bind(appId, releaseId).first<ReleaseSymbolsRow>();
}

async function getReleaseArtifact(db: D1Database, appId: string, releaseId: string): Promise<ReleaseArtifactRow | null> {
  return db.prepare(
    `SELECT r.id AS release_id, r.revision AS release_revision, r.status AS release_status,
            r.changelog AS release_changelog,
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
    /** Extra webhook payload fields; only set for non-default operations, so default promote events are unchanged. */
    notification?: Record<string, unknown> | undefined;
  },
) {
  const now = Date.now();
  const statement = db.prepare(
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
    JSON.stringify(args.payload), args.actor, now,
  );
  if (args.kind !== "play-promotion") { await statement.run(); return; }
  const success = args.verdict === "success";
  const event = success ? "google_play:submission_succeeded" : "google_play:submission_failed";
  const raw = args.payload as { result?: { failure_code?: string }; play?: { rollout_percent?: number } };
  await db.batch([statement, playDeliveryStatement(db, args.appId, event,
    `hands-play-receipt:${args.id}`, {
      receipt_id: args.id, release_id: args.releaseId,
      source: "hands_operation_receipt", platform: "ANDROID",
      version: args.artifact.version_name, version_code: args.artifact.version_code,
      package_name: args.artifact.package_name, track: args.track,
      state: success ? "SUBMISSION_SUCCEEDED" : "SUBMISSION_FAILED",
      state_label: success ? "提交到 Google Play 成功（非审核结论）" : "提交失败或被安全检查阻止",
      reason: raw.result?.failure_code ?? null,
      rollout_percent: raw.play?.rollout_percent ?? null,
      occurred_at: new Date(now).toISOString(),
      ...(args.notification ?? {}),
    }, now, "SELECT 1 FROM release_receipts WHERE id=?6 AND app_id=?5 AND kind='play-promotion'", [args.id])]);
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
    // A store listing push holds its own package-scoped lock row
    // (play_store_listing_locks); one Hands-held Play edit per package at a time.
    const result = await db.prepare(
      `INSERT INTO play_edit_locks
       (app_id, package_name, release_id, operation_id, acquired_by, acquired_at)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6
       WHERE NOT EXISTS (SELECT 1 FROM play_store_listing_locks WHERE app_id = ?1 AND package_name = ?2)`,
    ).bind(appId, row.package_name, row.release_id, operationId, actor, Date.now()).run();
    return (result.meta?.changes ?? 0) === 1;
  } catch {
    return false;
  }
}

async function releaseLock(db: D1Database, operationId: string) {
  await db.prepare("DELETE FROM play_edit_locks WHERE operation_id = ?1").bind(operationId).run();
}

/**
 * Narrow an adapter-supplied cause to the two fields a receipt may carry, each
 * validated as an identifier. Anything else is dropped rather than persisted: a
 * receipt is durable and outward-facing, so an unexpected key must not survive just
 * because some upstream chose to include it.
 */
function receiptCause(value: unknown): { stage: string; provider_cause: string } | null {
  if (!value || typeof value !== "object") return null;
  const source = value as Record<string, unknown>;
  const pick = (field: string): string | null => {
    const raw = source[field];
    return typeof raw === "string" && IDENTIFIER_RE.test(raw) ? raw : null;
  };
  const stage = pick("stage");
  const provider_cause = pick("provider_cause");
  if (!stage && !provider_cause) return null;
  return {
    ...(stage ? { stage } : {}),
    ...(provider_cause ? { provider_cause } : {}),
  } as { stage: string; provider_cause: string };
}

/** Google's identifiers: camelCase or UPPER_SNAKE, bounded length. */
const IDENTIFIER_RE = /^[A-Za-z][A-Za-z0-9._]{0,60}$/;

async function failedPromotionReceipt(
  c: AdminContext,
  artifact: ReleaseArtifactRow,
  actor: string,
  track: PlayTrack,
  approvalNote: string,
  reason: string,
  details: unknown,
  options: {
    action?: "promote" | "send-for-review";
    review?: Record<string, unknown>;
    notification?: Record<string, unknown>;
  } = {},
) {
  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const action = options.action ?? "promote";
  await insertReceipt(c.env.DB, {
    id, appId: c.req.param("appId") ?? "", releaseId: artifact.release_id,
    kind: "play-promotion", verdict: "failed-closed", artifact,
    action, track, notification: options.notification, payload: {
      schema_version: 1,
      kind: "play-promotion",
      receipt_id: id,
      created_at: createdAt,
      artifact: receiptArtifact(artifact),
      source: receiptSource(artifact),
      signing: { upload_key_cert_sha256: artifact.upload_key_cert_sha256 },
      actor,
      action,
      approvals: [{ approver: actor, at: createdAt, scope: `${track}: ${approvalNote}` }],
      ...(options.review ? { review: options.review } : {}),
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
        failure_code: reason,
        failure_reason: `${reason}: ${JSON.stringify(details)}`,
      },
    }, actor,
  });
  c.executionCtx.waitUntil(enqueueDueDeliveries(c.env, Date.now()).catch(() => 0));
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
  const actorType = currentActorInfo(c).type;
  if (actorType !== "human" && actorType !== "agent") {
    return fail(c, 403, { code: "forbidden", gate: "permission", message: "Play promotion requires an authenticated human or agent publisher" });
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
  // Declared native debug symbols must be sealed to their exact bytes too; a
  // declared-but-unsealed zip fails closed instead of being silently skipped.
  const symbolsAsset = await getReleaseSymbols(c.env.DB, appId, releaseId);
  if (symbolsAsset && !sealed(symbolsAsset)) {
    return fail(c, 400, { code: "gate_failed", gate: "immutable_binding", message: "native debug symbols are not sealed to their declared exact bytes" });
  }
  // Same rule for an attached R8/ProGuard mapping: present-but-unsealed fails closed.
  const mappingAsset = await getReleaseMapping(c.env.DB, appId, releaseId);
  if (mappingAsset && !sealed(mappingAsset)) {
    return fail(c, 400, { code: "gate_failed", gate: "immutable_binding", failure_code: "mapping_not_sealed", message: "R8/ProGuard mapping is not sealed to its declared exact bytes" });
  }
  if (mappingAsset && mappingAsset.size_bytes > PLAY_DEOBFUSCATION_MAX_BYTES) {
    return fail(c, 400, { code: "gate_failed", gate: "immutable_binding", failure_code: "mapping_too_large", message: `R8/ProGuard mapping is ${mappingAsset.size_bytes} bytes; Google Play accepts at most ${PLAY_DEOBFUSCATION_MAX_BYTES}` });
  }
  // Changelog -> Play releaseNotes, validated before any Play call or lock.
  let releaseNotes: PlayReleaseNotesResult;
  try {
    releaseNotes = playReleaseNotesFromChangelog(artifact.release_changelog);
  } catch (error) {
    if (!(error instanceof PlayReleaseNotesError)) throw error;
    return fail(c, 400, { code: "gate_failed", gate: "release_notes", failure_code: error.code, message: error.message });
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
  if (!binding || !hasGooglePlayConfiguration(binding) || binding.enabled !== 1 || binding.verification_state !== "verified") {
    return fail(c, 403, { code: "forbidden", gate: "permission", message: "Google Play must be bound, verified, and enabled for this app" });
  }
  if (binding.package_name !== artifact.package_name) {
    return fail(c, 400, { code: "gate_failed", gate: "immutable_binding", message: "AAB package does not match this app's Google Play binding" });
  }

  const actor = currentActor(c);
  const operationId = crypto.randomUUID();
  const notSentForReview = input.changes_not_sent_for_review === true;
  // Failed receipts carry the requested review mode too; the webhook gains
  // action/review_requested only for the non-default mode.
  const promoteReceipt = {
    review: promotionReview(input),
    ...(notSentForReview ? { notification: { action: "promote", review_requested: false } } : {}),
  };
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
    if (artifact.version_code <= maxVersionCode || artifact.version_code > 2_100_000_000) {
      return fail(c, 409, { code: "version_conflict", gate: "version_code", message: `artifact versionCode ${artifact.version_code} must be greater than Play ${input.track} max (${maxVersionCode}) and no greater than 2100000000` });
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
      const receiptId = await failedPromotionReceipt(c, artifact, actor, input.track, input.approval.note, "immutable_binding", { object_read: "failed" }, promoteReceipt);
      return fail(c, 400, { code: "gate_failed", gate: "immutable_binding", message: "stored AAB could not be read", receipt_id: receiptId });
    }
    if (!object || object.size !== artifact.size_bytes) {
      const receiptId = await failedPromotionReceipt(c, artifact, actor, input.track, input.approval.note, "immutable_binding", { object_size: object?.size ?? null }, promoteReceipt);
      return fail(c, 400, { code: "gate_failed", gate: "immutable_binding", message: "stored AAB size changed", receipt_id: receiptId });
    }
    let symbolsObject: R2ObjectBody | null = null;
    if (symbolsAsset) {
      try {
        symbolsObject = await c.env.APK_BUCKET.get(symbolsAsset.r2_key);
      } catch {
        const receiptId = await failedPromotionReceipt(c, artifact, actor, input.track, input.approval.note, "immutable_binding", { symbols_object_read: "failed" }, promoteReceipt);
        return fail(c, 400, { code: "gate_failed", gate: "immutable_binding", message: "stored native debug symbols could not be read", receipt_id: receiptId });
      }
      if (!symbolsObject || symbolsObject.size !== symbolsAsset.size_bytes) {
        const receiptId = await failedPromotionReceipt(c, artifact, actor, input.track, input.approval.note, "immutable_binding", { symbols_object_size: symbolsObject?.size ?? null }, promoteReceipt);
        return fail(c, 400, { code: "gate_failed", gate: "immutable_binding", message: "stored native debug symbols size changed", receipt_id: receiptId });
      }
    }
    let mappingObject: R2ObjectBody | null = null;
    if (mappingAsset) {
      try {
        mappingObject = await c.env.APK_BUCKET.get(mappingAsset.r2_key);
      } catch {
        const receiptId = await failedPromotionReceipt(c, artifact, actor, input.track, input.approval.note, "immutable_binding", { mapping_object_read: "failed" }, promoteReceipt);
        return fail(c, 400, { code: "gate_failed", gate: "immutable_binding", message: "stored R8/ProGuard mapping could not be read", receipt_id: receiptId });
      }
      if (!mappingObject || mappingObject.size !== mappingAsset.size_bytes) {
        const receiptId = await failedPromotionReceipt(c, artifact, actor, input.track, input.approval.note, "immutable_binding", { mapping_object_size: mappingObject?.size ?? null }, promoteReceipt);
        return fail(c, 400, { code: "gate_failed", gate: "immutable_binding", message: "stored R8/ProGuard mapping size changed", receipt_id: receiptId });
      }
    }
    const [hashBranch, uploadBranch] = object.body.tee();
    const [symbolsHashBranch, symbolsUploadBranch] = symbolsObject ? symbolsObject.body.tee() : [null, null];
    const [mappingHashBranch, mappingUploadBranch] = mappingObject ? mappingObject.body.tee() : [null, null];
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
      symbols: symbolsAsset ? { expectedSha256: symbolsAsset.file_hash, expectedSize: symbolsAsset.size_bytes } : null,
      mapping: mappingAsset ? { expectedSha256: mappingAsset.file_hash, expectedSize: mappingAsset.size_bytes } : null,
      releaseNotes: releaseNotes.present && releaseNotes.notes.length > 0 ? releaseNotes.notes : null,
      // Sent only when requested, so the default RPC input is unchanged.
      ...(notSentForReview ? { changesNotSentForReview: true } : {}),
    }, uploadBranch, symbolsUploadBranch, mappingUploadBranch));
    const [localResult, symbolsLocalResult, mappingLocalResult, uploadResult] = await Promise.allSettled([
      hashStream(hashBranch),
      symbolsHashBranch ? hashStream(symbolsHashBranch) : null,
      mappingHashBranch ? hashStream(mappingHashBranch) : null,
      uploadResponsePromise,
    ]);
    if (localResult.status === "rejected") {
      const receiptId = await failedPromotionReceipt(c, artifact, actor, input.track, input.approval.note, "immutable_binding", { stream_read: "failed" }, promoteReceipt);
      return fail(c, 400, { code: "gate_failed", gate: "immutable_binding", message: "stored AAB stream could not be verified", receipt_id: receiptId });
    }
    if (symbolsAsset && symbolsLocalResult.status === "rejected") {
      const receiptId = await failedPromotionReceipt(c, artifact, actor, input.track, input.approval.note, "immutable_binding", { symbols_stream_read: "failed" }, promoteReceipt);
      return fail(c, 400, { code: "gate_failed", gate: "immutable_binding", message: "stored native debug symbols stream could not be verified", receipt_id: receiptId });
    }
    if (mappingAsset && mappingLocalResult.status === "rejected") {
      const receiptId = await failedPromotionReceipt(c, artifact, actor, input.track, input.approval.note, "immutable_binding", { mapping_stream_read: "failed" }, promoteReceipt);
      return fail(c, 400, { code: "gate_failed", gate: "immutable_binding", message: "stored R8/ProGuard mapping stream could not be verified", receipt_id: receiptId });
    }
    if (uploadResult.status === "rejected") {
      const receiptId = await failedPromotionReceipt(c, artifact, actor, input.track, input.approval.note, "play_api_error", { request: "failed" }, promoteReceipt);
      return fail(c, 502, { code: "play_api_error", gate: null, message: "Play edit request failed", receipt_id: receiptId });
    }
    const local = localResult.value;
    const uploadResponse = uploadResult.value;
    if (local.sha256 !== artifact.file_hash || local.size !== artifact.size_bytes) {
      const receiptId = await failedPromotionReceipt(c, artifact, actor, input.track, input.approval.note, "immutable_binding", { actual: local }, promoteReceipt);
      return fail(c, 400, { code: "gate_failed", gate: "immutable_binding", message: "streamed AAB did not match the accepted artifact", receipt_id: receiptId });
    }
    if (symbolsAsset) {
      const symbolsLocal = symbolsLocalResult.status === "fulfilled" ? symbolsLocalResult.value : null;
      if (!symbolsLocal || symbolsLocal.sha256 !== symbolsAsset.file_hash || symbolsLocal.size !== symbolsAsset.size_bytes) {
        const receiptId = await failedPromotionReceipt(c, artifact, actor, input.track, input.approval.note, "immutable_binding", { symbols_actual: symbolsLocal }, promoteReceipt);
        return fail(c, 400, { code: "gate_failed", gate: "immutable_binding", message: "streamed native debug symbols did not match the accepted artifact", receipt_id: receiptId });
      }
    }
    if (mappingAsset) {
      const mappingLocal = mappingLocalResult.status === "fulfilled" ? mappingLocalResult.value : null;
      if (!mappingLocal || mappingLocal.sha256 !== mappingAsset.file_hash || mappingLocal.size !== mappingAsset.size_bytes) {
        const receiptId = await failedPromotionReceipt(c, artifact, actor, input.track, input.approval.note, "immutable_binding", { mapping_actual: mappingLocal }, promoteReceipt);
        return fail(c, 400, { code: "gate_failed", gate: "immutable_binding", message: "streamed R8/ProGuard mapping did not match the accepted artifact", receipt_id: receiptId });
      }
    }
    if (!uploadResponse?.ok) {
      // Carry the adapter's classified cause into the receipt. The log line is not
      // reachable by everyone who can read a receipt, so the cause has to travel
      // with the failure itself: whoever triggers the next one can see why without
      // needing observability scope on someone else's machine.
      //
      // The RECEIPT is the outward-facing surface, so the guard belongs here and not
      // only in the adapter: pick the two known fields and validate each shape, so a
      // future adapter field cannot ride into a receipt just by being returned.
      // No cast: the adapter's AdapterResult now DECLARES `cause`, so a rename or
      // reshape upstream fails to compile here instead of silently stopping the
      // receipt from carrying it.
      const cause = receiptCause(uploadResponse.error.cause);
      const errorCode = uploadResponse?.error?.code ?? "unknown";
      const receiptId = await failedPromotionReceipt(c, artifact, actor, input.track, input.approval.note, "play_api_error", {
        code: errorCode,
        ...(cause ? { cause } : {}),
      }, promoteReceipt);
      // Edit-state codes come only from the changes_not_sent_for_review path (the
      // adapter classifies its commit); a default promote keeps today's mapping.
      if (errorCode === "play_edit_in_review" || errorCode === "play_changes_not_sent_for_review" || errorCode === "play_review_not_managed") {
        return fail(c, 409, { code: "edit_in_review", gate: null, failure_code: errorCode, message: uploadResponse.error.message, receipt_id: receiptId });
      }
      if (errorCode === "play_edit_state_unknown") {
        return fail(c, 502, { code: "edit_state_unknown", gate: null, failure_code: errorCode, message: uploadResponse.error.message, receipt_id: receiptId });
      }
      return fail(c, 502, { code: "play_api_error", gate: null, message: uploadResponse?.error?.message ?? "Play edit failed", receipt_id: receiptId });
    }
    const readback: PlayReadback = uploadResponse.value;
    if (!playReadbackMatches(artifact, input.track, readback)) {
      const receiptId = await failedPromotionReceipt(c, artifact, actor, input.track, input.approval.note, "play_readback_mismatch", { readback }, promoteReceipt);
      return fail(c, 502, { code: "play_api_error", gate: "immutable_binding", message: "Play readback did not match package/version/track/SHA-256", receipt_id: receiptId });
    }
    const reported = uploadResponse.value as {
      deobfuscation_files?: AdapterDeobfuscationFile[];
      release_notes_languages?: unknown;
      changes_not_sent_for_review?: unknown;
    };
    // An adapter older than the flag omits the field: recorded as not acknowledged.
    const review = promotionReview(input, notSentForReview ? reported.changes_not_sent_for_review ?? false : undefined);
    const reportedFiles = Array.isArray(reported.deobfuscation_files) ? reported.deobfuscation_files : undefined;
    const receiptId = crypto.randomUUID();
    await insertReceipt(c.env.DB, {
      id: receiptId, appId, releaseId, kind: "play-promotion", verdict: "success",
      artifact, action: "promote", track: input.track, editId: readback.edit_id,
      ...(notSentForReview ? { notification: { action: "promote", review_requested: review.requested } } : {}),
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
        // Google exposes no post-commit GET for deobfuscation files; the only
        // provider acknowledgement is the upload response, checked by the adapter
        // against the requested symbolType. Recorded from what the adapter
        // reported: uploaded, rejected (with the provider's identifiers), or not
        // acknowledged. The files are attempted even when the bundle was already
        // on Play, so "bundle already on Play" is never a reason recorded here.
        symbols: symbolsAsset
          ? receiptDeobfuscationFile(symbolsAsset, "nativeCode", reportedFiles)
          : { present: false, uploaded: false, skipped_reason: "no_symbols_asset" },
        mapping: mappingAsset
          ? receiptDeobfuscationFile(mappingAsset, "proguard", reportedFiles)
          : { present: false, uploaded: false, skipped_reason: "no_mapping_asset" },
        release_notes: receiptReleaseNotes(releaseNotes, reported.release_notes_languages),
        review,
        play: {
          edit_id: readback.edit_id,
          track: input.track,
          rollout_percent: input.rollout_percent ?? 100,
          // Version dimension only: says nothing about the deobfuscation files above.
          ...(typeof (reported as { bundle_uploaded?: unknown }).bundle_uploaded === "boolean"
            ? { bundle_uploaded: (reported as { bundle_uploaded: boolean }).bundle_uploaded } : {}),
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
    c.executionCtx.waitUntil(enqueueDueDeliveries(c.env, Date.now()).catch(() => 0));
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
    return c.json({
      receipt_id: receiptId, edit_id: readback.edit_id, track: input.track, version_code: artifact.version_code, revision: input.expected_revision + 1,
      // Only with the flag, so the default response is unchanged.
      ...(notSentForReview ? { review } : {}),
    });
  } finally {
    await releaseLock(c.env.DB, operationId);
  }
}

/**
 * Send this release's pending Play changes for review.
 *
 * Step two of the two-step flow: promote with changes_not_sent_for_review saves
 * the release on Play without review (e.g. while another release is in review);
 * this commits an empty edit WITHOUT changesNotSentForReview, always with
 * ERROR_IF_IN_REVIEW -- Hands never cancels a review in progress. Before the
 * commit the adapter checks that Play holds the accepted AAB (sha256) for this
 * versionCode and that the requested track carries it; it records the release
 * lifecycle before/after as evidence (Google does not document whether such a
 * commit submits changes saved earlier without review; the lifecycle shows it).
 *
 * Same gates as promote minus the upload ones: authenticated human/agent
 * publisher (route role + actor type), expected_revision CAS, sealed + accepted
 * AAB, a Hands promotion of this versionCode to this track, no live hold, a
 * verified/enabled binding for the AAB's package, and the package-scoped Play
 * edit lock (play_edit_locks, exclusive with play_store_listing_locks). Every
 * adapter outcome writes an immutable play-promotion receipt with
 * action "send-for-review" (release_receipts.kind is CHECK-constrained; reusing
 * the kind with an action avoids a migration).
 */
export async function handleSendPlayDistributionForReview(c: AdminContext) {
  const appId = c.req.param("appId") ?? "";
  const releaseId = c.req.param("releaseId") ?? "";
  let input: PlaySendForReviewInput;
  try {
    input = normalizePlaySendForReviewInput(await c.req.json<PlaySendForReviewInput>());
  } catch (error) {
    return fail(c, 400, { code: "gate_failed", gate: "permission", message: (error as Error).message });
  }
  const actorType = currentActorInfo(c).type;
  if (actorType !== "human" && actorType !== "agent") {
    return fail(c, 403, { code: "forbidden", gate: "permission", message: "Sending a Play release for review requires an authenticated human or agent publisher" });
  }
  const artifact = await getReleaseArtifact(c.env.DB, appId, releaseId);
  if (!artifact) return fail(c, 400, { code: "gate_failed", gate: "channel", message: "release does not contain an Android AAB" });
  if (artifact.release_revision !== input.expected_revision) {
    return fail(c, 409, { code: "version_conflict", gate: null, message: `release revision is ${artifact.release_revision}, not ${input.expected_revision}` });
  }
  const metadata = jsonObject(artifact.metadata_json);
  if (artifact.bundle_state !== "ready" || metadata.upload_state !== "ready" || metadata.verified_sha256 !== artifact.file_hash || metadata.verified_size_bytes !== artifact.size_bytes) {
    return fail(c, 400, { code: "gate_failed", gate: "immutable_binding", message: "AAB is not sealed to its declared exact bytes" });
  }
  const acceptance = await latestAcceptance(c.env.DB, appId, releaseId, artifact.asset_id);
  if (!acceptanceMatches(artifact, acceptance)) {
    return fail(c, 400, { code: "gate_failed", gate: "acceptance_receipt", message: "latest Hands acceptance receipt does not pass for the exact AAB" });
  }
  // Only what Hands itself put on this track: never send unrelated changes blind.
  const state = await c.env.DB.prepare(
    "SELECT track, version_code FROM play_distribution_state WHERE app_id = ?1 AND release_id = ?2",
  ).bind(appId, releaseId).first<{ track: string; version_code: number }>();
  if (!state || state.track !== input.track || state.version_code !== artifact.version_code) {
    return fail(c, 400, { code: "gate_failed", gate: "channel", failure_code: "not_promoted_to_track", message: `release versionCode ${artifact.version_code} has not been promoted to ${input.track} through Hands` });
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
  if (!binding || !hasGooglePlayConfiguration(binding) || binding.enabled !== 1 || binding.verification_state !== "verified") {
    return fail(c, 403, { code: "forbidden", gate: "permission", message: "Google Play must be bound, verified, and enabled for this app" });
  }
  if (binding.package_name !== artifact.package_name) {
    return fail(c, 400, { code: "gate_failed", gate: "immutable_binding", message: "AAB package does not match this app's Google Play binding" });
  }

  const actor = currentActor(c);
  const operationId = crypto.randomUUID();
  const options = {
    action: "send-for-review" as const,
    review: { requested: true, changes_not_sent_for_review: false, changes_in_review_behavior: "ERROR_IF_IN_REVIEW" },
    notification: { action: "send-for-review", review_requested: true },
  };
  if (!(await takeLock(c.env.DB, appId, artifact, operationId, actor))) {
    return fail(c, 409, { code: "edit_conflict", gate: "edit_lock", message: "another Play edit is active for this package" });
  }
  try {
    const reserved = await c.env.DB.prepare(
      `UPDATE releases SET revision = revision + 1, updated_at = ?1
       WHERE app_id = ?2 AND id = ?3 AND revision = ?4`,
    ).bind(Date.now(), appId, releaseId, input.expected_revision).run();
    if (Number(reserved.meta?.changes ?? 0) !== 1) {
      return fail(c, 409, { code: "version_conflict", gate: null, message: "release changed before the Play edit was reserved" });
    }
    let reply;
    try {
      reply = await c.env.PLAY_RELEASE_SERVICE.sendForReview({
        credential: binding.credential,
        packageName: binding.package_name,
        tracks: binding.tracks,
        handsTrack: input.track,
        versionCode: artifact.version_code,
        expectedSha256: artifact.file_hash,
        operationId,
      });
    } catch {
      const receiptId = await failedPromotionReceipt(c, artifact, actor, input.track, input.approval.note, "play_api_error", { request: "failed" }, options);
      return fail(c, 502, { code: "play_api_error", gate: null, message: "Play send-for-review request failed", receipt_id: receiptId });
    }
    if (!reply?.ok) {
      const code = typeof reply?.error?.code === "string" && IDENTIFIER_RE.test(reply.error.code) ? reply.error.code : "unknown";
      const cause = receiptCause(reply?.error?.cause);
      const receiptId = await failedPromotionReceipt(c, artifact, actor, input.track, input.approval.note, "play_api_error", {
        code,
        ...(cause ? { cause } : {}),
      }, options);
      const message = reply?.error?.message ?? "Play send-for-review failed";
      if (code === "play_edit_in_review" || code === "play_changes_not_sent_for_review" || code === "play_review_not_managed") {
        return fail(c, 409, { code: "edit_in_review", gate: null, failure_code: code, message, receipt_id: receiptId });
      }
      if (code === "play_edit_state_unknown" || code === "play_commit_ambiguous") {
        return fail(c, 502, { code: "edit_state_unknown", gate: null, failure_code: code, message, receipt_id: receiptId });
      }
      if (code === "play_release_not_on_track" || code === "play_bundle_not_on_play" || code === "aab_integrity_mismatch") {
        return fail(c, 409, { code: "gate_failed", gate: "immutable_binding", failure_code: code, message, receipt_id: receiptId });
      }
      return fail(c, 502, { code: "play_api_error", gate: null, failure_code: code, message, receipt_id: receiptId });
    }
    const value = reply.value;
    const readback: PlayReadback = {
      edit_id: value.edit_id, package_name: value.package_name, version_code: value.version_code,
      track: value.track, sha256: value.sha256,
    };
    if (typeof value.edit_id !== "string" || !value.edit_id || !playReadbackMatches(artifact, input.track, readback)) {
      const receiptId = await failedPromotionReceipt(c, artifact, actor, input.track, input.approval.note, "play_readback_mismatch", { readback }, options);
      return fail(c, 502, { code: "play_api_error", gate: "immutable_binding", message: "Play send-for-review answer did not match package/version/track/SHA-256", receipt_id: receiptId });
    }
    const review = {
      ...options.review,
      lifecycle_before: lifecycleState(value.lifecycle_before),
      lifecycle_after: lifecycleState(value.lifecycle_after),
    };
    const trackStatus = value.track_release?.status;
    const receiptId = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    await insertReceipt(c.env.DB, {
      id: receiptId, appId, releaseId, kind: "play-promotion", verdict: "success",
      artifact, action: "send-for-review", track: input.track, editId: value.edit_id,
      notification: options.notification,
      payload: {
        schema_version: 1,
        kind: "play-promotion",
        receipt_id: receiptId,
        created_at: createdAt,
        artifact: receiptArtifact(artifact),
        source: receiptSource(artifact),
        signing: { upload_key_cert_sha256: artifact.upload_key_cert_sha256 },
        actor,
        action: "send-for-review",
        approvals: [{ approver: actor, at: createdAt, scope: `${input.track}: ${input.approval.note}` }],
        review,
        play: {
          edit_id: value.edit_id,
          track: input.track,
          play_version_code: artifact.version_code,
          // The track release found in the edit before the commit (Google's status enum only).
          track_release: {
            status: typeof trackStatus === "string" && IDENTIFIER_RE.test(trackStatus) ? trackStatus : null,
            user_fraction: typeof value.track_release?.user_fraction === "number" ? value.track_release.user_fraction : null,
          },
          api_readback: {
            package: value.package_name,
            version_code: value.version_code,
            track: value.track,
            sha256_match: true,
          },
        },
        result: { status: "success" },
      },
      actor,
    });
    c.executionCtx.waitUntil(enqueueDueDeliveries(c.env, Date.now()).catch(() => 0));
    return c.json({
      receipt_id: receiptId,
      edit_id: value.edit_id,
      track: input.track,
      version_code: artifact.version_code,
      revision: input.expected_revision + 1,
      review,
    });
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
  if ((actor.type !== "human" && actor.type !== "agent") || positiveRevision(body.expected_revision) === null || !body.approval?.note?.trim()) {
    return fail(c, 403, { code: "forbidden", gate: "permission", message: `${action} requires expected_revision and an authenticated human or agent submission note` });
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
