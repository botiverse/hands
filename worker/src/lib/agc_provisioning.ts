/**
 * HarmonyOS (5 and later) app, certificate, profile and debug-device
 * management through AppGallery Connect's Connect API ("Provisioning API" and
 * the Publishing API's create-APP-ID), so Hands can manage HarmonyOS signing
 * the way it manages iOS signing. Every call accepts a service account or an
 * API client credential; what it may do is decided by the role the credential
 * was created with in the console.
 *
 * Endpoints (connect-api.cloud.huawei.com/api):
 *   POST /publish/v3/app         create an app (APP ID) for a package name
 *   POST /publish/v3/cert        issue a certificate for a CSR
 *   POST /publish/v3/provision   issue a profile for a certificate and app
 *   POST /publish/v2/device      register debug devices (by UDID)
 *   GET  /publish/v2/device/list list debug devices
 * Certificate and profile download URLs are valid for five minutes.
 */
import { agcJson, AgcApiError, type AgcAuth } from "./agc_api";

export const HARMONY_CERT_TYPES = { debug: 1, release: 2 } as const;
export type HarmonyCertKind = keyof typeof HARMONY_CERT_TYPES;
export const HARMONY_PROFILE_TYPES = { debug: 1, release: 2 } as const;

/** Device types AGC knows: 1 sports watch, 2 smart watch, 4 phone, 5 tablet, 8 smart screen, 19 PC/2-in-1. */
export const HARMONY_DEVICE_TYPES = [1, 2, 4, 5, 8, 19] as const;

export type HarmonyCertificate = { id: string; name: string; type: number; expires_at: number | null; download_url: string };
export type HarmonyProfile = {
  id: string; name: string; type: number; app_id: string | null; expires_at: number | null; download_url: string;
  device_ids: string[];
};
export type HarmonyDevice = { id: string; name: string; udid: string; type: number | null; created_at: string | null };

const str = (v: unknown) => (typeof v === "string" ? v : v === undefined || v === null ? null : String(v));
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v !== "" && Number.isFinite(Number(v)) ? Number(v) : null);

/** Creates the HarmonyOS app (not an atomic service) for a package name; returns AGC's app id. */
export async function createHarmonyApp(auth: AgcAuth, input: { appName: string; packageName: string; projectId?: string | null }, fetchImpl: typeof fetch = fetch) {
  const query = input.projectId ? `?projectId=${encodeURIComponent(input.projectId)}` : "";
  const body = await agcJson(auth, `/api/publish/v3/app${query}`, {
    method: "POST",
    body: JSON.stringify({ appName: input.appName, packageName: input.packageName, parentType: 13, installationFree: 0 }),
  }, fetchImpl);
  const appId = str(body?.appId);
  if (!appId) throw new AgcApiError(502, "AGC created no app id");
  return appId;
}

export async function issueHarmonyCertificate(auth: AgcAuth, input: { csrPem: string; name: string; kind: HarmonyCertKind }, fetchImpl: typeof fetch = fetch): Promise<HarmonyCertificate> {
  const body = await agcJson(auth, "/api/publish/v3/cert", {
    method: "POST",
    body: JSON.stringify({ csr: input.csrPem, certName: input.name.slice(0, 100), certType: HARMONY_CERT_TYPES[input.kind] }),
  }, fetchImpl);
  const info = body?.certInfo ?? {};
  const id = str(info.id);
  const url = str(info.certDownloadUrl);
  if (!id || !url) throw new AgcApiError(502, "AGC issued no certificate");
  return { id, name: str(info.certName) ?? input.name, type: num(info.certType) ?? HARMONY_CERT_TYPES[input.kind], expires_at: num(info.expireTime), download_url: url };
}

export async function issueHarmonyProfile(
  auth: AgcAuth,
  input: { name: string; kind: HarmonyCertKind; certId: string; appId: string; deviceIds?: string[] },
  fetchImpl: typeof fetch = fetch,
): Promise<HarmonyProfile> {
  if (input.kind === "debug" && !(input.deviceIds?.length)) throw new AgcApiError(400, "a debug profile needs at least one registered device");
  const body = await agcJson(auth, "/api/publish/v3/provision", {
    method: "POST",
    body: JSON.stringify({
      provisionName: input.name.slice(0, 256), provisionType: HARMONY_PROFILE_TYPES[input.kind], certId: input.certId, appId: input.appId,
      ...(input.deviceIds?.length ? { deviceIdList: input.deviceIds } : {}),
    }),
  }, fetchImpl);
  const info = body?.provisionInfo ?? {};
  const id = str(info.id);
  const url = str(info.provisionDownloadUrl);
  if (!id || !url) throw new AgcApiError(502, "AGC issued no profile");
  return {
    id, name: str(info.provisionName) ?? input.name, type: num(info.provisionType) ?? HARMONY_PROFILE_TYPES[input.kind],
    app_id: str(info.appId) ?? input.appId, expires_at: num(info.expireTime), download_url: url,
    device_ids: Array.isArray(info.deviceList) ? info.deviceList.map((d: Record<string, unknown>) => str(d.id)).filter(Boolean) as string[] : [],
  };
}

export async function addHarmonyDevices(auth: AgcAuth, devices: Array<{ name: string; udid: string; type: number }>, fetchImpl: typeof fetch = fetch) {
  const body = await agcJson(auth, "/api/publish/v2/device", {
    method: "POST",
    body: JSON.stringify({ deviceList: devices.map((d) => ({ deviceName: d.name, udid: d.udid, deviceType: d.type })) }),
  }, fetchImpl);
  return {
    added: num(body?.successedCount) ?? 0,
    failed: num(body?.failedCount) ?? 0,
    failures: Array.isArray(body?.failedAddDeviceDetail) ? body.failedAddDeviceDetail as unknown[] : [],
  };
}

export async function listHarmonyDevices(auth: AgcAuth, fetchImpl: typeof fetch = fetch): Promise<HarmonyDevice[]> {
  const out: HarmonyDevice[] = [];
  for (let page = 1; page <= 50; page++) {
    const body = await agcJson(auth, `/api/publish/v2/device/list?fromRecCount=${page}&maxReqCount=100&order=1`, {}, fetchImpl);
    const list = Array.isArray(body?.deviceList) ? body.deviceList as Record<string, unknown>[] : [];
    for (const d of list) {
      const id = str(d.id); const udid = str(d.udid);
      if (id && udid) out.push({ id, name: str(d.deviceName) ?? "", udid, type: num(d.deviceType), created_at: str(d.createTime) });
    }
    const total = num(body?.totalCount) ?? out.length;
    if (list.length === 0 || out.length >= total) break;
  }
  return out;
}

/** Downloads a certificate or profile from the short-lived URL AGC returned (never sent credentials). */
export async function downloadAgcFile(url: string, maxBytes = 256 * 1024, fetchImpl: typeof fetch = fetch): Promise<Uint8Array> {
  if (!/^https:\/\//.test(url)) throw new AgcApiError(502, "AGC returned a non-https download URL");
  const response = await fetchImpl(url, { redirect: "follow" });
  if (!response.ok) throw new AgcApiError(502, `AGC file download failed (HTTP ${response.status})`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength === 0 || bytes.byteLength > maxBytes) throw new AgcApiError(502, "AGC file download had an unexpected size");
  return bytes;
}

export async function listHarmonyCertificates(auth: AgcAuth, kind: HarmonyCertKind, fetchImpl: typeof fetch = fetch) {
  const body = await agcJson(auth, "/api/publish/v3/cert/list", { method: "POST", body: JSON.stringify({ certType: HARMONY_CERT_TYPES[kind] }) }, fetchImpl);
  const list = Array.isArray(body?.certInfo) ? body.certInfo as Record<string, unknown>[] : [];
  return list.map((c) => ({ id: str(c.id) ?? "", name: str(c.certName) ?? "", type: num(c.certType), created_at: num(c.createTime), expires_at: num(c.expireTime) }))
    .filter((c) => c.id);
}

/** Deletes certificates in AGC (frees the account's limited certificate slots). */
export async function deleteHarmonyCertificates(auth: AgcAuth, certIds: string[], fetchImpl: typeof fetch = fetch) {
  await agcJson(auth, "/api/publish/v2/cert/delete", { method: "POST", body: JSON.stringify({ certIds }) }, fetchImpl);
}
