import type { Context } from "hono";
import { currentActor, type AdminEnv } from "../middleware/auth";
import { currentAccount, insertAuditLog } from "../lib/permissions";
import { presignR2DownloadUrl, presignR2UploadUrl } from "../lib/r2_presign";
import { createAscJwt } from "../lib/asc_api";
import { getAscCredentials } from "../lib/asc_credentials";
import { appStoreProfile, createDistributionCertificate, revokeDistributionCertificate, type ResolvedProfile } from "../lib/ios_profiles";
import { applyAppIdPlan, planAppId, validBundleId } from "../lib/apple_app_ids";
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
  type NotaryKey,
  type PendingKeySecret,
  type SigningKind,
  type SigningMetadata,
  type SigningSecret,
} from "../lib/signing";

type AdminContext = Context<AdminEnv & { Bindings: Env }>;

const MAX_ARTIFACT_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_SECRET_FILE_BYTES = 64 * 1024;
const NAME_PATTERN = /^[\p{L}\p{N} ,._()&-]{1,80}$/u;
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

type ResolvedKey = { key: NotaryKey | null; fromApp: { id: string; slug: string } | null };

/**
 * An App Store Connect API key given inline (`key_id`, `issuer_id`, `p8`) or
 * as `{ from_app: <app id or slug> }`: a copy of the TestFlight key that an
 * app in the same organization already holds, so a team key is entered once.
 */
async function resolveApiKey(c: AdminContext, orgId: string, value: unknown, field: string): Promise<ResolvedKey> {
  if (value === undefined || value === null) return { key: null, fromApp: null };
  const n = value as Record<string, unknown>;
  if (n.from_app !== undefined) {
    const ref = str(n.from_app, 128);
    if (!ref) throw new SigningError(400, "invalid_request", `${field}.from_app must name an app`);
    const app = await c.env.DB.prepare("SELECT id, slug FROM apps WHERE org_id = ?1 AND (id = ?2 OR slug = ?2)")
      .bind(orgId, ref).first<{ id: string; slug: string }>();
    if (!app) throw new SigningError(404, "app_not_in_org", `${field}.from_app: app not found in this organization`);
    if (!c.env.ASC_CRED_ENC_KEY) throw new SigningError(500, "signing_not_configured", "server is missing its credential encryption key");
    const creds = await getAscCredentials(c.env.DB, c.env.ASC_CRED_ENC_KEY, app.id);
    if (!creds) throw new SigningError(409, "asc_credentials_missing", `${app.slug} has no App Store Connect API key`);
    return { key: { key_id: creds.key_id, issuer_id: creds.issuer_id, p8: creds.p8 }, fromApp: app };
  }
  const keyId = str(n.key_id, 32);
  const issuerId = str(n.issuer_id, 64);
  const p8 = str(n.p8, 8192);
  if (!keyId || !issuerId || !p8 || !p8.includes("PRIVATE KEY")) {
    throw new SigningError(400, "invalid_request", `${field} needs key_id, issuer_id and the .p8 contents, or from_app`);
  }
  return { key: { key_id: keyId, issuer_id: issuerId, p8 }, fromApp: null };
}

/** Validate an upload body into a secret bundle; the container then proves it opens. */
async function secretFromBody(
  c: AdminContext,
  orgId: string,
  kind: SigningKind,
  body: Record<string, unknown>,
): Promise<{ secret: SigningSecret; extra: SigningMetadata }> {
  if (kind === "android_keystore") {
    const keystore = b64(body.keystore_b64);
    const storePassword = str(body.store_password, 256);
    const alias = typeof body.key_alias === "string" && /^[A-Za-z0-9_][A-Za-z0-9._-]{0,63}$/.test(body.key_alias) ? body.key_alias : null;
    if (!keystore || !storePassword || !alias) {
      throw new SigningError(400, "invalid_request", "keystore_b64, store_password and key_alias (letters, digits, . _ -) are required");
    }
    return {
      secret: {
        kind,
        keystore_b64: keystore,
        store_password: storePassword,
        key_alias: alias,
        key_password: str(body.key_password, 256) ?? storePassword,
      },
      extra: {},
    };
  }
  const p12 = b64(body.p12_b64);
  const password = typeof body.p12_password === "string" && body.p12_password.length <= 256 ? body.p12_password : null;
  if (!p12 || password === null) throw new SigningError(400, "invalid_request", "p12_b64 and p12_password are required");
  if (kind === "apple_developer_id") {
    const notary = await resolveApiKey(c, orgId, body.notary, "notary");
    return {
      secret: { kind, p12_b64: p12, p12_password: password, notary: notary.key },
      extra: notary.fromApp ? { api_key_from_app: notary.fromApp.slug } : {},
    };
  }
  const profiles = Array.isArray(body.provisioning_profiles_b64) ? body.provisioning_profiles_b64.map(b64) : [];
  if (profiles.some((p) => !p)) throw new SigningError(400, "invalid_request", "provisioning_profiles_b64 must be base64 files");
  const asc = await resolveApiKey(c, orgId, body.asc, "asc");
  if (profiles.length === 0 && !asc.key) {
    throw new SigningError(400, "invalid_request", "give an App Store Connect API key (asc) so Hands can create the profile, or upload a provisioning profile");
  }
  return {
    secret: { kind, p12_b64: p12, p12_password: password, provisioning_profiles_b64: profiles as string[], asc: asc.key },
    extra: {
      asc_key_id: asc.key?.key_id ?? null,
      provisioning_profile_count: profiles.length,
      ...(asc.fromApp ? { api_key_from_app: asc.fromApp.slug } : {}),
    },
  };
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

/** Apps in the organization that hold an App Store Connect API key (ids only, never the key). */
export async function handleListSigningApiKeySources(c: AdminContext) {
  const orgId = c.req.param("orgId") ?? "";
  const { results } = await c.env.DB.prepare(
    `SELECT a.id AS app_id, a.slug, a.name, k.key_id, k.issuer_id, k.updated_at
     FROM app_asc_credentials k JOIN apps a ON a.id = k.app_id
     WHERE a.org_id = ?1 ORDER BY a.slug`,
  ).bind(orgId).all<{ app_id: string; slug: string; name: string; key_id: string; issuer_id: string; updated_at: number }>();
  return c.json({ api_keys: results });
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
    if (!NAME_PATTERN.test(name)) throw new SigningError(400, "invalid_request", "name is required (letters, digits, spaces, , . _ - & ( ))");
    const { secret, extra } = await secretFromBody(c, orgId, kind, body);
    const { metadata } = await callSigningContainer<{ metadata: SigningMetadata }>(c.env, "/signing/inspect", { secret }, 60_000);
    const row = await storeIdentity(c, orgId, { kind, name, origin: "uploaded", secret, metadata: { ...metadata, ...extra } });
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

// ---------- Apple keys made in Hands ----------

type AppleKind = "apple_developer_id" | "apple_ios_distribution";

type CertificateRequestRow = {
  id: string;
  org_id: string;
  kind: AppleKind;
  name: string;
  csr_pem: string;
  metadata_json: string;
  secret_ciphertext_b64: string | null;
  secret_iv_b64: string | null;
  identity_id: string | null;
  created_by_actor: string;
  created_at: number;
  completed_at: number | null;
  cancelled_at: number | null;
};

function appleKind(value: unknown): AppleKind {
  if (value === "apple_developer_id" || value === "apple_ios_distribution") return value;
  throw new SigningError(400, "invalid_request", "kind must be apple_developer_id or apple_ios_distribution");
}

function bodyName(body: Record<string, unknown>) {
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!NAME_PATTERN.test(name)) throw new SigningError(400, "invalid_request", "name is required (letters, digits, spaces, , . _ - & ( ))");
  return name;
}

/** The API key an Apple identity keeps: notarization for macOS, profiles for iOS. */
async function appleApiKey(c: AdminContext, orgId: string, kind: AppleKind, body: Record<string, unknown>) {
  const field = kind === "apple_developer_id" ? "notary" : "asc";
  const resolved = await resolveApiKey(c, orgId, body[field], field);
  const extra: SigningMetadata = resolved.fromApp ? { api_key_from_app: resolved.fromApp.slug } : {};
  if (kind === "apple_ios_distribution") extra.asc_key_id = resolved.key?.key_id ?? null;
  return { key: resolved.key, extra };
}

async function newAppleKey(c: AdminContext, name: string) {
  const made = await callSigningContainer<{ key_pem?: string; csr_pem?: string }>(c.env, "/signing/apple-csr", { common_name: name }, 60_000);
  if (!made.key_pem || !made.csr_pem) throw new SigningError(502, "signing_generate_failed", "container returned no key");
  return { key_pem: made.key_pem, csr_pem: made.csr_pem };
}

/** Join a key made in Hands with the certificate Apple issued, and store it as an identity. */
async function storeAppleIdentity(
  c: AdminContext,
  orgId: string,
  input: { kind: AppleKind; name: string; keyPem: string; certificate: string; apiKey: NotaryKey | null; extra: SigningMetadata },
) {
  const joined = await callSigningContainer<{ secret?: { p12_b64: string; p12_password: string }; metadata: SigningMetadata }>(
    c.env, "/signing/apple-p12", { kind: input.kind, key_pem: input.keyPem, certificate_b64: input.certificate, notary: input.kind === "apple_developer_id" ? input.apiKey : null }, 60_000,
  );
  if (!joined.secret?.p12_b64) throw new SigningError(502, "signing_generate_failed", "container returned no certificate");
  const secret: SigningSecret = input.kind === "apple_developer_id"
    ? { kind: input.kind, p12_b64: joined.secret.p12_b64, p12_password: joined.secret.p12_password, notary: input.apiKey }
    : { kind: input.kind, p12_b64: joined.secret.p12_b64, p12_password: joined.secret.p12_password, provisioning_profiles_b64: [], asc: input.apiKey };
  return storeIdentity(c, orgId, { kind: input.kind, name: input.name, origin: "generated", secret, metadata: { ...joined.metadata, ...input.extra } });
}

/**
 * iOS in one step: Hands makes the key, App Store Connect issues an Apple
 * Distribution certificate for it (API key with the Admin role), and the key
 * never leaves Hands.
 */
export async function handleGenerateAppleIosSigningIdentity(c: AdminContext) {
  const orgId = c.req.param("orgId") ?? "";
  try {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const name = bodyName(body);
    const api = await appleApiKey(c, orgId, "apple_ios_distribution", body);
    if (!api.key) throw new SigningError(400, "invalid_request", "an App Store Connect API key (asc) with the Admin role is required");
    const made = await newAppleKey(c, name);
    const issued = await createDistributionCertificate(api.key, made.csr_pem);
    let row: IdentityRow;
    try {
      row = await storeAppleIdentity(c, orgId, {
        kind: "apple_ios_distribution", name, keyPem: made.key_pem, certificate: issued.certificate_b64, apiKey: api.key,
        extra: { ...api.extra, apple_certificate_id: issued.id },
      });
    } catch (error) {
      // Without its key the certificate is useless and takes one of the
      // team's few Distribution slots: give it back.
      await revokeDistributionCertificate(api.key, issued.id).catch(() => {});
      throw error;
    }
    return c.json({ signing_identity: await identityResponse(c.env.DB, row) }, 201);
  } catch (error) {
    return fail(c, error);
  }
}

function certificateRequestResponse(row: CertificateRequestRow) {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    csr_pem: row.csr_pem,
    metadata: parseMetadata(row.metadata_json),
    identity_id: row.identity_id,
    created_by_actor: row.created_by_actor,
    created_at: row.created_at,
    completed_at: row.completed_at,
    cancelled_at: row.cancelled_at,
  };
}

const REQUEST_COLUMNS = `id, org_id, kind, name, csr_pem, metadata_json, secret_ciphertext_b64, secret_iv_b64, identity_id,
  created_by_actor, created_at, completed_at, cancelled_at`;

/**
 * A key made in Hands and its certificate request, for a person to take to
 * the Apple Developer site (Developer ID certificates can only be created
 * there, by the Account Holder). The issued certificate comes back through
 * `complete`.
 */
export async function handleCreateSigningCertificateRequest(c: AdminContext) {
  const orgId = c.req.param("orgId") ?? "";
  try {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const kind = appleKind(body.kind);
    const name = bodyName(body);
    const api = await appleApiKey(c, orgId, kind, body);
    if (kind === "apple_ios_distribution" && !api.key) {
      throw new SigningError(400, "invalid_request", "an App Store Connect API key (asc) is required so Hands can create the provisioning profiles");
    }
    const made = await newAppleKey(c, name);
    const pending: PendingKeySecret = { kind: "pending_apple_key", key_pem: made.key_pem, api_key: api.key };
    const encrypted = await encryptSigningSecret(pending, c.env.ASC_CRED_ENC_KEY);
    const id = crypto.randomUUID();
    await c.env.DB.prepare(
      `INSERT INTO signing_certificate_requests (id, org_id, kind, name, csr_pem, metadata_json, secret_ciphertext_b64, secret_iv_b64,
         created_by_actor, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
    ).bind(id, orgId, kind, name, made.csr_pem, JSON.stringify(api.extra), encrypted.secret_ciphertext_b64, encrypted.secret_iv_b64,
      currentActor(c), Date.now()).run();
    const auditApp = await orgAuditApp(c.env.DB, orgId);
    if (auditApp) await insertAuditLog(c.env.DB, c, { app_id: auditApp, action: "signing_certificate_request.create", payload: { org_id: orgId, request_id: id } });
    const row = await c.env.DB.prepare(`SELECT ${REQUEST_COLUMNS} FROM signing_certificate_requests WHERE id = ?1`).bind(id).first<CertificateRequestRow>();
    return c.json({ certificate_request: certificateRequestResponse(row!) }, 201);
  } catch (error) {
    return fail(c, error);
  }
}

export async function handleListSigningCertificateRequests(c: AdminContext) {
  const orgId = c.req.param("orgId") ?? "";
  const { results } = await c.env.DB.prepare(
    `SELECT ${REQUEST_COLUMNS} FROM signing_certificate_requests
     WHERE org_id = ?1 AND completed_at IS NULL AND cancelled_at IS NULL ORDER BY created_at DESC`,
  ).bind(orgId).all<CertificateRequestRow>();
  return c.json({ certificate_requests: results.map(certificateRequestResponse) });
}

export async function handleCompleteSigningCertificateRequest(c: AdminContext) {
  const orgId = c.req.param("orgId") ?? "";
  const id = c.req.param("requestId") ?? "";
  try {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const certificate = str(body.certificate_b64, 64 * 1024);
    if (!certificate) throw new SigningError(400, "invalid_request", "certificate_b64 (the .cer file Apple issued) is required");
    const row = await c.env.DB.prepare(`SELECT ${REQUEST_COLUMNS} FROM signing_certificate_requests WHERE id = ?1 AND org_id = ?2`)
      .bind(id, orgId).first<CertificateRequestRow>();
    if (!row || row.cancelled_at !== null || !row.secret_ciphertext_b64 || !row.secret_iv_b64) {
      throw new SigningError(404, "not_found", "certificate request not found");
    }
    // Claim the request so two uploads cannot make two identities; a failed
    // attempt releases it for another try.
    const claim = await c.env.DB.prepare(
      "UPDATE signing_certificate_requests SET completed_at = ?1 WHERE id = ?2 AND completed_at IS NULL AND cancelled_at IS NULL",
    ).bind(Date.now(), id).run();
    if (Number(claim.meta?.changes ?? 0) !== 1) throw new SigningError(409, "certificate_request_completed", "this request already has its certificate");
    let identity: IdentityRow;
    try {
      const pending = await decryptSigningSecret<PendingKeySecret>(
        { secret_ciphertext_b64: row.secret_ciphertext_b64, secret_iv_b64: row.secret_iv_b64 }, c.env.ASC_CRED_ENC_KEY,
      );
      identity = await storeAppleIdentity(c, orgId, {
        kind: row.kind, name: row.name, keyPem: pending.key_pem, certificate, apiKey: pending.api_key, extra: parseMetadata(row.metadata_json),
      });
    } catch (error) {
      await c.env.DB.prepare("UPDATE signing_certificate_requests SET completed_at = NULL WHERE id = ?1 AND identity_id IS NULL").bind(id).run();
      throw error;
    }
    // The key now lives in the identity; clear it here.
    await c.env.DB.prepare(
      `UPDATE signing_certificate_requests SET completed_at = ?1, identity_id = ?2, secret_ciphertext_b64 = NULL, secret_iv_b64 = NULL
       WHERE id = ?3`,
    ).bind(Date.now(), identity.id, id).run();
    return c.json({ signing_identity: await identityResponse(c.env.DB, identity) }, 201);
  } catch (error) {
    return fail(c, error);
  }
}

export async function handleCancelSigningCertificateRequest(c: AdminContext) {
  const orgId = c.req.param("orgId") ?? "";
  const id = c.req.param("requestId") ?? "";
  const result = await c.env.DB.prepare(
    `UPDATE signing_certificate_requests SET cancelled_at = ?1, secret_ciphertext_b64 = NULL, secret_iv_b64 = NULL
     WHERE id = ?2 AND org_id = ?3 AND completed_at IS NULL AND cancelled_at IS NULL`,
  ).bind(Date.now(), id, orgId).run();
  if (Number(result.meta?.changes ?? 0) !== 1) return c.json({ error: "certificate request not found" }, 404);
  return c.json({ cancelled: true });
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
    // iOS with an App Store Connect key: read the bundle ID, then find or create its App Store profile.
    let profile: ResolvedProfile | null = null;
    if (job.artifact_type === "ipa" && secret.kind === "apple_ios_distribution" && secret.asc) {
      const info = await callSigningContainer<{ bundle_id: string; extensions: string[] }>(
        c.env, "/signing/ipa-info", { input_url: inputUrl, expected_input_sha256: job.input_sha256 }, 10 * 60 * 1000,
      );
      if (info.extensions?.length) {
        throw new SigningError(400, "signing_unsupported", `app extensions are not supported yet: ${info.extensions.join(", ")}`);
      }
      const fingerprint = parseMetadata(identity.metadata_json).sha256_fingerprint;
      if (!fingerprint) throw new SigningError(409, "signing_identity_invalid", "the identity has no certificate fingerprint; upload it again");
      profile = await appStoreProfile(secret.asc, info.bundle_id, fingerprint);
      await insertAuditLog(c.env.DB, c, {
        app_id: appId,
        action: profile.created ? "signing_profile.create" : "signing_profile.reuse",
        payload: { job_id: jobId, identity_id: identity.id, bundle_id: info.bundle_id, profile_id: profile.profile_id, name: profile.name, expiration: profile.expiration },
      }).catch(() => undefined);
    }
    const result = await callSigningContainer<{
      output_size: number;
      output_sha256: string;
      input_sha256?: string;
      notary_submission_id: string | null;
      ios?: { bundle_id: string; version: string | null; build: string | null; profile: { name: string; uuid: string; expiration: string; team_id: string }; entitlement_keys: string[] };
    }>(
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
        ...(profile ? { provisioning_profile_b64: profile.profile_b64 } : {}),
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
          ...(result.ios ? { ios: result.ios } : {}),
        },
      }).catch(() => undefined);
    }
  } catch (error) {
    await failJob(c, job, error, "signing");
  }
  return c.json({ job: await jobResponse(c.env, (await loadJob(c.env.DB, appId, jobId))!) });
}

// ---------- Apple App IDs (app admin; people and agents) ----------

/**
 * Plan or register the App ID for an iOS app and turn on the capabilities its
 * entitlements ask for, with the App Store Connect key of the Distribution
 * identity granted to the app. `apply: false` (the default) only reports what
 * would change.
 */
export async function handleAppleAppId(c: AdminContext) {
  const appId = c.req.param("appId") ?? "";
  try {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    if (!validBundleId(body.bundle_id)) {
      throw new SigningError(400, "invalid_request", "bundle_id must be an explicit bundle ID such as com.example.app (no wildcard)");
    }
    const bundleId = body.bundle_id;
    let entitlements: Record<string, unknown>;
    if (body.entitlements && typeof body.entitlements === "object" && !Array.isArray(body.entitlements)) {
      if (body.entitlements_b64 !== undefined) throw new SigningError(400, "invalid_request", "pass entitlements or entitlements_b64, not both");
      entitlements = body.entitlements as Record<string, unknown>;
    } else if (typeof body.entitlements_b64 === "string") {
      if (body.entitlements_b64.length > 64 * 1024) throw new SigningError(400, "signing_entitlements_invalid", "entitlements_b64 is too large");
      entitlements = (await callSigningContainer<{ entitlements: Record<string, unknown> }>(
        c.env, "/signing/entitlements", { entitlements_b64: body.entitlements_b64 }, 30_000,
      )).entitlements;
    } else if (body.entitlements === undefined && body.entitlements_b64 === undefined) {
      // An app without an entitlements file needs only the App ID.
      entitlements = {};
    } else {
      throw new SigningError(400, "invalid_request", "entitlements must be an object, or entitlements_b64 the .entitlements file in base64");
    }
    const identityId = typeof body.identity_id === "string" ? body.identity_id : null;
    const identity = await identityForApp(c.env.DB, appId, "apple_ios_distribution", identityId);
    const secret = await decryptSigningSecret(identity, c.env.ASC_CRED_ENC_KEY);
    if (secret.kind !== "apple_ios_distribution" || !secret.asc) {
      throw new SigningError(400, "signing_asc_key_missing", "this identity has no App Store Connect API key; add one to let Hands manage App IDs");
    }
    const plan = await planAppId(secret.asc, bundleId, entitlements);
    if (body.apply !== true) return c.json({ plan, applied: null });
    const applied = await applyAppIdPlan(secret.asc, plan);
    await insertAuditLog(c.env.DB, c, {
      app_id: appId,
      action: "signing_app_id.apply",
      payload: {
        identity_id: identity.id,
        bundle_id: bundleId,
        app_id_resource_id: applied.app_id_resource_id,
        created_app_id: applied.created_app_id,
        enabled: applied.enabled,
        profiles_removed: applied.profiles_removed,
      },
    }).catch(() => undefined);
    return c.json({ plan, applied });
  } catch (error) {
    return fail(c, error);
  }
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
