/**
 * Hands-managed HarmonyOS signing, part 1: the AGC app, certificates, debug
 * devices and profiles, through AppGallery Connect's Connect API
 * (lib/agc_provisioning.ts) with an app's stored AGC credential.
 *
 *   POST /api/orgs/:orgId/harmony-signing/identities      {name, kind: debug|release, agc_from_app}  org admin
 *   GET  /api/orgs/:orgId/harmony-signing/identities                                                  org admin
 *   POST /api/apps/:appId/harmony-signing/agc-app          {app_name?}          app admin  (find or create)
 *   GET  /api/apps/:appId/harmony-signing/devices                               app admin
 *   POST /api/apps/:appId/harmony-signing/devices          {devices:[{name, udid, type}]}  app admin
 *   GET  /api/apps/:appId/harmony-signing/profiles                              app admin
 *   POST /api/apps/:appId/harmony-signing/profiles         {identity_id, device_ids?}       app admin
 *
 * The key is ECDSA P-256, made in the signing container and stored encrypted;
 * it never leaves Hands. The app's package name is its main channel's bundle id.
 */
import type { Context } from "hono";
import { currentActor, type AdminEnv } from "../middleware/auth";
import { insertAuditLog } from "../lib/permissions";
import { AgcApiError, resolveAgcAppId } from "../lib/agc_api";
import {
  addHarmonyDevices, createHarmonyApp, deleteHarmonyCertificates, downloadAgcFile, listHarmonyCertificates, HARMONY_DEVICE_TYPES, issueHarmonyCertificate, issueHarmonyProfile,
  listHarmonyDevices, type HarmonyCertKind,
} from "../lib/agc_provisioning";
import { callSigningContainer, decryptSigningSecret, encryptSigningSecret, SigningError, type HarmonySigningSecret } from "../lib/signing";
import { presignR2DownloadUrl, presignR2UploadUrl } from "../lib/r2_presign";
import { resolveAgcAppAuth } from "./agc_testing";

type AdminContext = Context<AdminEnv & { Bindings: Env }>;

const NAME_PATTERN = /^[\p{L}\p{N} ,._()&-]{1,64}$/u;

type IdentityRow = {
  id: string; org_id: string; name: string; cert_kind: HarmonyCertKind; agc_cert_id: string; credential_app_id: string | null;
  metadata_json: string; secret_ciphertext_b64: string; secret_iv_b64: string; created_by_actor: string; created_at: number;
  revoked_at: number | null;
};
type ProfileRow = {
  id: string; app_id: string; identity_id: string; kind: HarmonyCertKind; agc_app_id: string; agc_profile_id: string;
  profile_b64: string; device_ids_json: string; expires_at: number | null; created_by_actor: string; created_at: number;
  replaced_at: number | null;
};

function fail(c: AdminContext, error: unknown) {
  if (error instanceof SigningError) return c.json({ error: error.message, code: error.code }, error.status);
  if (error instanceof AgcApiError) {
    // AGC's own words (agcJson builds them from Huawei's message and code).
    const status = error.status === 401 || error.status === 403 ? 409 : error.status >= 400 && error.status < 500 ? 400 : 502;
    return c.json({ error: `AppGallery Connect: ${error.message}`, code: "agc_request_failed" }, status);
  }
  if (error instanceof Error && /AGC credentials|AGC_CRED_ENC_KEY/.test(error.message)) {
    return c.json({ error: error.message, code: "agc_not_configured" }, 409);
  }
  throw error;
}

function identityView(row: IdentityRow) {
  let metadata: Record<string, unknown> = {};
  try { metadata = JSON.parse(row.metadata_json) as Record<string, unknown>; } catch { metadata = {}; }
  return {
    id: row.id, name: row.name, kind: row.cert_kind, agc_cert_id: row.agc_cert_id, credential_app_id: row.credential_app_id,
    metadata, created_by_actor: row.created_by_actor, created_at: row.created_at, revoked_at: row.revoked_at,
  };
}

function profileView(row: ProfileRow) {
  let devices: string[] = [];
  try { devices = JSON.parse(row.device_ids_json) as string[]; } catch { devices = []; }
  return {
    id: row.id, identity_id: row.identity_id, kind: row.kind, agc_app_id: row.agc_app_id, agc_profile_id: row.agc_profile_id,
    device_ids: devices, expires_at: row.expires_at, created_at: row.created_at, replaced_at: row.replaced_at,
  };
}

async function body(c: AdminContext): Promise<Record<string, unknown>> {
  const value = await c.req.json().catch(() => ({}));
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** The app's HarmonyOS package name: its main channel's bundle id. */
async function packageName(db: D1Database, appId: string) {
  const row = await db.prepare(
    `SELECT a.slug, a.name, a.platform, a.org_id, c.bundle_id FROM apps a
     LEFT JOIN channels c ON c.app_id = a.id AND c.slug = 'main' WHERE a.id = ?1`,
  ).bind(appId).first<{ slug: string; name: string; platform: string; org_id: string | null; bundle_id: string | null }>();
  if (!row) throw new SigningError(404, "not_found", "app not found");
  if (row.platform !== "ohos") throw new SigningError(400, "invalid_request", "HarmonyOS signing is for ohos apps");
  if (!row.bundle_id) throw new SigningError(400, "invalid_request", "set the main channel's bundle id to the HarmonyOS package name first");
  return row;
}

export async function handleCreateHarmonyIdentity(c: AdminContext) {
  const orgId = c.req.param("orgId") ?? "";
  try {
    const input = await body(c);
    const name = typeof input.name === "string" ? input.name.trim() : "";
    if (!NAME_PATTERN.test(name)) throw new SigningError(400, "invalid_request", "name is required (letters, digits, spaces, , . _ - & ( ), at most 64)");
    const kind = input.kind === "debug" || input.kind === "release" ? input.kind : null;
    if (!kind) throw new SigningError(400, "invalid_request", "kind must be debug or release");
    const fromSlug = typeof input.agc_from_app === "string" ? input.agc_from_app : "";
    const source = await c.env.DB.prepare("SELECT id FROM apps WHERE (slug = ?1 OR id = ?1) AND org_id = ?2 AND archived = 0")
      .bind(fromSlug, orgId).first<{ id: string }>();
    if (!source) throw new SigningError(400, "invalid_request", "agc_from_app must name an app of this organization with AGC credentials");
    const auth = await resolveAgcAppAuth(c.env, source.id);
    const made = await callSigningContainer<{ key_pem?: string; csr_pem?: string }>(c.env, "/signing/harmony-csr", { common_name: name }, 60_000);
    if (!made.key_pem || !made.csr_pem) throw new SigningError(502, "signing_generate_failed", "container returned no key");
    const cert = await issueHarmonyCertificate(auth, { csrPem: made.csr_pem, name, kind });
    let checked: { chain_pem?: string; metadata?: Record<string, unknown> };
    try {
      const certBytes = await downloadAgcFile(cert.download_url);
      let b64 = "";
      for (const byte of certBytes) b64 += String.fromCharCode(byte);
      checked = await callSigningContainer<{ chain_pem?: string; metadata?: Record<string, unknown> }>(
        c.env, "/signing/harmony-certificate", { key_pem: made.key_pem, certificate_b64: btoa(b64) }, 60_000,
      );
      if (!checked.chain_pem) throw new SigningError(502, "signing_generate_failed", "container could not read the certificate");
    } catch (error) {
      // Without its key the certificate is useless and takes one of the
      // account's few certificate slots: give it back.
      await deleteHarmonyCertificates(auth, [cert.id]).catch(() => undefined);
      throw error;
    }
    const secret: HarmonySigningSecret = { kind: "harmony", key_pem: made.key_pem, chain_pem: checked.chain_pem };
    const encrypted = await encryptSigningSecret(secret, c.env.ASC_CRED_ENC_KEY);
    const id = crypto.randomUUID();
    const now = Date.now();
    const metadata = { ...(checked.metadata ?? {}), agc_cert_expires_at: cert.expires_at };
    await c.env.DB.prepare(
      `INSERT INTO harmony_signing_identities (id, org_id, name, cert_kind, agc_cert_id, credential_app_id, metadata_json,
         secret_ciphertext_b64, secret_iv_b64, created_by_actor, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`,
    ).bind(id, orgId, name, kind, cert.id, source.id, JSON.stringify(metadata), encrypted.secret_ciphertext_b64, encrypted.secret_iv_b64,
      currentActor(c), now).run();
    await insertAuditLog(c.env.DB, c, { app_id: source.id, action: "harmony_signing.identity_created", payload: { identity_id: id, kind, agc_cert_id: cert.id } })
      .catch(() => undefined);
    const row = await c.env.DB.prepare("SELECT * FROM harmony_signing_identities WHERE id = ?1").bind(id).first<IdentityRow>();
    return c.json({ identity: identityView(row!) }, 201);
  } catch (error) {
    return fail(c, error);
  }
}

async function credentialApp(c: AdminContext, orgId: string, ref: unknown) {
  const slug = typeof ref === "string" ? ref : "";
  const source = await c.env.DB.prepare("SELECT id FROM apps WHERE (slug = ?1 OR id = ?1) AND org_id = ?2 AND archived = 0")
    .bind(slug, orgId).first<{ id: string }>();
  if (!source) throw new SigningError(400, "invalid_request", "agc_from_app must name an app of this organization with AGC credentials");
  return source.id;
}

/** AGC's certificates of a kind for the account behind an app's credential, marked when a Hands identity holds the key. */
export async function handleListHarmonyAgcCertificates(c: AdminContext) {
  const orgId = c.req.param("orgId") ?? "";
  try {
    const input = await body(c);
    const kind = input.kind === "debug" || input.kind === "release" ? input.kind : null;
    if (!kind) throw new SigningError(400, "invalid_request", "kind must be debug or release");
    const certs = await listHarmonyCertificates(await resolveAgcAppAuth(c.env, await credentialApp(c, orgId, input.agc_from_app)), kind);
    const { results } = await c.env.DB.prepare("SELECT agc_cert_id, id FROM harmony_signing_identities WHERE revoked_at IS NULL").all<{ agc_cert_id: string; id: string }>();
    const held = new Map(results.map((r) => [r.agc_cert_id, r.id]));
    return c.json({ certificates: certs.map((cert) => ({ ...cert, identity_id: held.get(cert.id) ?? null })) });
  } catch (error) {
    return fail(c, error);
  }
}

/** Deletes AGC certificates no Hands identity holds (e.g. one left by an interrupted setup). */
export async function handleDeleteHarmonyAgcCertificates(c: AdminContext) {
  const orgId = c.req.param("orgId") ?? "";
  try {
    const input = await body(c);
    const ids = Array.isArray(input.cert_ids) ? input.cert_ids.filter((v): v is string => typeof v === "string" && /^[0-9]{1,32}$/.test(v)) : [];
    if (ids.length === 0 || ids.length > 20) throw new SigningError(400, "invalid_request", "cert_ids must list 1-20 AGC certificate ids");
    for (const id of ids) {
      const held = await c.env.DB.prepare("SELECT 1 FROM harmony_signing_identities WHERE agc_cert_id = ?1 AND revoked_at IS NULL").bind(id).first();
      if (held) throw new SigningError(409, "harmony_certificate_in_use", `certificate ${id} belongs to a Hands signing identity`);
    }
    const appId = await credentialApp(c, orgId, input.agc_from_app);
    await deleteHarmonyCertificates(await resolveAgcAppAuth(c.env, appId), ids);
    await insertAuditLog(c.env.DB, c, { app_id: appId, action: "harmony_signing.agc_certificates_deleted", payload: { cert_ids: ids } }).catch(() => undefined);
    return c.json({ deleted: ids });
  } catch (error) {
    return fail(c, error);
  }
}

export async function handleListHarmonyIdentities(c: AdminContext) {
  const orgId = c.req.param("orgId") ?? "";
  const { results } = await c.env.DB.prepare(
    "SELECT * FROM harmony_signing_identities WHERE org_id = ?1 ORDER BY created_at DESC",
  ).bind(orgId).all<IdentityRow>();
  return c.json({ identities: results.map(identityView) });
}

/** Finds the AGC app for the app's package name, or creates it. */
export async function handleEnsureHarmonyAgcApp(c: AdminContext) {
  const appId = c.req.param("appId") ?? "";
  try {
    const input = await body(c);
    const app = await packageName(c.env.DB, appId);
    const auth = await resolveAgcAppAuth(c.env, appId);
    const existing = await resolveAgcAppId(auth, app.bundle_id!).catch((error: unknown) => {
      if (error instanceof AgcApiError && error.status === 404) return null;
      throw error;
    });
    if (existing) return c.json({ agc_app_id: existing, package_name: app.bundle_id, created: false });
    const appName = typeof input.app_name === "string" && input.app_name.trim() ? input.app_name.trim().slice(0, 64) : app.name;
    const created = await createHarmonyApp(auth, { appName, packageName: app.bundle_id! });
    await insertAuditLog(c.env.DB, c, { app_id: appId, action: "harmony_signing.agc_app_created", payload: { agc_app_id: created, package_name: app.bundle_id } })
      .catch(() => undefined);
    return c.json({ agc_app_id: created, package_name: app.bundle_id, created: true }, 201);
  } catch (error) {
    return fail(c, error);
  }
}

export async function handleListHarmonyDevices(c: AdminContext) {
  const appId = c.req.param("appId") ?? "";
  try {
    return c.json({ devices: await listHarmonyDevices(await resolveAgcAppAuth(c.env, appId)) });
  } catch (error) {
    return fail(c, error);
  }
}

export async function handleAddHarmonyDevices(c: AdminContext) {
  const appId = c.req.param("appId") ?? "";
  try {
    const input = await body(c);
    const list = Array.isArray(input.devices) ? input.devices : [];
    if (list.length === 0 || list.length > 100) throw new SigningError(400, "invalid_request", "devices must list 1-100 devices");
    const devices = list.map((d) => {
      const r = d && typeof d === "object" ? d as Record<string, unknown> : {};
      const name = typeof r.name === "string" ? r.name.trim() : "";
      const udid = typeof r.udid === "string" ? r.udid.trim() : "";
      const type = r.type === undefined ? 4 : Number(r.type);
      if (!name || name.length > 256 || !/^[0-9A-Fa-f]{16,64}$/.test(udid) || !(HARMONY_DEVICE_TYPES as readonly number[]).includes(type)) {
        throw new SigningError(400, "invalid_request", "each device needs a name, a UDID (hex, 16-64 characters) and a type (1, 2, 4, 5, 8 or 19; default 4 phone)");
      }
      return { name, udid, type };
    });
    const result = await addHarmonyDevices(await resolveAgcAppAuth(c.env, appId), devices);
    await insertAuditLog(c.env.DB, c, { app_id: appId, action: "harmony_signing.devices_added", payload: { count: devices.length, added: result.added } })
      .catch(() => undefined);
    return c.json(result);
  } catch (error) {
    return fail(c, error);
  }
}

export async function handleListHarmonyProfiles(c: AdminContext) {
  const appId = c.req.param("appId") ?? "";
  const { results } = await c.env.DB.prepare(
    "SELECT * FROM harmony_signing_profiles WHERE app_id = ?1 ORDER BY created_at DESC",
  ).bind(appId).all<ProfileRow>();
  return c.json({ profiles: results.map(profileView) });
}

/**
 * Issues a profile for the app with an identity of its organization: release
 * for the identity's release certificate, debug (with registered devices) for
 * a debug one. The new profile replaces the app's earlier one of that kind.
 */
export async function handleCreateHarmonyProfile(c: AdminContext) {
  const appId = c.req.param("appId") ?? "";
  try {
    const input = await body(c);
    const app = await packageName(c.env.DB, appId);
    const identityId = typeof input.identity_id === "string" ? input.identity_id : "";
    const identity = await c.env.DB.prepare(
      "SELECT * FROM harmony_signing_identities WHERE id = ?1 AND org_id = ?2 AND revoked_at IS NULL",
    ).bind(identityId, app.org_id).first<IdentityRow>();
    if (!identity) throw new SigningError(404, "not_found", "signing identity not found in this app's organization");
    const deviceIds = Array.isArray(input.device_ids) ? input.device_ids.filter((d): d is string => typeof d === "string" && /^[0-9A-Za-z]{1,32}$/.test(d)) : [];
    if (identity.cert_kind === "debug" && deviceIds.length === 0) {
      throw new SigningError(400, "invalid_request", "a debug profile needs device_ids (register devices first)");
    }
    const auth = await resolveAgcAppAuth(c.env, appId);
    const agcAppId = await resolveAgcAppId(auth, app.bundle_id!);
    const profile = await issueHarmonyProfile(auth, {
      name: `${app.slug}-${identity.cert_kind}-${new Date().toISOString().slice(0, 10)}`.slice(0, 256),
      kind: identity.cert_kind, certId: identity.agc_cert_id, appId: agcAppId, deviceIds,
    });
    const bytes = await downloadAgcFile(profile.download_url);
    let b64 = "";
    for (const byte of bytes) b64 += String.fromCharCode(byte);
    const id = crypto.randomUUID();
    const now = Date.now();
    await c.env.DB.batch([
      c.env.DB.prepare("UPDATE harmony_signing_profiles SET replaced_at = ?1 WHERE app_id = ?2 AND kind = ?3 AND replaced_at IS NULL")
        .bind(now, appId, identity.cert_kind),
      c.env.DB.prepare(
        `INSERT INTO harmony_signing_profiles (id, app_id, identity_id, kind, agc_app_id, agc_profile_id, profile_b64, device_ids_json,
           expires_at, created_by_actor, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`,
      ).bind(id, appId, identity.id, identity.cert_kind, agcAppId, profile.id, btoa(b64), JSON.stringify(profile.device_ids.length ? profile.device_ids : deviceIds),
        profile.expires_at, currentActor(c), now),
    ]);
    await insertAuditLog(c.env.DB, c, { app_id: appId, action: "harmony_signing.profile_created", payload: { profile_id: id, kind: identity.cert_kind, agc_profile_id: profile.id } })
      .catch(() => undefined);
    const row = await c.env.DB.prepare("SELECT * FROM harmony_signing_profiles WHERE id = ?1").bind(id).first<ProfileRow>();
    return c.json({ profile: profileView(row!) }, 201);
  } catch (error) {
    return fail(c, error);
  }
}

/** For the signing job (part 2): the identity's key and chain and the app's current profile of that kind. */
export async function harmonySigningMaterial(env: Env, appId: string, kind: HarmonyCertKind) {
  const profile = await env.DB.prepare(
    "SELECT * FROM harmony_signing_profiles WHERE app_id = ?1 AND kind = ?2 AND replaced_at IS NULL ORDER BY created_at DESC LIMIT 1",
  ).bind(appId, kind).first<ProfileRow>();
  if (!profile) return null;
  const identity = await env.DB.prepare("SELECT * FROM harmony_signing_identities WHERE id = ?1 AND revoked_at IS NULL")
    .bind(profile.identity_id).first<IdentityRow>();
  if (!identity) return null;
  const secret = await decryptSigningSecret<HarmonySigningSecret>(identity, env.ASC_CRED_ENC_KEY);
  return { identity: identityView(identity), profile_b64: profile.profile_b64, secret };
}

// ---------- Part 2: signing .hap / .app packages ----------

const MAX_PACKAGE_BYTES = 2 * 1024 * 1024 * 1024;
const SIGN_TIMEOUT_MS = 25 * 60 * 1000;

type JobRow = {
  id: string; app_id: string; kind: HarmonyCertKind; artifact_type: "hap" | "app"; profile_id: string | null; sign_code: number;
  status: "awaiting_upload" | "signing" | "succeeded" | "failed"; filename: string; input_r2_key: string; input_size: number;
  input_sha256: string; output_r2_key: string | null; output_size: number | null; output_sha256: string | null;
  error_code: string | null; error_message: string | null; actor: string; created_at: number; updated_at: number;
};

async function loadJob(db: D1Database, appId: string, jobId: string) {
  return db.prepare("SELECT * FROM harmony_signing_jobs WHERE id = ?1 AND app_id = ?2").bind(jobId, appId).first<JobRow>();
}

async function jobView(env: Env, job: JobRow) {
  const download = job.status === "succeeded" && job.output_r2_key
    ? await presignR2DownloadUrl(env, { key: job.output_r2_key, filetype: "bin",
      contentDisposition: `attachment; filename="${job.filename.replace(/["\\\r\n]/g, "_")}"` }, 3600)
    : null;
  return {
    id: job.id, app_id: job.app_id, kind: job.kind, artifact_type: job.artifact_type, profile_id: job.profile_id,
    sign_code: job.sign_code === 1, status: job.status, filename: job.filename, input_size: job.input_size, input_sha256: job.input_sha256,
    output_size: job.output_size, output_sha256: job.output_sha256, error_code: job.error_code, error_message: job.error_message,
    actor: job.actor, created_at: job.created_at, updated_at: job.updated_at, ...(download ? { download_url: download } : {}),
  };
}

/** Declares an unsigned .hap/.app; returns the URL to upload it to. */
export async function handleCreateHarmonySigningJob(c: AdminContext) {
  const appId = c.req.param("appId") ?? "";
  try {
    const input = await body(c);
    const kind = input.kind === "debug" || input.kind === "release" ? input.kind : null;
    if (!kind) throw new SigningError(400, "invalid_request", "kind must be debug or release");
    const artifactType = input.artifact_type === "hap" || input.artifact_type === "app" ? input.artifact_type : null;
    if (!artifactType) throw new SigningError(400, "invalid_request", "artifact_type must be hap or app");
    const filename = typeof input.filename === "string" ? input.filename.trim() : "";
    if (!/^[A-Za-z0-9 ._()+-]{1,200}$/.test(filename)) throw new SigningError(400, "invalid_request", "filename is required");
    const size = input.size;
    if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 1 || size > MAX_PACKAGE_BYTES) {
      throw new SigningError(400, "invalid_request", "size must be 1 byte to 2 GiB");
    }
    const sha256 = typeof input.sha256 === "string" ? input.sha256.toLowerCase() : "";
    if (!/^[0-9a-f]{64}$/.test(sha256)) throw new SigningError(400, "invalid_request", "sha256 must be a hex SHA-256");
    const profile = await c.env.DB.prepare(
      "SELECT id FROM harmony_signing_profiles WHERE app_id = ?1 AND kind = ?2 AND replaced_at IS NULL ORDER BY created_at DESC LIMIT 1",
    ).bind(appId, kind).first<{ id: string }>();
    if (!profile) throw new SigningError(409, "harmony_profile_missing", `this app has no ${kind} profile yet; issue one first`);
    const id = crypto.randomUUID();
    const inputKey = `signing/${appId}/harmony/${id}/input`;
    const uploadUrl = await presignR2UploadUrl(c.env, inputKey, "application/octet-stream", 3600);
    if (!uploadUrl) throw new SigningError(503, "signing_storage_unavailable", "direct upload is not configured");
    const now = Date.now();
    await c.env.DB.prepare(
      `INSERT INTO harmony_signing_jobs (id, app_id, kind, artifact_type, profile_id, sign_code, status, filename, input_r2_key,
         input_size, input_sha256, actor, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'awaiting_upload', ?7, ?8, ?9, ?10, ?11, ?12, ?12)`,
    ).bind(id, appId, kind, artifactType, profile.id, input.sign_code === false ? 0 : 1, filename, inputKey, size, sha256, currentActor(c), now).run();
    const job = (await loadJob(c.env.DB, appId, id))!;
    return c.json({ job: await jobView(c.env, job), upload_url: uploadUrl, upload_headers: { "content-type": "application/octet-stream" } }, 201);
  } catch (error) {
    return fail(c, error);
  }
}

/** Signs the uploaded package with the app's current profile of the job's kind and that profile's identity. */
export async function handleRunHarmonySigningJob(c: AdminContext) {
  const appId = c.req.param("appId") ?? "";
  const jobId = c.req.param("jobId") ?? "";
  const job = await loadJob(c.env.DB, appId, jobId);
  if (!job) return c.json({ error: "signing job not found" }, 404);
  if (job.status !== "awaiting_upload") return c.json({ job: await jobView(c.env, job) });
  const claim = await c.env.DB.prepare("UPDATE harmony_signing_jobs SET status = 'signing', updated_at = ?1 WHERE id = ?2 AND status = 'awaiting_upload'")
    .bind(Date.now(), jobId).run();
  if (Number(claim.meta?.changes ?? 0) !== 1) return c.json({ job: await jobView(c.env, (await loadJob(c.env.DB, appId, jobId))!) });
  try {
    const head = await c.env.APK_BUCKET.head(job.input_r2_key);
    if (!head) throw new SigningError(409, "signing_input_missing", "upload the file before signing");
    if (head.size !== job.input_size) throw new SigningError(409, "signing_input_mismatch", "uploaded size differs from the declared size");
    const material = await harmonySigningMaterial(c.env, appId, job.kind);
    if (!material) throw new SigningError(409, "harmony_profile_missing", `this app has no ${job.kind} profile with a valid identity`);
    const outputKey = `signing/${appId}/harmony/${jobId}/output`;
    const inputUrl = await presignR2DownloadUrl(c.env, { key: job.input_r2_key, filetype: "bin", contentDisposition: "attachment" }, 3600);
    const outputUrl = await presignR2UploadUrl(c.env, outputKey, "application/octet-stream", 3600);
    if (!inputUrl || !outputUrl) throw new SigningError(503, "signing_storage_unavailable", "direct storage is not configured");
    const result = await callSigningContainer<{ output_size: number; output_sha256: string }>(c.env, "/signing/sign", {
      artifact_type: job.artifact_type, secret: material.secret, harmony_profile_b64: material.profile_b64, sign_code: job.sign_code === 1,
      input_url: inputUrl, output_url: outputUrl, expected_input_sha256: job.input_sha256,
    }, SIGN_TIMEOUT_MS);
    await c.env.DB.prepare(
      `UPDATE harmony_signing_jobs SET status = 'succeeded', output_r2_key = ?1, output_size = ?2, output_sha256 = ?3, updated_at = ?4
       WHERE id = ?5 AND status = 'signing'`,
    ).bind(outputKey, result.output_size, result.output_sha256, Date.now(), jobId).run();
    await c.env.APK_BUCKET.delete(job.input_r2_key).catch(() => undefined);
    await insertAuditLog(c.env.DB, c, { app_id: appId, action: "harmony_signing.signed",
      payload: { job_id: jobId, kind: job.kind, artifact_type: job.artifact_type, identity_id: material.identity.id, input_sha256: job.input_sha256, output_sha256: result.output_sha256 } })
      .catch(() => undefined);
  } catch (error) {
    const code = error instanceof SigningError ? error.code : "signing_internal";
    const message = error instanceof SigningError ? error.message : "signing failed unexpectedly";
    await c.env.DB.prepare("UPDATE harmony_signing_jobs SET status = 'failed', error_code = ?1, error_message = ?2, updated_at = ?3 WHERE id = ?4 AND status = 'signing'")
      .bind(code, message.slice(0, 1000), Date.now(), jobId).run();
    if (!(error instanceof SigningError)) throw error;
  }
  return c.json({ job: await jobView(c.env, (await loadJob(c.env.DB, appId, jobId))!) });
}

export async function handleGetHarmonySigningJob(c: AdminContext) {
  const job = await loadJob(c.env.DB, c.req.param("appId") ?? "", c.req.param("jobId") ?? "");
  if (!job) return c.json({ error: "signing job not found" }, 404);
  return c.json({ job: await jobView(c.env, job) });
}
