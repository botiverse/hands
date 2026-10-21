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
  if (path.includes("/deobfuscationFiles/")) return "upload_symbols";
  if (path.endsWith("/releases") && path.includes("/tracks/")) return "list_release_states";
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
  console.warn("hands_play_rejection", JSON.stringify({ stage, status, reason, provider: providerDiagnostic(body) }));
  return new PlayAdapterError(
    [400, 401, 403, 404].includes(status) ? 403 : 502,
    "play_api_rejected",
    `Google Play API request failed with ${status} (stage=${stage}; reason=${reason})`,
  );
}

/**
 * Diagnostic fields from Google's error envelope, for the operator's log only.
 *
 * The caller still receives exactly the sanitised code and stage: nothing here is
 * returned to a client, because Google's message is arbitrary text this adapter
 * does not control. Keeping it out of the response is the existing contract.
 *
 * What goes in: the message, Google's own status string, and every
 * `errors[].reason` / `errors[].message` / `details[].*` field that is a short
 * scalar. The whitelist above drops reasons like `badRequest` or
 * `releaseValidationError`, which is exactly how an investigation ends up stuck
 * on "unspecified" with no way to tell a bad release body from a permission
 * problem.
 *
 * What stays out: long or structured values are skipped so a provider cannot use
 * the log line as a channel or blow it up. Google's `message` is arbitrary text and
 * is the one field that could echo a credential back, so it is redacted: the reasons
 * and Google's status are the diagnostic value, the prose is not.
 */
function providerDiagnostic(body: unknown): Record<string, unknown> | null {
  const envelope = body && typeof body === "object" ? (body as Record<string, unknown>).error : null;
  if (!envelope || typeof envelope !== "object") return null;
  const e = envelope as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of ["code", "status"]) {
    const value = e[key];
    if (typeof value === "string" || typeof value === "number") {
      out[key] = typeof value === "string" ? clip(value) : value;
    }
  }
  // Arbitrary provider prose: report only that it exists and how long it is. A
  // credential can be reflected into this field, and the reason identifiers below
  // carry the diagnostic value.
  if (typeof e.message === "string") out.message_length = e.message.length;
  for (const key of ["errors", "details"]) {
    const items = e[key];
    if (!Array.isArray(items)) continue;
    const picked = items.slice(0, 8).map((item) => {
      const entry: Record<string, unknown> = {};
      if (item && typeof item === "object") {
        for (const [k, v] of Object.entries(item as Record<string, unknown>)) {
          // Same rule one level down: keep identifiers and scalars, never the prose
          // that could carry a reflected secret or private project metadata.
          if (k === "message" || k === "metadata") {
            if (typeof v === "string") entry[`${k}_length`] = v.length;
            continue;
          }
          if (typeof v === "string") entry[k] = k === "reason" ? reasonLike(v) : clip(v);
          else if (typeof v === "number" || typeof v === "boolean") entry[k] = v;
        }
      }
      return entry;
    });
    out[key] = picked;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** Bound a provider string so one field cannot dominate or evade the log. */
function clip(value: string): string {
  const flat = value.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  return flat.length > 300 ? `${flat.slice(0, 300)}…` : flat;
}

/**
 * Google's reason identifiers are a bounded vocabulary (`badRequest`,
 * `releaseValidationError`, `SERVICE_DISABLED`, …). Anything outside that shape is
 * not something this adapter can interpret, and the field is provider-controlled, so
 * it is reported by shape rather than echoed: a value that fails this test must not
 * reach the log verbatim, whatever it contains.
 */
function reasonLike(value: string): string {
  return /^[A-Za-z][A-Za-z0-9.]{0,60}$/.test(value) ? value : `<non-identifier:${value.length}>`;
}
