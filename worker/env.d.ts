/**
 * Workaround for ADMIN_API_TOKEN being a Cloudflare Worker secret binding
 * (not in `vars`), so wrangler types doesn't include it. We declare it
 * explicitly here as `string | undefined`.
 *
 * The CF_ACCESS_* vars are declared in wrangler.jsonc so they DO show up in
 * the generated worker-configuration.d.ts. We re-declare them here just to
 * make the Env type available alongside the auto-generated bindings.
 */

import "@cloudflare/workers-types";

declare global {
  interface Env {
    ADMIN_API_TOKEN?: string;
    CF_ACCESS_AUD?: string;
    CF_ACCESS_JWKS_URL?: string;
  }
}

export {};