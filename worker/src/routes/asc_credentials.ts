import type { Context } from "hono";
import { currentActor, type AdminEnv } from "../middleware/auth";
import { ensureAppRole, getAppOrgId, insertAuditLog } from "../lib/permissions";
import {
  storeAscCredentials,
  getAscCredentialsMeta,
  getAscCredentials,
  deleteAscCredentials,
} from "../lib/asc_credentials";
import { resolveAscAppId, AscApiError } from "../lib/asc_api";

type AdminContext = Context<AdminEnv & { Bindings: Env }>;

/** GET — returns credential metadata only (never the .p8). */
export async function handleGetAscCredentials(c: AdminContext) {
  const appId = c.req.param("appId") ?? "";
  const meta = await getAscCredentialsMeta(c.env.DB, appId);
  return c.json({ asc_credentials: meta });
}

/**
 * PUT — set (or rotate) the app's ASC API credentials. Body:
 * { key_id, issuer_id, p8 }. The .p8 is the raw PEM contents of the
 * downloaded AuthKey_XXXX.p8. Stored encrypted; response is metadata only.
 */
export async function handleSetAscCredentials(c: AdminContext) {
  const appId = c.req.param("appId") ?? "";
  const encKey = c.env.ASC_CRED_ENC_KEY;
  if (!encKey) {
    return c.json(
      { error: "server is missing ASC_CRED_ENC_KEY; cannot store credentials" },
      500,
    );
  }
  const body = (await c.req.json().catch(() => ({}))) as {
    key_id?: unknown;
    issuer_id?: unknown;
    p8?: unknown;
    from_app?: unknown;
  };
  if (body.from_app !== undefined) return copyAscCredentials(c, appId, encKey, body.from_app);
  const key_id = typeof body.key_id === "string" ? body.key_id.trim() : "";
  const issuer_id =
    typeof body.issuer_id === "string" ? body.issuer_id.trim() : "";
  const p8 = typeof body.p8 === "string" ? body.p8.trim() : "";
  if (!key_id) return c.json({ error: "key_id is required" }, 400);
  if (!issuer_id) return c.json({ error: "issuer_id is required" }, 400);
  if (!p8) return c.json({ error: "p8 is required" }, 400);
  if (!p8.includes("BEGIN PRIVATE KEY")) {
    return c.json(
      { error: "p8 must be the PEM contents of the AuthKey_XXXX.p8 file" },
      400,
    );
  }

  const actor = currentActor(c);
  const meta = await storeAscCredentials(c.env.DB, encKey, {
    app_id: appId,
    key_id,
    issuer_id,
    p8,
    actor,
  });

  await insertAuditLog(c.env.DB, c, {
    app_id: appId,
    action: "asc_credentials.set",
    // never log the p8 or its ciphertext
    payload: { key_id, issuer_id },
    created_at: meta.updated_at,
  });

  return c.json({ asc_credentials: meta });
}

/**
 * `{ from_app }`: copy the key another app of the same organization holds, so
 * a team key is entered once. The caller must be admin of both apps.
 */
async function copyAscCredentials(c: AdminContext, appId: string, encKey: string, fromApp: unknown) {
  const ref = typeof fromApp === "string" ? fromApp.trim() : "";
  if (!ref || ref.length > 128) return c.json({ error: "from_app must name an app (id or slug)" }, 400);
  const orgId = await getAppOrgId(c.env.DB, appId);
  const source = orgId
    ? await c.env.DB.prepare("SELECT id, slug FROM apps WHERE org_id = ?1 AND (id = ?2 OR slug = ?2)")
      .bind(orgId, ref).first<{ id: string; slug: string }>()
    : null;
  if (!source) return c.json({ error: "from_app: app not found in this organization", code: "app_not_in_org" }, 404);
  if (source.id === appId) return c.json({ error: "from_app is this app" }, 400);
  const allowed = await ensureAppRole(c, source.id, "admin");
  if (!allowed.ok) return allowed.response;
  const creds = await getAscCredentials(c.env.DB, encKey, source.id);
  if (!creds) return c.json({ error: `${source.slug} has no App Store Connect API key`, code: "asc_credentials_missing" }, 409);
  const meta = await storeAscCredentials(c.env.DB, encKey, {
    app_id: appId,
    key_id: creds.key_id,
    issuer_id: creds.issuer_id,
    p8: creds.p8,
    actor: currentActor(c),
  });
  await insertAuditLog(c.env.DB, c, {
    app_id: appId,
    action: "asc_credentials.set",
    payload: { key_id: creds.key_id, issuer_id: creds.issuer_id, from_app: source.slug },
    created_at: meta.updated_at,
  });
  return c.json({ asc_credentials: meta });
}

export async function handleDeleteAscCredentials(c: AdminContext) {
  const appId = c.req.param("appId") ?? "";
  await deleteAscCredentials(c.env.DB, appId);
  await insertAuditLog(c.env.DB, c, {
    app_id: appId,
    action: "asc_credentials.delete",
    payload: {},
  });
  return c.json({ ok: true });
}

/**
 * POST /verify — prove the stored credentials work end-to-end: decrypt the
 * .p8, sign a JWT, and ask App Store Connect for the app record matching
 * the given bundle id. Read-only against Apple; never returns the key.
 * Body: { bundle_id: string }.
 */
export async function handleVerifyAscCredentials(c: AdminContext) {
  const appId = c.req.param("appId") ?? "";
  const encKey = c.env.ASC_CRED_ENC_KEY;
  if (!encKey) {
    return c.json({ error: "server is missing ASC_CRED_ENC_KEY" }, 500);
  }
  const body = (await c.req.json().catch(() => ({}))) as { bundle_id?: unknown };
  const bundleId = typeof body.bundle_id === "string" ? body.bundle_id.trim() : "";
  if (!bundleId) return c.json({ error: "bundle_id is required" }, 400);

  const creds = await getAscCredentials(c.env.DB, encKey, appId);
  if (!creds) return c.json({ error: "no ASC credentials configured for this app" }, 404);

  try {
    const ascAppId = await resolveAscAppId(creds, bundleId);
    return c.json({
      ok: ascAppId !== null,
      key_id: creds.key_id,
      bundle_id: bundleId,
      asc_app_id: ascAppId,
      detail: ascAppId
        ? "Credentials valid; App Store Connect app record found."
        : "Credentials valid, but no App Store Connect app record matches this bundle id — create it under My Apps first.",
    });
  } catch (e) {
    if (e instanceof AscApiError) {
      return c.json(
        { ok: false, key_id: creds.key_id, status: e.status, error: e.message, detail: e.detail },
        502,
      );
    }
    throw e;
  }
}
