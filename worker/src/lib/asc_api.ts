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

export interface BuildUploadResource {
  id: string;
  attributes: {
    cfBundleShortVersionString: string | null;
    cfBundleVersion: string | null;
    platform: string | null;
    state: BuildUploadState | null;
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
