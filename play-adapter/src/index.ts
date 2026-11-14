import { createAccessToken, parsePlayCredential, PLAY_REPORTS_SCOPE } from "./auth";
import { PlayAdapterError } from "./errors";
import { DEOBFUSCATION_FILE_KINDS, GooglePlayClient, MAX_SYMBOLS_SIZE_BYTES } from "./google_play";
import { resumableUploadOptions } from "./resumable_upload";
import { pushStoreListings, readStoreListings, storeListingImagesInput, storeListingsInput } from "./store_listing";
import { normalizeProduct, reconcileProduct } from "./subscription_products";
import {
  MAX_STATS_OBJECT_BYTES,
  PlayStatsStorageClient,
  statsBucketInput,
  statsObjectInput,
  statsPackageInput,
  statsReportInput,
  type StatsObject,
  type StatsReport,
} from "./stats_reports";
import type {
  AdapterResult,
  DeobfuscationSymbolType,
  LocalizedReleaseNote,
  HandsTrack,
  PlayAdapterEnv,
  PlayApiMethod,
  PlayApiProxyRequest,
  PlayApiProxyResult,
  PlayApiProxyRpcInput,
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
  StatsListRpcInput,
  StatsReadRpcInput,
  SymbolsRpcInput,
  TrackMaximumRpcInput,
  UpdateReleaseNotesRequest,
  UpdateReleaseNotesResult,
  UpdateReleaseNotesRpcInput,
  UploadDeobfuscationRequest,
  UploadDeobfuscationResult,
  UploadDeobfuscationRpcInput,
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
  if (input.cancelInReview !== undefined && typeof input.cancelInReview !== "boolean") {
    throw new PlayAdapterError(400, "promotion_request_invalid", "Hands promotion request is invalid");
  }
  if (input.cancelInReview === true && input.changesNotSentForReview === true) {
    throw new PlayAdapterError(400, "promotion_request_invalid", "cancelInReview cannot be combined with changesNotSentForReview");
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
    ...(input.cancelInReview === true ? { cancelInReview: true } : {}),
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
/** updateReleaseNotes input: the notes are required and validated like promote's. */
function updateReleaseNotesInput(input: UpdateReleaseNotesRpcInput): UpdateReleaseNotesRequest {
  const track = trackInput(input);
  const versionCode = positiveInteger(input.versionCode);
  const expectedSha256 = typeof input.expectedSha256 === "string" ? input.expectedSha256.toLowerCase() : "";
  const operationId = typeof input.operationId === "string" ? input.operationId : "";
  if (versionCode === null || versionCode > 2_100_000_000 || !SHA256.test(expectedSha256) || !OPERATION_ID.test(operationId)) {
    throw new PlayAdapterError(400, "release_notes_request_invalid", "Hands release notes request is invalid");
  }
  const releaseNotes = releaseNotesInput(input.releaseNotes);
  if (!releaseNotes) {
    throw new PlayAdapterError(400, "release_notes_invalid", "Release notes are required to update them");
  }
  return {
    packageName: track.packageName,
    handsTrack: track.handsTrack,
    playTrack: track.playTrack,
    versionCode,
    expectedSha256,
    operationId,
    releaseNotes,
  };
}

/**
 * uploadDeobfuscation input. At least one file must be declared. On dry_run no
 * stream may be passed (nothing is uploaded); on commit every declared file must
 * arrive with its stream and no undeclared stream is accepted.
 */
function uploadDeobfuscationInput(
  input: UploadDeobfuscationRpcInput,
  mappingBody: ReadableStream<Uint8Array> | null,
  symbolsBody: ReadableStream<Uint8Array> | null,
): UploadDeobfuscationRequest {
  const invalid = () => new PlayAdapterError(400, "deobfuscation_request_invalid", "Hands deobfuscation upload request is invalid");
  const binding = discoveryInput(input);
  const versionCode = positiveInteger(input.versionCode);
  const expectedSha256 = typeof input.expectedSha256 === "string" ? input.expectedSha256.toLowerCase() : "";
  const operationId = typeof input.operationId === "string" ? input.operationId : "";
  const mode = input.mode;
  if (
    versionCode === null || versionCode > 2_100_000_000 || !SHA256.test(expectedSha256)
    || !OPERATION_ID.test(operationId) || (mode !== "dry_run" && mode !== "commit")
  ) {
    throw invalid();
  }
  const files: UploadDeobfuscationRequest["files"] = [];
  // Same order as promote: native symbols first, then the mapping.
  for (const [symbolType, declared, stream] of [
    ["nativeCode", input.symbols, symbolsBody],
    ["proguard", input.mapping, mappingBody],
  ] as Array<[DeobfuscationSymbolType, SymbolsRpcInput | null | undefined, ReadableStream<Uint8Array> | null]>) {
    if (declared === null || declared === undefined) {
      if (stream !== null) throw invalid();
      continue;
    }
    if (mode === "dry_run") {
      if (stream !== null) throw invalid();
      const size = positiveInteger(declared.expectedSize);
      const sha = typeof declared.expectedSha256 === "string" ? declared.expectedSha256.toLowerCase() : "";
      if (size === null || !SHA256.test(sha)) throw invalid();
      if (size > MAX_SYMBOLS_SIZE_BYTES) {
        const kind = DEOBFUSCATION_FILE_KINDS[symbolType];
        throw new PlayAdapterError(413, kind.tooLargeCode, `${kind.label} exceed the Google Play maximum size`);
      }
      files.push({ symbolType, expectedSha256: sha, expectedSize: size, body: null });
      continue;
    }
    let checked: PromotionSymbolsRequest | null;
    try {
      checked = deobfuscationInput(symbolType, declared, stream);
    } catch (error) {
      if (error instanceof PlayAdapterError && error.code === "promotion_request_invalid") throw invalid();
      throw error;
    }
    files.push({ symbolType, expectedSha256: checked!.expectedSha256, expectedSize: checked!.expectedSize, body: checked!.body });
  }
  if (files.length === 0) throw invalid();
  return { packageName: binding.packageName, mode, versionCode, expectedSha256, operationId, files };
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

const PLAY_API_METHODS = new Set<PlayApiMethod>(["GET", "POST", "PUT", "PATCH", "DELETE"]);

export function normalizePlayApiPath(packageName: string, rawPath: string): {
  canonicalPath: string;
  inlineQuery: Record<string, string[]>;
} {
  const invalid = (message = "Google Play API path is invalid") =>
    new PlayAdapterError(400, "play_api_path_invalid", message);
  if (typeof rawPath !== "string" || !rawPath.trim()) throw invalid();
  const trimmed = rawPath.trim();
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed)) {
    throw invalid("Google Play API path must be a path, not a full URL");
  }
  if (trimmed.startsWith("//") || trimmed.includes("\\")) {
    throw invalid();
  }
  const [pathnamePart = "", searchPart] = trimmed.split("?", 2);
  if (pathnamePart.includes("#")) throw invalid();
  const rawSegments = pathnamePart.replace(/^\/+/, "").split("/").filter((s) => s.length > 0);
  for (const seg of rawSegments) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(seg);
    } catch {
      throw invalid();
    }
    if (decoded === "." || decoded === ".." || decoded.includes("/") || decoded.includes("\\") || decoded.includes("\0")) {
      throw invalid("Google Play API path cannot contain path traversal segments");
    }
  }

  let subSegments: string[];
  if (
    rawSegments[0] === "androidpublisher" &&
    rawSegments[1] === "v3" &&
    rawSegments[2] === "applications"
  ) {
    if (rawSegments.length < 4) throw invalid("Google Play API path is missing packageName");
    const pathPkg = decodeURIComponent(rawSegments[3]!);
    if (pathPkg !== packageName) {
      throw new PlayAdapterError(
        403,
        "play_api_package_mismatch",
        `Google Play API path targets package '${pathPkg}', but this app is bound to '${packageName}'`,
      );
    }
    subSegments = rawSegments.slice(4);
  } else if (rawSegments[0] === "v3" && rawSegments[1] === "applications") {
    if (rawSegments.length < 3) throw invalid("Google Play API path is missing packageName");
    const pathPkg = decodeURIComponent(rawSegments[2]!);
    if (pathPkg !== packageName) {
      throw new PlayAdapterError(
        403,
        "play_api_package_mismatch",
        `Google Play API path targets package '${pathPkg}', but this app is bound to '${packageName}'`,
      );
    }
    subSegments = rawSegments.slice(3);
  } else if (rawSegments[0] === "applications") {
    if (rawSegments.length < 2) throw invalid("Google Play API path is missing packageName");
    const pathPkg = decodeURIComponent(rawSegments[1]!);
    if (pathPkg !== packageName) {
      throw new PlayAdapterError(
        403,
        "play_api_package_mismatch",
        `Google Play API path targets package '${pathPkg}', but this app is bound to '${packageName}'`,
      );
    }
    subSegments = rawSegments.slice(2);
  } else if (rawSegments[0] === "upload") {
    throw invalid("Media upload paths are not supported by the JSON API proxy");
  } else {
    subSegments = rawSegments;
  }

  const base = `/androidpublisher/v3/applications/${encodeURIComponent(packageName)}`;
  const canonicalPath = subSegments.length > 0 ? `${base}/${subSegments.join("/")}` : base;

  const inlineQuery: Record<string, string[]> = {};
  if (searchPart) {
    const params = new URLSearchParams(searchPart);
    for (const [k, v] of params.entries()) {
      if (!inlineQuery[k]) inlineQuery[k] = [];
      inlineQuery[k].push(v);
    }
  }
  return { canonicalPath, inlineQuery };
}

function playApiProxyInput(input: PlayApiProxyRpcInput): PlayApiProxyRequest {
  const binding = discoveryInput(input);
  const operationId = typeof input?.operationId === "string" ? input.operationId : "";
  if (!OPERATION_ID.test(operationId)) {
    throw new PlayAdapterError(400, "play_api_request_invalid", "Hands Google Play API request is invalid");
  }
  const method = (typeof input.method === "string" ? input.method.toUpperCase() : "") as PlayApiMethod;
  if (!PLAY_API_METHODS.has(method)) {
    throw new PlayAdapterError(400, "play_api_method_invalid", "Google Play API method must be GET, POST, PUT, PATCH, or DELETE");
  }
  if (method === "GET" && input.body !== undefined && input.body !== null) {
    throw new PlayAdapterError(400, "play_api_request_invalid", "GET requests cannot include a request body");
  }
  const { canonicalPath, inlineQuery } = normalizePlayApiPath(binding.packageName, input.path);
  const query: Record<string, string | string[]> = { ...inlineQuery };
  if (input.query && typeof input.query === "object") {
    for (const [key, value] of Object.entries(input.query)) {
      if (!key.trim()) continue;
      if (typeof value === "string") {
        query[key] = value;
      } else if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
        query[key] = value;
      } else {
        throw new PlayAdapterError(400, "play_api_request_invalid", "Query parameter values must be strings");
      }
    }
  }
  return {
    packageName: binding.packageName,
    operationId,
    method,
    canonicalPath,
    query,
    ...(input.body !== undefined && input.body !== null ? { body: input.body } : {}),
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
  /** Test hook: base delay before a resumable status query (default 1000 ms). */
  resumableRetryDelayMs?: number;
}

export function createPlayAdapterService(options: AdapterOptions = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const uploadOptions = (env: PlayAdapterEnv) => ({
    ...resumableUploadOptions(env),
    ...(options.resumableRetryDelayMs !== undefined ? { retryDelayMs: options.resumableRetryDelayMs } : {}),
  });

  async function client(input: PlayBindingInput, env: PlayAdapterEnv) {
    const binding = bindingInput(input);
    const accessToken = await createAccessToken(
      binding.credential,
      fetchImpl,
      options.nowSeconds?.() ?? Math.floor(Date.now() / 1000),
    );
    return { binding, client: new GooglePlayClient(accessToken, fetchImpl, maxAabSize(env), uploadOptions(env)) };
  }

  /** A client for operations that need only the package (store listings are not track-scoped). */
  async function discoveryClient(input: PlayDiscoveryInput, env: PlayAdapterEnv) {
    const binding = discoveryInput(input);
    const token = await createAccessToken(binding.credential, fetchImpl, options.nowSeconds?.() ?? Math.floor(Date.now() / 1000));
    return { binding, client: new GooglePlayClient(token, fetchImpl, maxAabSize(env), uploadOptions(env)) };
  }

  /** A storage client holding a devstorage.read_only token; nothing else can use it. */
  async function statsClient(credential: unknown) {
    const parsed = parsePlayCredential(credential);
    const token = await createAccessToken(parsed, fetchImpl, options.nowSeconds?.() ?? Math.floor(Date.now() / 1000), PLAY_REPORTS_SCOPE);
    return new PlayStatsStorageClient(token, fetchImpl);
  }

  return {
    /**
     * List the Play Console statistics CSVs of one report folder for the bound
     * package (all pages, bounded). Read-only; see stats_reports.ts.
     */
    async listStatsObjects(input: StatsListRpcInput): Promise<AdapterResult<{ bucket: string; report: StatsReport; objects: StatsObject[]; truncated: boolean }>> {
      try {
        // Validate before OAuth: a malformed request never reaches Google.
        const packageName = statsPackageInput(input?.packageName);
        const bucket = statsBucketInput(input?.bucket);
        const report = statsReportInput(input?.report);
        const google = await statsClient(input.credential);
        const listed = await google.list(bucket, report, packageName);
        return { ok: true, value: { bucket, report, ...listed } };
      } catch (error) { return failure(error, null); }
    },

    /** Download one generation of one statistics CSV of the bound package, size-bounded. */
    async readStatsObject(input: StatsReadRpcInput): Promise<AdapterResult<{ name: string; generation: string; size: number; bytes: Uint8Array }>> {
      try {
        const packageName = statsPackageInput(input?.packageName);
        const bucket = statsBucketInput(input?.bucket);
        const object = statsObjectInput(packageName, input?.name, input?.generation);
        const requested = positiveInteger(input?.maxBytes);
        if (requested === null) throw new PlayAdapterError(400, "play_reports_request_invalid", "maxBytes is required");
        const maxBytes = Math.min(requested, MAX_STATS_OBJECT_BYTES);
        const google = await statsClient(input.credential);
        const bytes = await google.read(bucket, object.name, object.generation, maxBytes);
        return { ok: true, value: { name: object.name, generation: object.generation, size: bytes.byteLength, bytes } };
      } catch (error) { return failure(error, null); }
    },

    async applySubscriptionProduct(input: PlayDiscoveryInput & { product: unknown; mode: "dry_run" | "commit"; regionsVersion: string }, env: PlayAdapterEnv) {
      try {
        if (input?.mode !== "dry_run" && input?.mode !== "commit") throw new PlayAdapterError(400, "subscription_request_invalid", "mode must be dry_run or commit");
        if (typeof input.regionsVersion !== "string" || !/^\d{4}\/\d{2}$/.test(input.regionsVersion)) throw new PlayAdapterError(400, "subscription_request_invalid", "regionsVersion must be YYYY/MM");
        const desired = normalizeProduct(input.product);
        const resolved = await discoveryClient(input, env);
        return { ok: true as const, value: await reconcileProduct(resolved.client, resolved.binding.packageName, desired, input.mode, input.regionsVersion) };
      } catch (error) { return failure(error, null); }
    },
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
        const google = new GooglePlayClient(token, fetchImpl, maxAabSize(env), uploadOptions(env));
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

    /**
     * Replace the release notes of the track release carrying versionCode; nothing
     * else on the track changes. Commit is ERROR_IF_IN_REVIEW, then a readback.
     */
    async updateReleaseNotes(input: UpdateReleaseNotesRpcInput, env: PlayAdapterEnv): Promise<AdapterResult<UpdateReleaseNotesResult>> {
      const operationId = OPERATION_ID.test(input?.operationId ?? "") ? input.operationId : null;
      try {
        // Validate before OAuth: a malformed request never reaches Google.
        const request = updateReleaseNotesInput(input);
        const resolved = await client(input, env);
        return { ok: true, value: await resolved.client.updateReleaseNotes(request) };
      } catch (error) {
        return failure(error, operationId);
      }
    },

    /**
     * Upload deobfuscation files for a versionCode Play already holds, in their own
     * edit (no track/rollout/bundle change). dry_run only checks the versionCode is
     * on Play and deletes the edit. Any failure deletes the edit.
     */
    async uploadDeobfuscation(
      input: UploadDeobfuscationRpcInput,
      env: PlayAdapterEnv,
      mappingBody: ReadableStream<Uint8Array> | null = null,
      symbolsBody: ReadableStream<Uint8Array> | null = null,
    ): Promise<AdapterResult<UploadDeobfuscationResult>> {
      const operationId = OPERATION_ID.test(input?.operationId ?? "") ? input.operationId : null;
      try {
        // Validate before OAuth: a malformed request never reaches Google.
        const request = uploadDeobfuscationInput(input, mappingBody, symbolsBody);
        const resolved = await discoveryClient(input, env);
        return { ok: true, value: await resolved.client.uploadDeobfuscation(request) };
      } catch (error) {
        // Release any stream that was never read (bad input, or the mapping after a
        // refused symbols upload) so the caller's R2 read is not left waiting.
        for (const stream of [mappingBody, symbolsBody]) {
          if (stream instanceof ReadableStream && !stream.locked) await stream.cancel().catch(() => undefined);
        }
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

    /** Separate RPC so an older adapter cannot silently ignore the required check. */
    async promoteWithPriorMapping(
      input: PromotionRpcInput,
      symbolsBody: ReadableStream<Uint8Array> | null,
      env: PlayAdapterEnv,
    ): Promise<AdapterResult<Awaited<ReturnType<GooglePlayClient["promote"]>>>> {
      const operationId = OPERATION_ID.test(input?.operationId ?? "") ? input.operationId : null;
      try {
        if (input.mapping != null) {
          throw new PlayAdapterError(400, "promotion_request_invalid", "Mapping must be omitted for this RPC");
        }
        // This RPC never uploads a bundle; no AAB stream crosses the boundary.
        const unusedBody = new ReadableStream<Uint8Array>({ start(controller) { controller.close(); } });
        const promotion = promotionInput(input, unusedBody, symbolsBody, null, env);
        const resolved = await client(input, env);
        return { ok: true, value: await resolved.client.promote({ ...promotion, requireExistingBundle: true }) };
      } catch (error) {
        return failure(error, operationId);
      }
    },

    async callPlayApi(
      input: PlayApiProxyRpcInput,
      env: PlayAdapterEnv,
    ): Promise<AdapterResult<PlayApiProxyResult>> {
      const operationId = OPERATION_ID.test(input?.operationId ?? "") ? input.operationId : null;
      try {
        const request = playApiProxyInput(input);
        const resolved = await discoveryClient(input, env);
        return { ok: true, value: await resolved.client.callPlayApi(request) };
      } catch (error) {
        return failure(error, operationId);
      }
    },
  };
}
