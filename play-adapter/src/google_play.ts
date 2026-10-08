import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";
import { PlayAdapterError } from "./errors";
import { playRejection, playRequestStage } from "./provider_errors";
import type { PromotionRequest, TrackRelease, TrackResource, ReleaseSummary } from "./types";

const API_ROOT = "https://androidpublisher.googleapis.com/androidpublisher/v3";
const UPLOAD_ROOT = "https://androidpublisher.googleapis.com/upload/androidpublisher/v3";

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
  if (request.rolloutPercent < 100) {
    if (request.handsTrack !== "production") {
      throw new PlayAdapterError(400, "rollout_track_invalid", "Partial rollout is supported only on the production track");
    }
    return {
      versionCodes: [String(request.versionCode)],
      status: "inProgress",
      userFraction: request.rolloutPercent / 100,
    };
  }
  return { versionCodes: [String(request.versionCode)], status: "completed" };
}

function hashingBody(body: ReadableStream<Uint8Array>, maxBytes: number) {
  const hasher = sha256.create();
  let size = 0;
  let finished = false;
  const stream = body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      size += chunk.byteLength;
      if (size > maxBytes) {
        throw new PlayAdapterError(413, "aab_too_large", "AAB exceeds the configured maximum size");
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
    digest() {
      if (!finished) {
        throw new PlayAdapterError(409, "aab_integrity_mismatch", "Google Play did not consume the complete AAB stream");
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
    const body = await response.json().catch(() => null) as T | null;
    if (!response.ok) {
      throw playRejection(response.status, body, playRequestStage(url, init.method));
    }
    if (!body || typeof body !== "object") {
      console.warn("hands_play_response_shape", JSON.stringify({ stage: playRequestStage(url, init.method),
        status: response.status, jsonObject: false }));
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
      if (!row || row.track !== track || typeof row.releaseName !== "string"
          || typeof row.releaseLifecycleState !== "string" || !row.releaseLifecycleState
          || !Array.isArray(row.activeArtifacts)
          || row.activeArtifacts.some(item => !item || typeof item.versionCode !== "number"
            || !Number.isSafeInteger(item.versionCode) || item.versionCode <= 0)) {
        // Fixed booleans only: never log provider names, states, versions,
        // URLs or response contents while diagnosing a contract mismatch.
        console.warn("hands_play_release_shape", JSON.stringify({
          rowObject: !!row && typeof row === "object",
          trackMatches: row?.track === track,
          nameString: typeof row?.releaseName === "string",
          stateString: typeof row?.releaseLifecycleState === "string" && !!row.releaseLifecycleState,
          artifactsArray: Array.isArray(row?.activeArtifacts),
          artifactVersionsValid: Array.isArray(row?.activeArtifacts) && row.activeArtifacts.every(item =>
            !!item && typeof item.versionCode === "number" && Number.isSafeInteger(item.versionCode) && item.versionCode > 0),
        }));
        throw new PlayAdapterError(502, "play_releases_malformed", "Google Play returned invalid release summaries");
      }
      return { releaseName: row.releaseName, track: row.track,
        releaseLifecycleState: row.releaseLifecycleState,
        activeArtifacts: row.activeArtifacts.map(item => ({ versionCode: item.versionCode })) };
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
      throw new PlayAdapterError(502, "play_upload_rejected", `Google Play AAB upload failed with ${response.status}`);
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

  private async updateTrack(request: PromotionRequest, editId: string, current: TrackResource): Promise<void> {
    const currentMax = maxTrackVersionCode(current);
    if (request.versionCode !== currentMax + 1) {
      throw new PlayAdapterError(409, "play_version_conflict", "AAB versionCode is no longer the live track maximum plus one");
    }
    if ((current.releases ?? []).some((release) => release.status === "inProgress" || release.status === "halted")) {
      throw new PlayAdapterError(409, "play_rollout_conflict", "The track already has a staged or halted release");
    }
    await this.requestJson<TrackResource>(
      `${this.editRoot(request.packageName, editId)}/tracks/${encodeURIComponent(request.playTrack)}`,
      {
        method: "PUT",
        body: JSON.stringify({
          track: request.playTrack,
          releases: [...(current.releases ?? []).map(cleanRelease), requestedRelease(request)],
        }),
      },
    );
  }

  private async commitEdit(packageName: string, editId: string): Promise<void> {
    await this.requestJson<{ id?: string }>(
      `${this.editRoot(packageName, editId)}:commit?changesInReviewBehavior=ERROR_IF_IN_REVIEW`,
      { method: "POST", body: "{}" },
    );
  }

  private async cleanupOrThrow(packageName: string, editId: string, original: unknown): Promise<never> {
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

  async promote(request: PromotionRequest) {
    if (request.expectedSize > this.maxAabSize) {
      throw new PlayAdapterError(413, "aab_too_large", "AAB exceeds the configured maximum size");
    }
    const editId = await this.createEdit(request.packageName);
    let commitAttempted = false;
    try {
      await this.uploadBundle(request, editId);
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
      track: request.handsTrack,
      sha256: request.expectedSha256,
      rollout_percent: request.rolloutPercent,
    };
  }
}
