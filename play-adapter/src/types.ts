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
  /**
   * Commit every edit of this promotion with `changesNotSentForReview=true`: the
   * bundle, track release, notes and deobfuscation files are saved on Play but not
   * sent for review (sendForReview, or Play Console, does that later). Default
   * false: the parameter is not sent, exactly as before.
   */
  changesNotSentForReview?: boolean;
}

/** sendForReview: one Hands release (versionCode) on one Hands track. */
export interface SendForReviewRpcInput extends TrackMaximumRpcInput {
  versionCode: number;
  /** sha256 of the accepted AAB; the bundle Play holds for versionCode must match. */
  expectedSha256: string;
  operationId: string;
}

export interface SendForReviewRequest {
  packageName: string;
  handsTrack: HandsTrack;
  playTrack: string;
  versionCode: number;
  expectedSha256: string;
  operationId: string;
}

/**
 * Result of sendForReview. `lifecycle_before/after` are best-effort reads of
 * tracks.releases.list (null when the read failed or no release carried the
 * versionCode); they are evidence only, never the success criterion.
 */
export interface SendForReviewResult {
  edit_id: string;
  package_name: string;
  version_code: number;
  track: HandsTrack;
  play_track: string;
  sha256: string;
  /** The track release in the edit that carried versionCode, before the commit. */
  track_release: { status: string | null; user_fraction: number | null };
  commit: { changes_in_review_behavior: "ERROR_IF_IN_REVIEW"; changes_not_sent_for_review: false };
  lifecycle_before: string | null;
  lifecycle_after: string | null;
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
  /** Commit with changesNotSentForReview=true (every edit of this promotion). */
  changesNotSentForReview?: boolean;
}

/** Read-only release summaries; lifecycle is distinct from edits.tracks status. */
export interface ReleaseSummary {
  releaseName: string;
  track: string;
  activeArtifacts: Array<{ versionCode: number }>;
  releaseLifecycleState: string;
}

/**
 * androidpublisher v3 `Listing` (discovery revision 20261027): every field is an
 * optional string, field names exactly as Google spells them. `language` is the
 * BCP-47 tag that is also the edits.listings path parameter.
 */
export interface PlayListing {
  language: string;
  title?: string;
  shortDescription?: string;
  fullDescription?: string;
  video?: string;
}

/** The mutable Listing fields, in Google's order. `language` is the key, not a field. */
export const PLAY_LISTING_FIELDS = ["title", "shortDescription", "fullDescription", "video"] as const;
export type PlayListingField = typeof PLAY_LISTING_FIELDS[number];

/**
 * dry_run: apply inside a fresh edit, edits.validate, then edits.delete.
 * commit: apply, edits.validate, edits.commit, then read back from a new edit.
 */
export type StoreListingMode = "dry_run" | "commit";

export interface StoreListingReadRpcInput extends PlayDiscoveryInput {}

export interface StoreListingPushRpcInput extends PlayDiscoveryInput {
  operationId: string;
  mode: StoreListingMode;
  /**
   * Listings to write. A field that is absent keeps the value Play already has
   * (Hands writes edits.listings.update with the merged resource); a field that is
   * present replaces it. Only `video` may be the empty string (clears the video).
   */
  listings: PlayListing[];
  /** edits.listings.delete every current language that is not in `listings`. Default false. */
  deleteUnlistedLanguages?: boolean;
  /** edits.commit `changesNotSentForReview=true`. Default false (parameter not sent). */
  changesNotSentForReview?: boolean;
  /** Image sets to replace in the same edit, after the listing text. Default none. */
  images?: StoreListingImageSetInput[];
}

export type StoreListingAction = "create" | "update" | "delete" | "unchanged";

export interface StoreListingChange {
  language: string;
  action: StoreListingAction;
  /** Fields whose value differs between before and after (empty for unchanged). */
  changed_fields: PlayListingField[];
  /** The listing Play held in the edit before Hands wrote; null for create. */
  before: PlayListing | null;
  /** The listing Hands wrote; null for delete. */
  after: PlayListing | null;
}

export interface StoreListingPushResult {
  edit_id: string;
  package_name: string;
  mode: StoreListingMode;
  /** validated: dry run passed edits.validate and the edit was deleted. */
  outcome: "validated" | "committed" | "no_changes";
  default_language: string | null;
  changes: StoreListingChange[];
  /** One entry per requested image set. Absent from adapters older than images. */
  image_changes: StoreListingImageChange[];
  changes_not_sent_for_review: boolean;
}

export interface StoreListingReadResult {
  package_name: string;
  default_language: string | null;
  listings: PlayListing[];
}

/** edits.images imageType, Google's full enum (discovery revision 20261027). */
export const PLAY_IMAGE_TYPES = [
  "appImageTypeUnspecified",
  "phoneScreenshots",
  "sevenInchScreenshots",
  "tenInchScreenshots",
  "tvScreenshots",
  "wearScreenshots",
  "icon",
  "featureGraphic",
  "tvBanner",
] as const;
export type PlayImageType = typeof PLAY_IMAGE_TYPES[number];

/** edits.images.upload `aiGeneratedState` query enum (discovery revision 20261027). */
export const PLAY_AI_GENERATED_STATES = [
  "aiGeneratedStateUnspecified",
  "aiGeneratedStateNotAiGenerated",
  "aiGeneratedStateAiGeneratedDeveloperAttested",
] as const;
export type PlayAiGeneratedState = typeof PLAY_AI_GENERATED_STATES[number];

export interface StoreListingImageInput {
  bytes: Uint8Array;
  sha256: string;
  contentType: "image/png" | "image/jpeg";
  /** Passed to edits.images.upload as-is; omitted when absent. */
  aiGeneratedState?: PlayAiGeneratedState;
}

/** Replace one (language, imageType) set: edits.images.deleteall, then upload in order. */
export interface StoreListingImageSetInput {
  language: string;
  imageType: PlayImageType;
  images: StoreListingImageInput[];
}

/**
 * Google `Image` fields Hands keeps: id and Google's reported sha256 (sha1/url are
 * not needed). sha256 is null when Google omits it or sends something that is not
 * a hex digest.
 */
export interface PlayImageRef {
  id: string;
  sha256: string | null;
}

/**
 * One uploaded image. `sha256` is Hands' own digest of the bytes it sent (checked
 * against the declaration before upload; that check fails closed). Google's
 * `Image.sha256` is recorded beside it: undocumented whether it is a digest of the
 * uploaded bytes, so a difference is a recorded warning, never a failure.
 */
export interface UploadedImageRecord {
  id: string;
  sha256: string;
  provider_sha256: string | null;
  /** null when Google returned no sha256. */
  sha256_match: boolean | null;
  size_bytes: number;
  aiGeneratedState: PlayAiGeneratedState | null;
}

export interface StoreListingImageChange {
  language: string;
  imageType: PlayImageType;
  /** unchanged: Play already holds exactly these bytes in this order; nothing was sent. */
  action: "replace" | "unchanged";
  before: PlayImageRef[];
  after: UploadedImageRecord[];
  /** Commit only: what a fresh edit lists for this set afterwards. */
  readback?: { count: number; sha256_match: boolean | null };
}
