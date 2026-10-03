import type { MiddlewareHandler } from "hono";

// Emit final statuses, including validators/auth short-circuiting before handlers.
// Only route templates and timing are recorded: never URLs, query values,
// request/response bodies, cookies, identities, or error messages.
export const httpResponseTelemetry: MiddlewareHandler = async (c, next) => {
  const started = Date.now();
  await next();
  if (!c.req.path.startsWith("/api/")) return;
  const route = [...c.req.matchedRoutes].reverse()
    .find((r) => !r.path.includes("*"))?.path ?? "unmatched";
  const ray = c.req.header("cf-ray") ?? "";
  console.info("hands_http_response", JSON.stringify({
    timestamp: Date.now(),
    method: c.req.method,
    route,
    status: c.res.status,
    duration_ms: Math.max(0, Date.now() - started),
    request_id: /^[a-f0-9]{16}-[A-Z]{3}$/.test(ray) ? ray : null,
  }));
};
