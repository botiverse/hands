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
  addHarmonyDevices, createHarmonyApp, downloadAgcFile, HARMONY_DEVICE_TYPES, issueHarmonyCertificate, issueHarmonyProfile,
  listHarmonyDevices, type HarmonyCertKind,
} from "../lib/agc_provisioning";
import { callSigningContainer, decryptSigningSecret, encryptSigningSecret, SigningError, type HarmonySigningSecret } from "../lib/signing";
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
    const certBytes = await downloadAgcFile(cert.download_url);
    let b64 = "";
    for (const byte of certBytes) b64 += String.fromCharCode(byte);
    const checked = await callSigningContainer<{ chain_pem?: string; metadata?: Record<string, unknown> }>(
      c.env, "/signing/harmony-certificate", { key_pem: made.key_pem, certificate_b64: btoa(b64) }, 60_000,
    );
    if (!checked.chain_pem) throw new SigningError(502, "signing_generate_failed", "container could not read the certificate");
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
