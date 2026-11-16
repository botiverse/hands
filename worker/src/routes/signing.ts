import type { Context } from "hono";
import { currentActor, type AdminEnv } from "../middleware/auth";
import { currentAccount, insertAuditLog } from "../lib/permissions";
import { presignR2DownloadUrl, presignR2UploadUrl } from "../lib/r2_presign";
import { createAscJwt } from "../lib/asc_api";
import { sha256Hex } from "../lib/deploy_tokens";
import {
  ARTIFACT_TYPES,
  KIND_FOR_ARTIFACT,
  SIGNING_KINDS,
  SigningError,
  callSigningContainer,
  decryptSigningSecret,
  encryptSigningSecret,
  type ArtifactType,
  type SigningKind,
  type SigningMetadata,
  type SigningSecret,
} from "../lib/signing";

type AdminContext = Context<AdminEnv & { Bindings: Env }>;

const MAX_ARTIFACT_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_SECRET_FILE_BYTES = 64 * 1024;
const NAME_PATTERN = /^[\p{L}\p{N} ._()-]{1,80}$/u;
const SIGN_TIMEOUT_MS = 25 * 60 * 1000;
/** After the first backup download, a retry is allowed for this long. */
const BACKUP_RETRY_WINDOW_MS = 10 * 60 * 1000;
/** A job still `signing` after this long lost its request; it is failed. */
const STALE_SIGNING_MS = SIGN_TIMEOUT_MS + 5 * 60 * 1000;

type IdentityRow = {
  id: string;
  org_id: string;
  kind: SigningKind;
  name: string;
  origin: "generated" | "uploaded";
  metadata_json: string;
  secret_ciphertext_b64: string;
  secret_iv_b64: string;
  backup_exported_at: number | null;
  created_by_actor: string;
  created_at: number;
  revoked_at: number | null;
};

type JobRow = {
  id: string;
  app_id: string;
  identity_id: string;
  artifact_type: ArtifactType;
  status: "awaiting_upload" | "signing" | "notarizing" | "stapling" | "succeeded" | "failed";
  filename: string;
  input_r2_key: string;
  input_size: number;
  input_sha256: string;
  output_r2_key: string | null;
  output_size: number | null;
  output_sha256: string | null;
  notarize: number;
  notary_submission_id: string | null;
  notary_status: string | null;
  error_code: string | null;
  error_message: string | null;
  actor: string;
  created_at: number;
  updated_at: number;
};

function fail(c: Context<any>, error: unknown) {
  if (error instanceof SigningError) return c.json({ error: error.message, code: error.code }, error.status);
  throw error;
}

function parseMetadata(json: string): SigningMetadata {
  try {
    return JSON.parse(json) as SigningMetadata;
  } catch {
    return {};
  }
}

async function identityResponse(db: D1Database, row: IdentityRow) {
  const { results } = await db.prepare(
    `SELECT g.app_id, a.slug FROM signing_identity_apps g JOIN apps a ON a.id = g.app_id AND a.org_id = ?2
     WHERE g.identity_id = ?1 ORDER BY a.slug`,
  ).bind(row.id, row.org_id).all<{ app_id: string; slug: string }>();
  return {
    id: row.id,
    org_id: row.org_id,
    kind: row.kind,
    name: row.name,
    origin: row.origin,
    metadata: parseMetadata(row.metadata_json),
    backup_exported_at: row.backup_exported_at,
    created_by_actor: row.created_by_actor,
    created_at: row.created_at,
    revoked_at: row.revoked_at,
    apps: results,
  };
}

const IDENTITY_COLUMNS = `id, org_id, kind, name, origin, metadata_json, secret_ciphertext_b64, secret_iv_b64,
  backup_exported_at, created_by_actor, created_at, revoked_at`;

async function loadIdentity(db: D1Database, orgId: string, id: string) {
  return db.prepare(`SELECT ${IDENTITY_COLUMNS} FROM signing_identities WHERE id = ?1 AND org_id = ?2`)
    .bind(id, orgId).first<IdentityRow>();
}

async function orgAuditApp(db: D1Database, orgId: string): Promise<string | null> {
  // audit_logs is keyed by app; org-level signing events are recorded against
  // every app the identity touches, or the org's first app when it has none.
  const row = await db.prepare("SELECT id FROM apps WHERE org_id = ?1 ORDER BY created_at LIMIT 1").bind(orgId).first<{ id: string }>();
  return row?.id ?? null;
}

async function auditIdentity(c: AdminContext, orgId: string, identityId: string, action: string, payload: Record<string, unknown>) {
  const { results } = await c.env.DB.prepare("SELECT app_id FROM signing_identity_apps WHERE identity_id = ?1")
    .bind(identityId).all<{ app_id: string }>();
  const granted = results.length > 0;
  const appIds = granted ? results.map((r) => r.app_id) : [await orgAuditApp(c.env.DB, orgId)].filter((id): id is string => !!id);
  for (const appId of appIds) {
    // Before any grant the event lands in an unrelated app's log: record only
    // that it happened, not which key it was.
    await insertAuditLog(c.env.DB, c, {
      app_id: appId,
      action,
      payload: granted ? { org_id: orgId, identity_id: identityId, ...payload } : { org_id: orgId, identity_id: identityId },
    });
  }
}

function str(value: unknown, max = 4096): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= max ? value : null;
}

function b64(value: unknown): string | null {
  const s = str(value, Math.ceil(MAX_SECRET_FILE_BYTES * 4 / 3) + 8);
  return s && /^[A-Za-z0-9+/]+={0,2}$/.test(s) ? s : null;
}

/** Validate an upload body into a secret bundle; the container then proves it opens. */
function secretFromBody(kind: SigningKind, body: Record<string, unknown>): SigningSecret {
  if (kind === "android_keystore") {
    const keystore = b64(body.keystore_b64);
    const storePassword = str(body.store_password, 256);
    const alias = typeof body.key_alias === "string" && /^[A-Za-z0-9_][A-Za-z0-9._-]{0,63}$/.test(body.key_alias) ? body.key_alias : null;
    if (!keystore || !storePassword || !alias) {
      throw new SigningError(400, "invalid_request", "keystore_b64, store_password and key_alias (letters, digits, . _ -) are required");
    }
    return {
      kind,
      keystore_b64: keystore,
      store_password: storePassword,
      key_alias: alias,
      key_password: str(body.key_password, 256) ?? storePassword,
    };
  }
  const p12 = b64(body.p12_b64);
  const password = typeof body.p12_password === "string" && body.p12_password.length <= 256 ? body.p12_password : null;
  if (!p12 || password === null) throw new SigningError(400, "invalid_request", "p12_b64 and p12_password are required");
  if (kind === "apple_developer_id") {
    let notary = null;
    if (body.notary !== undefined && body.notary !== null) {
      const n = body.notary as Record<string, unknown>;
      const keyId = str(n.key_id, 32);
      const issuerId = str(n.issuer_id, 64);
      const p8 = str(n.p8, 8192);
      if (!keyId || !issuerId || !p8 || !p8.includes("PRIVATE KEY")) {
        throw new SigningError(400, "invalid_request", "notary needs key_id, issuer_id and the .p8 contents");
      }
      notary = { key_id: keyId, issuer_id: issuerId, p8 };
    }
    return { kind, p12_b64: p12, p12_password: password, notary };
  }
  const profiles = Array.isArray(body.provisioning_profiles_b64) ? body.provisioning_profiles_b64.map(b64) : [];
  if (profiles.length === 0 || profiles.some((p) => !p)) {
    throw new SigningError(400, "invalid_request", "provisioning_profiles_b64 must list at least one profile");
  }
  return { kind, p12_b64: p12, p12_password: password, provisioning_profiles_b64: profiles as string[] };
}

async function storeIdentity(
  c: AdminContext,
  orgId: string,
  input: { kind: SigningKind; name: string; origin: "generated" | "uploaded"; secret: SigningSecret; metadata: SigningMetadata },
) {
  const id = crypto.randomUUID();
  const encrypted = await encryptSigningSecret(input.secret, c.env.ASC_CRED_ENC_KEY);
  const now = Date.now();
  await c.env.DB.prepare(
    `INSERT INTO signing_identities (id, org_id, kind, name, origin, metadata_json, secret_ciphertext_b64, secret_iv_b64,
       created_by, created_by_actor, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`,
  ).bind(
    id, orgId, input.kind, input.name, input.origin, JSON.stringify(input.metadata),
    encrypted.secret_ciphertext_b64, encrypted.secret_iv_b64, currentAccount(c)?.id ?? null, currentActor(c), now,
  ).run();
  await auditIdentity(c, orgId, id, "signing_identity.create", { kind: input.kind, origin: input.origin, name: input.name, metadata: input.metadata });
  return (await loadIdentity(c.env.DB, orgId, id))!;
}

// ---------- Identity management (org admin, signed-in session) ----------

export async function handleListSigningIdentities(c: AdminContext) {
  const orgId = c.req.param("orgId") ?? "";
  const { results } = await c.env.DB.prepare(
    `SELECT ${IDENTITY_COLUMNS} FROM signing_identities WHERE org_id = ?1 AND revoked_at IS NULL ORDER BY created_at DESC`,
  ).bind(orgId).all<IdentityRow>();
  return c.json({ signing_identities: await Promise.all(results.map((row) => identityResponse(c.env.DB, row))) });
}

export async function handleUploadSigningIdentity(c: AdminContext) {
  const orgId = c.req.param("orgId") ?? "";
  try {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const kind = body.kind as SigningKind;
    if (!(SIGNING_KINDS as readonly string[]).includes(kind)) {
      throw new SigningError(400, "invalid_request", `kind must be one of ${SIGNING_KINDS.join(", ")}`);
    }
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!NAME_PATTERN.test(name)) throw new SigningError(400, "invalid_request", "name is required (letters, digits, spaces, . _ - ( ))");
    const secret = secretFromBody(kind, body);
    const { metadata } = await callSigningContainer<{ metadata: SigningMetadata }>(c.env, "/signing/inspect", { secret }, 60_000);
    const row = await storeIdentity(c, orgId, { kind, name, origin: "uploaded", secret, metadata });
    return c.json({ signing_identity: await identityResponse(c.env.DB, row) }, 201);
  } catch (error) {
    return fail(c, error);
  }
}

export async function handleGenerateAndroidSigningIdentity(c: AdminContext) {
  const orgId = c.req.param("orgId") ?? "";
  try {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!NAME_PATTERN.test(name)) throw new SigningError(400, "invalid_request", "name is required");
    const generated = await callSigningContainer<{ secret: SigningSecret; metadata: SigningMetadata }>(
      c.env,
      "/signing/generate-android",
      { common_name: body.common_name ?? name, organization: body.organization, alias: body.alias },
      120_000,
    );
    if (generated.secret?.kind !== "android_keystore") throw new SigningError(502, "signing_generate_failed", "container returned no keystore");
    const row = await storeIdentity(c, orgId, { kind: "android_keystore", name, origin: "generated", secret: generated.secret, metadata: generated.metadata });
    return c.json({ signing_identity: await identityResponse(c.env.DB, row) }, 201);
  } catch (error) {
    return fail(c, error);
  }
}

/**
 * One-time backup of a key generated inside Hands: the only copy that ever
 * leaves Hands, for offline safekeeping. A second request is refused.
 */
export async function handleExportSigningIdentityBackup(c: AdminContext) {
  const orgId = c.req.param("orgId") ?? "";
  const id = c.req.param("identityId") ?? "";
  try {
    const row = await loadIdentity(c.env.DB, orgId, id);
    if (!row || row.revoked_at !== null) throw new SigningError(404, "not_found", "signing identity not found");
    if (row.origin !== "generated" || row.kind !== "android_keystore") {
      throw new SigningError(409, "backup_not_available", "only keys generated in Hands have a backup");
    }
    // The first download opens a short window for a retry if that response
    // was lost; after it closes the backup is gone for good.
    const now = Date.now();
    const claim = await c.env.DB.prepare(
      `UPDATE signing_identities SET backup_exported_at = COALESCE(backup_exported_at, ?1)
       WHERE id = ?2 AND (backup_exported_at IS NULL OR backup_exported_at > ?3)`,
    ).bind(now, id, now - BACKUP_RETRY_WINDOW_MS).run();
    if (Number(claim.meta?.changes ?? 0) !== 1) throw new SigningError(409, "backup_already_exported", "the backup was already downloaded");
    const secret = await decryptSigningSecret(row, c.env.ASC_CRED_ENC_KEY);
    await auditIdentity(c, orgId, id, "signing_identity.backup_export", {});
    if (secret.kind !== "android_keystore") throw new SigningError(500, "signing_internal", "unexpected secret");
    return c.json({
      keystore_b64: secret.keystore_b64,
      store_password: secret.store_password,
      key_alias: secret.key_alias,
      key_password: secret.key_password,
      format: "PKCS12",
    });
  } catch (error) {
    return fail(c, error);
  }
}

export async function handleRevokeSigningIdentity(c: AdminContext) {
  const orgId = c.req.param("orgId") ?? "";
  const id = c.req.param("identityId") ?? "";
  const result = await c.env.DB.prepare(
    "UPDATE signing_identities SET revoked_at = ?1 WHERE id = ?2 AND org_id = ?3 AND revoked_at IS NULL",
  ).bind(Date.now(), id, orgId).run();
  if (Number(result.meta?.changes ?? 0) !== 1) return c.json({ error: "signing identity not found" }, 404);
  await auditIdentity(c, orgId, id, "signing_identity.revoke", {});
  return c.json({ revoked: true });
}

export async function handleGrantSigningIdentity(c: AdminContext) {
  const orgId = c.req.param("orgId") ?? "";
  const id = c.req.param("identityId") ?? "";
  const appId = c.req.param("appId") ?? "";
  const row = await loadIdentity(c.env.DB, orgId, id);
  if (!row || row.revoked_at !== null) return c.json({ error: "signing identity not found" }, 404);
  const app = await c.env.DB.prepare("SELECT id FROM apps WHERE id = ?1 AND org_id = ?2").bind(appId, orgId).first();
  if (!app) return c.json({ error: "app not found in this organization", code: "app_not_in_org" }, 404);
  await c.env.DB.prepare(
    `INSERT INTO signing_identity_apps (identity_id, app_id, created_by_actor, created_at) VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT (identity_id, app_id) DO NOTHING`,
  ).bind(id, appId, currentActor(c), Date.now()).run();
  await insertAuditLog(c.env.DB, c, { app_id: appId, action: "signing_identity.grant", payload: { identity_id: id, kind: row.kind, name: row.name } });
  return c.json({ signing_identity: await identityResponse(c.env.DB, row) });
}

export async function handleUngrantSigningIdentity(c: AdminContext) {
  const orgId = c.req.param("orgId") ?? "";
  const id = c.req.param("identityId") ?? "";
  const appId = c.req.param("appId") ?? "";
  const row = await loadIdentity(c.env.DB, orgId, id);
  if (!row) return c.json({ error: "signing identity not found" }, 404);
  const result = await c.env.DB.prepare("DELETE FROM signing_identity_apps WHERE identity_id = ?1 AND app_id = ?2").bind(id, appId).run();
  if (Number(result.meta?.changes ?? 0) !== 1) return c.json({ error: "grant not found" }, 404);
  await insertAuditLog(c.env.DB, c, { app_id: appId, action: "signing_identity.ungrant", payload: { identity_id: id } });
  return c.json({ signing_identity: await identityResponse(c.env.DB, row) });
}

// ---------- Signing jobs (app publisher; CI uses an OIDC-minted deploy token) ----------

const JOB_COLUMNS = `id, app_id, identity_id, artifact_type, status, filename, input_r2_key, input_size, input_sha256,
  output_r2_key, output_size, output_sha256, notarize, notary_submission_id, notary_status, error_code, error_message,
  actor, created_at, updated_at`;

async function loadJob(db: D1Database, appId: string, jobId: string) {
  return db.prepare(`SELECT ${JOB_COLUMNS} FROM signing_jobs WHERE id = ?1 AND app_id = ?2`).bind(jobId, appId).first<JobRow>();
}

async function jobResponse(env: Env, job: JobRow) {
  const download = job.status === "succeeded" && job.output_r2_key
    ? await presignR2DownloadUrl(env, {
      key: job.output_r2_key,
      filetype: "bin",
      contentDisposition: `attachment; filename="${job.filename.replace(/["\\\r\n]/g, "_")}"`,
    }, 3600)
    : null;
  return {
    id: job.id,
    app_id: job.app_id,
    identity_id: job.identity_id,
    artifact_type: job.artifact_type,
    status: job.status,
    filename: job.filename,
    input_size: job.input_size,
    input_sha256: job.input_sha256,
    output_size: job.output_size,
    output_sha256: job.output_sha256,
    notarize: job.notarize === 1,
    notary_submission_id: job.notary_submission_id,
    notary_status: job.notary_status,
    error_code: job.error_code,
    error_message: job.error_message,
    actor: job.actor,
    created_at: job.created_at,
    updated_at: job.updated_at,
    ...(download ? { download_url: download } : {}),
  };
}

async function identityForApp(db: D1Database, appId: string, kind: SigningKind, identityId: string | null) {
  const { results } = await db.prepare(
    `SELECT ${IDENTITY_COLUMNS.split(",").map((col) => `i.${col.trim()}`).join(", ")}
     FROM signing_identities i JOIN signing_identity_apps g ON g.identity_id = i.id
     JOIN apps a ON a.id = g.app_id AND a.org_id = i.org_id
     WHERE g.app_id = ?1 AND i.kind = ?2 AND i.revoked_at IS NULL AND (?3 IS NULL OR i.id = ?3)`,
  ).bind(appId, kind, identityId).all<IdentityRow>();
  if (results.length === 0) {
    throw new SigningError(403, "signing_identity_not_granted", `no ${kind} signing identity is granted to this app`);
  }
  if (results.length > 1) {
    throw new SigningError(409, "signing_identity_ambiguous", "several identities are granted; pass identity_id");
  }
  return results[0]!;
}

export async function handleCreateSigningJob(c: AdminContext) {
  const appId = c.req.param("appId") ?? "";
  try {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const artifactType = body.artifact_type as ArtifactType;
    if (!(ARTIFACT_TYPES as readonly string[]).includes(artifactType)) {
      throw new SigningError(400, "invalid_request", `artifact_type must be one of ${ARTIFACT_TYPES.join(", ")}`);
    }
    if (artifactType === "ipa") throw new SigningError(400, "signing_unsupported", "iOS signing is not available yet");
    const filename = typeof body.filename === "string" ? body.filename.trim() : "";
    if (!/^[A-Za-z0-9 ._()+-]{1,200}$/.test(filename)) throw new SigningError(400, "invalid_request", "filename is required");
    const size = body.size;
    if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 1 || size > MAX_ARTIFACT_BYTES) {
      throw new SigningError(400, "invalid_request", "size must be 1 byte to 2 GiB");
    }
    const sha256 = typeof body.sha256 === "string" ? body.sha256.toLowerCase() : "";
    if (!/^[0-9a-f]{64}$/.test(sha256)) throw new SigningError(400, "invalid_request", "sha256 must be a hex SHA-256");
    const notarize = body.notarize === true;
    if (notarize && artifactType !== "macos") throw new SigningError(400, "invalid_request", "only macOS artifacts are notarized");
    const identityId = typeof body.identity_id === "string" ? body.identity_id : null;
    const identity = await identityForApp(c.env.DB, appId, KIND_FOR_ARTIFACT[artifactType], identityId);
    if (notarize && !parseMetadata(identity.metadata_json).notary_key_id) {
      throw new SigningError(400, "signing_notary_not_configured", "this identity has no notary API key");
    }
    const id = crypto.randomUUID();
    const inputKey = `signing/${appId}/${id}/input`;
    const uploadUrl = await presignR2UploadUrl(c.env, inputKey, "application/octet-stream", 3600);
    if (!uploadUrl) throw new SigningError(503, "signing_storage_unavailable", "direct upload is not configured");
    const now = Date.now();
    await c.env.DB.prepare(
      `INSERT INTO signing_jobs (id, app_id, identity_id, artifact_type, status, filename, input_r2_key, input_size, input_sha256,
         notarize, actor, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, 'awaiting_upload', ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?11)`,
    ).bind(id, appId, identity.id, artifactType, filename, inputKey, size, sha256, notarize ? 1 : 0, currentActor(c), now).run();
    await insertAuditLog(c.env.DB, c, {
      app_id: appId,
      action: "signing_job.create",
      payload: { job_id: id, identity_id: identity.id, artifact_type: artifactType, filename, size, sha256, notarize },
    });
    const job = (await loadJob(c.env.DB, appId, id))!;
    return c.json({ job: await jobResponse(c.env, job), upload_url: uploadUrl, upload_headers: { "content-type": "application/octet-stream" } }, 201);
  } catch (error) {
    return fail(c, error);
  }
}

/** Fail a job only from the state the caller observed, so a late error never overwrites a success. */
async function failJob(c: AdminContext, job: JobRow, error: unknown, from: JobRow["status"]) {
  const code = error instanceof SigningError ? error.code : "signing_internal";
  const message = error instanceof SigningError ? error.message : "signing failed unexpectedly";
  const result = await c.env.DB.prepare(
    `UPDATE signing_jobs SET status = 'failed', error_code = ?1, error_message = ?2, updated_at = ?3 WHERE id = ?4 AND status = ?5`,
  ).bind(code, message.slice(0, 1000), Date.now(), job.id, from).run();
  if (Number(result.meta?.changes ?? 0) !== 1) return;
  await insertAuditLog(c.env.DB, c, { app_id: job.app_id, action: "signing_job.fail", payload: { job_id: job.id, error_code: code } });
}

export async function handleRunSigningJob(c: AdminContext) {
  const appId = c.req.param("appId") ?? "";
  const jobId = c.req.param("jobId") ?? "";
  const job = await loadJob(c.env.DB, appId, jobId);
  if (!job) return c.json({ error: "signing job not found" }, 404);
  if (job.status !== "awaiting_upload") return c.json({ job: await jobResponse(c.env, job) });
  const claim = await c.env.DB.prepare(
    "UPDATE signing_jobs SET status = 'signing', updated_at = ?1 WHERE id = ?2 AND status = 'awaiting_upload'",
  ).bind(Date.now(), jobId).run();
  if (Number(claim.meta?.changes ?? 0) !== 1) return c.json({ job: await jobResponse(c.env, (await loadJob(c.env.DB, appId, jobId))!) });
  const body = (await c.req.json().catch(() => ({}))) as { entitlements_b64?: unknown };
  try {
    const head = await c.env.APK_BUCKET.head(job.input_r2_key);
    if (!head) throw new SigningError(409, "signing_input_missing", "upload the file before signing");
    if (head.size !== job.input_size) throw new SigningError(409, "signing_input_mismatch", "uploaded size differs from the declared size");
    const identity = await c.env.DB.prepare(`SELECT ${IDENTITY_COLUMNS} FROM signing_identities WHERE id = ?1`)
      .bind(job.identity_id).first<IdentityRow>();
    if (!identity || identity.revoked_at !== null) throw new SigningError(403, "signing_identity_revoked", "the signing identity was revoked");
    const granted = await c.env.DB.prepare(
      `SELECT 1 FROM signing_identity_apps g JOIN apps a ON a.id = g.app_id AND a.org_id = ?3
       WHERE g.identity_id = ?1 AND g.app_id = ?2`,
    ).bind(identity.id, appId, identity.org_id).first();
    if (!granted) throw new SigningError(403, "signing_identity_not_granted", "the signing identity is no longer granted to this app");
    const secret = await decryptSigningSecret(identity, c.env.ASC_CRED_ENC_KEY);
    const outputKey = `signing/${appId}/${jobId}/output`;
    const inputUrl = await presignR2DownloadUrl(c.env, { key: job.input_r2_key, filetype: "bin", contentDisposition: "attachment" }, 3600);
    const outputUrl = await presignR2UploadUrl(c.env, outputKey, "application/octet-stream", 3600);
    if (!inputUrl || !outputUrl) throw new SigningError(503, "signing_storage_unavailable", "direct storage is not configured");
    const entitlements = typeof body.entitlements_b64 === "string" && body.entitlements_b64.length < 64 * 1024 ? body.entitlements_b64 : undefined;
    const result = await callSigningContainer<{ output_size: number; output_sha256: string; input_sha256?: string; notary_submission_id: string | null }>(
      c.env,
      "/signing/sign",
      {
        artifact_type: job.artifact_type,
        secret,
        input_url: inputUrl,
        output_url: outputUrl,
        expected_input_sha256: job.input_sha256,
        notarize: job.notarize === 1,
        ...(entitlements ? { entitlements_b64: entitlements } : {}),
      },
      SIGN_TIMEOUT_MS,
    );
    const notarizing = job.notarize === 1 && !!result.notary_submission_id;
    if (job.notarize === 1 && !result.notary_submission_id) {
      throw new SigningError(502, "signing_notary_submit_failed", "Apple returned no submission id");
    }
    const done = await c.env.DB.prepare(
      `UPDATE signing_jobs SET status = ?1, output_r2_key = ?2, output_size = ?3, output_sha256 = ?4,
         notary_submission_id = ?5, notary_status = ?6, updated_at = ?7
       WHERE id = ?8 AND status = 'signing'`,
    ).bind(
      notarizing ? "notarizing" : "succeeded", outputKey, result.output_size, result.output_sha256,
      result.notary_submission_id, notarizing ? "In Progress" : null, Date.now(), jobId,
    ).run();
    if (Number(done.meta?.changes ?? 0) === 1) {
      // The input is no longer needed; the output stays for download.
      await c.env.APK_BUCKET.delete(job.input_r2_key).catch(() => undefined);
      await insertAuditLog(c.env.DB, c, {
        app_id: appId,
        action: "signing_job.sign",
        payload: {
          job_id: jobId, identity_id: identity.id, artifact_type: job.artifact_type, input_sha256: job.input_sha256,
          output_sha256: result.output_sha256, notary_submission_id: result.notary_submission_id,
          fingerprint: parseMetadata(identity.metadata_json).sha256_fingerprint ?? null,
          entitlements_sha256: entitlements ? await sha256Hex(entitlements) : null,
        },
      }).catch(() => undefined);
    }
  } catch (error) {
    await failJob(c, job, error, "signing");
  }
  return c.json({ job: await jobResponse(c.env, (await loadJob(c.env.DB, appId, jobId))!) });
}

/** Apple Notary API status for a submission (Accepted | In Progress | Invalid | Rejected). */
async function notaryStatus(secret: SigningSecret, submissionId: string) {
  if (secret.kind !== "apple_developer_id" || !secret.notary) throw new SigningError(500, "signing_internal", "no notary key");
  const jwt = await createAscJwt(secret.notary);
  try {
    const response = await fetch(`https://appstoreconnect.apple.com/notary/v2/submissions/${encodeURIComponent(submissionId)}`, {
      headers: { authorization: `Bearer ${jwt}` },
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await response.json() as { data?: { attributes?: { status?: string } } };
    return body.data?.attributes?.status ?? "unknown";
  } catch (error) {
    throw new SigningError(502, "signing_notary_status_unavailable", `Apple notary status unavailable: ${error instanceof Error ? error.message.slice(0, 100) : "error"}`);
  }
}

export async function handleGetSigningJob(c: AdminContext) {
  const appId = c.req.param("appId") ?? "";
  const jobId = c.req.param("jobId") ?? "";
  let job = await loadJob(c.env.DB, appId, jobId);
  if (!job) return c.json({ error: "signing job not found" }, 404);
  if (job.status === "signing" && job.updated_at < Date.now() - STALE_SIGNING_MS) {
    // The request that was signing it is gone (client or Worker cancelled).
    await failJob(c, job, new SigningError(502, "signing_interrupted", "signing was interrupted; start a new job"), "signing");
    job = (await loadJob(c.env.DB, appId, jobId))!;
  }
  if (job.status === "stapling" && job.updated_at < Date.now() - 15 * 60 * 1000) {
    // A stapling request that died mid-way: let the next poll staple again.
    await c.env.DB.prepare("UPDATE signing_jobs SET status = 'notarizing', updated_at = ?1 WHERE id = ?2 AND status = 'stapling' AND updated_at = ?3")
      .bind(Date.now(), jobId, job.updated_at).run();
    job = (await loadJob(c.env.DB, appId, jobId))!;
  }
  if (job.status === "notarizing" && job.notary_submission_id) {
    const current = job;
    let phase: "notarizing" | "stapling" = "notarizing";
    try {
      const identity = await c.env.DB.prepare(`SELECT ${IDENTITY_COLUMNS} FROM signing_identities WHERE id = ?1`)
        .bind(current.identity_id).first<IdentityRow>();
      if (!identity) throw new SigningError(403, "signing_identity_revoked", "the signing identity is gone");
      // A job already submitted to Apple finishes even if the identity was
      // revoked since: the key is only used to read its status and staple.
      const secret = await decryptSigningSecret(identity, c.env.ASC_CRED_ENC_KEY);
      const status = await notaryStatus(secret, current.notary_submission_id!);
      if (status === "Accepted") {
        const claim = await c.env.DB.prepare(
          "UPDATE signing_jobs SET status = 'stapling', notary_status = ?1, updated_at = ?2 WHERE id = ?3 AND status = 'notarizing'",
        ).bind(status, Date.now(), jobId).run();
        if (Number(claim.meta?.changes ?? 0) === 1) {
          phase = "stapling";
          const key = current.output_r2_key!;
          const inputUrl = await presignR2DownloadUrl(c.env, { key, filetype: "bin", contentDisposition: "attachment" }, 3600);
          const stapledKey = `${key}-stapled`;
          const outputUrl = await presignR2UploadUrl(c.env, stapledKey, "application/octet-stream", 3600);
          if (!inputUrl || !outputUrl) throw new SigningError(503, "signing_storage_unavailable", "direct storage is not configured");
          const stapled = await callSigningContainer<{ output_size: number; output_sha256: string }>(
            c.env, "/signing/staple", { input_url: inputUrl, output_url: outputUrl }, 10 * 60 * 1000,
          );
          const done = await c.env.DB.prepare(
            `UPDATE signing_jobs SET status = 'succeeded', output_r2_key = ?1, output_size = ?2, output_sha256 = ?3, updated_at = ?4
             WHERE id = ?5 AND status = 'stapling'`,
          ).bind(stapledKey, stapled.output_size, stapled.output_sha256, Date.now(), jobId).run();
          if (Number(done.meta?.changes ?? 0) === 1) {
            await c.env.APK_BUCKET.delete(key).catch(() => undefined);
            await insertAuditLog(c.env.DB, c, {
              app_id: appId, action: "signing_job.notarized",
              payload: { job_id: jobId, notary_submission_id: current.notary_submission_id, output_sha256: stapled.output_sha256 },
            }).catch(() => undefined);
          }
        }
      } else if (status === "Invalid" || status === "Rejected") {
        throw new SigningError(400, "signing_notary_rejected", `Apple notarization ${status.toLowerCase()}; see the notary log for submission ${current.notary_submission_id}`);
      } else if (status !== current.notary_status) {
        await c.env.DB.prepare("UPDATE signing_jobs SET notary_status = ?1, updated_at = ?2 WHERE id = ?3 AND status = 'notarizing'")
          .bind(status, Date.now(), jobId).run();
      }
    } catch (error) {
      const transient = error instanceof SigningError
        && (error.code === "signing_notary_status_unavailable" || error.status === 502 || error.status === 503)
        && error.code !== "signing_notary_rejected";
      if (transient) {
        // Try again on the next poll; a stapling attempt goes back to notarizing.
        if (phase === "stapling") {
          await c.env.DB.prepare("UPDATE signing_jobs SET status = 'notarizing', updated_at = ?1 WHERE id = ?2 AND status = 'stapling'")
            .bind(Date.now(), jobId).run();
        }
      } else {
        await failJob(c, current, error, phase);
      }
    }
    job = (await loadJob(c.env.DB, appId, jobId))!;
  }
  return c.json({ job: await jobResponse(c.env, job) });
}
