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

/** One entry of Apple's `meta.associatedErrors`: which resource is blocking, and why. */
export interface AscAssociatedError {
  resource: string;
  code: string | null;
  detail: string | null;
}

/** One of Apple's `errors[]` entries after the first, bounded. */
export interface AscErrorEntry {
  code: string | null;
  title: string | null;
  detail: string | null;
  source: string | null;
}

export class AscApiError extends Error {
  status: number;
  detail: string | null;
  /** Apple's machine code for errors[0], e.g. STATE_ERROR.ENTITY_STATE_INVALID. */
  code: string | null = null;
  /** errors[0].source.pointer (or .parameter): the attribute or query parameter at fault. */
  source: string | null = null;
  /** errors[1..], which Apple uses when one request has several faults. */
  others: AscErrorEntry[] = [];
  /**
   * Apple's per-resource reasons. A refusal like "This resource cannot be reviewed,
   * please check associated errors to see why." names nothing by itself; the actual
   * blockers (missing screenshots, missing localization fields, ...) are only here.
   */
  associated: AscAssociatedError[];
  constructor(status: number, message: string, detail: string | null = null, associated: AscAssociatedError[] = []) {
    super(message);
    this.status = status;
    this.detail = detail;
    this.associated = associated;
  }
}

const MAX_ASSOCIATED_ERRORS = 30;
const MAX_ASSOCIATED_TEXT = 300;
const MAX_OTHER_ERRORS = 10;

const boundedText = (v: unknown) => (typeof v === "string" && v ? v.slice(0, MAX_ASSOCIATED_TEXT) : null);

/** One `errors[]` entry as {code, title, detail, source}; null for a non-object entry. */
export function parseAscErrorEntry(error: unknown): AscErrorEntry | null {
  if (!error || typeof error !== "object" || Array.isArray(error)) return null;
  const e = error as { code?: unknown; title?: unknown; detail?: unknown; source?: unknown };
  const source = e.source && typeof e.source === "object" ? (e.source as { pointer?: unknown; parameter?: unknown }) : null;
  return {
    code: boundedText(e.code),
    title: boundedText(e.title),
    detail: boundedText(e.detail),
    source: boundedText(source?.pointer) ?? boundedText(source?.parameter),
  };
}

/** errors[1..] as bounded entries; junk entries are skipped, never thrown on. */
export function parseOtherAscErrors(errors: unknown): AscErrorEntry[] {
  if (!Array.isArray(errors)) return [];
  const out: AscErrorEntry[] = [];
  for (const error of errors.slice(1)) {
    if (out.length >= MAX_OTHER_ERRORS) break;
    const entry = parseAscErrorEntry(error);
    if (entry) out.push(entry);
  }
  return out;
}

/** Flatten `errors[].meta.associatedErrors` ({ "<resource path>": [{code, detail}] }), bounded. */
export function parseAssociatedErrors(errors: unknown): AscAssociatedError[] {
  const out: AscAssociatedError[] = [];
  if (!Array.isArray(errors)) return out;
  const text = (v: unknown) => (typeof v === "string" && v ? v.slice(0, MAX_ASSOCIATED_TEXT) : null);
  for (const error of errors) {
    const map = (error as { meta?: { associatedErrors?: unknown } })?.meta?.associatedErrors;
    if (!map || typeof map !== "object") continue;
    for (const [resource, list] of Object.entries(map as Record<string, unknown>)) {
      if (!Array.isArray(list)) continue;
      for (const item of list) {
        if (out.length >= MAX_ASSOCIATED_ERRORS) return out;
        // A null/primitive entry must not throw here: that would replace Apple's
        // original AscApiError with a TypeError.
        if (!item || typeof item !== "object") continue;
        const i = item as { code?: unknown; detail?: unknown; title?: unknown };
        out.push({ resource: resource.slice(0, MAX_ASSOCIATED_TEXT), code: text(i.code), detail: text(i.detail) ?? text(i.title) });
      }
    }
  }
  return out;
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
    const error = new AscApiError(
      res.status,
      first?.title ?? `App Store Connect API ${method} ${path} failed (${res.status})`,
      first?.detail ?? (parsed ? null : text.slice(0, 500) || null),
      parseAssociatedErrors(errors),
    );
    const head = Array.isArray(errors) ? parseAscErrorEntry(errors[0]) : null;
    error.code = head?.code ?? null;
    error.source = head?.source ?? null;
    error.others = parseOtherAscErrors(errors);
    throw error;
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
  signal?: AbortSignal,
): Promise<BetaGroupResource[]> {
  const res = await ascRequest<{ data: BetaGroupResource[] }>(
    creds,
    "GET",
    `/v1/apps/${encodeURIComponent(ascAppId)}/betaGroups?limit=200`,
    undefined,
    signal,
  );
  return res.data ?? [];
}

/**
 * Named beta groups assigned to a build, for notification display.
 *
 * Two calls, deliberately: `getAssignedBetaGroupIds` returns only ids, and the names
 * live on the app-level `listBetaGroups`. Showing an id is useless to a reader, so
 * both are needed and the join happens here rather than in each caller.
 *
 * `timeoutMs` is set by the caller because this runs inside the webhook path, which
 * has a tighter budget than an interactive request: two sequential round trips would
 * not fit the single-hop allowance `resolveBuildIdentity` was written against.
 *
 * Returns [] rather than throwing when the build has no groups. That is a real state
 * (an external build assigned to nothing yet), not a failure.
 */
export async function listAssignedBetaGroupNames(
  creds: AscApiCredentials,
  ascAppId: string,
  ascBuildId: string,
  timeoutMs: number,
): Promise<Array<{ name: string; isInternal: boolean }>> {
  const signal = AbortSignal.timeout(timeoutMs);
  const assignedIds = await getAssignedBetaGroupIds(creds, ascBuildId, signal);
  if (assignedIds.length === 0) return [];
  const all = await listBetaGroups(creds, ascAppId, signal);
  const byId = new Map(all.map((group) => [group.id, group]));
  return assignedIds
    .map((id) => byId.get(id))
    // A group the build references but the app listing does not return is dropped
    // rather than shown as a bare id: an id in a notification looks like information
    // without being readable.
    .filter((group): group is BetaGroupResource => group !== undefined)
    .map((group) => ({
      name: (group.attributes.name ?? "").trim() || group.id,
      isInternal: group.attributes.isInternalGroup === true,
    }));
}

export async function getAssignedBetaGroupIds(
  creds: AscApiCredentials,
  ascBuildId: string,
  signal?: AbortSignal,
): Promise<string[]> {
  const res = await ascRequest<{
    data: AscBuildResource;
    included?: Array<{ type?: string; id?: string }>;
  }>(
    creds,
    "GET",
    `/v1/builds/${encodeURIComponent(ascBuildId)}?include=betaGroups&limit[betaGroups]=50`,
    undefined,
    signal,
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
  signal?: AbortSignal,
): Promise<BetaFeedbackCrashSubmission> {
  const res = await ascRequest<{ data: BetaFeedbackCrashSubmission }>(
    creds,
    "GET",
    `/v1/betaFeedbackCrashSubmissions/${encodeURIComponent(submissionId)}`,
    undefined,
    signal,
  );
  return res.data;
}

/** The raw crash log text (.ips-style) attached to a crash submission. */
export async function getBetaCrashLogText(
  creds: AscApiCredentials,
  submissionId: string,
  signal?: AbortSignal,
): Promise<string | null> {
  const res = await ascRequest<{ data?: { attributes?: { logText?: string | null } } | null }>(
    creds,
    "GET",
    `/v1/betaFeedbackCrashSubmissions/${encodeURIComponent(submissionId)}/crashLog`,
    undefined,
    signal,
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
  /** appStoreState when Apple sends it, else appVersionState (historical precedence). */
  state: string | null;
  /** Apple's current lifecycle field (AppVersionState); null when Apple omitted it. */
  appVersionState: string | null;
  /** Apple's deprecated lifecycle field (AppStoreVersionState); null when omitted. */
  appStoreState: string | null;
  platform: string | null;
  /** MANUAL / AFTER_APPROVAL / SCHEDULED; governs what happens after approval. */
  releaseType: string | null;
  buildId: string | null;
  /**
   * True only when Apple's response carried `relationships.build.data` (an object or
   * an explicit null). False means the relationship was not returned at all, so
   * `buildId: null` is "we did not learn it", not "Apple says no build".
   */
  buildRelationshipReturned: boolean;
}

export type RawAppStoreVersion = {
  id?: unknown;
  attributes?: {
    versionString?: unknown;
    appStoreState?: unknown;
    appVersionState?: unknown;
    platform?: unknown;
    releaseType?: unknown;
  };
  relationships?: { build?: { data?: { id?: unknown } | null } };
};

const str = (value: unknown): string | null => (typeof value === "string" ? value : null);

export function toAppStoreVersion(raw: RawAppStoreVersion): AscAppStoreVersion | null {
  if (typeof raw.id !== "string" || !raw.id) return null;
  const appStoreState = str(raw.attributes?.appStoreState);
  const appVersionState = str(raw.attributes?.appVersionState);
  const build = raw.relationships?.build;
  const buildRelationshipReturned = !!build && typeof build === "object" && "data" in build;
  const buildId = buildRelationshipReturned && build?.data && typeof build.data.id === "string" ? build.data.id : null;
  return {
    id: raw.id,
    versionString: str(raw.attributes?.versionString),
    state: appStoreState ?? appVersionState,
    appVersionState,
    appStoreState,
    platform: str(raw.attributes?.platform),
    releaseType: str(raw.attributes?.releaseType),
    buildId,
    buildRelationshipReturned,
  };
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
  // `include=build` is required: without it Apple omits relationships.build
  // entirely, which is indistinguishable from "no build attached". Callers that
  // report build_attached would then report false for every version.
  const res = await ascRequest<{ data?: RawAppStoreVersion[] }>(
    creds, "GET", `/v1/apps/${encodeURIComponent(ascAppId)}/appStoreVersions?limit=50&include=build${query}`,
  );
  const match = (res.data ?? []).find(
    (v) => typeof v.attributes?.versionString === "string" && v.attributes.versionString === versionString,
  );
  return match ? toAppStoreVersion(match) : null;
}

/** Resolve one App Store version by ASC resource id, scoped to this app. */
export async function findAppStoreVersionById(
  creds: AscApiCredentials,
  ascAppId: string,
  versionId: string,
): Promise<AscAppStoreVersion | null> {
  const res = await ascRequest<{ data?: RawAppStoreVersion[] }>(
    creds, "GET", `/v1/apps/${encodeURIComponent(ascAppId)}/appStoreVersions?limit=200&include=build`,
  );
  const match = (res.data ?? []).find((v) => v.id === versionId);
  return match ? toAppStoreVersion(match) : null;
}

/** Bound on version-list pages; an app with more than this many versions fails closed. */
const MAX_VERSION_PAGES = 5;

/**
 * Every App Store version of the app on one platform, with the build relationship.
 *
 * Follows `links.next` so a decision like "is there another unreleased version?" is
 * made on the whole list, not the first page. If the list is longer than the page
 * bound, this throws instead of answering from a partial view.
 */
export async function listAppStoreVersions(
  creds: AscApiCredentials,
  ascAppId: string,
  platform: string,
): Promise<AscAppStoreVersion[]> {
  const out: AscAppStoreVersion[] = [];
  let path: string | null =
    `/v1/apps/${encodeURIComponent(ascAppId)}/appStoreVersions?limit=200&include=build&filter[platform]=${encodeURIComponent(platform)}`;
  for (let page = 0; path; page++) {
    if (page >= MAX_VERSION_PAGES) {
      throw new AscApiError(502, "app_store_version_list_too_long", `more than ${MAX_VERSION_PAGES} pages of App Store versions; refusing to decide from a partial list`);
    }
    const res: { data?: RawAppStoreVersion[]; links?: { next?: unknown } } = await ascRequest(creds, "GET", path);
    if (!Array.isArray(res?.data)) {
      throw new AscApiError(502, "app_store_version_list_malformed", "App Store Connect returned no version list");
    }
    for (const raw of res.data) {
      const version = toAppStoreVersion(raw);
      if (version) out.push(version);
    }
    const next = typeof res.links?.next === "string" ? res.links.next : null;
    path = next ? sameOriginAscPath(next) : null;
  }
  return out;
}

/**
 * Follow Apple's `links.next` only when it points at the App Store Connect API
 * origin itself. A prefix check would accept `https://api.appstoreconnect.apple.com.evil.example/…`
 * and send the API token there; compare parsed origins instead.
 */
export function sameOriginAscPath(link: string): string | null {
  let url: URL;
  let base: URL;
  try {
    url = new URL(link);
    base = new URL(ASC_API_BASE);
  } catch {
    return null;
  }
  if (url.origin !== base.origin) return null;
  return `${url.pathname}${url.search}`;
}

/** Read one version directly, with the build relationship. Used for read-back after writes. */
export async function getAppStoreVersion(
  creds: AscApiCredentials,
  versionId: string,
): Promise<AscAppStoreVersion | null> {
  const res = await ascRequest<{ data?: RawAppStoreVersion }>(
    creds, "GET", `/v1/appStoreVersions/${encodeURIComponent(versionId)}?include=build`,
  );
  return res?.data ? toAppStoreVersion(res.data) : null;
}

/**
 * Change an editable version's marketing string and, when given, its build, in one
 * PATCH. Apple allows a single not-yet-released version per platform, so moving
 * that record to the new version string is the only way to prepare a newer release
 * while it exists. Callers must check the version state first.
 */
export async function renameAppStoreVersion(
  creds: AscApiCredentials,
  versionId: string,
  versionString: string,
  ascBuildId?: string | null,
  releaseType?: AppStoreReleaseType | null,
): Promise<void> {
  await updateAppStoreVersion(creds, versionId, { versionString, ascBuildId: ascBuildId ?? null, releaseType: releaseType ?? null });
}

export type AppStoreReleaseType = "MANUAL" | "AFTER_APPROVAL" | "SCHEDULED";

/**
 * One PATCH of an editable version: any of versionString, releaseType (attributes)
 * and the build relationship. Omitted fields are not sent, so Apple keeps them.
 */
export async function updateAppStoreVersion(
  creds: AscApiCredentials,
  versionId: string,
  changes: { versionString?: string | null; releaseType?: AppStoreReleaseType | null; ascBuildId?: string | null },
): Promise<void> {
  const attributes: Record<string, string> = {};
  if (changes.versionString) attributes.versionString = changes.versionString;
  if (changes.releaseType) attributes.releaseType = changes.releaseType;
  await ascRequest(creds, "PATCH", `/v1/appStoreVersions/${encodeURIComponent(versionId)}`, {
    data: {
      type: "appStoreVersions",
      id: versionId,
      ...(Object.keys(attributes).length ? { attributes } : {}),
      ...(changes.ascBuildId ? { relationships: { build: { data: { type: "builds", id: changes.ascBuildId } } } } : {}),
    },
  });
}

/**
 * Release a version Apple has approved and parked at PENDING_DEVELOPER_RELEASE
 * (releaseType MANUAL). Irreversible: once released, the version is live on the
 * App Store. Apple processes the request asynchronously, so the version may still
 * read PENDING_DEVELOPER_RELEASE (or PROCESSING_FOR_*) right after this returns.
 *
 * Apple exposes this resource as create-only: there is no GET of existing release
 * requests, so callers must guard against a duplicate with the version state (and
 * their own receipts), not by listing requests.
 */
export async function createAppStoreVersionReleaseRequest(
  creds: AscApiCredentials,
  versionId: string,
): Promise<{ id: string | null }> {
  const res = await ascRequest<{ data?: { id?: unknown } } | null>(creds, "POST", "/v1/appStoreVersionReleaseRequests", {
    data: {
      type: "appStoreVersionReleaseRequests",
      relationships: { appStoreVersion: { data: { type: "appStoreVersions", id: versionId } } },
    },
  });
  const id = res?.data?.id;
  return { id: typeof id === "string" && id ? id : null };
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
 * Update the per-locale "What's New" text of an existing localization.
 *
 * Locales are independent resources; one call per locale. A missing localization is
 * NOT created: a localization holding only whatsNew lacks description/keywords/
 * supportUrl, and Apple then refuses the review submission
 * (ENTITY_ERROR.ATTRIBUTE.REQUIRED). Create it with the listing-text push instead.
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
  if (!match?.id) {
    throw new Error(`no ${locale} localization on version ${versionId}; create it with hands app-store localizations push`);
  }
  await ascRequest(creds, "PATCH", `/v1/appStoreVersionLocalizations/${encodeURIComponent(match.id)}`, {
    data: {
      type: "appStoreVersionLocalizations",
      id: match.id,
      attributes: { whatsNew },
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
 *   - SCHEDULED: ships at `earliestReleaseDate`. Hands never sets that date, so the
 *     prepare route refuses SCHEDULED rather than create a version Apple cannot ship.
 *
 * ASC only allows one editable version per platform, so a version still in review
 * must be withdrawn first, not overwritten.
 */
export async function createAppStoreVersion(
  creds: AscApiCredentials,
  ascAppId: string,
  versionString: string,
  platform: string,
  releaseType: AppStoreReleaseType,
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
    data?: Array<{ relationships?: { appStoreVersion?: { data?: { id?: unknown } } } }>;
    // Same trap as the version lookups: JSON:API omits the relationship unless it is
    // requested. On reviewSubmissionItems the relationship is `appStoreVersion`;
    // `appStoreVersionForReview` belongs to reviewSubmissions and Apple answers it here
    // with 400 "'appStoreVersionForReview' is not a valid relationship name"
    // (observed 2026-10-29 on raft-ios 1.17.0).
  }>(creds, "GET", `/v1/reviewSubmissions/${encodeURIComponent(submissionId)}/items?limit=50&include=appStoreVersion`);
  for (const item of res.data ?? []) {
    const id = item.relationships?.appStoreVersion?.data?.id;
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

/**
 * Send an UNRESOLVED_ISSUES submission back to Apple after the version was fixed.
 *
 * After a rejection the submission stays open with the version still in it as an
 * item, and Apple will not open a new submission for the platform until this one is
 * resubmitted or cancelled. So resubmitting is only `submitted: true` on the same
 * resource -- adding the version as an item again is refused because it is already
 * there.
 */
export async function resubmitReviewSubmission(
  creds: AscApiCredentials,
  submissionId: string,
): Promise<void> {
  await ascRequest(creds, "PATCH", `/v1/reviewSubmissions/${encodeURIComponent(submissionId)}`, {
    data: {
      type: "reviewSubmissions",
      id: submissionId,
      attributes: { submitted: true },
    },
  });
}

/**
 * Create (or reuse), populate and submit a review in one call so a half-submitted
 * review cannot linger.
 *
 * `reuseSubmissionId` is an existing READY_FOR_REVIEW draft for the same platform.
 * A draft is what a failed earlier attempt leaves behind (step 1 succeeded, a later
 * step did not); App Store Connect keeps one open draft per platform, so creating a
 * second one instead of reusing it is at best clutter.
 *
 * When this call created the draft itself and a later step fails, the draft is
 * cancelled best-effort before the error is rethrown.
 */
export async function submitVersionForReview(
  creds: AscApiCredentials,
  ascAppId: string,
  versionId: string,
  platform: string,
  opts: { reuseSubmissionId?: string } = {},
): Promise<{ submissionId: string; reused: boolean }> {
  let submissionId = opts.reuseSubmissionId ?? null;
  const reused = submissionId !== null;
  if (!submissionId) {
    const created = await ascRequest<{ data?: { id?: string } }>(creds, "POST", "/v1/reviewSubmissions", {
      data: {
        type: "reviewSubmissions",
        attributes: { platform },
        relationships: { app: { data: { type: "apps", id: ascAppId } } },
      },
    });
    submissionId = typeof created.data?.id === "string" && created.data.id ? created.data.id : null;
    if (!submissionId) {
      throw new AscApiError(502, "review_submission_malformed", "App Store Connect did not return a submission id");
    }
  }
  try {
    // The item's relationship to the version is `appStoreVersion`.
    // `appStoreVersionForReview` is the relationship on the reviewSubmission itself;
    // sent here it is rejected with "The provided entity includes an unknown relationship".
    await ascRequest(creds, "POST", "/v1/reviewSubmissionItems", {
      data: {
        type: "reviewSubmissionItems",
        relationships: {
          reviewSubmission: { data: { type: "reviewSubmissions", id: submissionId } },
          appStoreVersion: { data: { type: "appStoreVersions", id: versionId } },
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
  } catch (error) {
    if (!reused) {
      await cancelReviewSubmission(creds, submissionId).catch(() => undefined);
    }
    throw error;
  }
  return { submissionId, reused };
}

// ---------- App Store version localizations (listing text) ----------

/** appStoreVersionLocalizations attributes Hands reads and writes, Apple's names verbatim. */
export const VERSION_LOCALIZATION_FIELDS = [
  "description",
  "keywords",
  "promotionalText",
  "marketingUrl",
  "supportUrl",
  "whatsNew",
] as const;
export type VersionLocalizationField = typeof VERSION_LOCALIZATION_FIELDS[number];

export interface AscVersionLocalization {
  id: string;
  locale: string;
  fields: Partial<Record<VersionLocalizationField, string | null>>;
}

/**
 * Every localization of one version. This is the related-resource list, so an empty
 * `data` array is Apple saying "none"; a response without `data` is malformed and
 * throws rather than reading as "none".
 */
export async function listVersionLocalizations(
  creds: AscApiCredentials,
  versionId: string,
): Promise<AscVersionLocalization[]> {
  const res = await ascRequest<{ data?: Array<{ id?: unknown; attributes?: Record<string, unknown> }> }>(
    creds, "GET", `/v1/appStoreVersions/${encodeURIComponent(versionId)}/appStoreVersionLocalizations?limit=200`,
  );
  if (!Array.isArray(res?.data)) {
    throw new AscApiError(502, "version_localizations_malformed", "App Store Connect returned no localization list");
  }
  const out: AscVersionLocalization[] = [];
  for (const item of res.data) {
    const locale = item.attributes?.locale;
    if (typeof item.id !== "string" || typeof locale !== "string") continue;
    const fields: AscVersionLocalization["fields"] = {};
    for (const field of VERSION_LOCALIZATION_FIELDS) {
      const value = item.attributes?.[field];
      fields[field] = typeof value === "string" ? value : null;
    }
    out.push({ id: item.id, locale, fields });
  }
  return out;
}

export async function updateVersionLocalizationFields(
  creds: AscApiCredentials,
  localizationId: string,
  attributes: Partial<Record<VersionLocalizationField, string>>,
): Promise<void> {
  await ascRequest(creds, "PATCH", `/v1/appStoreVersionLocalizations/${encodeURIComponent(localizationId)}`, {
    data: { type: "appStoreVersionLocalizations", id: localizationId, attributes },
  });
}

export async function createVersionLocalizationWithFields(
  creds: AscApiCredentials,
  versionId: string,
  locale: string,
  attributes: Partial<Record<VersionLocalizationField, string>>,
): Promise<string> {
  const res = await ascRequest<{ data?: { id?: unknown } }>(creds, "POST", "/v1/appStoreVersionLocalizations", {
    data: {
      type: "appStoreVersionLocalizations",
      attributes: { locale, ...attributes },
      relationships: { appStoreVersion: { data: { type: "appStoreVersions", id: versionId } } },
    },
  });
  if (typeof res?.data?.id !== "string" || !res.data.id) {
    throw new AscApiError(502, "version_localization_malformed", "App Store Connect did not return a localization id");
  }
  return res.data.id;
}

// ---------- App Store screenshots ----------
//
// Apple's asset flow (developer.apple.com "Uploading assets to App Store Connect"):
//   POST /v1/appScreenshots {fileName, fileSize} -> uploadOperations
//   PUT each operation's byte range to its URL with its headers (no ASC JWT)
//   PATCH /v1/appScreenshots/{id} {uploaded: true, sourceFileChecksum: <MD5 hex>}
//   poll GET /v1/appScreenshots/{id} assetDeliveryState.state -> COMPLETE | FAILED

export interface AscScreenshotSet {
  id: string;
  displayType: string | null;
}

export interface AscScreenshot {
  id: string;
  fileName: string | null;
  fileSize: number | null;
  /** MD5 hex the uploader declared at commit; null when Apple has none on record. */
  sourceFileChecksum: string | null;
  /** assetDeliveryState.state: AWAITING_UPLOAD | UPLOAD_COMPLETE | COMPLETE | FAILED. */
  state: string | null;
  errors: Array<{ code: string | null; description: string | null }>;
}

type RawScreenshot = {
  id?: unknown;
  type?: unknown;
  attributes?: {
    fileName?: unknown;
    fileSize?: unknown;
    sourceFileChecksum?: unknown;
    assetDeliveryState?: { state?: unknown; errors?: unknown } | null;
    uploadOperations?: unknown;
  };
};

function toScreenshot(raw: RawScreenshot): AscScreenshot | null {
  if (typeof raw.id !== "string" || !raw.id) return null;
  const delivery = raw.attributes?.assetDeliveryState;
  const errors = Array.isArray(delivery?.errors)
    ? (delivery!.errors as Array<{ code?: unknown; description?: unknown }>).slice(0, 10).map((e) => ({
        code: str(e?.code), description: typeof e?.description === "string" ? e.description.slice(0, 500) : null,
      }))
    : [];
  return {
    id: raw.id,
    fileName: str(raw.attributes?.fileName),
    fileSize: typeof raw.attributes?.fileSize === "number" ? raw.attributes.fileSize : null,
    sourceFileChecksum: str(raw.attributes?.sourceFileChecksum)?.toLowerCase() ?? null,
    state: str(delivery?.state),
    errors,
  };
}

/** Screenshot sets of one localization (related-resource list; empty `data` = none). */
export async function listScreenshotSets(
  creds: AscApiCredentials,
  localizationId: string,
): Promise<AscScreenshotSet[]> {
  const res = await ascRequest<{ data?: Array<{ id?: unknown; attributes?: { screenshotDisplayType?: unknown } }> }>(
    creds, "GET", `/v1/appStoreVersionLocalizations/${encodeURIComponent(localizationId)}/appScreenshotSets?limit=50`,
  );
  if (!Array.isArray(res?.data)) {
    throw new AscApiError(502, "screenshot_sets_malformed", "App Store Connect returned no screenshot set list");
  }
  return res.data
    .filter((s): s is { id: string; attributes?: { screenshotDisplayType?: unknown } } => typeof s.id === "string")
    .map((s) => ({ id: s.id, displayType: str(s.attributes?.screenshotDisplayType) }));
}

/**
 * One screenshot set with its screenshots, in Apple's display order.
 *
 * The order lives in the set's `appScreenshots` relationship, which JSON:API only
 * fills when asked: `include=appScreenshots` is required. A response without
 * `relationships.appScreenshots.data` is "we did not learn it" and throws; an empty
 * array is Apple saying the set is empty.
 */
export async function getScreenshotSetWithScreenshots(
  creds: AscApiCredentials,
  setId: string,
): Promise<AscScreenshot[]> {
  const res = await ascRequest<{
    data?: { relationships?: { appScreenshots?: { data?: Array<{ id?: unknown }> | null } } };
    included?: RawScreenshot[];
  }>(creds, "GET", `/v1/appScreenshotSets/${encodeURIComponent(setId)}?include=appScreenshots&limit[appScreenshots]=50`);
  const linkage = res?.data?.relationships?.appScreenshots?.data;
  if (!Array.isArray(linkage)) {
    throw new AscApiError(502, "screenshot_set_relationship_missing",
      "App Store Connect did not return the screenshot set's appScreenshots relationship");
  }
  const included = new Map<string, AscScreenshot>();
  for (const raw of res.included ?? []) {
    if (raw?.type !== undefined && raw.type !== "appScreenshots") continue;
    const shot = toScreenshot(raw);
    if (shot) included.set(shot.id, shot);
  }
  return linkage.map((ref) => {
    const id = typeof ref?.id === "string" ? ref.id : "";
    const shot = included.get(id);
    if (!shot) {
      throw new AscApiError(502, "screenshot_set_include_missing",
        `App Store Connect listed screenshot ${id} in the set but did not include it`);
    }
    return shot;
  });
}

export async function createScreenshotSet(
  creds: AscApiCredentials,
  localizationId: string,
  displayType: string,
): Promise<string> {
  const res = await ascRequest<{ data?: { id?: unknown } }>(creds, "POST", "/v1/appScreenshotSets", {
    data: {
      type: "appScreenshotSets",
      attributes: { screenshotDisplayType: displayType },
      relationships: { appStoreVersionLocalization: { data: { type: "appStoreVersionLocalizations", id: localizationId } } },
    },
  });
  if (typeof res?.data?.id !== "string" || !res.data.id) {
    throw new AscApiError(502, "screenshot_set_malformed", "App Store Connect did not return a screenshot set id");
  }
  return res.data.id;
}

/** Reserve a screenshot; returns its id and the upload operations Apple wants performed. */
export async function reserveScreenshot(
  creds: AscApiCredentials,
  setId: string,
  fileName: string,
  fileSize: number,
): Promise<{ id: string; uploadOperations: UploadOperation[] }> {
  const res = await ascRequest<{ data?: RawScreenshot }>(creds, "POST", "/v1/appScreenshots", {
    data: {
      type: "appScreenshots",
      attributes: { fileName, fileSize },
      relationships: { appScreenshotSet: { data: { type: "appScreenshotSets", id: setId } } },
    },
  });
  const id = res?.data?.id;
  const ops = res?.data?.attributes?.uploadOperations;
  if (typeof id !== "string" || !id || !Array.isArray(ops) || ops.length === 0) {
    throw new AscApiError(502, "screenshot_reservation_malformed", "App Store Connect did not return a screenshot id with upload operations");
  }
  return { id, uploadOperations: ops as UploadOperation[] };
}

/**
 * Perform Apple's upload operations for one file: each covers [offset, offset+length)
 * and carries its own headers. These go to Apple's asset host, not the ASC API, so no
 * JWT is sent. Any non-2xx is an error; nothing is retried silently.
 */
export async function performUploadOperations(
  operations: UploadOperation[],
  bytes: Uint8Array,
): Promise<void> {
  let covered = 0;
  for (const op of operations) {
    if (typeof op?.url !== "string" || !Number.isSafeInteger(op.offset) || !Number.isSafeInteger(op.length)
      || op.offset < 0 || op.length <= 0 || op.offset + op.length > bytes.byteLength) {
      throw new AscApiError(502, "upload_operation_malformed", "App Store Connect returned an unusable upload operation");
    }
    const headers: Record<string, string> = {};
    for (const h of op.requestHeaders ?? []) {
      if (typeof h?.name === "string" && typeof h?.value === "string") headers[h.name] = h.value;
    }
    const res = await fetch(op.url, {
      method: typeof op.method === "string" && op.method ? op.method : "PUT",
      headers,
      body: bytes.slice(op.offset, op.offset + op.length),
    });
    if (!res.ok) {
      throw new AscApiError(res.status, "upload_part_failed", `asset upload part at offset ${op.offset} failed (${res.status})`);
    }
    covered += op.length;
  }
  if (covered !== bytes.byteLength) {
    throw new AscApiError(502, "upload_operations_incomplete", `upload operations covered ${covered} of ${bytes.byteLength} bytes`);
  }
}

/** Mark a reserved screenshot uploaded; Apple's sourceFileChecksum is the file's MD5 hex. */
export async function commitScreenshot(
  creds: AscApiCredentials,
  screenshotId: string,
  md5Hex: string,
): Promise<void> {
  await ascRequest(creds, "PATCH", `/v1/appScreenshots/${encodeURIComponent(screenshotId)}`, {
    data: { type: "appScreenshots", id: screenshotId, attributes: { uploaded: true, sourceFileChecksum: md5Hex } },
  });
}

export async function getScreenshot(
  creds: AscApiCredentials,
  screenshotId: string,
): Promise<AscScreenshot | null> {
  const res = await ascRequest<{ data?: RawScreenshot }>(creds, "GET", `/v1/appScreenshots/${encodeURIComponent(screenshotId)}`);
  return res?.data ? toScreenshot(res.data) : null;
}

export async function deleteScreenshot(creds: AscApiCredentials, screenshotId: string): Promise<void> {
  await ascRequest(creds, "DELETE", `/v1/appScreenshots/${encodeURIComponent(screenshotId)}`);
}

/** Set the display order of a set: the full ordered list of its screenshot ids. */
export async function reorderScreenshots(
  creds: AscApiCredentials,
  setId: string,
  orderedIds: string[],
): Promise<void> {
  await ascRequest(creds, "PATCH", `/v1/appScreenshotSets/${encodeURIComponent(setId)}/relationships/appScreenshots`, {
    data: orderedIds.map((id) => ({ type: "appScreenshots", id })),
  });
}
