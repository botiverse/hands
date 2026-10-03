import { PlayAdapterError } from "./errors";

// Only documented error identifiers cross the provider boundary. Never expose
// Google's arbitrary message, metadata, URLs or the request's credential.
const REASONS = new Set([
  "SERVICE_DISABLED", "API_DISABLED", "ACCESS_TOKEN_SCOPE_INSUFFICIENT",
  "IAM_PERMISSION_DENIED", "RATE_LIMIT_EXCEEDED", "QUOTA_EXCEEDED",
  "accessNotConfigured", "insufficientPermissions", "permissionDenied",
  "forbidden", "authError", "notFound", "applicationNotFound",
  "quotaExceeded", "rateLimitExceeded", "userRateLimitExceeded",
]);

export function playRequestStage(url: string, method = "GET"): string {
  const path = new URL(url).pathname;
  if (path.endsWith("/edits") && method === "POST") return "create_edit";
  if (path.endsWith(":commit")) return "commit_edit";
  if (path.endsWith("/bundles")) return "upload_bundle";
  if (path.endsWith("/tracks")) return "list_tracks";
  if (path.includes("/tracks/")) return method === "PUT" ? "update_track" : "get_track";
  if (method === "DELETE") return "delete_edit";
  return "play_request";
}

export function playRejection(status: number, body: unknown, stage: string): PlayAdapterError {
  const error = body && typeof body === "object" ? (body as Record<string, unknown>).error : null;
  const reasons = new Set<string>();
  if (error && typeof error === "object") {
    const e = error as Record<string, unknown>;
    for (const items of [e.errors, e.details]) {
      if (!Array.isArray(items)) continue;
      for (const item of items) {
        if (!item || typeof item !== "object") continue;
        const reason = (item as Record<string, unknown>).reason;
        if (typeof reason === "string" && REASONS.has(reason)) reasons.add(reason);
      }
    }
  }
  const reason = [...reasons].sort().join(",") || "unspecified";
  return new PlayAdapterError(
    [400, 401, 403, 404].includes(status) ? 403 : 502,
    "play_api_rejected",
    `Google Play API request failed with ${status} (stage=${stage}; reason=${reason})`,
  );
}
