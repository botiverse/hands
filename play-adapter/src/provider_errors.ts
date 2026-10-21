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
  // `reason` is only a documented identifier, and a validation rejection reports
  // `badRequest` for causes as different as a duplicate completed release and a
  // reused version code. The classified cause travels with the error so the caller
  // -- and the receipt it writes -- carries it too, without needing log access.
  const envelopeMessage = error && typeof error === "object" ? (error as Record<string, unknown>).message : null;
  const providerCause = typeof envelopeMessage === "string" ? classifyProviderMessage(envelopeMessage) : undefined;
  return new PlayAdapterError(
    [400, 401, 403, 404].includes(status) ? 403 : 502,
    "play_api_rejected",
    `Google Play API request failed with ${status} (stage=${stage}; reason=${reason})`,
    { stage, ...(providerCause ? { provider_cause: providerCause } : {}) },
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
    // `status` is a Google enum string (INVALID_ARGUMENT, PERMISSION_DENIED, ...).
    if (typeof value === "number") out[key] = value;
    else if (typeof value === "string") out[key] = key === "status" ? reasonLike(value) : clip(value);
  }
  // Arbitrary provider prose: never echoed. A credential can be reflected into it,
  // yet for a validation rejection the reason is only `badRequest` and the actual
  // cause lives right here. So the text is matched against known causes and only the
  // category name is logged -- no provider text, no credential, still one-shot
  // diagnosable.
  if (typeof e.message === "string") {
    out.message_length = e.message.length;
    out.message_cause = classifyProviderMessage(e.message);
  }
  for (const key of ["errors", "details"]) {
    const items = e[key];
    if (!Array.isArray(items)) continue;
    const picked = items.slice(0, 8).map((item) => {
      const entry: Record<string, unknown> = {};
      if (item && typeof item === "object") {
        for (const [k, v] of Object.entries(item as Record<string, unknown>)) {
          // An ALLOWLIST, not a denylist. Naming the fields to redact (message,
          // metadata) only covered the shapes seen so far: location, detail,
          // extendedHelp, description and anything Google adds later would have
          // carried a reflected secret straight into the log. Only fields whose
          // value is an identifier by construction are echoed, and each is still
          // shape-checked.
          if (typeof v === "string") {
            if (k === "message") {
              entry.message_length = v.length;
              entry.message_cause = classifyProviderMessage(v);
            } else if (itemKeyIsIdentifier(k, v)) {
              entry[k] = reasonLike(v);
            } else {
              entry[`${k}_length`] = v.length;
            }
            continue;
          }
          if (typeof v === "number" || typeof v === "boolean") entry[k] = v;
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
 * Fields whose value is an identifier by construction, so echoing it is safe:
 * Google's declared error-info keys plus the `@type` discriminator. Everything
 * else a provider sends is prose, a URL or metadata and is reported by length.
 */
function itemKeyIsIdentifier(key: string, value: string): boolean {
  if (key === "reason" || key === "domain" || key === "type") return true;
  if (key === "location" || key === "locationType") return true;
  return key.startsWith("at") && /^[A-Za-z]+$/.test(key) && value.length < 80;
}

/**
 * Map a provider message onto a known cause, without ever emitting its text.
 *
 * Every pattern here answers a question an operator would otherwise have to guess
 * at, and each is narrow enough that a credential cannot accidentally match and be
 * echoed: only the constant category string reaches the log. `OTHER` is the honest
 * answer when nothing matches -- it says "we still do not know", it does not dress
 * the message up as understood.
 */
// Order matters: the first match wins, so the more specific causes precede the
// broader ones. "Version code X has already been used" must read as DUPLICATE_VERSION
// rather than VERSION_CODE_CONFLICT, because the two have different remedies.
const PROVIDER_CAUSES: Array<[RegExp, string]> = [
  [/multiple.*completed|more than one completed|only one (?:completed|release)/i, "MULTIPLE_COMPLETED"],
  [/draft/i, "DRAFT_APP_RESTRICTION"],
  [/already been (?:used|uploaded)|duplicate/i, "DUPLICATE_VERSION"],
  [/version ?code/i, "VERSION_CODE_CONFLICT"],
  [/not ?found|does not exist|unknown (?:track|package)/i, "NOT_FOUND"],
];

function classifyProviderMessage(message: string): string {
  for (const [pattern, cause] of PROVIDER_CAUSES) {
    if (pattern.test(message)) return cause;
  }
  return "OTHER";
}

/**
 * Google's reason identifiers are a bounded vocabulary (`badRequest`,
 * `releaseValidationError`, `SERVICE_DISABLED`, …). Anything outside that shape is
 * not something this adapter can interpret, and the field is provider-controlled, so
 * it is reported by shape rather than echoed: a value that fails this test must not
 * reach the log verbatim, whatever it contains.
 */
function reasonLike(value: string): string {
  // Google uses both camelCase (`badRequest`) and UPPER_SNAKE (`SERVICE_DISABLED`,
  // `PERMISSION_DENIED`), so underscores must be accepted: without them the very
  // reasons the whitelist recognises would be logged as unrecognisable.
  return /^[A-Za-z][A-Za-z0-9._]{0,60}$/.test(value) ? value : `<non-identifier:${value.length}>`;
}
