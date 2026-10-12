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
export type AgcReviewStatus = {
  release_state: number | null;
  audit_opinion: string | null;
  copyright_audit_result: string | null;
  copyright_audit_opinion: string | null;
  copyright_code_audit_result: string | null;
  copyright_code_audit_opinion: string | null;
  record_audit_result: string | null;
  record_audit_opinion: string | null;
};

/**
 * Read-only listing-review status for an AGC app. `releaseType` selects the
 * lifecycle AGC reports on (1 = the on-sale/listing lane; the invitation-test
 * lane this file otherwise drives uses 6). Returns the raw provider values
 * without interpretation: AGC's enums are provider-owned and are surfaced as
 * received so an unexpected value is visible rather than silently remapped.
 */
export async function getAgcReviewStatus(
  auth: AgcAuth,
  appId: string,
  releaseType = 1,
  fetchImpl: typeof fetch = fetch,
): Promise<AgcReviewStatus> {
  const body = await agcJson(
    auth,
    `/api/publish/v2/app-info?appId=${encodeURIComponent(appId)}&releaseType=${encodeURIComponent(String(releaseType))}`,
    {},
    fetchImpl,
  );
  const appInfo = body?.appInfo ?? null;
  const auditInfo = body?.auditInfo ?? null;
  const text = (value: unknown): string | null => {
    if (typeof value === "string") return value.trim() ? value : null;
    if (typeof value === "number") return String(value);
    return null;
  };
  // Number(null) is 0 and Number("") is 0, so coercing first would report a
  // missing state as provider enum 0 — inventing a value the provider never
  // sent. Absent stays absent; the enum itself is passed through unmapped, and
  // a non-numeric value is reported as absent rather than silently reshaped.
  const enumValue = (value: unknown): number | null => {
    if (typeof value === "number") return Number.isFinite(value) ? value : null;
    if (typeof value === "string" && value.trim() !== "") {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
  };
  return {
    release_state: enumValue(appInfo?.releaseState),
    audit_opinion: text(auditInfo?.auditOpinion),
    copyright_audit_result: text(auditInfo?.copyRightAuditResult),
    copyright_audit_opinion: text(auditInfo?.copyRightAuditOpinion),
    copyright_code_audit_result: text(auditInfo?.copyRightCodeAuditResult),
    copyright_code_audit_opinion: text(auditInfo?.copyRightCodeAuditOpinion),
    record_audit_result: text(auditInfo?.recordAuditResult),
    record_audit_opinion: text(auditInfo?.recordAuditOpinion),
  };
}

export type AgcTestVersionStatus = {
  release_state: number | null;
  audit_opinion: string | null;
  open_test_info: { start_time: number | null; end_time: number | null } | null;
  /**
   * Version identity Huawei echoed for the queried version, or null when the
   * response named none. `version_number` is the human version (e.g. 1.13.0);
   * `identity_keys` lists which `appInfo` keys mentioning "version" were
   * present (names only) so an unexpected response shape is diagnosable
   * without storing the whole provider payload.
   */
  version_number: string | null;
  version_id: string | null;
  app_id: string | null;
  release_type: number | null;
  update_time: string | null;
  identity_keys: string[];
};

/**
 * Read-only status of one HarmonyOS test version (invitation/public testing).
 * Huawei's Testing API has no dedicated "query test version" call; the
 * documented way is the Publishing app-info query with `releaseType=6`, where
 * `versionId` becomes mandatory. The provider enum is returned unmapped;
 * `mapAgcTestReleaseState` is the only place that interprets it.
 */
export async function getAgcTestVersionStatus(
  auth: AgcAuth,
  appId: string,
  versionId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<AgcTestVersionStatus> {
  const query = new URLSearchParams({ appId, releaseType: "6", versionId });
  const body = await agcJson(auth, `/api/publish/v3/app-info?${query}`, {}, fetchImpl);
  const releaseState = body?.appInfo?.releaseState;
  const numeric = typeof releaseState === "number"
    ? releaseState
    : typeof releaseState === "string" && releaseState.trim() !== "" ? Number(releaseState) : NaN;
  const opinion = body?.auditInfo?.auditOpinion;
  const openTest = body?.openTestInfo;
  const ms = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : null);
  const appInfo = body?.appInfo && typeof body.appInfo === "object" ? body.appInfo as Record<string, unknown> : {};
  const text = (value: unknown): string | null => {
    if (typeof value === "string") return value.trim() ? value.trim() : null;
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
    return null;
  };
  const releaseTypeRaw = appInfo.releaseType;
  const releaseType = typeof releaseTypeRaw === "number" ? releaseTypeRaw
    : typeof releaseTypeRaw === "string" && releaseTypeRaw.trim() !== "" ? Number(releaseTypeRaw) : NaN;
  return {
    release_state: Number.isFinite(numeric) ? numeric : null,
    audit_opinion: typeof opinion === "string" && opinion.trim() ? opinion : null,
    open_test_info: openTest ? { start_time: ms(openTest.startTime), end_time: ms(openTest.endTime) } : null,
    version_number: text(appInfo.versionNumber),
    version_id: text(appInfo.versionId ?? body?.versionId),
    app_id: text(appInfo.appId ?? body?.appId),
    release_type: Number.isFinite(releaseType) ? releaseType : null,
    update_time: text(appInfo.updateTime),
    identity_keys: Object.keys(appInfo).filter((key) => /version/iu.test(key)).sort(),
  };
}

export type AgcTestVersionExpectation = { version_name: string | null; version_id?: string | null; app_id?: string | null };

export type AgcTestVersionAssessment = {
  /** Next Hands state when the provider reading is confirmed to be about this version, else null. */
  next: string | null;
  /** "confirmed" only when every reason check passed; the snapshot records the rest verbatim. */
  identity_status: "confirmed" | "unconfirmed";
  identity_reasons: string[];
};

/**
 * Decide whether a releaseType=6 reading may move a Hands submission.
 *
 * Field case (2026-10-11, #proj-mobile-release:fa1a72f8): the test-lane query
 * for build 11301004 returned `releaseState=0` with the listing-review opinion
 * "应用上架审核通过" while the console still showed the invitation test under
 * review. Reading `releaseState` alone therefore advanced the submission to
 * `testing_active` on a response that may describe another version or another
 * lane. This stays fail-closed: a transition needs the response to name the
 * version Hands asked about, and the opinion must not read as the listing
 * (上架) lane. Anything else keeps the current state and records why.
 */
export function assessAgcTestVersionStatus(
  remote: AgcTestVersionStatus,
  expected: AgcTestVersionExpectation,
): AgcTestVersionAssessment {
  const reasons: string[] = [];
  const expectedVersion = expected.version_name?.trim() || null;
  const expectedVersionId = expected.version_id?.trim() || null;
  const expectedAppId = expected.app_id?.trim() || null;
  // Identity: the echoed versionId (the id Hands queried with) is the strongest
  // proof; the human version number against the build is the fallback. Either
  // one matching confirms; any present field that contradicts us rejects.
  if (remote.version_id !== null && expectedVersionId !== null && remote.version_id !== expectedVersionId) reasons.push("version_id_mismatch");
  if (remote.app_id !== null && expectedAppId !== null && remote.app_id !== expectedAppId) reasons.push("app_id_mismatch");
  const versionIdConfirms = remote.version_id !== null && expectedVersionId !== null && remote.version_id === expectedVersionId;
  if (!versionIdConfirms) {
    if (remote.version_number === null) reasons.push("no_version_identity_in_response");
    else if (expectedVersion === null) reasons.push("no_expected_version_on_build");
    else if (remote.version_number !== expectedVersion) reasons.push("version_mismatch");
  }
  if (remote.release_type !== null && remote.release_type !== 6) reasons.push("response_release_type_not_test_lane");
  if (remote.audit_opinion && /上架|listing/iu.test(remote.audit_opinion)) reasons.push("listing_review_opinion_in_test_lane");
  const mapped = mapAgcTestReleaseState(remote.release_state);
  if (reasons.length > 0) return { next: null, identity_status: "unconfirmed", identity_reasons: reasons };
  return { next: mapped, identity_status: "confirmed", identity_reasons: [] };
}

/** The version Hands expects Huawei to echo for this submission's build. */
export async function loadAgcBuildExpectation(
  db: D1Database,
  sub: { build_id: string; app_id: string; external_app_id: string | null; external_version_id: string | null },
): Promise<AgcTestVersionExpectation> {
  const build = await db.prepare("SELECT version_name FROM builds WHERE id=?1 AND app_id=?2")
    .bind(sub.build_id, sub.app_id).first<{ version_name: string | null }>().catch(() => null);
  return { version_name: build?.version_name ?? null, version_id: sub.external_version_id, app_id: sub.external_app_id };
}

/** Provider snapshot fields shared by the poll loop and the admin refresh route. */
export function agcTestVersionSnapshot(remote: AgcTestVersionStatus, assessment: AgcTestVersionAssessment, syncedAt: number) {
  return {
    release_state: remote.release_state,
    audit_opinion: remote.audit_opinion,
    open_test_info: remote.open_test_info,
    version_number: remote.version_number,
    response_version_id: remote.version_id,
    response_app_id: remote.app_id,
    response_release_type: remote.release_type,
    response_update_time: remote.update_time,
    response_identity_keys: remote.identity_keys,
    identity_status: assessment.identity_status,
    identity_reasons: assessment.identity_reasons,
    synced_at: syncedAt,
  };
}

/**
 * Huawei test-release `releaseState` (releaseType=6) → Hands submission state.
 * Source: AppInfo data model, "releaseType 为6时" table.
 *   0 正在测试 → testing_active      1 审核不通过 → rejected
 *   2 已失效（运营停止）→ stopped     3 待生效 → testing_scheduled
 *   4 正在审核 / 12 预审中 → testing_review
 *   7 准备提交 → ready (submit did not take; can be resubmitted)
 *   10 已失效（开发者停止）→ stopped   11 撤销审核 → ready
 *   13 预审不通过 → rejected
 * Unknown values return null so the caller keeps its state and surfaces the
 * raw provider value instead of guessing.
 */
export function mapAgcTestReleaseState(releaseState: number | null): string | null {
  switch (releaseState) {
    case 0: return "testing_active";
    case 1: case 13: return "rejected";
    case 2: case 10: return "stopped";
    case 3: return "testing_scheduled";
    case 4: case 12: return "testing_review";
    case 7: case 11: return "ready";
    default: return null;
  }
}

/** PackageStates.successStatus: 0 normal, 1 parsing, 2 failed (unusable). */
export const AGC_PACKAGE_OK = 0;
export const AGC_PACKAGE_FAILED = 2;

/** Huawei invitation-test windows may not exceed 90 days. */
export const AGC_INVITATION_TEST_MAX_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * Huawei invite-test PUT example (`openTestInfo.testTaskInfo`):
 * `displayArea: "1"` = 测试专区, `needShareLink: 0`, `needNotify: 0`.
 * Submit 204144692 ("displayArea is necessary for invite test") is the live
 * proof that the whole TestTaskInfo object is required at submit, not just
 * startTime/endTime. Do not send groupInfos without a real groupId.
 */
export const AGC_INVITE_TEST_DISPLAY_AREA = "1";
export const AGC_INVITE_TEST_NEED_SHARE_LINK = 0;
export const AGC_INVITE_TEST_NEED_NOTIFY = 0;

export type AgcTestGroup = {
  groupId: string;
  groupName?: string;
  addedTestersNum?: number;
};

export async function listAgcTestGroups(auth: AgcAuth, appId: string, fetchImpl: typeof fetch = fetch): Promise<AgcTestGroup[]> {
  const body = await agcJson(auth, `/api/app-test/v1/test-group/list?current=1&pageSize=100`, {
    headers: { appId },
  }, fetchImpl);
  return (body?.groups ?? []) as AgcTestGroup[];
}

export function invitationTestWindow(now = Date.now(), groupIds: string[] = []) {
  return {
    startTime: now,
    endTime: now + AGC_INVITATION_TEST_MAX_MS - 60_000,
    testTaskInfo: {
      displayArea: AGC_INVITE_TEST_DISPLAY_AREA,
      needShareLink: AGC_INVITE_TEST_NEED_SHARE_LINK,
      needNotify: AGC_INVITE_TEST_NEED_NOTIFY,
      ...(groupIds.length > 0 ? { groupInfos: groupIds.map((groupId) => ({ groupId })) } : {}),
    },
  };
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
/** Huawei package API: distributeMode 2 places the package in AppGallery,
 * without creating a test version or submitting any review.
 * https://developer.huawei.com/consumer/cn/doc/app/agc-help-test-api-add-test-package-0000002236201330
 */
export async function addAgcMarketPackage(auth: AgcAuth, appId: string, fileName: string, objectId: string, fetchImpl: typeof fetch = fetch) {
  const body = await agcJson(auth, `/api/publish/v2/test/version/pkg?appId=${encodeURIComponent(appId)}`, {
    method: "POST", body: JSON.stringify({ distributeMode: 2, file: { fileName, objectId } }),
  }, fetchImpl);
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
export async function setAgcInvitationTestWindow(auth: AgcAuth, appId: string, versionId: string, fetchImpl: typeof fetch = fetch, now = Date.now(), groupIds: string[] = []) {
  const window = invitationTestWindow(now, groupIds);
  await agcJson(auth, `/api/publish/v2/test/app/version?appId=${encodeURIComponent(appId)}`, { method: "PUT", body: JSON.stringify({ versionId, openTestInfo: window }) }, fetchImpl);
  return window;
}

export async function submitAgcTestVersion(auth: AgcAuth, appId: string, versionId: string, fetchImpl: typeof fetch = fetch, now = Date.now(), groupIds: string[] = []) {
  await setAgcInvitationTestWindow(auth, appId, versionId, fetchImpl, now, groupIds);
  await agcJson(auth, `/api/publish/v2/test/app/version/submit?appId=${encodeURIComponent(appId)}`, { method: "POST", body: JSON.stringify({ versionId }) }, fetchImpl);
}
