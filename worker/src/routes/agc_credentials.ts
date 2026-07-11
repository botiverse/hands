import type { Context } from "hono";
import { currentActor, type AdminEnv } from "../middleware/auth";
import { insertAuditLog } from "../lib/permissions";
import { agcCredentialKind, deleteAgcCredentials, getAgcCredentials, getAgcCredentialsMeta, parseAgcCredential, storeAgcCredentials, type AgcApiClientCredential, type AgcServiceAccountCredential } from "../lib/agc_credentials";
import { AgcApiError, createAgcServiceAccountJwt, exchangeAgcApiClientToken } from "../lib/agc_api";

type AdminContext = Context<AdminEnv & { Bindings: Env }>;
async function requireOhosApp(c: AdminContext) {
  const appId = c.req.param("appId") ?? "";
  const app = await c.env.DB.prepare("SELECT platform FROM apps WHERE id=?1").bind(appId).first<{ platform: string }>();
  if (!app) return c.json({ error: "app not found" }, 404);
  if (app.platform !== "ohos") return c.json({ error: "AppGallery Connect credentials are only available for OHOS apps" }, 400);
  return null;
}
export async function handleGetAgcCredentials(c: AdminContext) {
  const invalid = await requireOhosApp(c); if (invalid) return invalid;
  return c.json({ agc_credentials: await getAgcCredentialsMeta(c.env.DB, c.req.param("appId") ?? "") });
}
export async function handleSetAgcCredentials(c: AdminContext) {
  const invalid = await requireOhosApp(c); if (invalid) return invalid;
  if (!c.env.AGC_CRED_ENC_KEY) return c.json({ error: "server is missing AGC_CRED_ENC_KEY; cannot store credentials" }, 500);
  const body = await c.req.json().catch(() => ({})) as { credential_json?: unknown };
  let credential;
  try { credential = parseAgcCredential(body.credential_json); } catch (e) { return c.json({ error: (e as Error).message }, 400); }
  const appId = c.req.param("appId") ?? "";
  const meta = await storeAgcCredentials(c.env.DB, c.env.AGC_CRED_ENC_KEY, { app_id: appId, credential, actor: currentActor(c) });
  await insertAuditLog(c.env.DB, c, { app_id: appId, action: "agc_credentials.set", payload: { credential_kind: meta.credential_kind, client_id: meta.client_id, key_id: meta.key_id, project_id: meta.project_id }, created_at: meta.updated_at });
  return c.json({ agc_credentials: meta });
}
export async function handleDeleteAgcCredentials(c: AdminContext) {
  const invalid = await requireOhosApp(c); if (invalid) return invalid;
  const appId = c.req.param("appId") ?? "";
  await deleteAgcCredentials(c.env.DB, appId);
  await insertAuditLog(c.env.DB, c, { app_id: appId, action: "agc_credentials.delete", payload: {} });
  return c.json({ ok: true });
}
export async function handleVerifyAgcCredentials(c: AdminContext) {
  const invalid = await requireOhosApp(c); if (invalid) return invalid;
  if (!c.env.AGC_CRED_ENC_KEY) return c.json({ error: "server is missing AGC_CRED_ENC_KEY" }, 500);
  const appId = c.req.param("appId") ?? "";
  const credential = await getAgcCredentials(c.env.DB, c.env.AGC_CRED_ENC_KEY, appId);
  if (!credential) return c.json({ error: "no AGC credentials configured for this app" }, 404);
  try {
    const kind = agcCredentialKind(credential);
    if (kind === "service_account") {
      const service = credential as AgcServiceAccountCredential;
      await createAgcServiceAccountJwt(service);
      await insertAuditLog(c.env.DB, c, { app_id: appId, action: "agc_credentials.verify", payload: { credential_kind: kind, ok: true } });
      return c.json({ ok: true, credential_kind: kind, project_id: service.project_id ?? null, key_id: service.key_id, sub_account: service.sub_account, expires_in: 3600 });
    }
    const api = credential as AgcApiClientCredential;
    const token = await exchangeAgcApiClientToken(api);
    await insertAuditLog(c.env.DB, c, { app_id: appId, action: "agc_credentials.verify", payload: { credential_kind: kind, ok: true } });
    return c.json({ ok: true, credential_kind: kind, developer_id: api.developer_id, project_id: api.project_id, client_id: api.client_id, region: api.region ?? null, expires_in: token.expires_in });
  } catch (e) {
    await insertAuditLog(c.env.DB, c, { app_id: appId, action: "agc_credentials.verify", payload: { credential_kind: agcCredentialKind(credential), ok: false } });
    if (e instanceof AgcApiError) return c.json({ ok: false, error: e.message, status: e.status }, 502);
    throw e;
  }
}
