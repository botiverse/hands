import { createAccessToken, parseServiceAccount } from "./auth";
import { PlayAdapterError } from "./errors";
import { GooglePlayClient } from "./google_play";
import type {
  AdapterResult,
  HandsTrack,
  PlayAdapterEnv,
  PlayBindingInput,
  PlayTracks,
  PromotionRequest,
  PromotionRpcInput,
  TrackMaximumRpcInput,
} from "./types";

const PACKAGE_NAME = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/;
const SHA256 = /^[a-f0-9]{64}$/;
const OPERATION_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const TRACK_NAME = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function positiveInteger(value: unknown): number | null {
  const parsed = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  return typeof parsed === "number" && Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function maxAabSize(env: PlayAdapterEnv): number {
  const value = positiveInteger(env.MAX_AAB_SIZE_BYTES);
  if (value === null) {
    throw new PlayAdapterError(503, "aab_limit_invalid", "Google Play AAB size limit is not configured");
  }
  return value;
}

function bindingInput(input: PlayBindingInput): PlayBindingInput {
  if (!input || typeof input !== "object") {
    throw new PlayAdapterError(400, "play_binding_invalid", "Google Play binding is invalid");
  }
  const packageName = typeof input.packageName === "string" ? input.packageName.trim() : "";
  if (!PACKAGE_NAME.test(packageName)) {
    throw new PlayAdapterError(400, "package_name_invalid", "Google Play package name is invalid");
  }
  const source = input.tracks as Partial<PlayTracks> | undefined;
  const tracks = {
    internal: typeof source?.internal === "string" ? source.internal.trim() : "",
    closed: typeof source?.closed === "string" ? source.closed.trim() : "",
    production: typeof source?.production === "string" ? source.production.trim() : "",
  };
  if (Object.values(tracks).some((track) => !TRACK_NAME.test(track))) {
    throw new PlayAdapterError(400, "track_name_invalid", "Google Play track name is invalid");
  }
  return { credential: parseServiceAccount(input.credential), packageName, tracks };
}

function trackInput(input: TrackMaximumRpcInput) {
  const binding = bindingInput(input);
  const handsTrack = input?.handsTrack;
  if (handsTrack !== "internal" && handsTrack !== "closed" && handsTrack !== "production") {
    throw new PlayAdapterError(400, "hands_track_invalid", "Hands track is invalid");
  }
  return { ...binding, handsTrack, playTrack: binding.tracks[handsTrack] };
}

function promotionInput(input: PromotionRpcInput, body: ReadableStream<Uint8Array>, env: PlayAdapterEnv): PromotionRequest {
  const track = trackInput(input);
  const versionCode = positiveInteger(input.versionCode);
  const expectedSize = positiveInteger(input.expectedSize);
  const rolloutPercent = positiveInteger(input.rolloutPercent);
  const expectedSha256 = typeof input.expectedSha256 === "string" ? input.expectedSha256.toLowerCase() : "";
  const operationId = typeof input.operationId === "string" ? input.operationId : "";
  if (
    versionCode === null
    || expectedSize === null
    || !SHA256.test(expectedSha256)
    || rolloutPercent === null
    || rolloutPercent > 100
    || !OPERATION_ID.test(operationId)
    || !(body instanceof ReadableStream)
  ) {
    throw new PlayAdapterError(400, "promotion_request_invalid", "Hands promotion request is invalid");
  }
  if (track.handsTrack !== "production" && rolloutPercent !== 100) {
    throw new PlayAdapterError(400, "rollout_track_invalid", "Partial rollout is supported only on the production track");
  }
  if (expectedSize > maxAabSize(env)) {
    throw new PlayAdapterError(413, "aab_too_large", "AAB exceeds the configured maximum size");
  }
  return {
    packageName: track.packageName,
    handsTrack: track.handsTrack,
    playTrack: track.playTrack,
    versionCode,
    expectedSha256,
    expectedSize,
    rolloutPercent,
    operationId,
    body,
  };
}
function failure(error: unknown, operationId: string | null): AdapterResult<never> {
  const known = error instanceof PlayAdapterError;
  const status = known ? error.status : 502;
  const code = known ? error.code : "play_adapter_error";
  const message = known ? error.message : "Google Play adapter request failed";
  console.error(JSON.stringify({ event: "google_play_adapter_error", operation_id: operationId, code, status }));
  return { ok: false, error: { status, code, message } };
}

export interface AdapterOptions {
  fetchImpl?: typeof fetch;
  nowSeconds?: () => number;
}

export function createPlayAdapterService(options: AdapterOptions = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;

  async function client(input: PlayBindingInput, env: PlayAdapterEnv) {
    const binding = bindingInput(input);
    const accessToken = await createAccessToken(
      binding.credential,
      fetchImpl,
      options.nowSeconds?.() ?? Math.floor(Date.now() / 1000),
    );
    return { binding, client: new GooglePlayClient(accessToken, fetchImpl, maxAabSize(env)) };
  }

  return {
    async verifyBinding(input: PlayBindingInput, env: PlayAdapterEnv): Promise<AdapterResult<{
      client_email: string;
      package_name: string;
      tracks: PlayTracks;
    }>> {
      try {
        const resolved = await client(input, env);
        await resolved.client.verifyBinding(resolved.binding.packageName, Object.values(resolved.binding.tracks));
        return {
          ok: true,
          value: {
            client_email: resolved.binding.credential.client_email,
            package_name: resolved.binding.packageName,
            tracks: resolved.binding.tracks,
          },
        };
      } catch (error) {
        return failure(error, null);
      }
    },

    async readTrackMaximum(input: TrackMaximumRpcInput, env: PlayAdapterEnv): Promise<AdapterResult<{
      max_version_code: number;
    }>> {
      try {
        const resolvedInput = trackInput(input);
        const resolved = await client(resolvedInput, env);
        const maximum = await resolved.client.readTrackMaximum(resolvedInput.packageName, resolvedInput.playTrack);
        return { ok: true, value: { max_version_code: maximum } };
      } catch (error) {
        return failure(error, null);
      }
    },

    async promote(
      input: PromotionRpcInput,
      body: ReadableStream<Uint8Array>,
      env: PlayAdapterEnv,
    ): Promise<AdapterResult<Awaited<ReturnType<GooglePlayClient["promote"]>>>> {
      const operationId = OPERATION_ID.test(input?.operationId ?? "") ? input.operationId : null;
      try {
        const promotion = promotionInput(input, body, env);
        const resolved = await client(input, env);
        return { ok: true, value: await resolved.client.promote(promotion) };
      } catch (error) {
        return failure(error, operationId);
      }
    },
  };
}
