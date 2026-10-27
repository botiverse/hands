import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";
import { PlayAdapterError } from "./errors";
import { playRejection, playRejectionReason, playRequestStage } from "./provider_errors";
import { PLAY_LISTING_FIELDS } from "./types";
import type {
  PlayListing,
  DeobfuscationFileResult,
  DeobfuscationSymbolType,
  PromotionRequest,
  PromotionSymbolsRequest,
  TrackRelease,
  TrackResource,
  ReleaseSummary,
} from "./types";

const API_ROOT = "https://androidpublisher.googleapis.com/androidpublisher/v3";
const UPLOAD_ROOT = "https://androidpublisher.googleapis.com/upload/androidpublisher/v3";
/**
 * Google Play mediaUpload.maxSize for edits.deobfuscationfiles.upload, taken
 * from the androidpublisher v3 discovery document (2,097,152,000 bytes).
 * Native debug symbols zips and R8/ProGuard mapping files above this bound are
 * rejected before streaming. The bound is per upload, for either symbolType.
 */
export const MAX_SYMBOLS_SIZE_BYTES = 2_097_152_000;

/**
 * Per-symbolType wording and error codes. A ProGuard mapping failure must never
 * read as a native-symbols failure (and vice versa): the codes and messages are
 * what an operator sees in a receipt.
 */
export const DEOBFUSCATION_FILE_KINDS: Record<DeobfuscationSymbolType, {
  label: string;
  stage: string;
  tooLargeCode: string;
  integrityCode: string;
  unavailableCode: string;
  malformedCode: string;
}> = {
  nativeCode: {
    label: "Native debug symbols",
    stage: "upload_symbols",
    tooLargeCode: "symbols_too_large",
    integrityCode: "symbols_integrity_mismatch",
    unavailableCode: "play_symbols_unavailable",
    malformedCode: "play_symbols_malformed",
  },
  proguard: {
    label: "R8/ProGuard mapping (deobfuscation file, proguard)",
    stage: "upload_mapping",
    tooLargeCode: "mapping_too_large",
    integrityCode: "mapping_integrity_mismatch",
    unavailableCode: "play_mapping_unavailable",
    malformedCode: "play_mapping_malformed",
  },
};

interface GoogleBundle {
  versionCode?: number;
  sha256?: string;
}

function exactVersionCode(value: unknown): number | null {
  const parsed = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  return typeof parsed === "number" && Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

export function maxTrackVersionCode(track: TrackResource): number {
  let max = 0;
  for (const release of track.releases ?? []) {
    for (const value of release.versionCodes ?? []) {
      const versionCode = exactVersionCode(value);
      if (versionCode === null) {
        throw new PlayAdapterError(502, "play_track_malformed", "Google Play returned an invalid track versionCode");
      }
      max = Math.max(max, versionCode);
    }
  }
  return max;
}

function cleanRelease(value: TrackRelease): TrackRelease {
  const release: TrackRelease = {};
  if (typeof value.name === "string") release.name = value.name;
  if (Array.isArray(value.versionCodes)) release.versionCodes = value.versionCodes.map((item) => String(item));
  if (Array.isArray(value.releaseNotes)) {
    release.releaseNotes = value.releaseNotes
      .filter((item) => typeof item?.language === "string" && typeof item?.text === "string")
      .map((item) => ({ language: item.language, text: item.text }));
  }
  const status = value.status;
  if (status && ["statusUnspecified", "draft", "inProgress", "halted", "completed"].includes(status)) {
    release.status = status;
  }
  if (typeof value.userFraction === "number" && Number.isFinite(value.userFraction)) {
    release.userFraction = value.userFraction;
  }
  if (value.countryTargeting && typeof value.countryTargeting === "object") {
    release.countryTargeting = {
      ...(Array.isArray(value.countryTargeting.countries)
        ? { countries: value.countryTargeting.countries.map((country) => String(country)) }
        : {}),
      ...(typeof value.countryTargeting.includeRestOfWorld === "boolean"
        ? { includeRestOfWorld: value.countryTargeting.includeRestOfWorld }
        : {}),
    };
  }
  const priority = value.inAppUpdatePriority;
  if (typeof priority === "number" && Number.isInteger(priority)) release.inAppUpdatePriority = priority;
  return release;
}

function requestedRelease(request: PromotionRequest): TrackRelease {
  // Release notes ride on the NEW release only; carried releases keep whatever
  // notes Play already had (cleanRelease passes them through untouched).
  const notes = request.releaseNotes && request.releaseNotes.length > 0
    ? { releaseNotes: request.releaseNotes.map((note) => ({ language: note.language, text: note.text })) }
    : {};
  if (request.rolloutPercent < 100) {
    if (request.handsTrack !== "production") {
      throw new PlayAdapterError(400, "rollout_track_invalid", "Partial rollout is supported only on the production track");
    }
    return {
      versionCodes: [String(request.versionCode)],
      status: "inProgress",
      userFraction: request.rolloutPercent / 100,
      ...notes,
    };
  }
  return { versionCodes: [String(request.versionCode)], status: "completed", ...notes };
}

/** BCP-47-shaped tag as Google returns it (en-US, fil, es-419). */
const PLAY_LANGUAGE_SHAPE = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;

/**
 * Narrow a provider Listing to Google's documented fields. Unknown keys are
 * dropped; a known field of the wrong type is a malformed response, not data.
 */
export function cleanListing(value: unknown): PlayListing {
  const row = value && typeof value === "object" ? value as Record<string, unknown> : null;
  if (!row || typeof row.language !== "string" || !PLAY_LANGUAGE_SHAPE.test(row.language)) {
    throw new PlayAdapterError(502, "play_listings_malformed", "Google Play returned malformed store listings");
  }
  const listing: PlayListing = { language: row.language };
  for (const field of PLAY_LISTING_FIELDS) {
    const raw = row[field];
    if (raw === undefined) continue;
    if (typeof raw !== "string") {
      throw new PlayAdapterError(502, "play_listings_malformed", "Google Play returned malformed store listings");
    }
    listing[field] = raw;
  }
  return listing;
}

function hashingBody(
  body: ReadableStream<Uint8Array>,
  maxBytes: number,
  limits = { tooLargeCode: "aab_too_large", tooLargeMessage: "AAB exceeds the configured maximum size", incompleteCode: "aab_integrity_mismatch", incompleteMessage: "Google Play did not consume the complete AAB stream" },
) {
  const hasher = sha256.create();
  let size = 0;
  let finished = false;
  let control: TransformStreamDefaultController<Uint8Array> | null = null;
  const stream = body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    start(controller) {
      control = controller;
    },
    transform(chunk, controller) {
      size += chunk.byteLength;
      if (size > maxBytes) {
        throw new PlayAdapterError(413, limits.tooLargeCode, limits.tooLargeMessage);
      }
      hasher.update(chunk);
      controller.enqueue(chunk);
    },
    flush() {
      finished = true;
    },
  }));
  return {
    stream,
    /**
     * Stop reading the source after Google answered early (e.g. a rejection).
     * Erroring the transform makes the pipe cancel the source, so the caller's
     * tee stops buffering bytes nobody will read.
     */
    abort() {
      if (finished) return;
      try { control?.error(new PlayAdapterError(409, limits.incompleteCode, limits.incompleteMessage)); } catch { /* already closed */ }
    },
    digest() {
      if (!finished) {
        throw new PlayAdapterError(409, limits.incompleteCode, limits.incompleteMessage);
      }
      return { size, sha256: bytesToHex(hasher.digest()) };
    },
  };
}

export class GooglePlayClient {
  constructor(
    private readonly accessToken: string,
    fetchImpl: typeof fetch,
    private readonly maxAabSize: number,
  ) {
    // Workers native fetch rejects a class instance as its receiver.
    // Keep injected fetch functions callable without changing their this value.
    this.fetchImpl = (input, init) => fetchImpl(input, init);
  }

  private readonly fetchImpl: typeof fetch;

  private async requestJson<T>(url: string, init: RequestInit = {}): Promise<T> {
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        ...init,
        signal: init.signal ?? AbortSignal.timeout(30_000),
        headers: {
          authorization: `Bearer ${this.accessToken}`,
          ...(init.body === undefined ? {} : { "content-type": "application/json" }),
          ...(init.headers ?? {}),
        },
        redirect: "manual",
      });
    } catch {
      throw new PlayAdapterError(502, "play_api_unavailable", "Google Play API request failed");
    }
    const responseText = await response.text();
    let body: T | null = null;
    let jsonParsed = true;
    try { body = JSON.parse(responseText) as T; } catch { jsonParsed = false; }
    if (!response.ok) {
      throw playRejection(response.status, body, playRequestStage(url, init.method));
    }
    if (!body || typeof body !== "object") {
      console.warn("hands_play_response_shape", JSON.stringify({ stage: playRequestStage(url, init.method),
        status: response.status, jsonObject: false, bodyEmpty: responseText.trim().length === 0, jsonParsed }));
      throw new PlayAdapterError(502, "play_api_malformed", "Google Play API returned malformed JSON");
    }
    return body;
  }

  private async requestEmpty(url: string, init: RequestInit): Promise<void> {
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        ...init,
        signal: init.signal ?? AbortSignal.timeout(30_000),
        headers: { authorization: `Bearer ${this.accessToken}`, ...(init.headers ?? {}) },
        redirect: "manual",
      });
    } catch {
      throw new PlayAdapterError(502, "play_api_unavailable", "Google Play API request failed");
    }
    if (!response.ok) {
      const body: unknown = await response.json().catch(() => null);
      throw playRejection(response.status, body, playRequestStage(url, init.method));
    }
  }

  async listReleaseStates(packageName: string, track: string): Promise<ReleaseSummary[]> {
    const result = await this.requestJson<{ releases?: unknown }>(
      `${API_ROOT}/applications/${encodeURIComponent(packageName)}/tracks/${encodeURIComponent(track)}/releases`,
    );
    if (result.releases === undefined) return [];
    if (!Array.isArray(result.releases) || result.releases.length > 20) {
      console.warn("hands_play_release_shape", JSON.stringify({ collectionArray: Array.isArray(result.releases),
        collectionTooLarge: Array.isArray(result.releases) && result.releases.length > 20 }));
      throw new PlayAdapterError(502, "play_releases_malformed", "Google Play returned invalid release summaries");
    }
    return result.releases.map((value: unknown) => {
      const row = value as Partial<ReleaseSummary> | null;
      // ProtoJSON omits default scalar/repeated fields. Empty artifact lists
      // produce no version observations; explicit invalid types still fail.
      const releaseName = row?.releaseName === undefined ? "" : row.releaseName;
      const activeArtifacts = row?.activeArtifacts === undefined ? [] : row.activeArtifacts;
      if (!row || row.track !== track || typeof releaseName !== "string"
          || typeof row.releaseLifecycleState !== "string" || !row.releaseLifecycleState
          || !Array.isArray(activeArtifacts)
          || activeArtifacts.some(item => !item || typeof item.versionCode !== "number"
            || !Number.isSafeInteger(item.versionCode) || item.versionCode <= 0)) {
        // Fixed booleans only: never log provider names, states, versions,
        // URLs or response contents while diagnosing a contract mismatch.
        console.warn("hands_play_release_shape", JSON.stringify({
          rowObject: !!row && typeof row === "object",
          trackMatches: row?.track === track,
          nameString: typeof row?.releaseName === "string", namePresent: row?.releaseName !== undefined,
          stateString: typeof row?.releaseLifecycleState === "string" && !!row.releaseLifecycleState,
          artifactsArray: Array.isArray(row?.activeArtifacts), artifactsPresent: row?.activeArtifacts !== undefined,
          artifactVersionsValid: Array.isArray(row?.activeArtifacts) && row.activeArtifacts.every(item =>
            !!item && typeof item.versionCode === "number" && Number.isSafeInteger(item.versionCode) && item.versionCode > 0),
        }));
        throw new PlayAdapterError(502, "play_releases_malformed", "Google Play returned invalid release summaries");
      }
      return { releaseName, track: row.track,
        releaseLifecycleState: row.releaseLifecycleState,
        activeArtifacts: activeArtifacts.map(item => ({ versionCode: item.versionCode })) };
    });
  }

  private editRoot(packageName: string, editId?: string): string {
    const root = `${API_ROOT}/applications/${encodeURIComponent(packageName)}/edits`;
    return editId ? `${root}/${encodeURIComponent(editId)}` : root;
  }

  async createEdit(packageName: string): Promise<string> {
    const body = await this.requestJson<{ id?: string }>(this.editRoot(packageName), {
      method: "POST",
      body: "{}",
    });
    if (typeof body.id !== "string" || !body.id) {
      throw new PlayAdapterError(502, "play_edit_malformed", "Google Play did not return an edit id");
    }
    return body.id;
  }

  async deleteEdit(packageName: string, editId: string): Promise<void> {
    await this.requestEmpty(this.editRoot(packageName, editId), { method: "DELETE" });
  }

  async getTrack(packageName: string, editId: string, track: string): Promise<TrackResource> {
    return this.requestJson<TrackResource>(
      `${this.editRoot(packageName, editId)}/tracks/${encodeURIComponent(track)}`,
    );
  }

  async listTracks(packageName: string): Promise<string[]> {
    const editId = await this.createEdit(packageName);
    let tracks: string[];
    try {
      const result = await this.requestJson<{ tracks?: TrackResource[] }>(`${this.editRoot(packageName, editId)}/tracks`);
      if (!Array.isArray(result.tracks) || result.tracks.some((t) => !t || typeof t.track !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(t.track))) {
        throw new PlayAdapterError(502, "play_tracks_malformed", "Google Play returned malformed tracks");
      }
      tracks = [...new Set(result.tracks.map((t) => t.track!))].sort();
    } catch (error) {
      await this.cleanupOrThrow(packageName, editId, error);
      throw error;
    }
    await this.deleteEdit(packageName, editId);
    return tracks;
  }

  async readTrackMaximum(packageName: string, track: string): Promise<number> {
    const editId = await this.createEdit(packageName);
    let value: number;
    try {
      value = maxTrackVersionCode(await this.getTrack(packageName, editId, track));
    } catch (error) {
      await this.cleanupOrThrow(packageName, editId, error);
      throw error;
    }
    await this.deleteEdit(packageName, editId);
    return value;
  }

  async verifyBinding(packageName: string, tracks: string[]): Promise<void> {
    const editId = await this.createEdit(packageName);
    try {
      for (const track of [...new Set(tracks)]) {
        await this.getTrack(packageName, editId, track);
      }
    } catch (error) {
      await this.cleanupOrThrow(packageName, editId, error);
    }
    await this.deleteEdit(packageName, editId);
  }

  private async uploadBundle(request: PromotionRequest, editId: string): Promise<GoogleBundle> {
    const local = hashingBody(request.body, this.maxAabSize);
    let response: Response;
    try {
      response = await this.fetchImpl(
        `${UPLOAD_ROOT}/applications/${encodeURIComponent(request.packageName)}/edits/${encodeURIComponent(editId)}/bundles?uploadType=media`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${this.accessToken}`,
            "content-type": "application/octet-stream",
          },
          body: local.stream,
          redirect: "manual",
        },
      );
    } catch (error) {
      if (error instanceof PlayAdapterError) throw error;
      throw new PlayAdapterError(502, "play_upload_unavailable", "Google Play AAB upload failed");
    }
    const body = await response.json().catch(() => null) as GoogleBundle | null;
    if (!response.ok) {
      // Same treatment as every other provider rejection: the caller keeps a stable
      // code plus the stage, and gains a classified cause, so a failed upload is
      // diagnosable from the receipt instead of needing someone with observability
      // scope to read the adapter's log.
      //
      // The code stays `play_upload_rejected` rather than becoming a generic
      // `play_api_rejected`: the stage is what tells an operator this failed while
      // uploading rather than while moving a track, and folding the two together
      // would lose that in every existing receipt's history.
      const rejection = playRejection(response.status, body, "upload_bundle");
      throw new PlayAdapterError(
        rejection.status,
        "play_upload_rejected",
        rejection.message,
        // Carry the lookup alongside the provider cause: it distinguishes "Google
        // said it has nothing" from "we failed to match what it returned", which are
        // otherwise the same failure to the reader of a receipt.
        this.lastBundleLookup
          ? { ...rejection.cause_detail, bundle_lookup: this.lastBundleLookup }
          : rejection.cause_detail,
      );
    }
    if (!body || typeof body !== "object") {
      throw new PlayAdapterError(502, "play_upload_malformed", "Google Play returned malformed AAB metadata");
    }
    const hashResult = local.digest();
    if (hashResult.size !== request.expectedSize || hashResult.sha256 !== request.expectedSha256) {
      throw new PlayAdapterError(409, "aab_integrity_mismatch", "Streamed AAB did not match the Hands identity");
    }
    if (exactVersionCode(body.versionCode) !== request.versionCode || body.sha256?.toLowerCase() !== request.expectedSha256) {
      throw new PlayAdapterError(409, "play_bundle_mismatch", "Google Play AAB readback did not match Hands");
    }
    return body;
  }

  /**
   * edits.deobfuscationfiles.upload for one declared file, inside the open edit.
   * symbolType selects both the URL path segment and the acknowledgement Google
   * must return, so a proguard upload can never be accepted on a nativeCode ack.
   *
   * mode "strict" throws on any failure (new bundle: the promote fails closed).
   * mode "soft" returns a provider refusal as attempt:"rejected" instead (bundle
   * already on Play). Hands' own integrity failures throw in both modes.
   */
  private async uploadDeobfuscationFile(
    request: PromotionRequest,
    editId: string,
    symbolType: DeobfuscationSymbolType,
    file: PromotionSymbolsRequest,
    mode: "strict" | "soft" = "strict",
  ): Promise<DeobfuscationFileResult> {
    const kind = DEOBFUSCATION_FILE_KINDS[symbolType];
    const local = hashingBody(file.body, MAX_SYMBOLS_SIZE_BYTES, {
      tooLargeCode: kind.tooLargeCode,
      tooLargeMessage: `${kind.label} exceed the Google Play maximum size`,
      incompleteCode: kind.integrityCode,
      incompleteMessage: `Google Play did not consume the complete ${kind.label} stream`,
    });
    const rejected = (fields: Partial<DeobfuscationFileResult>): DeobfuscationFileResult => {
      local.abort();
      return {
        symbol_type: symbolType,
        sha256: file.expectedSha256,
        size_bytes: file.expectedSize,
        uploaded: false,
        attempt: "rejected",
        stage: kind.stage,
        ...fields,
      };
    };
    let response: Response;
    try {
      response = await this.fetchImpl(
        `${UPLOAD_ROOT}/applications/${encodeURIComponent(request.packageName)}/edits/${encodeURIComponent(editId)}/apks/${request.versionCode}/deobfuscationFiles/${symbolType}?uploadType=media`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${this.accessToken}`,
            "content-type": "application/octet-stream",
          },
          body: local.stream,
          redirect: "manual",
        },
      );
    } catch (error) {
      if (error instanceof PlayAdapterError) throw error;
      if (mode === "soft") return rejected({ error_code: kind.unavailableCode });
      throw new PlayAdapterError(502, kind.unavailableCode, `Google Play ${kind.label} upload failed`);
    }
    const body = await response.json().catch(() => null) as { deobfuscationFile?: { symbolType?: string } } | null;
    if (!response.ok) {
      const rejection = playRejection(response.status, body, kind.stage);
      if (mode === "soft") {
        return rejected({
          error_code: rejection.code,
          http_status: response.status,
          provider_reason: playRejectionReason(body),
          ...(rejection.cause_detail?.provider_cause ? { provider_cause: rejection.cause_detail.provider_cause } : {}),
        });
      }
      throw rejection;
    }
    const hashResult = local.digest();
    if (hashResult.size !== file.expectedSize || hashResult.sha256 !== file.expectedSha256) {
      throw new PlayAdapterError(409, kind.integrityCode, `Streamed ${kind.label} did not match the Hands identity`);
    }
    // Discovery documents no post-commit GET for deobfuscation files: this
    // upload response is the only provider-side acknowledgement available.
    if (body?.deobfuscationFile?.symbolType !== symbolType) {
      if (mode === "soft") return rejected({ error_code: kind.malformedCode, http_status: response.status });
      throw new PlayAdapterError(502, kind.malformedCode, `Google Play did not acknowledge a ${symbolType} deobfuscation file`);
    }
    return { symbol_type: symbolType, sha256: hashResult.sha256, size_bytes: hashResult.size, uploaded: true };
  }

  /**
   * Attach deobfuscation files to a bundle Play ALREADY holds, in their own edit
   * (the lookup edit), committed or deleted before the release edit is created.
   *
   * "Bundle already on Play" says nothing about whether its mapping is: a bundle
   * pushed by an older Hands (or by hand) has none, and Google offers no GET to
   * check, so the files are always uploaded. Whether Play accepts a re-upload for
   * a versionCode is not documented, so a provider refusal here is reported,
   * never fatal. It runs in a SEPARATE edit so a refused upload can never poison
   * the release edit's commit, and BEFORE that edit, because committing any edit
   * invalidates edits opened earlier and because a commit made after the release
   * commit could hit ERROR_IF_IN_REVIEW on our own just-submitted release.
   */
  private async attachToExistingBundle(
    request: PromotionRequest,
    editId: string,
    files: Array<[DeobfuscationSymbolType, PromotionSymbolsRequest]>,
  ): Promise<DeobfuscationFileResult[]> {
    let results: DeobfuscationFileResult[] = [];
    try {
      for (const [symbolType, file] of files) {
        results.push({ ...(await this.uploadDeobfuscationFile(request, editId, symbolType, file, "soft")), edit: "existing_bundle" });
      }
    } catch (error) {
      // Hands' own integrity failure (bytes did not match the sealed identity):
      // nothing is committed and the promote fails closed, as on the new-bundle path.
      await this.cleanupOrThrow(request.packageName, editId, error);
    }
    if (!results.some((result) => result.uploaded)) {
      await this.deleteEdit(request.packageName, editId).catch(() => undefined);
      return results;
    }
    try {
      await this.commitEdit(request.packageName, editId);
    } catch (error) {
      const known = error instanceof PlayAdapterError ? error : null;
      results = results.map((result) => result.uploaded ? {
        ...result,
        uploaded: false,
        attempt: "rejected" as const,
        stage: "commit_edit",
        error_code: known?.code ?? "play_api_unavailable",
        ...(known?.cause_detail?.provider_cause ? { provider_cause: known.cause_detail.provider_cause } : {}),
      } : result);
      await this.deleteEdit(request.packageName, editId).catch(() => undefined);
    }
    return results;
  }

  private async updateTrack(request: PromotionRequest, editId: string, current: TrackResource): Promise<void> {
    const currentMax = maxTrackVersionCode(current);
    if (request.versionCode <= currentMax || request.versionCode > 2_100_000_000) {
      throw new PlayAdapterError(409, "play_version_conflict", "AAB versionCode must exceed the live track maximum and be at most 2100000000");
    }
    if ((current.releases ?? []).some((release) => release.status === "inProgress" || release.status === "halted")) {
      throw new PlayAdapterError(409, "play_rollout_conflict", "The track already has a staged or halted release");
    }
    // Google Play rejects a track body carrying more than one `completed` release:
    // "Track has more than one completed release". Carrying every existing release
    // forward and appending another completed one therefore fails on any track that
    // has already shipped once -- which, for a real app, is every track.
    //
    // A new completed release SUPERSEDES the previous one, so the old ones are not
    // preserved alongside it; they remain in Play's release history regardless. Only
    // `completed` is dropped: `draft` and `inProgress` are rejected earlier by the
    // conflict check above, and any other status is not ours to rewrite.
    const nextRelease = requestedRelease(request);
    const carried = (current.releases ?? [])
      .map(cleanRelease)
      .filter((release) => !(nextRelease.status === "completed" && release.status === "completed"));
    await this.requestJson<TrackResource>(
      `${this.editRoot(request.packageName, editId)}/tracks/${encodeURIComponent(request.playTrack)}`,
      {
        method: "PUT",
        body: JSON.stringify({
          track: request.playTrack,
          releases: [...carried, nextRelease],
        }),
      },
    );
  }

  /**
   * edits.commit. Always `changesInReviewBehavior=ERROR_IF_IN_REVIEW`: Hands never
   * cancels someone else's in-review submission. `changesNotSentForReview=true` is
   * sent only when the caller opts in; omitted otherwise (Google's default).
   */
  async commitEdit(packageName: string, editId: string, options: { changesNotSentForReview?: boolean } = {}): Promise<string | null> {
    const query = options.changesNotSentForReview
      ? "changesInReviewBehavior=ERROR_IF_IN_REVIEW&changesNotSentForReview=true"
      : "changesInReviewBehavior=ERROR_IF_IN_REVIEW";
    const body = await this.requestJson<{ id?: unknown }>(
      `${this.editRoot(packageName, editId)}:commit?${query}`,
      { method: "POST", body: "{}" },
    );
    // The returned AppEdit id; promote does not inspect it, store listing requires it.
    return typeof body.id === "string" ? body.id : null;
  }

  /** edits.validate: Google checks the edit as a commit would, without committing. */
  async validateEdit(packageName: string, editId: string): Promise<void> {
    const body = await this.requestJson<{ id?: string }>(`${this.editRoot(packageName, editId)}:validate`, {
      method: "POST",
      body: "{}",
    });
    if (body.id !== undefined && body.id !== editId) {
      throw new PlayAdapterError(502, "play_edit_malformed", "Google Play validated a different edit");
    }
  }

  /** edits.details.get: only `defaultLanguage` is read; contact fields are not Hands' concern. */
  async getDefaultLanguage(packageName: string, editId: string): Promise<string | null> {
    const body = await this.requestJson<{ defaultLanguage?: unknown }>(`${this.editRoot(packageName, editId)}/details`);
    if (body.defaultLanguage === undefined) return null;
    if (typeof body.defaultLanguage !== "string" || !PLAY_LANGUAGE_SHAPE.test(body.defaultLanguage)) {
      throw new PlayAdapterError(502, "play_details_malformed", "Google Play returned malformed app details");
    }
    return body.defaultLanguage;
  }

  /** edits.listings.list. */
  async listListings(packageName: string, editId: string): Promise<PlayListing[]> {
    const body = await this.requestJson<{ listings?: unknown }>(`${this.editRoot(packageName, editId)}/listings`);
    if (body.listings === undefined) return [];
    if (!Array.isArray(body.listings) || body.listings.length > 500) {
      throw new PlayAdapterError(502, "play_listings_malformed", "Google Play returned malformed store listings");
    }
    return body.listings.map((value) => cleanListing(value));
  }

  /** edits.listings.update (PUT): creates or fully replaces one language's listing. */
  async updateListing(packageName: string, editId: string, listing: PlayListing): Promise<PlayListing> {
    const body = await this.requestJson<unknown>(
      `${this.editRoot(packageName, editId)}/listings/${encodeURIComponent(listing.language)}`,
      { method: "PUT", body: JSON.stringify(listing) },
    );
    return cleanListing(body);
  }

  /** edits.listings.delete. */
  async deleteListing(packageName: string, editId: string, language: string): Promise<void> {
    await this.requestEmpty(
      `${this.editRoot(packageName, editId)}/listings/${encodeURIComponent(language)}`,
      { method: "DELETE" },
    );
  }

  async cleanupOrThrow(packageName: string, editId: string, original: unknown): Promise<never> {
    try {
      await this.deleteEdit(packageName, editId);
    } catch {
      throw new PlayAdapterError(502, "play_edit_cleanup_failed", "Google Play edit cleanup failed");
    }
    throw original;
  }

  private async readback(request: PromotionRequest): Promise<void> {
    const editId = await this.createEdit(request.packageName);
    let track: TrackResource;
    try {
      track = await this.getTrack(request.packageName, editId, request.playTrack);
    } catch (error) {
      await this.cleanupOrThrow(request.packageName, editId, error);
    }
    await this.deleteEdit(request.packageName, editId);
    const release = (track!.releases ?? []).find((candidate) =>
      candidate.versionCodes?.some((value) => exactVersionCode(value) === request.versionCode));
    const expectedStatus = request.rolloutPercent < 100 ? "inProgress" : "completed";
    const fractionMatches = request.rolloutPercent === 100
      ? release?.userFraction === undefined
      : release?.userFraction === request.rolloutPercent / 100;
    if (!release || release.status !== expectedStatus || !fractionMatches) {
      throw new PlayAdapterError(502, "play_readback_mismatch", "Google Play track readback did not match the requested release");
    }
  }

  /**
   * True when Google Play already holds this versionCode on any track.
   *
   * Uploading a duplicate versionCode is rejected, and the bundle is immutable once
   * accepted, so a repeat promote only needs the track edit. Deliberately generous:
   * a malformed track read throws rather than silently claiming "not present", so a
   * broken read can never skip an upload that was actually needed.
   */
  /** What the last bundle lookup saw; attached to an upload rejection's cause. */
  /**
   * What the last bundle lookup saw.
   *
   * Scoped to one promote() call: promote() always assigns it before any upload, so
   * a stale value cannot survive into another app's receipt. A client is constructed
   * per invocation (index.ts), which is the only reason instance state is safe here;
   * if the client is ever reused or cached, pass this through the call chain instead.
   */
  private lastBundleLookup: {
    count: number;
    version_codes: number[];
    wanted: number;
    /** -1 count plus this string when the list call itself failed. */
    error?: string;
  } | null = null;

  private async bundleAlreadyOnPlay(
    packageName: string,
    editId: string,
    request: PromotionRequest,
  ): Promise<boolean> {
    // Ask Google for the bundle it actually holds, not just whether a track mentions
    // this versionCode. Play stores one bundle per versionCode, so a versionCode match
    // alone is NOT proof that the bytes are ours: the same versionCode may have been
    // uploaded by hand in the console or repackaged elsewhere. Skipping the upload on
    // a versionCode match would ship those bytes while the receipt below still
    // reported request.expectedSha256 -- an unverified "Hands-certified bytes are
    // live" claim. The upload path already enforces this binding (:330-333), so the
    // skip path must too.
    //
    // No query parameters: edits.bundles.list does not document versionCode/maxResults,
    // and a silently ignored filter would return an empty list for every edit -- which
    // reads as "not present" and sends us back down the upload path, exactly the bug
    // this check exists to prevent. Filter client-side over the full list instead.
    const bundlesUrl = `${this.editRoot(packageName, editId)}/bundles`;
    let result: { bundles?: Array<{ versionCode?: unknown; sha256?: unknown }> };
    try {
      result = await this.requestJson<{ bundles?: Array<{ versionCode?: unknown; sha256?: unknown }> }>(bundlesUrl);
    } catch (error) {
      // Throw a purpose-built error rather than setting instance state and rethrowing.
      // The upload-rejection path is the only place that reads lastBundleLookup, and a
      // lookup failure never reaches it -- so recording the attempt there produced a
      // receipt with no bundle_lookup at all, and one whose stage said "upload_bundle"
      // when the listing is what actually failed. Both point the reader at the wrong
      // place, which is worse than reporting nothing.
      const lookup = {
        count: -1,
        version_codes: [] as number[],
        wanted: request.versionCode,
        // Our own constant, never Google's text: PlayAdapterError.code is chosen by
        // this adapter, and anything else collapses to a fixed label. errors.ts
        // requires that no provider text reaches a cause.
        error: error instanceof PlayAdapterError ? error.code : "lookup_failed",
      };
      this.lastBundleLookup = lookup;
      throw new PlayAdapterError(
        502,
        "play_bundle_lookup_failed",
        "Could not list the app's Android App Bundles; the skip decision is unavailable",
        { stage: "bundle_lookup", bundle_lookup: lookup },
      );
    }
    if (result.bundles !== undefined && !Array.isArray(result.bundles)) {
      throw new PlayAdapterError(502, "play_bundles_malformed", "Google Play returned a malformed bundle list");
    }
    const bundles = result.bundles ?? [];
    // Log what Google actually returned. The skip decision is only sound if this
    // list really contains previously-uploaded bundles; if it comes back empty the
    // check silently degrades to "always upload", which looks identical to the bug
    // it was meant to fix. Recorded rather than inferred.
    const seen = {
      count: bundles.length,
      version_codes: bundles.map((bundle) => exactVersionCode(bundle.versionCode)).filter((v): v is number => v !== null),
      wanted: request.versionCode,
    };
    this.lastBundleLookup = seen;
    // Also logged, but the receipt is what an operator can actually read.
    console.warn("hands_play_bundles_seen", JSON.stringify({ stage: "bundle_lookup", ...seen }));
    const match = bundles.find(
      (bundle) => exactVersionCode(bundle.versionCode) === request.versionCode,
    );
    if (!match) return false;
    if (typeof match.sha256 !== "string" || match.sha256.toLowerCase() !== request.expectedSha256) {
      // Present but different bytes. Loud, and the same code the upload path uses.
      throw new PlayAdapterError(
        409,
        "aab_integrity_mismatch",
        "Google Play already holds this versionCode with different bytes; refusing to promote unverified content",
      );
    }
    return true;
  }

  async promote(request: PromotionRequest) {
    if (request.expectedSize > this.maxAabSize) {
      throw new PlayAdapterError(413, "aab_too_large", "AAB exceeds the configured maximum size");
    }
    let editId = await this.createEdit(request.packageName);
    let commitAttempted = false;
    let bundleUploaded = true;
    const declaredFiles: Array<[DeobfuscationSymbolType, PromotionSymbolsRequest]> = [];
    if (request.symbols) declaredFiles.push(["nativeCode", request.symbols]);
    if (request.mapping) declaredFiles.push(["proguard", request.mapping]);
    let deobfuscationFiles: DeobfuscationFileResult[] = [];
    // Reset per promote: a reused client must never report a previous app's lookup.
    this.lastBundleLookup = null;
    try {
      // Google Play rejects re-uploading a versionCode it already holds, which made
      // the second promote of one build (internal -> closed -> production) fail with
      // 403. The bundle does not need re-uploading in that case: the track update is
      // the whole operation. Check every track first and skip the upload when this
      // versionCode is already present anywhere.
      bundleUploaded = !(await this.bundleAlreadyOnPlay(request.packageName, editId, request));
    } catch (error) {
      await this.cleanupOrThrow(request.packageName, editId, error);
    }
    if (!bundleUploaded && declaredFiles.length > 0) {
      // The bundle is on Play, but that does not mean its files are: upload them
      // anyway, fail-soft, in the lookup edit; the release gets a fresh edit.
      deobfuscationFiles = await this.attachToExistingBundle(request, editId, declaredFiles);
      editId = await this.createEdit(request.packageName);
    }
    try {
      if (bundleUploaded) {
        await this.uploadBundle(request, editId);
        // New bundle: files attach in the release edit before the track update,
        // fail-closed; any failure runs cleanupOrThrow, so nothing half-commits.
        for (const [symbolType, file] of declaredFiles) {
          deobfuscationFiles.push({ ...(await this.uploadDeobfuscationFile(request, editId, symbolType, file)), edit: "promotion" });
        }
      }
      const current = await this.getTrack(request.packageName, editId, request.playTrack);
      await this.updateTrack(request, editId, current);
      commitAttempted = true;
      await this.commitEdit(request.packageName, editId);
    } catch (error) {
      if (commitAttempted) throw error;
      await this.cleanupOrThrow(request.packageName, editId, error);
    }
    await this.readback(request);
    return {
      edit_id: editId,
      package_name: request.packageName,
      version_code: request.versionCode,
      // false when Google already held this exact versionCode+sha256 and only the
      // track was edited, so a caller can tell a real upload from a re-promote.
      bundle_uploaded: bundleUploaded,
      track: request.handsTrack,
      sha256: request.expectedSha256,
      rollout_percent: request.rolloutPercent,
      // One entry per declared file, in upload order: acknowledged (uploaded:true)
      // or refused (attempt:"rejected", bundle-already-on-Play path only). Empty
      // when Hands declared none.
      deobfuscation_files: deobfuscationFiles,
      // The languages sent as releaseNotes on the new track release (empty: none).
      release_notes_languages: (request.releaseNotes ?? []).map((note) => note.language),
    };
  }
}
