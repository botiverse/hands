import { importPKCS8, SignJWT } from "jose";
import type { AgcApiClientCredential, AgcServiceAccountCredential } from "./agc_credentials";

export class AgcApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export async function exchangeAgcApiClientToken(credential: AgcApiClientCredential, fetchImpl: typeof fetch = fetch) {
  const response = await fetchImpl("https://connect-api.cloud.huawei.com/api/oauth2/v1/token", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_id: credential.client_id, client_secret: credential.client_secret, grant_type: "client_credentials" }),
  });
  let body: unknown;
  try { body = await response.json(); } catch { body = null; }
  if (!response.ok) throw new AgcApiError(response.status, "AGC rejected the API client credentials");
  const obj = body as Record<string, unknown> | null;
  if (!obj || typeof obj.access_token !== "string" || !obj.access_token || typeof obj.expires_in !== "number") {
    throw new AgcApiError(502, "AGC returned a malformed token response");
  }
  return { access_token: obj.access_token, expires_in: obj.expires_in };
}

export async function createAgcServiceAccountJwt(credential: AgcServiceAccountCredential, nowSeconds = Math.floor(Date.now() / 1000)) {
  const key = await importPKCS8(credential.private_key, "PS256");
  return new SignJWT({})
    .setProtectedHeader({ alg: "PS256", typ: "JWT", kid: credential.key_id })
    .setIssuer(credential.sub_account)
    .setAudience("https://oauth-login.cloud.huawei.com/oauth2/v3/token")
    .setIssuedAt(nowSeconds)
    .setExpirationTime(nowSeconds + 3600)
    .sign(key);
}

export type AgcAuth = { clientId?: string; accessToken: string };
async function agcJson(auth: AgcAuth, path: string, init: RequestInit = {}, fetchImpl: typeof fetch = fetch) {
  const response = await fetchImpl(`https://connect-api.cloud.huawei.com${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(auth.clientId ? { client_id: auth.clientId } : {}), authorization: `Bearer ${auth.accessToken}`, ...(init.headers ?? {}) },
  });
  const body = await response.json().catch(() => null) as any;
  const providerCode = body?.ret?.code ?? body?.rtnCode;
  if (!response.ok || (providerCode !== undefined && String(providerCode) !== "0")) {
    const providerMessage = body?.ret?.msg || body?.rtnDesc || body?.error_description || body?.error;
    const suffix = providerCode !== undefined ? `, code ${String(providerCode)}` : "";
    throw new AgcApiError(response.status, `${providerMessage || "AGC API request failed"} (HTTP ${response.status}${suffix})`);
  }
  return body;
}
export async function resolveAgcAppId(auth: AgcAuth, packageName: string, fetchImpl: typeof fetch = fetch) {
  const body = await agcJson(auth, `/api/publish/v2/appid-list?packageName=${encodeURIComponent(packageName)}&packageTypes=7`, {}, fetchImpl);
  const match = body?.appids?.find((item: any) => item?.key === packageName) ?? body?.appids?.[0];
  if (!match?.value) throw new AgcApiError(404, `No AGC app found for package ${packageName}`);
  return String(match.value);
}
export async function createAgcInvitationVersion(auth: AgcAuth, appId: string, description: string, selfDetect: boolean, fetchImpl: typeof fetch = fetch) {
  const body = await agcJson(auth, `/api/publish/v2/test/app/version?appId=${encodeURIComponent(appId)}`, { method: "POST", body: JSON.stringify({ releaseType: 6, testType: 3, testDesc: description.slice(0, 50), onshelfSelfDetect: selfDetect ? 1 : 0 }) }, fetchImpl);
  if (!body?.versionId) throw new AgcApiError(502, "AGC did not return a test version id");
  return String(body.versionId);
}
export async function requestAgcUpload(auth: AgcAuth, appId: string, fileName: string, sha256: string, size: number, fetchImpl: typeof fetch = fetch) {
  const query = new URLSearchParams({ appId, fileName, sha256, contentLength: String(size) });
  const body = await agcJson(auth, `/api/publish/v2/upload-url/for-obs?${query}`, {}, fetchImpl);
  if (!body?.urlInfo?.url || !body?.urlInfo?.objectId) throw new AgcApiError(502, "AGC did not return an upload URL");
  return body.urlInfo as { objectId: string; url: string; method: string; headers?: Record<string, string> };
}
export async function uploadAgcObject(info: { url: string; headers?: Record<string, string> }, body: BodyInit, fetchImpl: typeof fetch = fetch) {
  const response = await fetchImpl(info.url, { method: "PUT", headers: info.headers ?? {}, body });
  if (!response.ok) throw new AgcApiError(response.status, "AGC package upload failed");
}
export async function addAgcTestPackage(auth: AgcAuth, appId: string, fileName: string, objectId: string, fetchImpl: typeof fetch = fetch) {
  const body = await agcJson(auth, `/api/publish/v2/test/version/pkg?appId=${encodeURIComponent(appId)}`, { method: "POST", body: JSON.stringify({ distributeMode: 1, file: { fileName, objectId } }) }, fetchImpl);
  const packageId = body?.pkgVersion?.[0];
  if (!packageId) throw new AgcApiError(502, "AGC did not return a package id");
  return String(packageId);
}
export async function getAgcCompileStatus(auth: AgcAuth, appId: string, packageId: string, fetchImpl: typeof fetch = fetch) {
  const body = await agcJson(auth, `/api/publish/v3/package/compile/status?appId=${encodeURIComponent(appId)}&pkgIds=${encodeURIComponent(packageId)}`, {}, fetchImpl);
  return body?.pkgStateList?.[0] ?? null;
}
export async function bindAgcTestPackage(auth: AgcAuth, appId: string, versionId: string, packageId: string, fetchImpl: typeof fetch = fetch) {
  await agcJson(auth, `/api/publish/v2/test/app/version?appId=${encodeURIComponent(appId)}`, { method: "PUT", body: JSON.stringify({ versionId, pkgId: packageId }) }, fetchImpl);
}
export async function submitAgcTestVersion(auth: AgcAuth, appId: string, versionId: string, fetchImpl: typeof fetch = fetch) {
  await agcJson(auth, `/api/publish/v2/test/app/version/submit?appId=${encodeURIComponent(appId)}`, { method: "POST", body: JSON.stringify({ versionId }) }, fetchImpl);
}
