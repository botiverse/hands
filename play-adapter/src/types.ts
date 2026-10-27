import type { PlayErrorCause } from "./errors";
export type HandsTrack = "internal" | "closed" | "production";

export interface PlayAdapterEnv {
  /** Maximum streamed AAB size accepted from Hands. */
  MAX_AAB_SIZE_BYTES?: string;
}

export interface ServiceAccountCredential {
  type: "service_account";
  project_id?: string;
  client_email: string;
  private_key: string;
  private_key_id?: string;
}

export interface GoogleOAuthCredential {
  type: "authorized_user";
  client_id: string;
  client_secret: string;
  refresh_token: string;
  client_email: string;
}
export type GooglePlayCredential = ServiceAccountCredential | GoogleOAuthCredential;

export type PlayTracks = Record<HandsTrack, string>;

export interface PlayDiscoveryInput {
  credential: GooglePlayCredential;
  packageName: string;
}

export interface PlayBindingInput extends PlayDiscoveryInput {
  credential: GooglePlayCredential;
  packageName: string;
  tracks: PlayTracks;
}

export interface TrackMaximumRpcInput extends PlayBindingInput {
  handsTrack: HandsTrack;
}

/**
 * Declared identity of the optional native debug symbols zip. Google's
 * edits.deobfuscationfiles.upload mediaUpload.maxSize is 2,097,152,000 bytes
 * (v3 discovery document); Hands enforces the same bound before streaming.
 */
export interface SymbolsRpcInput {
  expectedSha256: string;
  expectedSize: number;
}

/** Google Play edits.deobfuscationfiles.upload `deobfuscationFileType` values Hands uploads. */
export type DeobfuscationSymbolType = "nativeCode" | "proguard";

/** Play `LocalizedText`: a BCP-47 language tag and plain text (Play caps it at 500 characters). */
export interface LocalizedReleaseNote {
  language: string;
  text: string;
}

export interface PromotionRpcInput extends TrackMaximumRpcInput {
  versionCode: number;
  expectedSha256: string;
  expectedSize: number;
  rolloutPercent: number;
  operationId: string;
  /** Optional native debug symbols declaration; the zip bytes arrive as a separate stream. */
  symbols?: SymbolsRpcInput | null;
  /** Optional R8/ProGuard mapping.txt declaration; the bytes arrive as the fourth RPC argument. */
  mapping?: SymbolsRpcInput | null;
  /** Optional release notes for the new track release, already mapped to Play BCP-47 tags. */
  releaseNotes?: LocalizedReleaseNote[] | null;
}

/**
 * What happened to one declared deobfuscation file during promote().
 *
 * uploaded:true  -> Google acknowledged the requested symbolType.
 * attempt:"rejected" -> Hands tried and Google refused (only reported, not
 *   thrown, when the bundle was already on Play; see GooglePlayClient.promote).
 *   The fields are identifiers this adapter derived, never Google's prose.
 */
export interface DeobfuscationFileResult {
  symbol_type: DeobfuscationSymbolType;
  sha256: string;
  size_bytes: number;
  uploaded: boolean;
  /** "existing_bundle" when attached to a bundle Play already held, in its own edit. */
  edit?: "promotion" | "existing_bundle";
  attempt?: "rejected";
  /** Adapter stage that failed: upload_symbols | upload_mapping | commit_edit. */
  stage?: string;
  /** Adapter error code, e.g. play_api_rejected or play_mapping_malformed. */
  error_code?: string;
  /** Google's HTTP status, when Google answered. */
  http_status?: number;
  /** Google's documented reason identifiers (allowlisted), e.g. insufficientPermissions. */
  provider_reason?: string;
  /** Classified cause of Google's message (e.g. EDIT_IN_REVIEW, OTHER). */
  provider_cause?: string;
}

export type AdapterResult<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      // `cause` is part of the declared contract, not an extra: callers persist it,
      // and without a named field each consumer would have to cast the error to reach
      // it -- which is how a rename upstream becomes a silent behavioural change
      // instead of a compile error.
      error: { status: number; code: string; message: string; cause?: PlayErrorCause };
    };

export interface TrackRelease {
  name?: string;
  versionCodes?: string[];
  releaseNotes?: Array<{ language: string; text: string }>;
  status?: "statusUnspecified" | "draft" | "inProgress" | "halted" | "completed";
  userFraction?: number;
  countryTargeting?: { countries?: string[]; includeRestOfWorld?: boolean };
  inAppUpdatePriority?: number;
}

export interface TrackResource {
  track?: string;
  releases?: TrackRelease[];
}

export interface PromotionSymbolsRequest {
  body: ReadableStream<Uint8Array>;
  expectedSha256: string;
  expectedSize: number;
}

export interface PromotionRequest {
  packageName: string;
  handsTrack: HandsTrack;
  playTrack: string;
  versionCode: number;
  expectedSha256: string;
  expectedSize: number;
  rolloutPercent: number;
  operationId: string;
  body: ReadableStream<Uint8Array>;
  /** Present only when Hands declared symbols for this promotion. */
  symbols?: PromotionSymbolsRequest | null;
  /** Present only when Hands declared an R8/ProGuard mapping for this promotion. */
  mapping?: PromotionSymbolsRequest | null;
  /** Validated release notes for the new track release; null/empty sends none. */
  releaseNotes?: LocalizedReleaseNote[] | null;
}

/** Read-only release summaries; lifecycle is distinct from edits.tracks status. */
export interface ReleaseSummary {
  releaseName: string;
  track: string;
  activeArtifacts: Array<{ versionCode: number }>;
  releaseLifecycleState: string;
}
