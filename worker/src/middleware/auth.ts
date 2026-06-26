/**
 * Auth middleware — Cloudflare Access JWT (production) or static API token (dev)
 *
 * For internal admin tools, we use Cloudflare Access to gate the entire admin route.
 * For CI / programmatic access, use a bearer token validated against the
 * `ADMIN_API_TOKEN` secret.
 */

import type { MiddlewareHandler } from "hono";

export const authMiddleware: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  const env = c.env.ENVIRONMENT;

  // Production: trust Cloudflare Access JWT in `cf-access-jwt-assertion` header
  if (env === "production") {
    const jwt = c.req.header("cf-access-jwt-assertion");
    if (!jwt) {
      return c.json({ error: "unauthorized: missing Cloudflare Access JWT" }, 401);
    }
    // NOTE: JWT verification is done by Cloudflare Access at the edge — if the header
    // is present, the request is already authenticated. For role checks, parse `email`
    // claim from `cf-access-authenticated-user-email` header.
    const email = c.req.header("cf-access-authenticated-user-email");
    if (!email) {
      return c.json({ error: "forbidden: no authenticated user" }, 403);
    }
    await next();
    return;
  }

  // Development: static API token (read from secret binding or .dev.vars)
  const auth = c.req.header("authorization");
  if (!auth || !auth.startsWith("Bearer ")) {
    return c.json({ error: "unauthorized: missing bearer token" }, 401);
  }
  const token = auth.slice("Bearer ".length).trim();
  // In dev, ADMIN_API_TOKEN secret is set via wrangler dev --secret or .dev.vars
  if (!c.env.ADMIN_API_TOKEN || token !== c.env.ADMIN_API_TOKEN) {
    return c.json({ error: "forbidden: invalid token" }, 403);
  }
  await next();
};