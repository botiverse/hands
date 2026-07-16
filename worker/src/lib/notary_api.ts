/**
 * Apple Notary API client.
 *
 * Hands owns the encrypted App Store Connect key. A caller uploads an already
 * Developer-ID-signed artifact to Hands, then this client creates a Notary API
 * submission and streams the exact R2 bytes to Apple's temporary S3 object.
 * The private key and Apple's temporary AWS credentials never leave Hands.
 *
 * Apple reference:
 * https://developer.apple.com/documentation/notaryapi/submitting-software-for-notarization-over-the-web
 */

import { AwsClient } from "aws4fetch";
import { createAscJwt, type AscApiCredentials } from "./asc_api";

export const NOTARY_API_BASE = "https://appstoreconnect.apple.com/notary/v2";
const NOTARY_UPLOAD_REGION = "us-west-2";

export type NotaryStatus = "Accepted" | "In Progress" | "Invalid" | "Rejected";

export type NotarySubmission = {
  id: string;
  attributes: {
    name: string;
    status: NotaryStatus;
    createdDate: string;
  };
  type: string;
};

export type NewNotarySubmission = {
  id: string;
  attributes: {
    awsAccessKeyId: string;
    awsSecretAccessKey: string;
    awsSessionToken: string;
    bucket: string;
    object: string;
  };
  type: string;
};

export type NotaryLog = Record<string, unknown>;

export type NotaryArtifactBinding = {
  verified: boolean;
  appleSha256: string | null;
  error: string | null;
};

export class NotaryApiError extends Error {
  readonly status: number;
  readonly detail: string | null;

  constructor(status: number, message: string, detail: string | null = null) {
    super(message);
    this.name = "NotaryApiError";
    this.status = status;
    this.detail = detail;
  }
}

async function parseResponse<T>(res: Response, operation: string): Promise<T> {
  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    // Keep the bounded raw response as the fallback error detail.
  }
  if (!res.ok) {
    const errors = (parsed as {
      errors?: Array<{ status?: string; title?: string; detail?: string }>;
    } | null)?.errors;
    const first = errors?.[0];
    throw new NotaryApiError(
      res.status,
      first?.title ?? `${operation} failed (${res.status})`,
      first?.detail ?? (parsed ? null : text.slice(0, 500) || null),
    );
  }
  return parsed as T;
}

export async function notaryRequest<T>(
  credentials: AscApiCredentials,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<T> {
  const jwt = await createAscJwt(credentials);
  const res = await fetch(`${NOTARY_API_BASE}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${jwt}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return parseResponse<T>(res, `Notary API ${method} ${path}`);
}

export async function createNotarySubmission(
  credentials: AscApiCredentials,
  args: { submissionName: string; sha256: string },
): Promise<NewNotarySubmission> {
  const res = await notaryRequest<{ data: NewNotarySubmission }>(
    credentials,
    "POST",
    "/submissions",
    {
      submissionName: args.submissionName,
      sha256: args.sha256,
    },
  );
  return res.data;
}

export async function getNotarySubmission(
  credentials: AscApiCredentials,
  submissionId: string,
): Promise<NotarySubmission> {
  const res = await notaryRequest<{ data: NotarySubmission }>(
    credentials,
    "GET",
    `/submissions/${encodeURIComponent(submissionId)}`,
  );
  return res.data;
}

export async function getNotarySubmissionLog(
  credentials: AscApiCredentials,
  submissionId: string,
): Promise<NotaryLog> {
  const res = await notaryRequest<{
    data: { attributes: { developerLogUrl: string } };
  }>(
    credentials,
    "GET",
    `/submissions/${encodeURIComponent(submissionId)}/logs`,
  );
  const logUrl = res.data.attributes.developerLogUrl;
  const logResponse = await fetch(logUrl);
  return parseResponse<NotaryLog>(logResponse, "Notary developer log download");
}

function encodeS3ObjectKey(value: string): string {
  return value.split("/").map(encodeURIComponent).join("/");
}

/**
 * Stream an R2 object to the temporary S3 destination Apple returned. The
 * query-signed request uses UNSIGNED-PAYLOAD, so aws4fetch never buffers the
 * artifact merely to compute another digest; Apple independently matches the
 * uploaded bytes against the SHA-256 supplied when creating the submission.
 */
export async function uploadNotaryArtifact(
  submission: NewNotarySubmission,
  artifact: { body: ReadableStream<Uint8Array>; size: number },
): Promise<void> {
  const attrs = submission.attributes;
  const aws = new AwsClient({
    accessKeyId: attrs.awsAccessKeyId,
    secretAccessKey: attrs.awsSecretAccessKey,
    sessionToken: attrs.awsSessionToken,
    service: "s3",
    region: NOTARY_UPLOAD_REGION,
    retries: 0,
  });
  const url = new URL(
    `https://${attrs.bucket}.s3-accelerate.amazonaws.com/${encodeS3ObjectKey(attrs.object)}`,
  );
  // Keep the presign lifetime below Apple's 12-hour temporary credential TTL.
  url.searchParams.set("X-Amz-Expires", "3600");
  const request = await aws.sign(url, {
    method: "PUT",
    headers: { "content-length": String(artifact.size) },
    body: artifact.body,
    aws: { signQuery: true },
  });
  const res = await fetch(request);
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 500);
    throw new NotaryApiError(
      res.status,
      `Apple notarization S3 upload failed (${res.status})`,
      detail || null,
    );
  }
}

export function isTerminalNotaryStatus(status: string): boolean {
  return status === "Accepted" || status === "Invalid" || status === "Rejected";
}

/**
 * Apple includes the digest it actually notarized in the terminal developer
 * log. Do not turn `Accepted` into a staple gate until that digest matches the
 * caller's app-scoped R2 upload. Size is bound separately by the R2 object
 * length and is returned to the caller on every status read.
 */
export function verifyNotaryArtifactBinding(
  log: NotaryLog | null,
  expectedSha256: string,
): NotaryArtifactBinding {
  if (!log) {
    return {
      verified: false,
      appleSha256: null,
      error: "Apple developer log is not available yet",
    };
  }
  const rawSha256 = log.sha256;
  const appleSha256 =
    typeof rawSha256 === "string" ? rawSha256.trim().toLowerCase() : null;
  if (!appleSha256 || !/^[a-f0-9]{64}$/.test(appleSha256)) {
    return {
      verified: false,
      appleSha256,
      error: "Apple developer log did not contain a valid SHA-256",
    };
  }
  if (appleSha256 !== expectedSha256.toLowerCase()) {
    return {
      verified: false,
      appleSha256,
      error: "Apple notarized SHA-256 does not match the submitted artifact",
    };
  }
  return { verified: true, appleSha256, error: null };
}
