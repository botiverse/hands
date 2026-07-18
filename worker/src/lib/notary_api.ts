/**
 * Apple Notary API client — JWT auth + submission lifecycle.
 *
 * Mirrors the ASC API client (asc_api.ts) but targets the Notary REST API
 * (appstoreconnect.apple.com/notary/v2). Auth is identical: the SAME App
 * Store Connect API key (ES256 JWT) authenticates notary submissions.
 *
 * Apple doc: "Use the same key to sign tokens for the notary service that
 * you use for the App Store Connect API."
 *
 * Field names verified from Apple official docs (2026-07-18):
 *   Status response: data.attributes.{status, name, createdDate}
 *   Status values: "In Progress" (WITH SPACE), "Accepted", "Invalid", "Rejected"
 *   Log response:  data.attributes.developerLogUrl (NOT logUrl)
 *   Log JSON:      { sha256, jobId, ... } (NOT archiveHash)
 *
 * S3 upload uses aws4fetch (SigV4) — already a worker dependency, used by r2_presign.ts.
 *
 * Secrets: .p8 key, temp AWS creds, developerLogUrl are NEVER persisted or returned.
 */

import type { AscApiCredentials } from "./asc_api";
import { createAscJwt, AscApiError } from "./asc_api";
import { AwsClient } from "aws4fetch";

export const NOTARY_API_BASE = "https://appstoreconnect.apple.com/notary/v2";

// ──────────── Authenticated request ────────────

export async function notaryRequest<T>(
  creds: AscApiCredentials,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const jwt = await createAscJwt(creds);
  const res = await fetch(`${NOTARY_API_BASE}${path}`, {
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
    // non-JSON body
  }
  if (!res.ok) {
    const errors = (
      parsed as { errors?: Array<{ title?: string; detail?: string }> } | undefined
    )?.errors;
    const first = errors?.[0];
    throw new AscApiError(
      res.status,
      first?.title ?? `Notary API ${method} ${path} failed (${res.status})`,
      first?.detail ?? (parsed ? null : text.slice(0, 500) || null),
    );
  }
  return parsed as T;
}

// ──────────── Types (verified field names) ────────────

export interface NotarySubmissionRequest {
  submissionName: string;
  sha256: string;
  notifications?: Array<{ channel: string; target: string }>;
}

export interface NotarySubmissionResponse {
  data: {
    id: string;
    type: "submissionsPostResponse";
    attributes: {
      awsAccessKeyId: string;
      awsSecretAccessKey: string;
      awsSessionToken: string;
      bucket: string;
      object: string;
    };
  };
  meta: Record<string, unknown>;
}

/** Apple status values — note "In Progress" has a SPACE. */
export type NotaryStatus = "In Progress" | "Accepted" | "Invalid" | "Rejected";

export interface NotarySubmissionStatusResponse {
  data: {
    id: string;
    type: "submissions";
    attributes: {
      name: string | null;
      status: NotaryStatus | null;
      createdDate: string | null;
    };
  };
}

export interface NotaryLogUrlResponse {
  data: {
    id: string;
    type: "submissionsLog";
    attributes: {
      developerLogUrl: string;  // NOT "logUrl"
    };
  };
}

/** Log JSON fetched from developerLogUrl — binding fields are sha256 + jobId. */
export interface NotaryLogJson {
  sha256?: string;   // artifact hash for binding verification
  jobId?: string;    // must match submission id
  issues?: Array<{ severity: string; message: string }>;
  [key: string]: unknown;
}

// ──────────── UUID validation ────────────

function validateSubmissionId(id: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    throw new AscApiError(400, "invalid submission id", "submission id must be a UUID");
  }
}

// ──────────── API operations ────────────

export async function createNotarySubmission(
  creds: AscApiCredentials,
  req: NotarySubmissionRequest,
): Promise<NotarySubmissionResponse> {
  return notaryRequest<NotarySubmissionResponse>(creds, "POST", "/submissions", req);
}

export async function getNotarySubmissionStatus(
  creds: AscApiCredentials,
  submissionId: string,
): Promise<NotarySubmissionStatusResponse> {
  validateSubmissionId(submissionId);
  return notaryRequest<NotarySubmissionStatusResponse>(
    creds, "GET", `/submissions/${submissionId}`,
  );
}

export async function getNotarySubmissionLog(
  creds: AscApiCredentials,
  submissionId: string,
): Promise<{ developerLogUrl: string; log: NotaryLogJson }> {
  validateSubmissionId(submissionId);
  const logResp = await notaryRequest<NotaryLogUrlResponse>(
    creds, "GET", `/submissions/${submissionId}/logs`,
  );
  const developerLogUrl = logResp.data.attributes.developerLogUrl;
  // Fetch the actual log JSON — URL is short-lived.
  const logFetch = await fetch(developerLogUrl);
  if (!logFetch.ok) {
    throw new AscApiError(
      logFetch.status,
      `failed to fetch notary log JSON (${logFetch.status})`,
    );
  }
  const log = (await logFetch.json()) as NotaryLogJson;
  return { developerLogUrl, log };
}

/**
 * Upload artifact to Apple's S3 using temp credentials from createNotarySubmission.
 * Uses aws4fetch for SigV4 signing (same library as r2_presign.ts).
 *
 * The body is a ReadableStream from R2 — streamed directly, never buffered.
 * Returns the S3 ETag receipt (NOT a content hash — do not use for integrity).
 */
export async function uploadArtifactToS3(
  attrs: NotarySubmissionResponse["data"]["attributes"],
  body: ReadableStream<Uint8Array>,
  contentType = "application/octet-stream",
): Promise<{ etag: string | null }> {
  const url = `https://${attrs.bucket}.s3-accelerate.amazonaws.com/${attrs.object}`;

  const aws = new AwsClient({
    accessKeyId: attrs.awsAccessKeyId,
    secretAccessKey: attrs.awsSecretAccessKey,
    sessionToken: attrs.awsSessionToken,
    service: "s3",
    region: "us-east-1",  // Apple's Notary S3 uses us-east-1
    retries: 0,
  });

  const signedReq = await aws.sign(url, {
    method: "PUT",
    headers: { "content-type": contentType },
    body,
  });

  const res = await fetch(signedReq);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new AscApiError(
      res.status,
      `S3 artifact upload failed (${res.status})`,
      text.slice(0, 500) || null,
    );
  }

  // S3 returns ETag header (content MD5 in classic S3, but NOT reliable as
  // content hash — we only use it as a receipt, never for integrity verification).
  const etag = res.headers.get("etag");
  // Strip quotes if present (S3 ETags are quoted)
  return { etag: etag ? etag.replace(/^"|"$/g, "") : null };
}
