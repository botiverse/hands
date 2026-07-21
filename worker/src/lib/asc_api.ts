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
): Promise<T> {
  const jwt = await createAscJwt(creds);
  const res = await fetch(`${ASC_API_BASE}${path}`, {
    method,
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
