/**
 * App Store Connect API client — JWT auth + the Build Upload flow
 * (WWDC25 API; replaces Transporter/altool for TestFlight delivery).
 *
 * Flow: resolve app by bundle id → POST /v1/buildUploads →
 * POST /v1/buildUploadFiles (returns per-part uploadOperations) →
 * PUT each part → PATCH the file uploaded:true → poll the buildUpload
 * state (AWAITING_UPLOAD → PROCESSING → COMPLETE | FAILED).
 */

export interface AscApiCredentials {
  key_id: string;
  issuer_id: string;
  /** PEM contents of the AuthKey_XXXX.p8 file. */
  p8: string;
}

export const ASC_API_BASE = "https://api.appstoreconnect.apple.com";

/** Max token lifetime Apple accepts is 20 minutes; stay under it. */
const JWT_TTL_SECONDS = 15 * 60;

function base64UrlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function pemToPkcs8(pem: string): Uint8Array {
  const body = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\s+/g, "");
  const bin = atob(body);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/**
 * Sign an App Store Connect API JWT (ES256). WebCrypto's ECDSA output is
 * already the raw r||s form JWTs use, so no DER re-encoding is needed.
 */
export async function createAscJwt(
  creds: AscApiCredentials,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToPkcs8(creds.p8),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  const encoder = new TextEncoder();
  const header = base64UrlEncode(
    encoder.encode(
      JSON.stringify({ alg: "ES256", kid: creds.key_id, typ: "JWT" }),
    ),
  );
  const payload = base64UrlEncode(
    encoder.encode(
      JSON.stringify({
        iss: creds.issuer_id,
        iat: nowSeconds,
        exp: nowSeconds + JWT_TTL_SECONDS,
        aud: "appstoreconnect-v1",
      }),
    ),
  );
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    encoder.encode(`${header}.${payload}`),
  );
  return `${header}.${payload}.${base64UrlEncode(new Uint8Array(signature))}`;
}

export class AscApiError extends Error {
  status: number;
  detail: string | null;
  constructor(status: number, message: string, detail: string | null = null) {
    super(message);
    this.status = status;
    this.detail = detail;
  }
}

/**
 * Authenticated JSON request against the ASC API. Throws AscApiError with
 * Apple's error detail (their errors array carries title/detail per item).
 */
export async function ascRequest<T>(
  creds: AscApiCredentials,
  method: string,
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const jwt = await createAscJwt(creds);
  const res = await fetch(`${ASC_API_BASE}${path}`, {
    method,
    ...(signal ? { signal } : {}),
    headers: {
      authorization: `Bearer ${jwt}`,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    // non-JSON error body; keep raw text as detail below
  }
  if (!res.ok) {
    const errors = (parsed as { errors?: Array<{ title?: string; detail?: string }> })
      ?.errors;
    const first = errors?.[0];
    throw new AscApiError(
      res.status,
      first?.title ?? `App Store Connect API ${method} ${path} failed (${res.status})`,
      first?.detail ?? (parsed ? null : text.slice(0, 500) || null),
    );
  }
  return parsed as T;
}

// ---------- Build Upload resources ----------

export interface UploadOperationHeader {
  name: string;
  value: string;
}

export interface UploadOperation {
  url: string;
  method: string;
  offset: number;
  length: number;
  requestHeaders: UploadOperationHeader[];
}

export type BuildUploadState =
  | "AWAITING_UPLOAD"
  | "PROCESSING"
  | "FAILED"
  | "COMPLETE";

export interface BuildUploadStateInfo {
  state: BuildUploadState | null;
  errors?: Array<{ code?: string; description?: string }>;
  warnings?: Array<{ code?: string; description?: string }>;
  infos?: Array<{ code?: string; description?: string }>;
}

export interface BuildUploadResource {
  id: string;
  attributes: {
    cfBundleShortVersionString: string | null;
    cfBundleVersion: string | null;
    platform: string | null;
    state: BuildUploadStateInfo | null;
    createdDate: string | null;
    uploadedDate: string | null;
  };
}

export interface BuildUploadFileResource {
  id: string;
  attributes: {
    fileName: string | null;
    fileSize: number | null;
    uploadOperations: UploadOperation[] | null;
    assetDeliveryState: unknown;
  };
}

/** Look up the ASC app id for a bundle id (e.g. "build.raft.app"). */
export async function resolveAscAppId(
  creds: AscApiCredentials,
  bundleId: string,
): Promise<string | null> {
  const res = await ascRequest<{ data: Array<{ id: string }> }>(
    creds,
    "GET",
    `/v1/apps?filter[bundleId]=${encodeURIComponent(bundleId)}&limit=1`,
  );
  return res.data[0]?.id ?? null;
}

export async function createBuildUpload(
  creds: AscApiCredentials,
  args: {
    ascAppId: string;
    /** Marketing version, e.g. "1.2.0". */
    version: string;
    /** Build number, e.g. "1020000". */
    buildNumber: string;
    platform?: "IOS" | "MAC_OS" | "TV_OS" | "VISION_OS";
  },
): Promise<BuildUploadResource> {
  const res = await ascRequest<{ data: BuildUploadResource }>(
    creds,
    "POST",
    "/v1/buildUploads",
    {
      data: {
        type: "buildUploads",
        attributes: {
          cfBundleShortVersionString: args.version,
          cfBundleVersion: args.buildNumber,
          platform: args.platform ?? "IOS",
        },
        relationships: {
          app: { data: { type: "apps", id: args.ascAppId } },
        },
      },
    },
  );
  return res.data;
}

export async function createBuildUploadFile(
  creds: AscApiCredentials,
  args: { buildUploadId: string; fileName: string; fileSize: number },
): Promise<BuildUploadFileResource> {
  const res = await ascRequest<{ data: BuildUploadFileResource }>(
    creds,
    "POST",
    "/v1/buildUploadFiles",
    {
      data: {
        type: "buildUploadFiles",
        attributes: {
          assetType: "ASSET",
          fileName: args.fileName,
          fileSize: args.fileSize,
          uti: "com.apple.ipa",
        },
        relationships: {
          buildUpload: {
            data: { type: "buildUploads", id: args.buildUploadId },
          },
        },
      },
    },
  );
  return res.data;
}

/** Tell Apple every part is uploaded so processing can start. */
export async function commitBuildUploadFile(
  creds: AscApiCredentials,
  args: { fileId: string; sha256?: string | undefined },
): Promise<void> {
  await ascRequest(creds, "PATCH", `/v1/buildUploadFiles/${args.fileId}`, {
    data: {
      type: "buildUploadFiles",
      id: args.fileId,
      attributes: {
        uploaded: true,
        ...(args.sha256
          ? {
              sourceFileChecksums: {
                file: { algorithm: "SHA_256", hash: args.sha256 },
              },
            }
          : {}),
      },
    },
  });
}

export async function getBuildUpload(
  creds: AscApiCredentials,
  buildUploadId: string,
): Promise<BuildUploadResource> {
  const res = await ascRequest<{ data: BuildUploadResource }>(
    creds,
    "GET",
    `/v1/buildUploads/${buildUploadId}`,
  );
  return res.data;
}

// ---------- TestFlight distribution resources ----------

export type AscBuildProcessingState =
  | "PROCESSING"
  | "FAILED"
  | "INVALID"
  | "VALID";

export interface AscBuildResource {
  id: string;
  attributes: {
    version: string | null;
    uploadedDate: string | null;
    expirationDate: string | null;
    expired: boolean | null;
    processingState: AscBuildProcessingState | string | null;
    buildAudienceType?:
      | "INTERNAL_ONLY"
      | "APP_STORE_ELIGIBLE"
      | string
      | null;
  };
  relationships?: {
    betaGroups?: {
      data?: Array<{ type: "betaGroups"; id: string }>;
    };
  };
}

export interface BetaGroupResource {
  id: string;
  attributes: {
    name: string | null;
    createdDate: string | null;
    isInternalGroup: boolean | null;
    hasAccessToAllBuilds: boolean | null;
    publicLinkEnabled: boolean | null;
    publicLink: string | null;
  };
}

export interface BetaBuildLocalizationResource {
  id: string;
  attributes: {
    locale: string | null;
    whatsNew: string | null;
  };
}

export interface BetaAppLocalizationResource {
  id: string;
  attributes: {
    locale: string | null;
    description: string | null;
  };
}

export interface BetaAppReviewSubmissionResource {
  id: string;
  attributes: {
    betaReviewState: string | null;
    submittedDate: string | null;
  };
}

export interface BuildBetaDetailResource {
  id: string;
  attributes: {
    autoNotifyEnabled: boolean | null;
    internalBuildState: string | null;
    externalBuildState: string | null;
  };
}

/** Resolve the processed ASC build matching one exact Hands version tuple. */
export async function resolveAscBuild(
  creds: AscApiCredentials,
  args: {
    ascAppId: string;
    version: string;
    buildNumber: string;
    platform?: "IOS" | "MAC_OS" | "TV_OS" | "VISION_OS";
  },
): Promise<AscBuildResource | null> {
  const query = [
    `filter[app]=${encodeURIComponent(args.ascAppId)}`,
    `filter[version]=${encodeURIComponent(args.buildNumber)}`,
    `filter[preReleaseVersion.version]=${encodeURIComponent(args.version)}`,
    `filter[preReleaseVersion.platform]=${encodeURIComponent(args.platform ?? "IOS")}`,
    "limit=2",
  ].join("&");
  const res = await ascRequest<{ data: AscBuildResource[] }>(
    creds,
    "GET",
    `/v1/builds?${query}`,
  );
  if ((res.data ?? []).length > 1) {
    throw new Error(
      `multiple App Store Connect builds matched ${args.version} (${args.buildNumber})`,
    );
  }
  return res.data?.[0] ?? null;
}

/**
 * Mark one exact processed build as expired in TestFlight.
 *
 * App Store Connect keeps the build record for audit/history; setting
 * `expired=true` only removes its TestFlight availability. This endpoint does
 * not mutate an App Store production version.
 */
export async function expireAscBuild(
  creds: AscApiCredentials,
  ascBuildId: string,
): Promise<AscBuildResource> {
  const res = await ascRequest<{ data: AscBuildResource }>(
    creds,
    "PATCH",
    `/v1/builds/${encodeURIComponent(ascBuildId)}`,
    {
      data: {
        type: "builds",
        id: ascBuildId,
        attributes: { expired: true },
      },
    },
  );
  return res.data;
}

export async function listBetaGroups(
  creds: AscApiCredentials,
  ascAppId: string,
): Promise<BetaGroupResource[]> {
  const res = await ascRequest<{ data: BetaGroupResource[] }>(
    creds,
    "GET",
    `/v1/apps/${encodeURIComponent(ascAppId)}/betaGroups?limit=200`,
  );
  return res.data ?? [];
}

export async function getAssignedBetaGroupIds(
  creds: AscApiCredentials,
  ascBuildId: string,
): Promise<string[]> {
  const res = await ascRequest<{
    data: AscBuildResource;
    included?: Array<{ type?: string; id?: string }>;
  }>(
    creds,
    "GET",
    `/v1/builds/${encodeURIComponent(ascBuildId)}?include=betaGroups&limit[betaGroups]=50`,
  );
  const relationshipIds =
    res.data.relationships?.betaGroups?.data?.map((item) => item.id) ?? [];
  const includedIds = (res.included ?? [])
    .filter((item) => item.type === "betaGroups" && typeof item.id === "string")
    .map((item) => item.id!);
  return Array.from(new Set([...relationshipIds, ...includedIds]));
}

export async function addBuildToBetaGroups(
  creds: AscApiCredentials,
  ascBuildId: string,
  groupIds: string[],
): Promise<void> {
  if (groupIds.length === 0) return;
  await ascRequest(
    creds,
    "POST",
    `/v1/builds/${encodeURIComponent(ascBuildId)}/relationships/betaGroups`,
    {
      data: groupIds.map((id) => ({ type: "betaGroups", id })),
    },
  );
}

export async function getBetaBuildLocalizations(
  creds: AscApiCredentials,
  ascBuildId: string,
): Promise<BetaBuildLocalizationResource[]> {
  const res = await ascRequest<{ data: BetaBuildLocalizationResource[] }>(
    creds,
    "GET",
    `/v1/builds/${encodeURIComponent(ascBuildId)}/betaBuildLocalizations?limit=200`,
  );
  return res.data ?? [];
}

export async function createBetaBuildLocalization(
  creds: AscApiCredentials,
  args: { ascBuildId: string; locale: string; whatsNew: string },
): Promise<BetaBuildLocalizationResource> {
  const res = await ascRequest<{ data: BetaBuildLocalizationResource }>(
    creds,
    "POST",
    "/v1/betaBuildLocalizations",
    {
      data: {
        type: "betaBuildLocalizations",
        attributes: {
          locale: args.locale,
          whatsNew: args.whatsNew,
        },
        relationships: {
          build: { data: { type: "builds", id: args.ascBuildId } },
        },
      },
    },
  );
  return res.data;
}

export async function updateBetaBuildLocalization(
  creds: AscApiCredentials,
  args: { localizationId: string; whatsNew: string },
): Promise<BetaBuildLocalizationResource> {
  const res = await ascRequest<{ data: BetaBuildLocalizationResource }>(
    creds,
    "PATCH",
    `/v1/betaBuildLocalizations/${encodeURIComponent(args.localizationId)}`,
    {
      data: {
        type: "betaBuildLocalizations",
        id: args.localizationId,
        attributes: { whatsNew: args.whatsNew },
      },
    },
  );
  return res.data;
}

/** Create or update every supplied locale without touching other locales. */
export async function upsertBetaBuildLocalizations(
  creds: AscApiCredentials,
  ascBuildId: string,
  localizations: Record<string, string>,
): Promise<BetaBuildLocalizationResource[]> {
  const requested = Object.entries(localizations);
  if (requested.length === 0) return [];
  const existing = await getBetaBuildLocalizations(creds, ascBuildId);
  const byLocale = new Map(
    existing
      .filter((item) => item.attributes.locale)
      .map((item) => [item.attributes.locale!, item]),
  );
  const results: BetaBuildLocalizationResource[] = [];
  for (const [locale, whatsNew] of requested) {
    const current = byLocale.get(locale);
    if (!current) {
      try {
        results.push(
          await createBetaBuildLocalization(creds, {
            ascBuildId,
            locale,
            whatsNew,
          }),
        );
      } catch (error) {
        if (!(error instanceof AscApiError) || error.status !== 409) {
          throw error;
        }
        const raced = (await getBetaBuildLocalizations(creds, ascBuildId)).find(
          (item) => item.attributes.locale === locale,
        );
        if (!raced) throw error;
        results.push(
          raced.attributes.whatsNew === whatsNew
            ? raced
            : await updateBetaBuildLocalization(creds, {
                localizationId: raced.id,
                whatsNew,
              }),
        );
      }
    } else if (current.attributes.whatsNew !== whatsNew) {
      results.push(
        await updateBetaBuildLocalization(creds, {
          localizationId: current.id,
          whatsNew,
        }),
      );
    } else {
      results.push(current);
    }
  }
  return results;
}

export async function getBetaAppLocalizations(
  creds: AscApiCredentials,
  ascAppId: string,
): Promise<BetaAppLocalizationResource[]> {
  const res = await ascRequest<{ data: BetaAppLocalizationResource[] }>(
    creds,
    "GET",
    `/v1/apps/${encodeURIComponent(ascAppId)}/betaAppLocalizations?limit=200`,
  );
  return res.data ?? [];
}

export async function createBetaAppLocalization(
  creds: AscApiCredentials,
  args: { ascAppId: string; locale: string; description: string },
): Promise<BetaAppLocalizationResource> {
  const res = await ascRequest<{ data: BetaAppLocalizationResource }>(
    creds,
    "POST",
    "/v1/betaAppLocalizations",
    {
      data: {
        type: "betaAppLocalizations",
        attributes: {
          locale: args.locale,
          description: args.description,
        },
        relationships: {
          app: { data: { type: "apps", id: args.ascAppId } },
        },
      },
    },
  );
  return res.data;
}

export async function updateBetaAppLocalization(
  creds: AscApiCredentials,
  args: { localizationId: string; description: string },
): Promise<BetaAppLocalizationResource> {
  const res = await ascRequest<{ data: BetaAppLocalizationResource }>(
    creds,
    "PATCH",
    `/v1/betaAppLocalizations/${encodeURIComponent(args.localizationId)}`,
    {
      data: {
        type: "betaAppLocalizations",
        id: args.localizationId,
        attributes: { description: args.description },
      },
    },
  );
  return res.data;
}

/** Create or update supplied app-level descriptions without touching other locales. */
export async function upsertBetaAppLocalizations(
  creds: AscApiCredentials,
  ascAppId: string,
  descriptions: Record<string, string>,
): Promise<BetaAppLocalizationResource[]> {
  const requested = Object.entries(descriptions);
  if (requested.length === 0) return [];
  const existing = await getBetaAppLocalizations(creds, ascAppId);
  const byLocale = new Map(
    existing
      .filter((item) => item.attributes.locale)
      .map((item) => [item.attributes.locale!, item]),
  );
  const results: BetaAppLocalizationResource[] = [];
  for (const [locale, description] of requested) {
    const current = byLocale.get(locale);
    if (!current) {
      try {
        results.push(
          await createBetaAppLocalization(creds, {
            ascAppId,
            locale,
            description,
          }),
        );
      } catch (error) {
        if (!(error instanceof AscApiError) || error.status !== 409) throw error;
        const raced = (await getBetaAppLocalizations(creds, ascAppId)).find(
          (item) => item.attributes.locale === locale,
        );
        if (!raced) throw error;
        results.push(
          raced.attributes.description === description
            ? raced
            : await updateBetaAppLocalization(creds, {
                localizationId: raced.id,
                description,
              }),
        );
      }
    } else if (current.attributes.description !== description) {
      results.push(
        await updateBetaAppLocalization(creds, {
          localizationId: current.id,
          description,
        }),
      );
    } else {
      results.push(current);
    }
  }
  return results;
}

export async function getBetaAppReviewSubmission(
  creds: AscApiCredentials,
  ascBuildId: string,
): Promise<BetaAppReviewSubmissionResource | null> {
  try {
    const res = await ascRequest<{
      data: BetaAppReviewSubmissionResource | null;
    }>(
      creds,
      "GET",
      `/v1/builds/${encodeURIComponent(ascBuildId)}/betaAppReviewSubmission`,
    );
    return res.data ?? null;
  } catch (error) {
    if (error instanceof AscApiError && error.status === 404) return null;
    throw error;
  }
}

export async function createBetaAppReviewSubmission(
  creds: AscApiCredentials,
  ascBuildId: string,
): Promise<BetaAppReviewSubmissionResource> {
  const res = await ascRequest<{ data: BetaAppReviewSubmissionResource }>(
    creds,
    "POST",
    "/v1/betaAppReviewSubmissions",
    {
      data: {
        type: "betaAppReviewSubmissions",
        relationships: {
          build: { data: { type: "builds", id: ascBuildId } },
        },
      },
    },
  );
  return res.data;
}

export async function getBuildBetaDetail(
  creds: AscApiCredentials,
  ascBuildId: string,
): Promise<BuildBetaDetailResource> {
  const res = await ascRequest<{ data: BuildBetaDetailResource }>(
    creds,
    "GET",
    `/v1/builds/${encodeURIComponent(ascBuildId)}/buildBetaDetail`,
  );
  return res.data;
}

export async function updateBuildBetaAutoNotify(
  creds: AscApiCredentials,
  args: { buildBetaDetailId: string; enabled: boolean },
): Promise<BuildBetaDetailResource> {
  const res = await ascRequest<{ data: BuildBetaDetailResource }>(
    creds,
    "PATCH",
    `/v1/buildBetaDetails/${encodeURIComponent(args.buildBetaDetailId)}`,
    {
      data: {
        type: "buildBetaDetails",
        id: args.buildBetaDetailId,
        attributes: { autoNotifyEnabled: args.enabled },
      },
    },
  );
  return res.data;
}

export async function sendBuildBetaNotification(
  creds: AscApiCredentials,
  ascBuildId: string,
): Promise<{ id: string }> {
  const res = await ascRequest<{ data: { id: string } }>(
    creds,
    "POST",
    "/v1/buildBetaNotifications",
    {
      data: {
        type: "buildBetaNotifications",
        relationships: {
          build: { data: { type: "builds", id: ascBuildId } },
        },
      },
    },
  );
  return res.data;
}

// ---------- App Store review status (read-only) ----------

/**
 * A version's App Store review lifecycle state, e.g. PREPARE_FOR_SUBMISSION,
 * WAITING_FOR_REVIEW, IN_REVIEW, PENDING_DEVELOPER_RELEASE,
 * PENDING_APPLE_RELEASE, READY_FOR_SALE, REJECTED, METADATA_REJECTED,
 * DEVELOPER_REJECTED, … (Apple keeps adding to this enum; keep it a string).
 */
export interface AppStoreVersionSummary {
  versionString: string | null;
  appStoreState: string | null;
  platform: string | null;
  createdDate: string | null;
}

/** Recent App Store versions with their review state (newest first, per Apple). */
export async function getAppStoreVersions(
  creds: AscApiCredentials,
  ascAppId: string,
): Promise<AppStoreVersionSummary[]> {
  // No sparse fieldset — ASC rejects some fields[...] selectors ("a given
  // parameter is not allowed"); fetch the full resource and read what we need.
  const res = await ascRequest<{
    data: Array<{
      attributes?: {
        versionString?: string | null;
        appStoreState?: string | null;
        appVersionState?: string | null;
        platform?: string | null;
        createdDate?: string | null;
      };
    }>;
  }>(
    creds,
    "GET",
    `/v1/apps/${ascAppId}/appStoreVersions?limit=5`,
  );
  return (res.data ?? []).map((v) => ({
    versionString: v.attributes?.versionString ?? null,
    // appStoreState is the classic field; newer API versions expose the same
    // value as appVersionState — fall back so the badge still resolves.
    appStoreState: v.attributes?.appStoreState ?? v.attributes?.appVersionState ?? null,
    platform: v.attributes?.platform ?? null,
    createdDate: v.attributes?.createdDate ?? null,
  }));
}

/**
 * A build's TestFlight beta-review state. betaReviewState is
 * WAITING_FOR_REVIEW / IN_REVIEW / APPROVED / REJECTED, or null when the
 * build has no beta review submission (e.g. internal-only builds).
 */
export interface BetaReviewSummary {
  version: string | null;
  processingState: string | null;
  uploadedDate: string | null;
  betaReviewState: string | null;
}

/** Recent builds joined to their betaAppReviewSubmission state (newest first). */
export async function getBetaReviewStates(
  creds: AscApiCredentials,
  ascAppId: string,
): Promise<BetaReviewSummary[]> {
  // ASC rejects `include` on /apps/{id}/builds ("The parameter 'include' can not
  // be used with this request"), so fetch the builds first, then each build's
  // beta review submission separately via its relationship endpoint.
  const res = await ascRequest<{
    data: Array<{
      id: string;
      attributes?: {
        version?: string | null;
        processingState?: string | null;
        uploadedDate?: string | null;
      };
    }>;
  }>(creds, "GET", `/v1/apps/${ascAppId}/builds?limit=5`);

  return Promise.all(
    (res.data ?? []).map(async (b) => {
      let betaReviewState: string | null = null;
      try {
        const sub = await ascRequest<{
          data?: { attributes?: { betaReviewState?: string | null } } | null;
        }>(creds, "GET", `/v1/builds/${b.id}/betaAppReviewSubmission`);
        betaReviewState = sub.data?.attributes?.betaReviewState ?? null;
      } catch {
        // No beta review submission (internal-only builds) or inaccessible → null.
      }
      return {
        version: b.attributes?.version ?? null,
        processingState: b.attributes?.processingState ?? null,
        uploadedDate: b.attributes?.uploadedDate ?? null,
        betaReviewState,
      };
    }),
  );
}

// ---------- TestFlight crash feedback ----------

/**
 * One tester-submitted TestFlight crash (betaFeedbackCrashSubmissions).
 * Only crashes the tester chose to share from the TestFlight prompt exist
 * here; silent crashes surface in Xcode Organizer instead.
 */
export interface BetaFeedbackCrashSubmission {
  id: string;
  attributes?: {
    createdDate?: string | null;
    comment?: string | null;
    email?: string | null;
    deviceModel?: string | null;
    osVersion?: string | null;
    locale?: string | null;
    timeZone?: string | null;
    architecture?: string | null;
    connectionType?: string | null;
    appUptimeInMilliseconds?: number | null;
    batteryPercentage?: number | null;
    appPlatform?: string | null;
    devicePlatform?: string | null;
    deviceFamily?: string | null;
    buildBundleId?: string | null;
  };
  relationships?: {
    build?: { data?: { id: string } | null };
  };
}

/** Resolve an ASC build by build number, optionally pinned to a marketing version. */
export async function findAscBuildsByNumber(
  creds: AscApiCredentials,
  args: { ascAppId: string; buildNumber: string; version?: string | undefined },
): Promise<AscBuildResource[]> {
  const query = [
    `filter[app]=${encodeURIComponent(args.ascAppId)}`,
    `filter[version]=${encodeURIComponent(args.buildNumber)}`,
    ...(args.version
      ? [`filter[preReleaseVersion.version]=${encodeURIComponent(args.version)}`]
      : []),
    "filter[preReleaseVersion.platform]=IOS",
    "limit=5",
  ].join("&");
  const res = await ascRequest<{ data: AscBuildResource[] }>(creds, "GET", `/v1/builds?${query}`);
  return res.data ?? [];
}

/** Newest-first crash submissions for an app, optionally for one ASC build. */
export async function listBetaFeedbackCrashSubmissions(
  creds: AscApiCredentials,
  args: { ascAppId: string; ascBuildId?: string | undefined; limit: number },
): Promise<BetaFeedbackCrashSubmission[]> {
  const query = [
    ...(args.ascBuildId ? [`filter[build]=${encodeURIComponent(args.ascBuildId)}`] : []),
    "include=build",
    "sort=-createdDate",
    `limit=${args.limit}`,
  ].join("&");
  const res = await ascRequest<{ data: BetaFeedbackCrashSubmission[] }>(
    creds,
    "GET",
    `/v1/apps/${encodeURIComponent(args.ascAppId)}/betaFeedbackCrashSubmissions?${query}`,
  );
  return res.data ?? [];
}

/** Read one submission (used to check it belongs to the app before serving its log). */
export async function getBetaFeedbackCrashSubmission(
  creds: AscApiCredentials,
  submissionId: string,
): Promise<BetaFeedbackCrashSubmission> {
  const res = await ascRequest<{ data: BetaFeedbackCrashSubmission }>(
    creds,
    "GET",
    `/v1/betaFeedbackCrashSubmissions/${encodeURIComponent(submissionId)}`,
  );
  return res.data;
}

/** The raw crash log text (.ips-style) attached to a crash submission. */
export async function getBetaCrashLogText(
  creds: AscApiCredentials,
  submissionId: string,
): Promise<string | null> {
  const res = await ascRequest<{ data?: { attributes?: { logText?: string | null } } | null }>(
    creds,
    "GET",
    `/v1/betaFeedbackCrashSubmissions/${encodeURIComponent(submissionId)}/crashLog`,
  );
  return res.data?.attributes?.logText ?? null;
}

// ---------- TestFlight screenshot feedback + closing submissions ----------

export interface BetaFeedbackScreenshotImage {
  url?: string | null;
  width?: number | null;
  height?: number | null;
  expirationDate?: string | null;
}

/** One tester-submitted TestFlight screenshot feedback (betaFeedbackScreenshotSubmissions). */
export interface BetaFeedbackScreenshotSubmission extends BetaFeedbackCrashSubmission {
  attributes?: NonNullable<BetaFeedbackCrashSubmission["attributes"]> & {
    screenshots?: BetaFeedbackScreenshotImage[] | null;
  };
}

export type BetaFeedbackKind = "crash" | "screenshot";

const FEEDBACK_RESOURCE: Record<BetaFeedbackKind, string> = {
  crash: "betaFeedbackCrashSubmissions",
  screenshot: "betaFeedbackScreenshotSubmissions",
};

/** Newest-first screenshot submissions for an app, optionally for one ASC build. */
export async function listBetaFeedbackScreenshotSubmissions(
  creds: AscApiCredentials,
  args: { ascAppId: string; ascBuildId?: string | undefined; limit: number },
): Promise<BetaFeedbackScreenshotSubmission[]> {
  const query = [
    ...(args.ascBuildId ? [`filter[build]=${encodeURIComponent(args.ascBuildId)}`] : []),
    "include=build",
    "sort=-createdDate",
    `limit=${args.limit}`,
  ].join("&");
  const res = await ascRequest<{ data: BetaFeedbackScreenshotSubmission[] }>(
    creds,
    "GET",
    `/v1/apps/${encodeURIComponent(args.ascAppId)}/betaFeedbackScreenshotSubmissions?${query}`,
  );
  return res.data ?? [];
}

/** Read one crash or screenshot submission. */
export async function getBetaFeedbackSubmission(
  creds: AscApiCredentials,
  kind: BetaFeedbackKind,
  submissionId: string,
): Promise<BetaFeedbackScreenshotSubmission> {
  const res = await ascRequest<{ data: BetaFeedbackScreenshotSubmission }>(
    creds,
    "GET",
    `/v1/${FEEDBACK_RESOURCE[kind]}/${encodeURIComponent(submissionId)}`,
  );
  return res.data;
}

/**
 * "Close" a TestFlight feedback item: Apple's only resolution action is DELETE,
 * which removes the submission from App Store Connect / TestFlight feedback.
 */
export async function deleteBetaFeedbackSubmission(
  creds: AscApiCredentials,
  kind: BetaFeedbackKind,
  submissionId: string,
): Promise<void> {
  await ascRequest<unknown>(
    creds,
    "DELETE",
    `/v1/${FEEDBACK_RESOURCE[kind]}/${encodeURIComponent(submissionId)}`,
  );
}

// ---------- App Store version submission ----------

/**
 * An App Store version in a shape the submission flow needs. `id` is the ASC
 * resource id; it is what every write below is addressed by, so callers must not
 * confuse it with the marketing version string.
 */
export interface AscAppStoreVersion {
  id: string;
  versionString: string | null;
  state: string | null;
  platform: string | null;
  /** MANUAL / AFTER_APPROVAL / SCHEDULED; governs what happens after approval. */
  releaseType: string | null;
  buildId: string | null;
}

/** Resolve one App Store version by marketing string (and platform when given). */
export async function findAppStoreVersion(
  creds: AscApiCredentials,
  ascAppId: string,
  versionString: string,
  platform?: string | null,
): Promise<AscAppStoreVersion | null> {
  const query = platform
    ? `&filter[platform]=${encodeURIComponent(platform)}`
    : "";
  const res = await ascRequest<{
    data?: Array<{
      id?: string;
      attributes?: { versionString?: unknown; appStoreState?: unknown; appVersionState?: unknown; platform?: unknown };
      relationships?: { build?: { data?: { id?: unknown } } };
    }>;
  }>(creds, "GET", `/v1/apps/${encodeURIComponent(ascAppId)}/appStoreVersions?limit=50${query}`);
  const match = (res.data ?? []).find(
    (v) => typeof v.attributes?.versionString === "string" && v.attributes.versionString === versionString,
  );
  if (!match?.id) return null;
  const state =
    typeof match.attributes?.appStoreState === "string"
      ? match.attributes.appStoreState
      : typeof match.attributes?.appVersionState === "string"
        ? match.attributes.appVersionState
        : null;
  return {
    id: match.id,
    versionString: typeof match.attributes?.versionString === "string" ? match.attributes.versionString : null,
    state,
    platform: typeof match.attributes?.platform === "string" ? match.attributes.platform : null,
    releaseType: typeof (match.attributes as { releaseType?: unknown } | undefined)?.releaseType === "string"
      ? (match.attributes as { releaseType: string }).releaseType
      : null,
    buildId: typeof match.relationships?.build?.data?.id === "string" ? match.relationships.build.data.id : null,
  };
}

/** Resolve one App Store version by ASC resource id, scoped to this app. */
export async function findAppStoreVersionById(
  creds: AscApiCredentials,
  ascAppId: string,
  versionId: string,
): Promise<AscAppStoreVersion | null> {
  const res = await ascRequest<{
    data?: Array<{
      id?: string;
      attributes?: { versionString?: unknown; appStoreState?: unknown; appVersionState?: unknown; platform?: unknown; releaseType?: unknown };
      relationships?: { build?: { data?: { id?: unknown } } };
    }>;
  }>(creds, "GET", `/v1/apps/${encodeURIComponent(ascAppId)}/appStoreVersions?limit=200`);
  const match = (res.data ?? []).find((v) => v.id === versionId);
  if (!match?.id) return null;
  return {
    id: match.id,
    versionString: typeof match.attributes?.versionString === "string" ? match.attributes.versionString : null,
    state: typeof match.attributes?.appStoreState === "string"
      ? match.attributes.appStoreState
      : typeof match.attributes?.appVersionState === "string" ? match.attributes.appVersionState : null,
    platform: typeof match.attributes?.platform === "string" ? match.attributes.platform : null,
    releaseType: typeof match.attributes?.releaseType === "string" ? match.attributes.releaseType : null,
    buildId: typeof match.relationships?.build?.data?.id === "string" ? match.relationships.build.data.id : null,
  };
}

/**
 * Attach a build to a version. Required before submission: a version with no
 * build cannot be reviewed, and ASC rejects the submission rather than this call.
 */
export async function attachBuildToVersion(
  creds: AscApiCredentials,
  versionId: string,
  ascBuildId: string,
): Promise<void> {
  await ascRequest(creds, "PATCH", `/v1/appStoreVersions/${encodeURIComponent(versionId)}`, {
    data: {
      type: "appStoreVersions",
      id: versionId,
      relationships: { build: { data: { type: "builds", id: ascBuildId } } },
    },
  });
}

/**
 * Upsert the per-locale "What's New" text.
 *
 * Locales are independent resources; one call per locale, and an existing
 * localization is patched rather than created so re-running a submission after a
 * rejection updates the copy instead of failing on a duplicate.
 */
export async function setVersionLocalization(
  creds: AscApiCredentials,
  versionId: string,
  locale: string,
  whatsNew: string,
): Promise<void> {
  const existing = await ascRequest<{
    data?: Array<{ id?: string; attributes?: { locale?: unknown } }>;
  }>(creds, "GET", `/v1/appStoreVersions/${encodeURIComponent(versionId)}/appStoreVersionLocalizations?limit=50`);
  const match = (existing.data ?? []).find(
    (l) => typeof l.attributes?.locale === "string" && l.attributes.locale === locale,
  );
  if (match?.id) {
    await ascRequest(creds, "PATCH", `/v1/appStoreVersionLocalizations/${encodeURIComponent(match.id)}`, {
      data: {
        type: "appStoreVersionLocalizations",
        id: match.id,
        attributes: { whatsNew },
      },
    });
    return;
  }
  await ascRequest(creds, "POST", "/v1/appStoreVersionLocalizations", {
    data: {
      type: "appStoreVersionLocalizations",
      attributes: { locale, whatsNew },
      relationships: { appStoreVersion: { data: { type: "appStoreVersions", id: versionId } } },
    },
  });
}

/**
 * Create an App Store version for a platform.
 *
 * `releaseType` decides what happens after approval:
 *   - MANUAL: approval parks the app at PENDING_DEVELOPER_RELEASE and waits for a
 *     human (or a later call). Required when artin wants to choose the moment.
 *   - AFTER_APPROVAL: ships automatically once approved.
 *   - SCHEDULED: ships at `earliestReleaseDate`; not used here.
 *
 * ASC only allows one editable version per platform, so a version still in review
 * must be withdrawn first, not overwritten.
 */
export async function createAppStoreVersion(
  creds: AscApiCredentials,
  ascAppId: string,
  versionString: string,
  platform: string,
  releaseType: "MANUAL" | "AFTER_APPROVAL" | "SCHEDULED",
): Promise<{ id: string }> {
  const res = await ascRequest<{ data?: { id?: string } }>(creds, "POST", "/v1/appStoreVersions", {
    data: {
      type: "appStoreVersions",
      attributes: { versionString, platform, releaseType },
      relationships: { app: { data: { type: "apps", id: ascAppId } } },
    },
  });
  const id = res.data?.id;
  if (typeof id !== "string" || !id) {
    throw new AscApiError(502, "app_store_version_malformed", "App Store Connect did not return a version id");
  }
  return { id };
}


/**
 * Review submissions.
 *
 * ASC models "submit for review" as three steps rather than one call:
 *   1. POST /v1/reviewSubmissions                      (platform)
 *   2. POST /v1/reviewSubmissionItems                  (attach the appStoreVersion)
 *   3. PATCH /v1/reviewSubmissions/{id} {submitted:true}
 *
 * Withdrawal is `canceled: true` on the same resource. The older
 * `DELETE /v1/appStoreVersionSubmissions/{id}` is deprecated and is not used.
 */
export interface AscReviewSubmission {
  id: string;
  state: string | null;
  platform: string | null;
}

export async function listReviewSubmissions(
  creds: AscApiCredentials,
  ascAppId: string,
): Promise<AscReviewSubmission[]> {
  const res = await ascRequest<{
    data?: Array<{ id?: string; attributes?: { state?: unknown; platform?: unknown } }>;
  }>(creds, "GET", `/v1/apps/${encodeURIComponent(ascAppId)}/reviewSubmissions?limit=50`);
  return (res.data ?? [])
    .filter((s): s is { id: string; attributes?: { state?: unknown; platform?: unknown } } => typeof s.id === "string")
    .map((s) => ({
      id: s.id,
      state: typeof s.attributes?.state === "string" ? s.attributes.state : null,
      platform: typeof s.attributes?.platform === "string" ? s.attributes.platform : null,
    }));
}

/** Which appStoreVersion a submission carries. Used to decide whether it is the one to cancel. */
export async function getReviewSubmissionVersionId(
  creds: AscApiCredentials,
  submissionId: string,
): Promise<string | null> {
  const res = await ascRequest<{
    data?: Array<{ relationships?: { appStoreVersionForReview?: { data?: { id?: unknown } } } }>;
  }>(creds, "GET", `/v1/reviewSubmissions/${encodeURIComponent(submissionId)}/items?limit=50`);
  for (const item of res.data ?? []) {
    const id = item.relationships?.appStoreVersionForReview?.data?.id;
    if (typeof id === "string" && id) return id;
  }
  return null;
}

/**
 * Withdraw a submission. ASC has no "withdraw" verb: cancelling the review
 * submission is what returns the version to an editable state.
 */
export async function cancelReviewSubmission(
  creds: AscApiCredentials,
  submissionId: string,
): Promise<void> {
  await ascRequest(creds, "PATCH", `/v1/reviewSubmissions/${encodeURIComponent(submissionId)}`, {
    data: {
      type: "reviewSubmissions",
      id: submissionId,
      attributes: { canceled: true },
    },
  });
}

/** Create, populate and submit a review in one call so a half-submitted review cannot linger. */
export async function submitVersionForReview(
  creds: AscApiCredentials,
  ascAppId: string,
  versionId: string,
  platform: string,
): Promise<{ submissionId: string }> {
  const created = await ascRequest<{ data?: { id?: string } }>(creds, "POST", "/v1/reviewSubmissions", {
    data: {
      type: "reviewSubmissions",
      attributes: { platform },
      relationships: { app: { data: { type: "apps", id: ascAppId } } },
    },
  });
  const submissionId = created.data?.id;
  if (typeof submissionId !== "string" || !submissionId) {
    throw new AscApiError(502, "review_submission_malformed", "App Store Connect did not return a submission id");
  }
  await ascRequest(creds, "POST", "/v1/reviewSubmissionItems", {
    data: {
      type: "reviewSubmissionItems",
      relationships: {
        reviewSubmission: { data: { type: "reviewSubmissions", id: submissionId } },
        appStoreVersionForReview: { data: { type: "appStoreVersions", id: versionId } },
      },
    },
  });
  await ascRequest(creds, "PATCH", `/v1/reviewSubmissions/${encodeURIComponent(submissionId)}`, {
    data: {
      type: "reviewSubmissions",
      id: submissionId,
      attributes: { submitted: true },
    },
  });
  return { submissionId };
}
