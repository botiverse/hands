/**
 * Auth middleware.
 *
 * Two modes, picked by `c.env.ENVIRONMENT`:
 *
 *   - "production" (or anything else with CF_ACCESS_AUD set):
 *       Verify the `cf-access-jwt-assertion` header against the Cloudflare
 *       Access JWKs at `CF_ACCESS_JWKS_URL`. The JWT must be signed by the
 *       Access app whose AUD tag matches `CF_ACCESS_AUD`. On success, the
 *       verified email is available as `c.get("cf_email")` for handlers to use.
 *
 *   - development (no CF_ACCESS_AUD):
 *       Static Bearer token comparison against the `ADMIN_API_TOKEN` secret,
 *       set via `wrangler secret put ADMIN_API_TOKEN` (or .dev.vars for dev).
 *
 * In either case, handlers under the `admin` Hono sub-app are protected;
 * public routes (/health, /api/apps/:appId/versions, /public/*) skip auth.
 */

import type { MiddlewareHandler } from "hono";
import { createRemoteJWKSet, jwtVerify } from "jose";

export type AdminEnv = {
  Variables: {
    cf_email?: string;
    cf_jwt?: string;
  };
};

// Cache the JWKs remote set per Worker instance — `createRemoteJWKSet` does
// its own caching internally but we lazily initialize on first request to
// avoid boot-time cost.
let jwksCache: ReturnType<typeof createRemoteJWKSet> | null = null;
let jwksCacheUrl: string | null = null;

function getJwks(url: string) {
  if (jwksCache && jwksCacheUrl === url) return jwksCache;
  jwksCache = createRemoteJWKSet(new URL(url));
  jwksCacheUrl = url;
  return jwksCache;
}

export const authMiddleware: MiddlewareHandler<AdminEnv & { Bindings: Env }> = async (
  c,
  next,
) => {
  const env: string = c.env.ENVIRONMENT;
  const cfAud = c.env.CF_ACCESS_AUD;
  const cfJwksUrl = c.env.CF_ACCESS_JWKS_URL;

  // Production: trust Cloudflare Access JWT
  if (cfAud && cfJwksUrl) {
    const jwt = c.req.header("cf-access-jwt-assertion");
    if (!jwt) {
      return c.json(
        { error: "unauthorized: missing Cloudflare Access JWT" },
        401,
      );
    }

    try {
      const jwks = getJwks(cfJwksUrl);
      const { payload } = await jwtVerify(jwt, jwks, {
        audience: cfAud,
        issuer: new URL("/", cfJwksUrl).origin,
      });

      // Stash verified identity for handlers to use (e.g. audit log actor).
      c.set("cf_email", String(payload.email ?? ""));
      c.set("cf_jwt", jwt);
      await next();
      return;
    } catch (e) {
      return c.json(
        {
          error: "unauthorized: Cloudflare Access JWT verification failed",
          detail: e instanceof Error ? e.message : String(e),
        },
        401,
      );
    }
  }

  // Development: static API token (Bearer header)
  const auth = c.req.header("authorization");
  if (!auth || !auth.startsWith("Bearer ")) {
    return c.json({ error: "unauthorized: missing bearer token" }, 401);
  }
  const token = auth.slice("Bearer ".length).trim();
  const expected = c.env.ADMIN_API_TOKEN;
  if (!expected || token !== expected) {
    return c.json({ error: "forbidden: invalid token" }, 403);
  }
  await next();
};