import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";
import { PlayAdapterError } from "./errors";
import {
  editStatePatternsTried,
  PLAY_UPLOAD_FAILURE_CODES,
  playRejection,
  playRejectionReason,
  playRequestStage,
  playUploadFailure,
} from "./provider_errors";
import { DEFAULT_RESUMABLE_UPLOAD_OPTIONS, resumableUpload } from "./resumable_upload";
import type { ResumableUploadOptions } from "./resumable_upload";
import { PLAY_LISTING_FIELDS } from "./types";
import type {
  PlayAiGeneratedState,
  PlayImageRef,
  PlayImageType,
  PlayListing,
  DeobfuscationFileResult,
  DeobfuscationSymbolType,
  PromotionRequest,
  PromotionSymbolsRequest,
  SendForReviewRequest,
  SendForReviewResult,
  TrackRelease,
  TrackResource,
  ReleaseSummary,
  UploadDeobfuscationRequest,
  UploadDeobfuscationResult,
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

/**
 * Google `Image`: an id is required for Hands to reason about it; the reported
 * sha256 is kept when it is a hex digest and is otherwise null (only a digest
 * shape is ever recorded, never other provider text).
 */
function cleanImage(value: unknown): PlayImageRef {
  const row = value && typeof value === "object" ? value as Record<string, unknown> : null;
  const id = row?.id;
  if (typeof id !== "string" || !/^[A-Za-z0-9._:-]{1,200}$/.test(id)) {
    throw new PlayAdapterError(502, "play_images_malformed", "Google Play returned a malformed image");
  }
  const sha = typeof row?.sha256 === "string" ? row.sha256.toLowerCase() : "";
  return { id, sha256: /^[0-9a-f]{64}$/.test(sha) ? sha : null };
}

function hashingBody(
  body: ReadableStream<Uint8Array>,
  maxBytes: number,
  limits = { tooLargeCode: "aab_too_large", tooLargeMessage: "AAB exceeds the configured maximum size", incompleteCode: "aab_integrity_mismatch", incompleteMessage: "Google Play did not consume the complete AAB stream" },
) {
  const hasher = sha256.create();
  let size = 0;
  let finished = false;
  let result: { size: number; sha256: string } | null = null;
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
      // Memoised: the resumable path checks before its final chunk and again after.
      result ??= { size, sha256: bytesToHex(hasher.digest()) };
      return result;
    },
  };
}

/**
 * Classify a release-edit commit that Google rejected, for the two paths that
 * decide on review: promote with changesNotSentForReview, and sendForReview.
 * Same rules as the store listing (store_listing.ts editStateRejection): in review
 * -> 409 play_edit_in_review (Hands commits with ERROR_IF_IN_REVIEW and never
 * cancels it); manual send required -> 409 play_changes_not_sent_for_review; an
 * answer no pattern recognises -> 502 play_edit_state_unknown, never success.
 * Recognised non-review causes (e.g. MULTIPLE_COMPLETED) keep play_api_rejected.
 * Plain promote (no flag) does not use this: its errors stay as they were.
 */
export function releaseEditStateRejection(error: unknown, what: "release" | "send_for_review" | "deobfuscation"): unknown {
  if (!(error instanceof PlayAdapterError) || error.code !== "play_api_rejected") return error;
  const cause = error.cause_detail?.provider_cause;
  const subject = what === "release"
    ? "the release edit was not committed"
    : what === "deobfuscation" ? "the deobfuscation files were not committed" : "nothing was sent for review";
  if (cause === "EDIT_IN_REVIEW") {
    return new PlayAdapterError(409, "play_edit_in_review",
      `Another change for this app is in review on Google Play (Hands commits with ERROR_IF_IN_REVIEW and never cancels it); ${subject}. Wait for the review to finish, then run it again.`,
      error.cause_detail);
  }
  if (cause === "APP_REVIEW_NOT_MANAGED") {
    // The opposite remedy to the branch below: the app does not allow
    // upload-without-review, so nothing here can be submitted by hand and retrying
    // with or without the flag changes nothing until the open review finishes.
    return new PlayAdapterError(409, "play_review_not_managed",
      `This app does not allow uploading a release without sending it for review, and another change is already in review; ${subject}. Retrying with or without changesNotSentForReview will fail the same way. Wait for the open review to finish, or enable managed publishing for this app once.`,
      error.cause_detail);
  }
  if (cause === "CHANGES_NOT_SENT_FOR_REVIEW") {
    return new PlayAdapterError(409, "play_changes_not_sent_for_review",
      `Google Play requires this app's changes to be sent for review from Play Console; ${subject}. Send the pending changes for review in Play Console.`,
      error.cause_detail);
  }
  if (!cause || cause === "OTHER") {
    return new PlayAdapterError(502, "play_edit_state_unknown",
      `Google Play answered the commit in a way Hands does not recognise; ${what === "send_for_review" ? "it is not reported as sent for review" : what === "deobfuscation" ? "the deobfuscation files are not reported as committed" : "the release is not reported as committed"}. Check the app in Play Console before running it again.`,
      {
        stage: "commit_edit",
        provider_cause: "OTHER",
        tried: editStatePatternsTried(),
        ...(error.cause_detail?.message_sha256
          ? { message_sha256: error.cause_detail.message_sha256, message_length: error.cause_detail.message_length }
          : {}),
      });
  }
  return error;
}

export class GooglePlayClient {
  constructor(
    private readonly accessToken: string,
    fetchImpl: typeof fetch,
    private readonly maxAabSize: number,
    private readonly resumable: ResumableUploadOptions = DEFAULT_RESUMABLE_UPLOAD_OPTIONS,
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
    request: Pick<PromotionRequest, "packageName" | "versionCode">,
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
    const uploadUrl = `${UPLOAD_ROOT}/applications/${encodeURIComponent(request.packageName)}/edits/${encodeURIComponent(editId)}/apks/${request.versionCode}/deobfuscationFiles/${symbolType}`;
    const integrityError = () => new PlayAdapterError(409, kind.integrityCode, `Streamed ${kind.label} did not match the Hands identity`);
    let response: Response;
    try {
      response = file.expectedSize >= this.resumable.thresholdBytes
        // Large files: Google's resumable protocol, one chunk in memory at a time.
        // The identity is verified before the final chunk is sent.
        ? await resumableUpload({
          fetchImpl: this.fetchImpl,
          accessToken: this.accessToken,
          uploadUrl,
          total: file.expectedSize,
          stage: kind.stage,
          source: local.stream,
          options: this.resumable,
          verify: () => {
            const hashResult = local.digest();
            if (hashResult.size !== file.expectedSize || hashResult.sha256 !== file.expectedSha256) throw integrityError();
          },
          lengthMismatch: integrityError,
        })
        : await this.fetchImpl(`${uploadUrl}?uploadType=media`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${this.accessToken}`,
            "content-type": "application/octet-stream",
          },
          body: local.stream,
          redirect: "manual",
        });
    } catch (error) {
      if (error instanceof PlayAdapterError) {
        // Upload-protocol failures are Google's answer, so fail-soft may report them;
        // Hands' own integrity/size failures always throw.
        if (mode === "soft" && PLAY_UPLOAD_FAILURE_CODES.has(error.code)) {
          return rejected({
            error_code: error.code,
            ...(error.cause_detail?.provider_cause ? { provider_cause: error.cause_detail.provider_cause } : {}),
          });
        }
        throw error;
      }
      if (mode === "soft") return rejected({ error_code: kind.unavailableCode });
      throw new PlayAdapterError(502, kind.unavailableCode, `Google Play ${kind.label} upload failed`);
    }
    const body = await response.json().catch(() => null) as { deobfuscationFile?: { symbolType?: string } } | null;
    if (!response.ok) {
      // 413 on the simple upload reads as a size refusal, not a content rejection.
      const rejection = response.status === 413
        ? playUploadFailure("play_upload_too_large", kind.stage, 413, body)
        : playRejection(response.status, body, kind.stage);
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
      throw integrityError();
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
      // Same review decision as the release edit: with changesNotSentForReview the
      // files join the pending (unsent) changes. Committing this side edit WITHOUT
      // the flag would send every pending change for review -- the opposite of what
      // the caller asked -- and would hit ERROR_IF_IN_REVIEW while another release
      // is in review anyway.
      await this.commitEdit(request.packageName, editId, { changesNotSentForReview: request.changesNotSentForReview === true });
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

  private imagesPath(packageName: string, editId: string, language: string, imageType: PlayImageType): string {
    return `/applications/${encodeURIComponent(packageName)}/edits/${encodeURIComponent(editId)}/listings/${encodeURIComponent(language)}/${encodeURIComponent(imageType)}`;
  }

  /** edits.images.list: ordered as Play displays them. */
  async listImages(packageName: string, editId: string, language: string, imageType: PlayImageType): Promise<PlayImageRef[]> {
    const body = await this.requestJson<{ images?: unknown }>(`${API_ROOT}${this.imagesPath(packageName, editId, language, imageType)}`);
    if (body.images === undefined) return [];
    if (!Array.isArray(body.images) || body.images.length > 50) {
      throw new PlayAdapterError(502, "play_images_malformed", "Google Play returned a malformed image list");
    }
    return body.images.map(cleanImage);
  }

  /** edits.images.deleteall. The ImagesDeleteAllResponse body is not needed. */
  async deleteAllImages(packageName: string, editId: string, language: string, imageType: PlayImageType): Promise<void> {
    await this.requestEmpty(`${API_ROOT}${this.imagesPath(packageName, editId, language, imageType)}`, { method: "DELETE" });
  }

  /**
   * edits.images.upload (simple media upload). Returns Google's Image id and its
   * reported sha256; the caller records whether that matches the bytes sent.
   */
  async uploadImage(
    packageName: string,
    editId: string,
    language: string,
    imageType: PlayImageType,
    image: { bytes: Uint8Array; sha256: string; contentType: string; aiGeneratedState?: PlayAiGeneratedState },
  ): Promise<PlayImageRef> {
    const query = new URLSearchParams({ uploadType: "media" });
    if (image.aiGeneratedState) query.set("aiGeneratedState", image.aiGeneratedState);
    let response: Response;
    try {
      response = await this.fetchImpl(`${UPLOAD_ROOT}${this.imagesPath(packageName, editId, language, imageType)}?${query}`, {
        method: "POST",
        headers: { authorization: `Bearer ${this.accessToken}`, "content-type": image.contentType },
        body: image.bytes as Uint8Array<ArrayBuffer>,
        redirect: "manual",
        signal: AbortSignal.timeout(120_000),
      });
    } catch {
      throw new PlayAdapterError(502, "play_image_upload_unavailable", "Google Play image upload failed");
    }
    const body = await response.json().catch(() => null) as { image?: unknown } | null;
    if (!response.ok) throw playRejection(response.status, body, "upload_image");
    return cleanImage(body?.image);
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
    request: Pick<PromotionRequest, "versionCode" | "expectedSha256">,
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
    const notSentForReview = request.changesNotSentForReview === true;
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
      if (request.requireExistingBundle && bundleUploaded) {
        throw new PlayAdapterError(409, "play_bundle_not_on_play",
          "Google Play does not hold the accepted bundle; refusing to omit its mapping");
      }
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
      if (notSentForReview) {
        try {
          await this.commitEdit(request.packageName, editId, { changesNotSentForReview: true });
        } catch (error) {
          throw releaseEditStateRejection(error, "release");
        }
      } else {
        await this.commitEdit(request.packageName, editId);
      }
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
      ...(request.requireExistingBundle ? { confirmed_existing_bundle: true as const } : {}),
      track: request.handsTrack,
      sha256: request.expectedSha256,
      rollout_percent: request.rolloutPercent,
      // One entry per declared file, in upload order: acknowledged (uploaded:true)
      // or refused (attempt:"rejected", bundle-already-on-Play path only). Empty
      // when Hands declared none.
      deobfuscation_files: deobfuscationFiles,
      // The languages sent as releaseNotes on the new track release (empty: none).
      release_notes_languages: (request.releaseNotes ?? []).map((note) => note.language),
      // Present only when requested, so a promotion without the flag returns exactly
      // what it always did. true = every edit was committed changesNotSentForReview.
      ...(notSentForReview ? { changes_not_sent_for_review: true as const } : {}),
    };
  }

  /** Best-effort lifecycle read for one versionCode; evidence only, never fatal. */
  private async lifecycleOf(packageName: string, playTrack: string, versionCode: number): Promise<string | null> {
    try {
      const releases = await this.listReleaseStates(packageName, playTrack);
      const match = releases.find((release) => release.activeArtifacts.some((artifact) => artifact.versionCode === versionCode));
      return match && /^[A-Z][A-Z0-9_]{0,80}$/.test(match.releaseLifecycleState) ? match.releaseLifecycleState : null;
    } catch {
      return null;
    }
  }

  /**
   * Send the app's pending (not-sent-for-review) changes for review.
   *
   * Google has no "send for review" method. edits.commit documents
   * changesNotSentForReview as "the changes in this edit will not be reviewed until
   * they are explicitly sent for review"; committing an edit WITHOUT that flag is
   * the API's only lever, and whether such a commit also submits changes saved
   * earlier with the flag is not documented by Google. So this does exactly one
   * thing -- open an edit, check that the release Hands is talking about is really
   * there, commit with ERROR_IF_IN_REVIEW and no changesNotSentForReview -- and
   * records the release lifecycle before and after as evidence.
   *
   * Checks before the commit (the edit is deleted on any failure):
   *   - the bundle Play holds for versionCode has the accepted sha256;
   *   - the requested Play track carries a release with that versionCode.
   * The edit itself carries no changes. Never CANCEL_IN_REVIEW_AND_SUBMIT.
   */
  async sendForReview(request: SendForReviewRequest): Promise<SendForReviewResult> {
    const lifecycleBefore = await this.lifecycleOf(request.packageName, request.playTrack, request.versionCode);
    const editId = await this.createEdit(request.packageName);
    let trackRelease: TrackRelease | undefined;
    try {
      const onPlay = await this.bundleAlreadyOnPlay(request.packageName, editId, request);
      if (!onPlay) {
        throw new PlayAdapterError(409, "play_bundle_not_on_play",
          "Google Play holds no bundle for this versionCode; promote it (with changes_not_sent_for_review) first");
      }
      const track = await this.getTrack(request.packageName, editId, request.playTrack);
      trackRelease = (track.releases ?? []).find((release) =>
        release.versionCodes?.some((value) => exactVersionCode(value) === request.versionCode));
      if (!trackRelease) {
        throw new PlayAdapterError(409, "play_release_not_on_track",
          "The requested Play track has no release with this versionCode; nothing was sent for review");
      }
    } catch (error) {
      await this.cleanupOrThrow(request.packageName, editId, error);
    }
    let committedId: string | null;
    try {
      committedId = await this.commitEdit(request.packageName, editId);
    } catch (error) {
      // No HTTP answer: Google may or may not have committed. Leave the edit alone.
      if (error instanceof PlayAdapterError && error.code === "play_api_unavailable") {
        throw new PlayAdapterError(502, "play_commit_ambiguous",
          "Google Play did not answer the commit; check Play Console before running it again", { stage: "commit_edit" });
      }
      if (error instanceof PlayAdapterError && error.code === "play_api_malformed") {
        throw new PlayAdapterError(502, "play_edit_state_unknown",
          "Google Play answered the commit in a way Hands does not recognise; it is not reported as sent for review. Check the app in Play Console before running it again.",
          { stage: "commit_edit", provider_cause: "MALFORMED_RESPONSE", tried: editStatePatternsTried() });
      }
      // ERROR_IF_IN_REVIEW leaves a rejected edit valid; delete it (best effort).
      await this.deleteEdit(request.packageName, editId).catch(() => undefined);
      throw releaseEditStateRejection(error, "send_for_review");
    }
    if (committedId !== editId) {
      throw new PlayAdapterError(502, "play_edit_state_unknown",
        "Google Play answered the commit in a way Hands does not recognise; it is not reported as sent for review. Check the app in Play Console before running it again.",
        { stage: "commit_edit", provider_cause: "MALFORMED_RESPONSE", tried: editStatePatternsTried() });
    }
    const lifecycleAfter = await this.lifecycleOf(request.packageName, request.playTrack, request.versionCode);
    const release = trackRelease!;
    return {
      edit_id: editId,
      package_name: request.packageName,
      version_code: request.versionCode,
      track: request.handsTrack,
      play_track: request.playTrack,
      sha256: request.expectedSha256,
      track_release: {
        status: typeof release.status === "string"
          && ["statusUnspecified", "draft", "inProgress", "halted", "completed"].includes(release.status) ? release.status : null,
        user_fraction: typeof release.userFraction === "number" ? release.userFraction : null,
      },
      commit: { changes_in_review_behavior: "ERROR_IF_IN_REVIEW", changes_not_sent_for_review: false },
      lifecycle_before: lifecycleBefore,
      lifecycle_after: lifecycleAfter,
    };
  }

  /**
   * Upload deobfuscation files (R8/ProGuard mapping, native debug symbols) for a
   * versionCode Play ALREADY holds, in one edit that changes nothing else: no
   * bundle upload, no track update, no rollout, no release notes. This is how a
   * mapping is backfilled for a version that is already live.
   *
   *   edits.insert -> edits.bundles.list (the versionCode must be there, with the
   *   expected AAB sha256) -> [dry_run: edits.delete, return]
   *   -> edits.deobfuscationfiles.upload per file (strict) -> edits.commit
   *
   * Commit is plain: changesInReviewBehavior=ERROR_IF_IN_REVIEW (never cancels a
   * review) and no changesNotSentForReview. Any failure after the insert deletes
   * the edit (best effort), so nothing is half-committed and no edit is leaked.
   * Re-running is meant to be safe: Google keeps one file per symbolType for a
   * versionCode, and an upload replaces it.
   */
  async uploadDeobfuscation(request: UploadDeobfuscationRequest): Promise<UploadDeobfuscationResult> {
    this.lastBundleLookup = null;
    const editId = await this.createEdit(request.packageName);
    const files: DeobfuscationFileResult[] = [];
    try {
      const onPlay = await this.bundleAlreadyOnPlay(request.packageName, editId, request);
      if (!onPlay) {
        throw new PlayAdapterError(409, "version_not_on_play",
          "Google Play holds no bundle for this versionCode; deobfuscation files can only be attached to a version already on Play",
          { stage: "bundle_lookup", ...(this.lastBundleLookup ? { bundle_lookup: this.lastBundleLookup } : {}) });
      }
      if (request.mode === "dry_run") {
        for (const file of request.files) {
          files.push({ symbol_type: file.symbolType, sha256: file.expectedSha256, size_bytes: file.expectedSize, uploaded: false });
        }
      } else {
        for (const file of request.files) {
          if (!file.body) {
            throw new PlayAdapterError(400, "deobfuscation_request_invalid", "Hands deobfuscation upload request is invalid");
          }
          files.push({
            ...(await this.uploadDeobfuscationFile(request, editId, file.symbolType, {
              body: file.body, expectedSha256: file.expectedSha256, expectedSize: file.expectedSize,
            })),
            edit: "upload_deobfuscation",
          });
        }
      }
    } catch (error) {
      await this.cleanupOrThrow(request.packageName, editId, error);
    }
    if (request.mode === "dry_run") {
      await this.deleteEdit(request.packageName, editId);
      return {
        mode: "dry_run", edit_id: editId, package_name: request.packageName, version_code: request.versionCode,
        version_on_play: true, files, commit: null,
      };
    }
    try {
      await this.commitEdit(request.packageName, editId);
    } catch (error) {
      // Never leave the edit behind. If the commit did land, Google refuses to
      // delete a committed edit and nothing changes; if it did not, this clears it.
      await this.deleteEdit(request.packageName, editId).catch(() => undefined);
      if (error instanceof PlayAdapterError && error.code === "play_api_unavailable") {
        throw new PlayAdapterError(502, "play_commit_ambiguous",
          "Google Play did not answer the commit; check Play Console, then run it again (re-uploading replaces the same file)", { stage: "commit_edit" });
      }
      if (error instanceof PlayAdapterError && error.code === "play_api_malformed") {
        throw new PlayAdapterError(502, "play_edit_state_unknown",
          "Google Play answered the commit in a way Hands does not recognise; the deobfuscation files are not reported as committed. Check the app in Play Console before running it again.",
          { stage: "commit_edit", provider_cause: "MALFORMED_RESPONSE", tried: editStatePatternsTried() });
      }
      throw releaseEditStateRejection(error, "deobfuscation");
    }
    return {
      mode: "commit", edit_id: editId, package_name: request.packageName, version_code: request.versionCode,
      version_on_play: true, files,
      commit: { changes_in_review_behavior: "ERROR_IF_IN_REVIEW", changes_not_sent_for_review: false },
    };
  }
}
