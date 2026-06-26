/**
 * /health — simple liveness check (no auth, no D1 query)
 */

import type { Context } from "hono";

export function handleHealth(c: Context<{ Bindings: Env }>) {
  return c.json({
    ok: true,
    service: "quiver-worker",
    env: c.env.ENVIRONMENT ?? "unknown",
    time: new Date().toISOString(),
  });
}