/**
 * Extra secret bindings are not emitted by wrangler types, so declare them
 * explicitly. Non-secret vars still live in wrangler.jsonc.
 */

import "@cloudflare/workers-types";

type GooglePlayCredential = import("./src/lib/google_play_bindings").GooglePlayCredential;

type GooglePlayTracks = Record<"internal" | "closed" | "production", string>;

type GooglePlayBindingInput = {
  credential: GooglePlayCredential;
  packageName: string;
  tracks: GooglePlayTracks;
};

type GooglePlayAdapterResult<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      // Mirrors AdapterResult in play-adapter/src/types.ts. Kept in step by the
      // promote route's use of `error.cause`: if the adapter renames or reshapes it,
      // the worker stops compiling instead of silently writing a receipt without it.
      error: { status: number; code: string; message: string; cause?: {
        stage?: string;
        provider_cause?: string;
        cause_source?: "structured" | "message";
        /** sha256 + length of Google's unmatched message, never the text. */
        message_sha256?: string;
        message_length?: number;
        /** play_edit_state_unknown: the adapter's own descriptions of the patterns it tried. */
        tried?: string[];
      } };
    };

/** androidpublisher v3 `Listing`; mirrors PlayListing in play-adapter/src/types.ts. */
type GooglePlayListing = {
  language: string;
  title?: string;
  shortDescription?: string;
  fullDescription?: string;
  video?: string;
};

type GooglePlayStoreListingChange = {
  language: string;
  action: "create" | "update" | "delete" | "unchanged";
  changed_fields: Array<"title" | "shortDescription" | "fullDescription" | "video">;
  before: GooglePlayListing | null;
  after: GooglePlayListing | null;
};

type GooglePlayImageType = import("./src/lib/play_images").PlayImageType;
type GooglePlayAiGeneratedState = import("./src/lib/play_images").PlayAiGeneratedState;

interface GooglePlayAdapterService {
  readStoreListings(input: Pick<GooglePlayBindingInput, "credential" | "packageName">): Promise<GooglePlayAdapterResult<{
    package_name: string;
    default_language: string | null;
    listings: GooglePlayListing[];
  }>>;
  pushStoreListings(input: Pick<GooglePlayBindingInput, "credential" | "packageName"> & {
    operationId: string;
    mode: "dry_run" | "commit";
    listings: GooglePlayListing[];
    deleteUnlistedLanguages?: boolean;
    changesNotSentForReview?: boolean;
    images?: Array<{
      language: string;
      imageType: GooglePlayImageType;
      images: Array<{ bytes: Uint8Array; sha256: string; contentType: "image/png" | "image/jpeg"; aiGeneratedState?: GooglePlayAiGeneratedState }>;
    }>;
  }): Promise<GooglePlayAdapterResult<{
    edit_id: string;
    package_name: string;
    mode: "dry_run" | "commit";
    outcome: "validated" | "committed" | "no_changes";
    default_language: string | null;
    changes: GooglePlayStoreListingChange[];
    /** Older adapters omit this; Hands then fails a push that carried images. */
    image_changes?: Array<{
      language: string;
      imageType: GooglePlayImageType;
      action: "replace" | "unchanged";
      before: Array<{ id: string; sha256: string }>;
      after: Array<{ id: string; sha256: string; size_bytes: number; aiGeneratedState: GooglePlayAiGeneratedState | null }>;
    }>;
    changes_not_sent_for_review: boolean;
  }>>;
  listTracks(input: Pick<GooglePlayBindingInput, "credential" | "packageName">): Promise<GooglePlayAdapterResult<{ client_email: string; package_name: string; tracks: string[] }>>;
  verifyBinding(input: GooglePlayBindingInput): Promise<GooglePlayAdapterResult<{
    client_email: string;
    package_name: string;
    tracks: GooglePlayTracks;
  }>>;
  listReleaseStates(input: GooglePlayBindingInput & { handsTrack: keyof GooglePlayTracks }): Promise<GooglePlayAdapterResult<Array<{
    releaseName: string; track: string; activeArtifacts: Array<{ versionCode: number }>; releaseLifecycleState: string;
  }>>>;
  readTrackMaximum(input: GooglePlayBindingInput & { handsTrack: keyof GooglePlayTracks }): Promise<
    GooglePlayAdapterResult<{ max_version_code: number }>
  >;
  promote(
    input: GooglePlayBindingInput & {
      handsTrack: keyof GooglePlayTracks;
      versionCode: number;
      expectedSha256: string;
      expectedSize: number;
      rolloutPercent: number;
      operationId: string;
      /** Declared identity of the optional native debug symbols zip. */
      symbols?: { expectedSha256: string; expectedSize: number } | null;
      /** Declared identity of the optional R8/ProGuard mapping.txt (symbolType proguard). */
      mapping?: { expectedSha256: string; expectedSize: number } | null;
      /** Release notes for the new track release, as Play BCP-47 language tags. */
      releaseNotes?: Array<{ language: string; text: string }> | null;
    },
    body: ReadableStream<Uint8Array>,
    symbolsBody: ReadableStream<Uint8Array> | null,
    mappingBody?: ReadableStream<Uint8Array> | null,
  ): Promise<GooglePlayAdapterResult<{
    edit_id: string;
    package_name: string;
    version_code: number;
    track: keyof GooglePlayTracks;
    sha256: string;
    rollout_percent: number;
    /** Older adapters omit these; Hands then records the files/notes as not acknowledged. */
    deobfuscation_files?: Array<{
      symbol_type: "nativeCode" | "proguard";
      sha256: string;
      size_bytes: number;
      uploaded: boolean;
      edit?: "promotion" | "existing_bundle";
      attempt?: "rejected";
      stage?: string;
      error_code?: string;
      http_status?: number;
      provider_reason?: string;
      provider_cause?: string;
    }>;
    /** false when Play already held this exact bundle and only the track was edited. */
    bundle_uploaded?: boolean;
    release_notes_languages?: string[];
  }>>;
}

declare global {
  interface Env {
    ADMIN_API_TOKEN?: string;
    RAFT_CLIENT_SECRET?: string;
    RAFT_ORIGIN?: string;
    RAFT_API_ORIGIN?: string;
    RAFT_CLIENT_ID?: string;
    CORS_ALLOWED_ORIGINS?: string;
    BUSINESS_ORIGIN?: string;
    DASHBOARD_ORIGIN?: string;
    SIGNED_URL_SECRET?: string;
    R2_ACCOUNT_ID?: string;
    R2_BUCKET_NAME?: string;
    R2_S3_ENDPOINT?: string;
    R2_S3_ACCESS_KEY_ID?: string;
    R2_S3_SECRET_ACCESS_KEY?: string;
    R2_PRESIGNED_DOWNLOAD_TTL_SECONDS?: string;
    SHARE_STATS_SALT?: string;
    // AES-GCM key material for encrypting per-app App Store Connect .p8 keys
    // (see lib/asc_credentials.ts). Set via `wrangler secret put ASC_CRED_ENC_KEY`.
    ASC_CRED_ENC_KEY?: string;
    /** AES-GCM root secret for per-app AppGallery Connect credential JSON. */
    AGC_CRED_ENC_KEY?: string;
    /** Optional server-side Google OAuth Web client. */
    GOOGLE_PLAY_OAUTH_CLIENT_ID?: string;
    GOOGLE_PLAY_OAUTH_CLIENT_SECRET?: string;
    /** Secret JSON keyring used for app-scoped Google Play credentials. */
    PLAY_CRED_ENC_KEYS?: string;
    /** Active key version within PLAY_CRED_ENC_KEYS. */
    PLAY_CRED_ENC_ACTIVE_KEY_VERSION?: string;
    RAFT_ALLOWED_SERVER_IDS?: string;
    RAFT_ALLOWED_SERVER_SLUGS?: string;
    /** Exact HTTPS app-link callbacks registered for Hands Installer. */
    INSTALLER_REDIRECT_URIS?: string;
    HANDS_ADMIN_ALLOWED_SERVER_IDS?: string;
    FEEDBACK_AUDIT_HMAC_KEY?: string;
    FEEDBACK_AUDIT_KEY_VERSION?: string;
    /** Disabled unless exactly "true"; reporter sessions remain server-only. */
    FEEDBACK_REPORTER_SESSION_ENABLED?: string;
    /** Active version in FEEDBACK_REPORTER_SESSION_KEYS. */
    FEEDBACK_REPORTER_SESSION_ACTIVE_KEY_VERSION?: string;
    /** Secret JSON object containing one or two base64url HMAC keys by version. */
    FEEDBACK_REPORTER_SESSION_KEYS?: string;
    /** Private stateless adapter; only Hands decrypts and supplies app-scoped credentials. */
    PLAY_RELEASE_SERVICE?: GooglePlayAdapterService;
    /** Cloudflare Queue for real-time webhook first attempts (task webhooks-
     * queue). Optional: absent → webhook_deliveries are delivered only by the
     * cron reaper every 5 min. */
    WEBHOOK_QUEUE?: Queue<unknown>;
  }
}

export {};
