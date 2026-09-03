/**
 * Extra secret bindings are not emitted by wrangler types, so declare them
 * explicitly. Non-secret vars still live in wrangler.jsonc.
 */

import "@cloudflare/workers-types";

type GooglePlayCredential = {
  type: "service_account";
  project_id?: string;
  private_key_id?: string;
  private_key: string;
  client_email: string;
};

type GooglePlayTracks = Record<"internal" | "closed" | "production", string>;

type GooglePlayBindingInput = {
  credential: GooglePlayCredential;
  packageName: string;
  tracks: GooglePlayTracks;
};

type GooglePlayAdapterResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: { status: number; code: string; message: string } };

interface GooglePlayAdapterService {
  verifyBinding(input: GooglePlayBindingInput): Promise<GooglePlayAdapterResult<{
    client_email: string;
    package_name: string;
    tracks: GooglePlayTracks;
  }>>;
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
    },
    body: ReadableStream<Uint8Array>,
  ): Promise<GooglePlayAdapterResult<{
    edit_id: string;
    package_name: string;
    version_code: number;
    track: keyof GooglePlayTracks;
    sha256: string;
    rollout_percent: number;
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
  }
}

export {};
