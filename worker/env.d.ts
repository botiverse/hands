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
    SIGNED_URL_SECRET?: string;
    RAFT_ALLOWED_SERVER_IDS?: string;
    RAFT_ALLOWED_SERVER_SLUGS?: string;
  }
}

export {};
