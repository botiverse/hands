import type { Context } from "hono";
import { currentActor, type AdminEnv } from "../middleware/auth";
import { insertAuditLog } from "../lib/permissions";
import {
  assertGooglePlayCredentialKeyring,
  deleteGooglePlayBinding,
  getGooglePlayBinding,
  getGooglePlayBindingMeta,
  normalizeGooglePlayPackage,
  normalizeGooglePlayTracks,
  parseGoogleServiceAccount,
  setGooglePlayBindingEnabled,
  setGooglePlayBindingVerification,
  storeGooglePlayBinding,
  type GooglePlayBinding,
} from "../lib/google_play_bindings";

type AdminContext = Context<AdminEnv & { Bindings: Env }>;

async function requireAndroidApp(c: AdminContext) {
  const appId = c.req.param("appId") ?? "";
  const app = await c.env.DB.prepare("SELECT platform FROM apps WHERE id=?1").bind(appId)
    .first<{ platform: string }>();
  if (!app) return c.json({ error: "app not found", code: "APP_NOT_FOUND" }, 404);
  if (app.platform !== "android") {
    return c.json({ error: "Google Play is only available for Android apps", code: "PLATFORM_MISMATCH" }, 400);
  }
  return null;
}

function safeMeta(meta: Awaited<ReturnType<typeof getGooglePlayBindingMeta>>) {
  return meta ? { ...meta, enabled: meta.enabled === 1 } : null;
}

async function verifyBinding(c: AdminContext, binding: Pick<GooglePlayBinding, "credential" | "package_name" | "tracks">) {
  if (!c.env.PLAY_RELEASE_SERVICE) {
    return { ok: false as const, invalidate: false, status: 503 as const, code: "PLAY_SERVICE_UNAVAILABLE", error: "Google Play validation service is not configured" };
  }
  try {
    const result = await c.env.PLAY_RELEASE_SERVICE.verifyBinding({
      credential: binding.credential,
      packageName: binding.package_name,
      tracks: binding.tracks,
    });
    if (!result?.ok) {
      return {
        ok: false as const,
        invalidate: result?.error?.status === 400 || result?.error?.status === 403,
        status: 502 as const,
        code: result?.error?.code ?? "PLAY_BINDING_REJECTED",
        error: result?.error?.message ?? "Google Play rejected the binding",
      };
    }
    if (
      result.value.client_email !== binding.credential.client_email
      || result.value.package_name !== binding.package_name
    ) {
      return { ok: false as const, invalidate: true, status: 502 as const, code: "PLAY_BINDING_MISMATCH", error: "Google Play validation returned a different binding identity" };
    }
    return { ok: true as const, result: result.value };
  } catch {
    return { ok: false as const, invalidate: false, status: 502 as const, code: "PLAY_SERVICE_UNAVAILABLE", error: "Google Play validation request failed" };
  }
}

export async function handleGetGooglePlayBinding(c: AdminContext) {
  const invalid = await requireAndroidApp(c);
  if (invalid) return invalid;
  return c.json({ google_play: safeMeta(await getGooglePlayBindingMeta(c.env.DB, c.req.param("appId") ?? "")) });
}

export async function handlePutGooglePlayBinding(c: AdminContext) {
  const invalid = await requireAndroidApp(c);
  if (invalid) return invalid;
  let body: { service_account_json?: unknown; package_name?: unknown; tracks?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "valid JSON body required", code: "INVALID_PLAY_BINDING" }, 400);
  }
  let credential;
  let packageName;
  let tracks;
  try {
    credential = parseGoogleServiceAccount(body.service_account_json);
    packageName = normalizeGooglePlayPackage(body.package_name);
    tracks = normalizeGooglePlayTracks(body.tracks);
  } catch (error) {
    return c.json({ error: (error as Error).message, code: "INVALID_PLAY_BINDING" }, 400);
  }
  const appId = c.req.param("appId") ?? "";
  try {
    assertGooglePlayCredentialKeyring(
      c.env.PLAY_CRED_ENC_KEYS,
      c.env.PLAY_CRED_ENC_ACTIVE_KEY_VERSION,
    );
  } catch {
    return c.json({
      error: "Google Play credential encryption is not configured",
      code: "PLAY_CREDENTIAL_STORAGE_UNAVAILABLE",
    }, 500);
  }
  const verified = await verifyBinding(c, { credential, package_name: packageName, tracks });
  if (!verified.ok) return c.json({ error: verified.error, code: verified.code }, verified.status);
  let meta;
  try {
    meta = await storeGooglePlayBinding(c.env.DB, {
      appId,
      packageName,
      tracks,
      credential,
      actor: currentActor(c),
      keyringJson: c.env.PLAY_CRED_ENC_KEYS,
      activeKeyVersion: c.env.PLAY_CRED_ENC_ACTIVE_KEY_VERSION,
    });
  } catch {
    return c.json({ error: "Google Play credential encryption is not configured", code: "PLAY_CREDENTIAL_STORAGE_UNAVAILABLE" }, 500);
  }
  await insertAuditLog(c.env.DB, c, {
    app_id: appId,
    action: "google_play.binding.set",
    payload: {
      package_name: packageName,
      tracks,
      service_account_email: credential.client_email,
      credential_fingerprint: meta.credential_fingerprint,
    },
    created_at: meta.updated_at,
  });
  return c.json({ google_play: safeMeta(meta), verification: verified.result });
}

export async function handleVerifyGooglePlayBinding(c: AdminContext) {
  const invalid = await requireAndroidApp(c);
  if (invalid) return invalid;
  const appId = c.req.param("appId") ?? "";
  let binding;
  try {
    binding = await getGooglePlayBinding(c.env.DB, appId, c.env.PLAY_CRED_ENC_KEYS);
  } catch {
    return c.json({ error: "Stored Google Play credential could not be decrypted", code: "PLAY_CREDENTIAL_UNAVAILABLE" }, 500);
  }
  if (!binding) return c.json({ error: "Google Play is not bound for this app", code: "PLAY_BINDING_MISSING" }, 404);
  const verified = await verifyBinding(c, binding);
  if (verified.ok || verified.invalidate) {
    await setGooglePlayBindingVerification(c.env.DB, appId, verified.ok, currentActor(c));
  }
  await insertAuditLog(c.env.DB, c, {
    app_id: appId,
    action: "google_play.binding.verify",
    payload: { package_name: binding.package_name, ok: verified.ok },
  });
  if (!verified.ok) return c.json({ error: verified.error, code: verified.code }, verified.status);
  return c.json({ ok: true, verification: verified.result });
}

export async function handleDisableGooglePlayBinding(c: AdminContext) {
  const invalid = await requireAndroidApp(c);
  if (invalid) return invalid;
  const appId = c.req.param("appId") ?? "";
  const changed = await setGooglePlayBindingEnabled(c.env.DB, appId, false, currentActor(c));
  if (!changed) return c.json({ error: "Google Play is not bound for this app", code: "PLAY_BINDING_MISSING" }, 404);
  await insertAuditLog(c.env.DB, c, { app_id: appId, action: "google_play.binding.disable", payload: {} });
  return c.json({ ok: true, enabled: false });
}

export async function handleEnableGooglePlayBinding(c: AdminContext) {
  const invalid = await requireAndroidApp(c);
  if (invalid) return invalid;
  const appId = c.req.param("appId") ?? "";
  let binding;
  try {
    binding = await getGooglePlayBinding(c.env.DB, appId, c.env.PLAY_CRED_ENC_KEYS);
  } catch {
    return c.json({ error: "Stored Google Play credential could not be decrypted", code: "PLAY_CREDENTIAL_UNAVAILABLE" }, 500);
  }
  if (!binding) return c.json({ error: "Google Play is not bound for this app", code: "PLAY_BINDING_MISSING" }, 404);
  const verified = await verifyBinding(c, binding);
  if (verified.ok || verified.invalidate) {
    await setGooglePlayBindingVerification(c.env.DB, appId, verified.ok, currentActor(c));
  }
  if (!verified.ok) {
    await insertAuditLog(c.env.DB, c, {
      app_id: appId,
      action: "google_play.binding.enable",
      payload: { package_name: binding.package_name, ok: false, code: verified.code },
    });
    return c.json({ error: verified.error, code: verified.code }, verified.status);
  }
  await setGooglePlayBindingEnabled(c.env.DB, appId, true, currentActor(c));
  await insertAuditLog(c.env.DB, c, { app_id: appId, action: "google_play.binding.enable", payload: { package_name: binding.package_name, ok: true } });
  return c.json({ ok: true, enabled: true, verification: verified.result });
}

export async function handleDeleteGooglePlayBinding(c: AdminContext) {
  const invalid = await requireAndroidApp(c);
  if (invalid) return invalid;
  const appId = c.req.param("appId") ?? "";
  await deleteGooglePlayBinding(c.env.DB, appId);
  await insertAuditLog(c.env.DB, c, { app_id: appId, action: "google_play.binding.delete", payload: {} });
  return c.json({ ok: true });
}
