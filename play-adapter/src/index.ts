import { createAccessToken, parseServiceAccount } from "./auth";
import { PlayAdapterError, safeErrorResponse } from "./errors";
import { GooglePlayClient } from "./google_play";
import type { HandsTrack, PlayAdapterEnv, PromotionRequest } from "./types";

const PACKAGE_NAME = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/;
const SHA256 = /^[a-f0-9]{64}$/;
const OPERATION_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const TRACK_NAME = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function positiveInteger(value: string | null): number | null {
  if (!value || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function handsTrack(value: string): HandsTrack | null {
  return value === "internal" || value === "closed" || value === "production" ? value : null;
}

function configuredPackages(env: PlayAdapterEnv): Set<string> {
  const packages = (env.ALLOWED_PACKAGE_NAMES ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (packages.length === 0 || packages.some((value) => !PACKAGE_NAME.test(value))) {
    throw new PlayAdapterError(503, "package_allowlist_invalid", "Google Play package allowlist is not configured");
  }
  return new Set(packages);
}

function maxAabSize(env: PlayAdapterEnv): number {
  const value = positiveInteger(env.MAX_AAB_SIZE_BYTES ?? null);
  if (value === null) {
    throw new PlayAdapterError(503, "aab_limit_invalid", "Google Play AAB size limit is not configured");
  }
  return value;
}

function playTrack(env: PlayAdapterEnv, track: HandsTrack): string {
  if (track === "internal") return "qa";
  if (track === "production") return "production";
  const value = env.GOOGLE_PLAY_CLOSED_TRACK_NAME?.trim() ?? "";
  if (!TRACK_NAME.test(value) || value === "qa" || value === "production") {
    throw new PlayAdapterError(503, "closed_track_invalid", "Google Play closed-testing track is not configured");
  }
  return value;
}

function route(request: Request): { packageName: string; track?: HandsTrack; operation: "track" | "promote" } | null {
  const parts = new URL(request.url).pathname.split("/").filter(Boolean);
  if (parts.length === 5 && parts[0] === "v1" && parts[1] === "apps" && parts[3] === "tracks") {
    const track = handsTrack(parts[4] ?? "");
    if (!track) return null;
    try {
      return { packageName: decodeURIComponent(parts[2] ?? ""), track, operation: "track" };
    } catch {
      return null;
    }
  }
  if (parts.length === 4 && parts[0] === "v1" && parts[1] === "apps" && parts[3] === "edits") {
    try {
      return { packageName: decodeURIComponent(parts[2] ?? ""), operation: "promote" };
    } catch {
      return null;
    }
  }
  return null;
}

function promotionRequest(
  request: Request,
  packageName: string,
  env: PlayAdapterEnv,
): PromotionRequest {
  const track = handsTrack(request.headers.get("x-hands-track") ?? "");
  const versionCode = positiveInteger(request.headers.get("x-hands-version-code"));
  const expectedSize = positiveInteger(request.headers.get("x-hands-size-bytes"));
  const expectedSha256 = request.headers.get("x-hands-sha256")?.toLowerCase() ?? "";
  const rolloutPercent = positiveInteger(request.headers.get("x-hands-rollout-percent"));
  const operationId = request.headers.get("x-hands-operation-id") ?? "";
  if (
    !track
    || versionCode === null
    || expectedSize === null
    || !SHA256.test(expectedSha256)
    || rolloutPercent === null
    || rolloutPercent > 100
    || !OPERATION_ID.test(operationId)
    || !request.body
  ) {
    throw new PlayAdapterError(400, "promotion_request_invalid", "Hands promotion request is invalid");
  }
  if (track !== "production" && rolloutPercent !== 100) {
    throw new PlayAdapterError(400, "rollout_track_invalid", "Partial rollout is supported only on the production track");
  }
  return {
    packageName,
    handsTrack: track,
    playTrack: playTrack(env, track),
    versionCode,
    expectedSha256,
    expectedSize,
    rolloutPercent,
    operationId,
    body: request.body,
  };
}

export interface AdapterOptions {
  fetchImpl?: typeof fetch;
  nowSeconds?: () => number;
}

export function createPlayAdapter(options: AdapterOptions = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  return {
    async fetch(request: Request, env: PlayAdapterEnv): Promise<Response> {
      let operationId: string | null = request.headers.get("x-hands-operation-id");
      try {
        const matched = route(request);
        if (!matched || (matched.operation === "track" ? request.method !== "GET" : request.method !== "POST")) {
          return new Response("Not found", { status: 404 });
        }
        if (!PACKAGE_NAME.test(matched.packageName) || !configuredPackages(env).has(matched.packageName)) {
          throw new PlayAdapterError(403, "package_not_allowed", "Google Play package is not allowed");
        }
        let promotion: PromotionRequest | null = null;
        if (matched.operation === "promote") {
          promotion = promotionRequest(request, matched.packageName, env);
          operationId = promotion.operationId;
          const contentLength = request.headers.get("content-length");
          if (contentLength !== null && positiveInteger(contentLength) !== promotion.expectedSize) {
            throw new PlayAdapterError(409, "aab_size_mismatch", "AAB content length did not match Hands");
          }
          if (promotion.expectedSize > maxAabSize(env)) {
            throw new PlayAdapterError(413, "aab_too_large", "AAB exceeds the configured maximum size");
          }
        }
        const credential = parseServiceAccount(env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON);
        const accessToken = await createAccessToken(
          credential,
          fetchImpl,
          options.nowSeconds?.() ?? Math.floor(Date.now() / 1000),
        );
        const client = new GooglePlayClient(accessToken, fetchImpl, maxAabSize(env));
        if (matched.operation === "track") {
          const mappedTrack = playTrack(env, matched.track!);
          const maximum = await client.readTrackMaximum(matched.packageName, mappedTrack);
          return Response.json({ max_version_code: maximum });
        }
        return Response.json(await client.promote(promotion!));
      } catch (error) {
        return safeErrorResponse(error, OPERATION_ID.test(operationId ?? "") ? operationId : null);
      }
    },
  };
}

export default createPlayAdapter();
