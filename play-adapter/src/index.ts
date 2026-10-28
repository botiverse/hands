import { createAccessToken, parsePlayCredential } from "./auth";
import { PlayAdapterError } from "./errors";
import { DEOBFUSCATION_FILE_KINDS, GooglePlayClient, MAX_SYMBOLS_SIZE_BYTES } from "./google_play";
import { pushStoreListings, readStoreListings, storeListingImagesInput, storeListingsInput } from "./store_listing";
import type {
  AdapterResult,
  DeobfuscationSymbolType,
  LocalizedReleaseNote,
  HandsTrack,
  PlayAdapterEnv,
  PlayBindingInput,
  PlayDiscoveryInput,
  PlayTracks,
  PromotionRequest,
  PromotionRpcInput,
  PromotionSymbolsRequest,
  SendForReviewRequest,
  SendForReviewResult,
  SendForReviewRpcInput,
  StoreListingPushResult,
  StoreListingPushRpcInput,
  StoreListingReadResult,
  StoreListingReadRpcInput,
  SymbolsRpcInput,
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

function discoveryInput(input: PlayDiscoveryInput): PlayDiscoveryInput {
  if (!input || typeof input !== "object") {
    throw new PlayAdapterError(400, "play_binding_invalid", "Google Play binding is invalid");
  }
  const packageName = typeof input.packageName === "string" ? input.packageName.trim() : "";
  if (!PACKAGE_NAME.test(packageName)) {
    throw new PlayAdapterError(400, "package_name_invalid", "Google Play package name is invalid");
  }
  return { credential: parsePlayCredential(input.credential), packageName };
}

function bindingInput(input: PlayBindingInput): PlayBindingInput {
  const binding = discoveryInput(input);
  const source = input.tracks as Partial<PlayTracks> | undefined;
  const tracks = {
    internal: typeof source?.internal === "string" ? source.internal.trim() : "",
    closed: typeof source?.closed === "string" ? source.closed.trim() : "",
    production: typeof source?.production === "string" ? source.production.trim() : "",
  };
  if (Object.values(tracks).some((track) => !TRACK_NAME.test(track))) {
    throw new PlayAdapterError(400, "track_name_invalid", "Google Play track name is invalid");
  }
  return { ...binding, tracks };
}

function trackInput(input: TrackMaximumRpcInput) {
  const binding = bindingInput(input);
  const handsTrack = input?.handsTrack;
  if (handsTrack !== "internal" && handsTrack !== "closed" && handsTrack !== "production") {
    throw new PlayAdapterError(400, "hands_track_invalid", "Hands track is invalid");
  }
  return { ...binding, handsTrack, playTrack: binding.tracks[handsTrack] };
}

/** Google Play caps LocalizedText release notes at 500 characters per language. */
export const MAX_RELEASE_NOTES_CHARS = 500;
/** BCP-47-shaped tag as Play lists them (en-US, zh-CN, fil, es-419). */
const PLAY_LANGUAGE = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;
const MAX_RELEASE_NOTES_LANGUAGES = 100;

/**
 * Validate release notes at the trust boundary. Hands maps and converts them;
 * the adapter refuses anything Play would reject rather than truncating. Length
 * is counted in Unicode code points.
 */
function releaseNotesInput(value: unknown): LocalizedReleaseNote[] | null {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value) || value.length > MAX_RELEASE_NOTES_LANGUAGES) {
    throw new PlayAdapterError(400, "release_notes_invalid", "Release notes must be a list of {language, text}");
  }
  const seen = new Set<string>();
  const notes: LocalizedReleaseNote[] = [];
  for (const item of value as Array<Partial<LocalizedReleaseNote> | null>) {
    const language = typeof item?.language === "string" ? item.language : "";
    const text = typeof item?.text === "string" ? item.text : "";
    if (!PLAY_LANGUAGE.test(language) || seen.has(language.toLowerCase()) || !text.trim()) {
      throw new PlayAdapterError(400, "release_notes_invalid", "Release notes need a unique Play language tag and non-empty text");
    }
    if ([...text].length > MAX_RELEASE_NOTES_CHARS) {
      throw new PlayAdapterError(400, "release_notes_too_long", `Release notes for ${language} exceed ${MAX_RELEASE_NOTES_CHARS} characters`);
    }
    seen.add(language.toLowerCase());
    notes.push({ language, text });
  }
  return notes.length > 0 ? notes : null;
}

/** A declared deobfuscation file must arrive with its stream, and a stream must be declared. */
function deobfuscationInput(
  symbolType: DeobfuscationSymbolType,
  declared: SymbolsRpcInput | null | undefined,
  stream: ReadableStream<Uint8Array> | null,
): PromotionSymbolsRequest | null {
  if (declared === null || declared === undefined) {
    if (stream !== null) {
      // An undeclared stream is a contract violation, not a silent extra upload.
      throw new PlayAdapterError(400, "promotion_request_invalid", "Hands promotion request is invalid");
    }
    return null;
  }
  const size = positiveInteger(declared.expectedSize);
  const sha = typeof declared.expectedSha256 === "string" ? declared.expectedSha256.toLowerCase() : "";
  if (size === null || !SHA256.test(sha) || !(stream instanceof ReadableStream)) {
    throw new PlayAdapterError(400, "promotion_request_invalid", "Hands promotion request is invalid");
  }
  if (size > MAX_SYMBOLS_SIZE_BYTES) {
    const kind = DEOBFUSCATION_FILE_KINDS[symbolType];
    throw new PlayAdapterError(413, kind.tooLargeCode, `${kind.label} exceed the Google Play maximum size`);
  }
  return { body: stream, expectedSha256: sha, expectedSize: size };
}

function promotionInput(
  input: PromotionRpcInput,
  body: ReadableStream<Uint8Array>,
  symbolsBody: ReadableStream<Uint8Array> | null,
  mappingBody: ReadableStream<Uint8Array> | null,
  env: PlayAdapterEnv,
): PromotionRequest {
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
  if (input.changesNotSentForReview !== undefined && typeof input.changesNotSentForReview !== "boolean") {
    throw new PlayAdapterError(400, "promotion_request_invalid", "Hands promotion request is invalid");
  }
  const symbols = deobfuscationInput("nativeCode", input.symbols, symbolsBody);
  const mapping = deobfuscationInput("proguard", input.mapping, mappingBody);
  const releaseNotes = releaseNotesInput(input.releaseNotes);
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
    symbols,
    mapping,
    releaseNotes,
    // Only carried when true, so a promotion without the flag is the same request as before.
    ...(input.changesNotSentForReview === true ? { changesNotSentForReview: true } : {}),
  };
}

function sendForReviewInput(input: SendForReviewRpcInput): SendForReviewRequest {
  const track = trackInput(input);
  const versionCode = positiveInteger(input.versionCode);
  const expectedSha256 = typeof input.expectedSha256 === "string" ? input.expectedSha256.toLowerCase() : "";
  const operationId = typeof input.operationId === "string" ? input.operationId : "";
  if (versionCode === null || versionCode > 2_100_000_000 || !SHA256.test(expectedSha256) || !OPERATION_ID.test(operationId)) {
    throw new PlayAdapterError(400, "send_for_review_request_invalid", "Hands send-for-review request is invalid");
  }
  return {
    packageName: track.packageName,
    handsTrack: track.handsTrack,
    playTrack: track.playTrack,
    versionCode,
    expectedSha256,
    operationId,
  };
}
function storeListingPushInput(input: StoreListingPushRpcInput) {
  const binding = discoveryInput(input);
  const operationId = typeof input?.operationId === "string" ? input.operationId : "";
  if (!OPERATION_ID.test(operationId) || (input.mode !== "dry_run" && input.mode !== "commit")) {
    throw new PlayAdapterError(400, "listing_request_invalid", "Hands store listing request is invalid");
  }
  for (const flag of [input.deleteUnlistedLanguages, input.changesNotSentForReview]) {
    if (flag !== undefined && typeof flag !== "boolean") {
      throw new PlayAdapterError(400, "listing_request_invalid", "Hands store listing request is invalid");
    }
  }
  const listings = storeListingsInput(input.listings);
  const images = storeListingImagesInput(input.images);
  if (listings.length === 0 && images.length === 0 && !input.deleteUnlistedLanguages) {
    throw new PlayAdapterError(400, "listing_request_invalid", "Hands store listing request names no listings");
  }
  return {
    ...binding,
    operationId,
    mode: input.mode,
    listings,
    deleteUnlistedLanguages: input.deleteUnlistedLanguages === true,
    changesNotSentForReview: input.changesNotSentForReview === true,
    images,
  };
}

function failure(error: unknown, operationId: string | null): AdapterResult<never> {
  const known = error instanceof PlayAdapterError;
  const status = known ? error.status : 502;
  const code = known ? error.code : "play_adapter_error";
  const message = known ? error.message : "Google Play adapter request failed";
  console.error(JSON.stringify({ event: "google_play_adapter_error", operation_id: operationId, code, status }));
  // Carry the provider-safe cause out to the caller. Every value is a constant this
  // adapter chose, so it is safe to transport and to persist in a receipt -- which is
  // where whoever triggers the next failure can actually read it, without needing
  // observability scope on the adapter's logs.
  const cause = known ? error.cause_detail : undefined;
  return { ok: false, error: { status, code, message, ...(cause ? { cause } : {}) } };
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

  /** A client for operations that need only the package (store listings are not track-scoped). */
  async function discoveryClient(input: PlayDiscoveryInput, env: PlayAdapterEnv) {
    const binding = discoveryInput(input);
    const token = await createAccessToken(binding.credential, fetchImpl, options.nowSeconds?.() ?? Math.floor(Date.now() / 1000));
    return { binding, client: new GooglePlayClient(token, fetchImpl, maxAabSize(env)) };
  }

  return {
    /** edits.details.get + edits.listings.list in a throwaway edit. */
    async readStoreListings(input: StoreListingReadRpcInput, env: PlayAdapterEnv): Promise<AdapterResult<StoreListingReadResult>> {
      try {
        const resolved = await discoveryClient(input, env);
        return { ok: true, value: await readStoreListings(resolved.client, resolved.binding.packageName) };
      } catch (error) { return failure(error, null); }
    },

    /** One edit: edits.listings.update/delete, edits.validate, then delete (dry_run) or commit. */
    async pushStoreListings(input: StoreListingPushRpcInput, env: PlayAdapterEnv): Promise<AdapterResult<StoreListingPushResult>> {
      const operationId = OPERATION_ID.test(input?.operationId ?? "") ? input.operationId : null;
      try {
        // Validate before OAuth: a malformed request never reaches Google.
        const request = storeListingPushInput(input);
        const resolved = await discoveryClient(request, env);
        return { ok: true, value: await pushStoreListings(resolved.client, request) };
      } catch (error) { return failure(error, operationId); }
    },

    async listTracks(input: PlayDiscoveryInput, env: PlayAdapterEnv): Promise<AdapterResult<{ client_email: string; package_name: string; tracks: string[] }>> {
      try {
        const binding = discoveryInput(input);
        const token = await createAccessToken(binding.credential, fetchImpl, options.nowSeconds?.() ?? Math.floor(Date.now() / 1000));
        const google = new GooglePlayClient(token, fetchImpl, maxAabSize(env));
        return { ok: true, value: { client_email: binding.credential.client_email, package_name: binding.packageName, tracks: await google.listTracks(binding.packageName) } };
      } catch (error) { return failure(error, null); }
    },
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

    async listReleaseStates(input: TrackMaximumRpcInput, env: PlayAdapterEnv): Promise<AdapterResult<import("./types").ReleaseSummary[]>> {
      try {
        const track = trackInput(input);
        const resolved = await client(track, env);
        return { ok: true, value: await resolved.client.listReleaseStates(track.packageName, track.playTrack) };
      } catch (error) { return failure(error, null); }
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

    /**
     * Commit an empty edit WITHOUT changesNotSentForReview (always ERROR_IF_IN_REVIEW),
     * after checking the accepted bundle and the track release are on Play.
     */
    async sendForReview(input: SendForReviewRpcInput, env: PlayAdapterEnv): Promise<AdapterResult<SendForReviewResult>> {
      const operationId = OPERATION_ID.test(input?.operationId ?? "") ? input.operationId : null;
      try {
        // Validate before OAuth: a malformed request never reaches Google.
        const request = sendForReviewInput(input);
        const resolved = await client(input, env);
        return { ok: true, value: await resolved.client.sendForReview(request) };
      } catch (error) {
        return failure(error, operationId);
      }
    },

    async promote(
      input: PromotionRpcInput,
      body: ReadableStream<Uint8Array>,
      symbolsBody: ReadableStream<Uint8Array> | null,
      env: PlayAdapterEnv,
      mappingBody: ReadableStream<Uint8Array> | null = null,
    ): Promise<AdapterResult<Awaited<ReturnType<GooglePlayClient["promote"]>>>> {
      const operationId = OPERATION_ID.test(input?.operationId ?? "") ? input.operationId : null;
      try {
        const promotion = promotionInput(input, body, symbolsBody, mappingBody, env);
        const resolved = await client(input, env);
        return { ok: true, value: await resolved.client.promote(promotion) };
      } catch (error) {
        return failure(error, operationId);
      }
    },
  };
}
