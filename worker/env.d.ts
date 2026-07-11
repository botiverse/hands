/**
 * Extra secret bindings are not emitted by wrangler types, so declare them
 * explicitly. Non-secret vars still live in wrangler.jsonc.
 */

import "@cloudflare/workers-types";

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
    RAFT_ALLOWED_SERVER_IDS?: string;
    RAFT_ALLOWED_SERVER_SLUGS?: string;
  }
}

export {};
