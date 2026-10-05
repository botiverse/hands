import { isTransientD1LookupError } from "../lib/d1_lookup_recovery";
import { sealedReporterFailure } from "../lib/reporter_failure_detail";
import { reporterFailureDiagnostic } from "../lib/reporter_failure";
import type { MiddlewareHandler, ErrorHandler } from "hono";

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
  const isReporterFailure = c.res.status >= 500 && (
    (c.req.method === "GET" && route === "/api/apps/:appId/reporter-feedback")
    || (c.req.method === "PUT" && route === "/api/apps/:appId/reporter-feedback/route-subject")
  );
  const diagnostic = isReporterFailure ? reporterFailureDiagnostic(c, c.error) : {};
  const sealed = isReporterFailure ? await sealedReporterFailure(c.error) : null;
  if (sealed) console.info("hands_reporter_failure_detail", JSON.stringify({ ...sealed, ...diagnostic, timestamp: Date.now(), route }));
  console.info("hands_http_response", JSON.stringify({
    ...diagnostic,
    timestamp: Date.now(),
    method: c.req.method,
    route,
    status: c.res.status,
    duration_ms: Math.max(0, Date.now() - started),
    request_id: /^[a-f0-9]{16}-[A-Z]{3}$/.test(ray) ? ray : null,
  }));
};

// Preserve Hono's response behavior, but leave reporter exception details to
// the sealed diagnostic instead of handing the Error object to console.error.
export const reporterErrorHandler: ErrorHandler = (error, c) => {
  if ("getResponse" in error) {
    const response = (error as Error & { getResponse(): Response }).getResponse();
    return c.newResponse(response.body, response);
  }
  const path = c.req.path;
  const reporter = (c.req.method === "GET" && /^\/api\/apps\/[^/]+\/reporter-feedback$/.test(path))
    || (c.req.method === "PUT" && /^\/api\/apps\/[^/]+\/reporter-feedback\/route-subject$/.test(path));
  if (reporter && isTransientD1LookupError(error)) {
    // Cover later database stages too, without replaying an ambiguous write.
    // Hono preserves c.error for the sealed telemetry after this response.
    c.header("Retry-After", "1");
    return c.json({ error: "reporter backend temporarily unavailable", code: "REPORTER_BACKEND_UNAVAILABLE" }, 503);
  }
  if (!reporter) console.error(error);
  return c.text("Internal Server Error", 500);
};
