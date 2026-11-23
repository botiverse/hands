/**
 * Content-addressed desktop bundle files (publisher side).
 *
 *   POST /api/apps/:appId/desktop/files/missing   {files:[{sha256,size}]}
 *   POST /api/apps/:appId/desktop/files/complete  {files:[{sha256,size}]}
 *
 * A publisher asks which of its bundle's files Hands does not hold yet, PUTs only
 * those straight to R2 through presigned URLs, then asks Hands to verify them. The
 * verified copy lives at apps/{appId}/files/sha256/{sha256} and is shared by every
 * version that ships those bytes, so an unchanged file (a bundled Java runtime, say)
 * is uploaded once per app, ever.
 *
 * Verification is the same technique the build-asset completion uses: the staging
 * object is streamed into the content-addressed key with R2's `sha256` put option, so
 * R2 itself refuses bytes whose digest differs from the declared one. Nothing reaches
 * the content-addressed key unverified.
 */

import type { Context } from "hono";
import { currentActor, type AdminEnv } from "../middleware/auth";
import { presignR2UploadUrl } from "../lib/r2_presign";
import {
  DESKTOP_FILE_MAX_BYTES,
  chunked,
  DIGEST_CHUNK,
  desktopFileKey,
  desktopFileStagingKey,
  isSha256,
} from "../lib/desktop_manifest";
import {
  UploadStreamSizeError,
  fixedLengthBody,
  hashBody,
  limitObjectBody,
} from "./build_asset_uploads";

type AdminContext = Context<AdminEnv & { Bindings: Env }>;

/** Entries one `/missing` call may ask about. A large bundle has a few thousand files. */
export const MISSING_MAX_ENTRIES = 20_000;
/**
 * Entries one `/complete` call may verify. Each file costs up to five R2 operations
 * (head staging, head final, get, put, delete), so this keeps a request well inside
 * the per-invocation subrequest budget.
 */
export const COMPLETE_MAX_ENTRIES = 100;
/** Files verified at the same time inside one `/complete` call. */
const COMPLETE_CONCURRENCY = 4;
const UPLOAD_TTL_SECONDS = 3600;
const UPLOAD_CONTENT_TYPE = "application/octet-stream";

interface FileRef {
  sha256: string;
  size: number;
}

class FileListError extends Error {}

function parseFileList(body: unknown, max: number): FileRef[] {
  const files = (body as { files?: unknown } | null)?.files;
  if (!Array.isArray(files) || files.length === 0) throw new FileListError("files must be a non-empty array");
  if (files.length > max) throw new FileListError(`files may hold at most ${max} entries per request`);
  const seen = new Map<string, number>();
  const out: FileRef[] = [];
  files.forEach((entry, index) => {
    const item = (entry ?? {}) as { sha256?: unknown; size?: unknown };
    const sha256 = typeof item.sha256 === "string" ? item.sha256.toLowerCase() : item.sha256;
    if (!isSha256(sha256)) throw new FileListError(`files[${index}].sha256 must be a 64-character hexadecimal digest`);
    const size = item.size;
    if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0 || size > DESKTOP_FILE_MAX_BYTES) {
      throw new FileListError(`files[${index}].size must be an integer 0-${DESKTOP_FILE_MAX_BYTES}`);
    }
    const known = seen.get(sha256);
    if (known !== undefined) {
      if (known !== size) throw new FileListError(`files[${index}]: sha256 ${sha256} is listed with two different sizes`);
      return;
    }
    seen.set(sha256, size);
    out.push({ sha256, size });
  });
  return out;
}

async function readFileList(c: AdminContext, max: number): Promise<FileRef[] | Response> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "body must be JSON", code: "INVALID_DESKTOP_FILES" }, 400);
  }
  try {
    return parseFileList(body, max);
  } catch (error) {
    return c.json({ error: (error as Error).message, code: "INVALID_DESKTOP_FILES" }, 400);
  }
}

async function storedSizes(db: D1Database, appId: string, digests: string[]): Promise<Map<string, number>> {
  const stored = new Map<string, number>();
  for (const chunk of chunked(digests, DIGEST_CHUNK)) {
    const { results } = await db.prepare(
      `SELECT f.sha256, f.size_bytes
         FROM desktop_files f
         JOIN json_each(?2) j ON j.value = f.sha256
        WHERE f.app_id = ?1`,
    ).bind(appId, JSON.stringify(chunk)).all<{ sha256: string; size_bytes: number }>();
    for (const row of results) stored.set(row.sha256, Number(row.size_bytes));
  }
  return stored;
}

async function appExists(db: D1Database, appId: string): Promise<boolean> {
  const row = await db.prepare("SELECT id FROM apps WHERE id = ?1").bind(appId).first<{ id: string }>();
  return Boolean(row);
}

export async function handleDesktopFilesMissing(c: AdminContext) {
  const appId = c.req.param("appId") ?? "";
  const files = await readFileList(c, MISSING_MAX_ENTRIES);
  if (files instanceof Response) return files;
  if (!await appExists(c.env.DB, appId)) return c.json({ error: "app not found", code: "APP_NOT_FOUND" }, 404);
  const stored = await storedSizes(c.env.DB, appId, files.map((file) => file.sha256));
  const conflicts = files.filter((file) => stored.has(file.sha256) && stored.get(file.sha256) !== file.size);
  if (conflicts.length > 0) {
    // Same digest, different size: the client is describing bytes that cannot be
    // the stored ones. Say so instead of offering an upload that would fail.
    return c.json({
      error: "a listed sha256 is already stored with a different size",
      code: "DESKTOP_FILE_SIZE_CONFLICT",
      conflicts: conflicts.slice(0, 50).map((file) => ({ sha256: file.sha256, size: file.size, stored_size: stored.get(file.sha256) })),
    }, 409);
  }
  const absent = files.filter((file) => !stored.has(file.sha256));
  const expiresAt = Date.now() + UPLOAD_TTL_SECONDS * 1000;
  const missing = [];
  for (const file of absent) {
    const uploadUrl = await presignR2UploadUrl(c.env, desktopFileStagingKey(appId, file.sha256), UPLOAD_CONTENT_TYPE, UPLOAD_TTL_SECONDS);
    if (!uploadUrl) {
      return c.json({ error: "direct uploads are unavailable", code: "ASSET_UPLOAD_UNAVAILABLE", retryable: false }, 503);
    }
    missing.push({
      sha256: file.sha256,
      size: file.size,
      upload_url: uploadUrl,
      headers: { "content-type": UPLOAD_CONTENT_TYPE },
      expires_at: expiresAt,
    });
  }
  c.header("Cache-Control", "no-store");
  return c.json({ missing, present_count: files.length - absent.length });
}

export type DesktopFileStatus =
  | "stored"
  | "present"
  | "missing_upload"
  | "size_mismatch"
  | "sha256_mismatch"
  | "storage_error";

interface DesktopFileResult {
  sha256: string;
  size: number;
  status: DesktopFileStatus;
  retryable: boolean;
  actual_size?: number;
  actual_sha256?: string;
}

async function recordStored(db: D1Database, appId: string, file: FileRef): Promise<void> {
  await db.prepare(
    `INSERT OR IGNORE INTO desktop_files (app_id, sha256, size_bytes, created_at)
     VALUES (?1, ?2, ?3, ?4)`,
  ).bind(appId, file.sha256, file.size, Date.now()).run();
}

async function verifyOne(env: Env, appId: string, file: FileRef): Promise<DesktopFileResult> {
  const result = (status: DesktopFileStatus, extra: Partial<DesktopFileResult> = {}): DesktopFileResult => ({
    sha256: file.sha256,
    size: file.size,
    status,
    retryable: status === "storage_error",
    ...extra,
  });
  const stagingKey = desktopFileStagingKey(appId, file.sha256);
  const finalKey = desktopFileKey(appId, file.sha256);
  try {
    const staging = await env.APK_BUCKET.head(stagingKey);
    if (!staging) {
      // A previous completion may have sealed the bytes and then lost its D1 write.
      // The content-addressed key is only ever written by a digest-checked put, so
      // an object there with the declared size is the verified file.
      const sealed = await env.APK_BUCKET.head(finalKey);
      if (sealed && sealed.size === file.size) {
        await recordStored(env.DB, appId, file);
        return result("stored");
      }
      return result("missing_upload");
    }
    if (staging.size !== file.size) {
      await env.APK_BUCKET.delete(stagingKey).catch(() => {});
      return result("size_mismatch", { actual_size: staging.size });
    }
    const object = await env.APK_BUCKET.get(stagingKey);
    if (!object?.body || object.size !== file.size) return result("storage_error");
    const abort = new AbortController();
    const fixed = fixedLengthBody(limitObjectBody(object.body, file.size), file.size, abort.signal);
    const failTogether = <T>(operation: Promise<T>): Promise<T> =>
      operation.catch((error: unknown) => { abort.abort(error); throw error; });
    const [pump, put] = await Promise.allSettled([
      failTogether(fixed.pump),
      failTogether(env.APK_BUCKET.put(finalKey, fixed.readable, {
        httpMetadata: { contentType: UPLOAD_CONTENT_TYPE },
        customMetadata: { sha256: file.sha256 },
        // R2 computes the digest while it streams and refuses a mismatch, so the
        // content-addressed key can never hold other bytes than its name says.
        sha256: file.sha256,
      })),
    ]);
    if (pump.status === "rejected" || put.status === "rejected") {
      const sizeFailure = [pump, put].find((r) => r.status === "rejected" && r.reason instanceof UploadStreamSizeError);
      if (sizeFailure) {
        await env.APK_BUCKET.delete(stagingKey).catch(() => {});
        return result("size_mismatch", { actual_size: ((sizeFailure as PromiseRejectedResult).reason as UploadStreamSizeError).actualBytes });
      }
      // Tell an integrity refusal from a storage fault by hashing what was uploaded.
      // Only this failure path pays for a second read.
      const again = await env.APK_BUCKET.get(stagingKey).catch(() => null);
      const actual = again?.body ? await hashBody(again.body).catch(() => null) : null;
      if (actual && (actual.sha256 !== file.sha256 || actual.size !== file.size)) {
        await env.APK_BUCKET.delete(stagingKey).catch(() => {});
        return result(actual.size !== file.size ? "size_mismatch" : "sha256_mismatch", {
          actual_size: actual.size,
          actual_sha256: actual.sha256,
        });
      }
      return result("storage_error");
    }
    await recordStored(env.DB, appId, file);
    await env.APK_BUCKET.delete(stagingKey).catch(() => {});
    return result("stored");
  } catch {
    return result("storage_error");
  }
}

async function mapBounded<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      out[index] = await fn(items[index]!);
    }
  });
  await Promise.all(workers);
  return out;
}

export async function handleDesktopFilesComplete(c: AdminContext) {
  const appId = c.req.param("appId") ?? "";
  const files = await readFileList(c, COMPLETE_MAX_ENTRIES);
  if (files instanceof Response) return files;
  if (!await appExists(c.env.DB, appId)) return c.json({ error: "app not found", code: "APP_NOT_FOUND" }, 404);
  const stored = await storedSizes(c.env.DB, appId, files.map((file) => file.sha256));
  const results = await mapBounded(files, COMPLETE_CONCURRENCY, async (file): Promise<DesktopFileResult> => {
    const storedSize = stored.get(file.sha256);
    if (storedSize !== undefined) {
      return storedSize === file.size
        ? { sha256: file.sha256, size: file.size, status: "present", retryable: false }
        : { sha256: file.sha256, size: file.size, status: "size_mismatch", retryable: false, actual_size: storedSize };
    }
    return verifyOne(c.env, appId, file);
  });
  const count = (status: DesktopFileStatus) => results.filter((r) => r.status === status).length;
  const storedCount = count("stored");
  const presentCount = count("present");
  const failed = results.length - storedCount - presentCount;
  if (storedCount > 0) {
    await c.env.DB.prepare(
      `INSERT INTO audit_logs (id, app_id, action, actor, payload, created_at)
       VALUES (?1, ?2, 'desktop_files.complete', ?3, ?4, ?5)`,
    ).bind(
      crypto.randomUUID(), appId, currentActor(c),
      JSON.stringify({
        stored: storedCount,
        present: presentCount,
        failed,
        stored_bytes: results.filter((r) => r.status === "stored").reduce((sum, r) => sum + r.size, 0),
      }),
      Date.now(),
    ).run().catch(() => {});
  }
  c.header("Cache-Control", "no-store");
  return c.json({ ok: failed === 0, stored: storedCount, present: presentCount, failed, results });
}
