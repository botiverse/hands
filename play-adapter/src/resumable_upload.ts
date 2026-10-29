import { PlayAdapterError } from "./errors";
import { playUploadFailure } from "./provider_errors";
import type { PlayAdapterEnv } from "./types";

/**
 * Google's resumable media upload protocol, used for deobfuscation files at or
 * above a size threshold (smaller files keep the single-request simple upload).
 *
 * Why: on 2026-10-29 a 282,045,359-byte mapping.txt sent as one simple media
 * upload was answered 413 about ten seconds in. Whether Google caps simple
 * uploads or the transfer was cut is NOT known; resumable is the candidate fix,
 * to be confirmed by a production retry.
 *
 *   POST {upload path}?uploadType=resumable   (no body; X-Upload-Content-Type/-Length)
 *     -> 200 + Location: session URI
 *   PUT  session URI, Content-Range: bytes a-b/total, one chunk at a time
 *     -> 308 Resume Incomplete (Range: bytes=0-n says what Google persisted)
 *     -> 200/201 + the method's JSON result after the last byte
 *   On a 5xx / network error: PUT session URI, Content-Range: bytes * /total,
 *   empty body -> 308 + Range (resume from there) or 200/201 (already complete).
 *
 * Only one chunk is held in memory. Bytes Google did not persist are always
 * inside that chunk (a Range that points before it cannot be served from a
 * stream and fails as play_upload_incomplete).
 */

/** Google requires every non-final chunk to be a multiple of 256 KiB. */
export const RESUMABLE_CHUNK_GRANULARITY = 262_144;
/** 32 MiB: below every size that has failed, above the ~29 MB AABs (which never use this path). */
export const DEFAULT_RESUMABLE_THRESHOLD_BYTES = 33_554_432;
/** 8 MiB per PUT. */
export const DEFAULT_RESUMABLE_CHUNK_BYTES = 8_388_608;
/** Status-query-and-resume attempts allowed per stall (progress resets the count). */
export const RESUMABLE_MAX_RETRIES = 3;

export interface ResumableUploadOptions {
  /** Deobfuscation files of at least this many bytes use the resumable protocol. */
  thresholdBytes: number;
  /** Bytes per PUT; a multiple of RESUMABLE_CHUNK_GRANULARITY. */
  chunkBytes: number;
  /** Base delay before a status query after a failed chunk (doubles per retry). */
  retryDelayMs: number;
  maxRetries: number;
  /** Per-chunk request timeout. */
  chunkTimeoutMs: number;
}

export const DEFAULT_RESUMABLE_UPLOAD_OPTIONS: ResumableUploadOptions = {
  thresholdBytes: DEFAULT_RESUMABLE_THRESHOLD_BYTES,
  chunkBytes: DEFAULT_RESUMABLE_CHUNK_BYTES,
  retryDelayMs: 1_000,
  maxRetries: RESUMABLE_MAX_RETRIES,
  chunkTimeoutMs: 300_000,
};

function positiveSafeInteger(value: unknown): number | null {
  const parsed = typeof value === "string" && /^\d+$/.test(value.trim()) ? Number(value.trim()) : value;
  return typeof parsed === "number" && Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

/**
 * PLAY_RESUMABLE_UPLOAD_THRESHOLD_BYTES (default 33554432) and
 * PLAY_RESUMABLE_CHUNK_BYTES (default 8388608). An unset or invalid value (not
 * a positive integer; a chunk size that is not a multiple of 262144) falls back
 * to the default rather than failing the upload.
 */
export function resumableUploadOptions(env: PlayAdapterEnv | undefined): ResumableUploadOptions {
  const threshold = positiveSafeInteger(env?.PLAY_RESUMABLE_UPLOAD_THRESHOLD_BYTES);
  const chunk = positiveSafeInteger(env?.PLAY_RESUMABLE_CHUNK_BYTES);
  return {
    ...DEFAULT_RESUMABLE_UPLOAD_OPTIONS,
    thresholdBytes: threshold ?? DEFAULT_RESUMABLE_THRESHOLD_BYTES,
    chunkBytes: chunk !== null && chunk % RESUMABLE_CHUNK_GRANULARITY === 0 ? chunk : DEFAULT_RESUMABLE_CHUNK_BYTES,
  };
}

export interface ResumableUploadArgs {
  fetchImpl: typeof fetch;
  accessToken: string;
  /** The simple-upload URL without its query; `?uploadType=resumable` is appended. */
  uploadUrl: string;
  /** Declared byte count; sent as X-Upload-Content-Length and as every Content-Range total. */
  total: number;
  stage: string;
  /** Already passes through the caller's hashing transform. */
  source: ReadableStream<Uint8Array>;
  options: ResumableUploadOptions;
  /**
   * Called once the source has ended with exactly `total` bytes, BEFORE the final
   * chunk is sent: throws when the bytes do not match the declared identity, so
   * Google never receives a complete file Hands would refuse.
   */
  verify: () => void;
  /** The error for a source that is shorter or longer than `total`. */
  lengthMismatch: () => PlayAdapterError;
}

type ChunkOutcome =
  | { kind: "done"; response: Response }
  | { kind: "persisted"; offset: number }
  | { kind: "transient"; status?: number };

/** Session URIs are Google's; never send the bearer token anywhere else. */
function sessionUri(location: string | null): string | null {
  if (!location) return null;
  try {
    const url = new URL(location);
    return url.protocol === "https:" && (url.hostname === "googleapis.com" || url.hostname.endsWith(".googleapis.com"))
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

/** `Range: bytes=0-N` -> N+1 bytes persisted; absent -> 0; anything else -> null. */
export function persistedBytes(range: string | null): number | null {
  if (range === null || range.trim() === "") return 0;
  const match = /^bytes=0-(\d+)$/.exec(range.trim());
  if (!match) return null;
  const last = Number(match[1]);
  return Number.isSafeInteger(last) ? last + 1 : null;
}

async function discard(response: Response): Promise<void> {
  await response.arrayBuffer().catch(() => undefined);
}

/** Returns Google's final 200/201 response (body unread), or throws a PlayAdapterError. */
export async function resumableUpload(args: ResumableUploadArgs): Promise<Response> {
  const { fetchImpl, accessToken, total, stage, options } = args;
  const reader = args.source.getReader();
  let finished = false;
  try {
    // 1. Initiate the session.
    let initiation: Response;
    try {
      initiation = await fetchImpl(`${args.uploadUrl}?uploadType=resumable`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${accessToken}`,
          "content-type": "application/json; charset=UTF-8",
          "x-upload-content-type": "application/octet-stream",
          "x-upload-content-length": String(total),
        },
        body: "",
        redirect: "manual",
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      throw playUploadFailure("play_upload_session_failed", stage);
    }
    if (initiation.status === 413) {
      const body: unknown = await initiation.json().catch(() => null);
      throw playUploadFailure("play_upload_too_large", stage, 413, body);
    }
    if (initiation.status !== 200) {
      const body: unknown = await initiation.json().catch(() => null);
      throw playUploadFailure("play_upload_session_failed", stage, initiation.status, body);
    }
    await discard(initiation);
    const session = sessionUri(initiation.headers.get("location"));
    if (!session) throw playUploadFailure("play_upload_session_failed", stage, 200);

    // 2. Stream chunks. buf[0, windowLen) holds bytes [windowStart, windowStart + windowLen).
    const buf = new Uint8Array(Math.min(options.chunkBytes, total));
    let windowStart = 0;
    let windowLen = 0;
    let spill: Uint8Array | null = null;
    let ended = false;
    let verified = false;

    const next = async (): Promise<Uint8Array | null> => {
      if (spill) { const piece = spill; spill = null; return piece; }
      if (ended) return null;
      const { done, value } = await reader.read();
      if (done) { ended = true; return null; }
      return value;
    };
    const fill = async (): Promise<void> => {
      const cap = Math.min(buf.length, total - windowStart);
      while (windowLen < cap) {
        const piece = await next();
        if (piece === null) return;
        const take = Math.min(cap - windowLen, piece.byteLength);
        buf.set(piece.subarray(0, take), windowLen);
        windowLen += take;
        if (take < piece.byteLength) spill = piece.subarray(take);
      }
    };
    /** The source must end exactly at `total`. */
    const ensureEnded = async (): Promise<void> => {
      for (;;) {
        const piece = await next();
        if (piece === null) return;
        if (piece.byteLength > 0) throw args.lengthMismatch();
      }
    };
    const send = async (headers: Record<string, string>, body: Uint8Array<ArrayBuffer> | null): Promise<ChunkOutcome> => {
      let response: Response;
      try {
        response = await fetchImpl(session, {
          method: "PUT",
          headers: { authorization: `Bearer ${accessToken}`, ...headers },
          ...(body ? { body } : {}),
          redirect: "manual",
          signal: AbortSignal.timeout(options.chunkTimeoutMs),
        });
      } catch {
        return { kind: "transient" };
      }
      if (response.status === 200 || response.status === 201) return { kind: "done", response };
      if (response.status === 308) {
        const offset = persistedBytes(response.headers.get("range"));
        await discard(response);
        if (offset === null) throw playUploadFailure("play_upload_incomplete", stage, 308);
        return { kind: "persisted", offset };
      }
      if (response.status >= 500) {
        await discard(response);
        return { kind: "transient", status: response.status };
      }
      const errorBody: unknown = await response.json().catch(() => null);
      if (response.status === 413) throw playUploadFailure("play_upload_too_large", stage, 413, errorBody);
      // 4xx on a session (404/410: expired or unknown) cannot be resumed.
      throw playUploadFailure("play_upload_interrupted", stage, response.status, errorBody);
    };

    let retries = 0;
    let query = false;
    let lastStatus: number | undefined;
    for (;;) {
      let outcome: ChunkOutcome;
      if (query) {
        outcome = await send({ "content-length": "0", "content-range": `bytes */${total}` }, null);
      } else {
        await fill();
        const end = windowStart + windowLen;
        if (end < total && windowLen < Math.min(buf.length, total - windowStart)) {
          throw args.lengthMismatch(); // source ended early
        }
        if (end === total && !verified) {
          await ensureEnded();
          args.verify();
          verified = true;
        }
        outcome = await send({
          "content-length": String(windowLen),
          "content-range": `bytes ${windowStart}-${end - 1}/${total}`,
        }, buf.subarray(0, windowLen));
      }
      const fromQuery = query;
      if (outcome.kind === "transient") {
        lastStatus = outcome.status ?? lastStatus;
        retries += 1;
        if (retries > options.maxRetries) throw playUploadFailure("play_upload_interrupted", stage, lastStatus);
        if (options.retryDelayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, options.retryDelayMs * 2 ** (retries - 1)));
        }
        query = true;
        continue;
      }
      query = false;
      const end = windowStart + windowLen;
      if (outcome.kind === "done") {
        // Completion is only believable once every byte was sent and verified.
        if (end !== total || !verified) {
          await discard(outcome.response);
          throw playUploadFailure("play_upload_incomplete", stage, outcome.response.status);
        }
        finished = true;
        return outcome.response;
      }
      const offset = outcome.offset;
      if (offset < windowStart || offset > end || offset === total) {
        // Before the held chunk (already discarded), beyond what was sent, or
        // "all bytes persisted" without a final answer: nothing safe to resume.
        throw playUploadFailure("play_upload_incomplete", stage, 308);
      }
      if (offset === windowStart && !fromQuery) {
        retries += 1;
        if (retries > options.maxRetries) throw playUploadFailure("play_upload_interrupted", stage, 308);
      } else if (offset > windowStart) {
        retries = 0;
      }
      const persisted = offset - windowStart;
      buf.copyWithin(0, persisted, windowLen);
      windowLen -= persisted;
      windowStart = offset;
    }
  } finally {
    if (!finished) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
