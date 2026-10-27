import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";
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
  if (path.endsWith(":validate")) return "validate_edit";
  if (path.endsWith("/details")) return "get_details";
  if (path.endsWith("/listings")) return "list_listings";
  if (path.includes("/listings/")) return method === "PUT" ? "update_listing" : method === "DELETE" ? "delete_listing" : "get_listing";
  if (path.endsWith("/bundles")) return "upload_bundle";
  if (path.includes("/deobfuscationFiles/proguard")) return "upload_mapping";
  if (path.includes("/deobfuscationFiles/")) return "upload_symbols";
  if (path.endsWith("/releases") && path.includes("/tracks/")) return "list_release_states";
  if (path.endsWith("/tracks")) return "list_tracks";
  if (path.includes("/tracks/")) return method === "PUT" ? "update_track" : "get_track";
  if (method === "DELETE") return "delete_edit";
  return "play_request";
}

/**
 * Google's documented `errors[].reason` / `details[].reason` identifiers in a
 * rejection body, allowlisted (REASONS) and joined; "unspecified" when none.
 * Identifiers only -- never Google's prose.
 */
export function playRejectionReason(body: unknown): string {
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
  return [...reasons].sort().join(",") || "unspecified";
}

export function playRejection(status: number, body: unknown, stage: string): PlayAdapterError {
  const error = body && typeof body === "object" ? (body as Record<string, unknown>).error : null;
  const reason = playRejectionReason(body);
  console.warn("hands_play_rejection", JSON.stringify({ stage, status, reason, provider: providerDiagnostic(body) }));
  // `reason` is only a documented identifier, and a validation rejection reports
  // `badRequest` for causes as different as a duplicate completed release and a
  // reused version code. The classified cause travels with the error so the caller
  // -- and the receipt it writes -- carries it too, without needing log access.
  const envelopeMessage = error && typeof error === "object" ? (error as Record<string, unknown>).message : null;
  // Structured identifiers first (stable across wording and locale), message text second.
  const structured = classifyStructuredIdentifiers(body);
  const providerCause = structured
    ?? (typeof envelopeMessage === "string" ? classifyProviderMessage(envelopeMessage) : undefined);
  return new PlayAdapterError(
    [400, 401, 403, 404].includes(status) ? 403 : 502,
    "play_api_rejected",
    `Google Play API request failed with ${status} (stage=${stage}; reason=${reason})`,
    {
      stage,
      ...(providerCause ? { provider_cause: providerCause, cause_source: structured ? "structured" as const : "message" as const } : {}),
      ...(typeof envelopeMessage === "string"
        ? { message_sha256: bytesToHex(sha256(new TextEncoder().encode(envelopeMessage))), message_length: envelopeMessage.length }
        : {}),
    },
  );
}

/**
 * Edit-state causes recognised from Google's structured identifiers:
 * `error.status`, `errors[].reason` and `details[].reason` (google.rpc.ErrorInfo).
 * Google does not document a specific identifier for "changes in review" or
 * "changes not sent for review" in androidpublisher, so these match any
 * identifier naming the condition; each value is shape-checked as an identifier
 * first, so no provider prose is ever matched here.
 */
// Same order as the text layer: NOT_SENT_FOR_REVIEW before IN_REVIEW per identifier;
// when both states are named, EDIT_IN_REVIEW wins (classified by the remedy that works).
const STRUCTURED_CAUSES: Array<[RegExp, string]> = [
  [/NOT_?SENT_?FOR_?REVIEW/i, "CHANGES_NOT_SENT_FOR_REVIEW"],
  [/(?:^|_)IN_?REVIEW(?:$|_)|InReview/, "EDIT_IN_REVIEW"],
];

function classifyStructuredIdentifiers(body: unknown): string | undefined {
  const error = body && typeof body === "object" ? (body as Record<string, unknown>).error : null;
  if (!error || typeof error !== "object") return undefined;
  const e = error as Record<string, unknown>;
  const identifiers: string[] = [];
  if (typeof e.status === "string") identifiers.push(e.status);
  for (const items of [e.errors, e.details]) {
    if (!Array.isArray(items)) continue;
    for (const item of items.slice(0, 16)) {
      const value = item && typeof item === "object" ? (item as Record<string, unknown>).reason : null;
      if (typeof value === "string") identifiers.push(value);
    }
  }
  const found = new Set<string>();
  for (const id of identifiers.filter((value) => /^[A-Za-z][A-Za-z0-9._]{0,60}$/.test(value))) {
    for (const [pattern, cause] of STRUCTURED_CAUSES) {
      if (pattern.test(id)) { found.add(cause); break; }
    }
  }
  // Both states named: classify by the remedy that works (wait), as the text layer does.
  if (found.has("EDIT_IN_REVIEW")) return "EDIT_IN_REVIEW";
  if (found.has("CHANGES_NOT_SENT_FOR_REVIEW")) return "CHANGES_NOT_SENT_FOR_REVIEW";
  return undefined;
}

/**
 * The edit-state patterns Hands tries, as constant descriptions derived from the
 * patterns themselves (so they cannot drift). Returned in play_edit_state_unknown
 * so a new Google wording can be added without guessing what was checked.
 */
export function editStatePatternsTried(): string[] {
  const relevant = (cause: string) => cause === "EDIT_IN_REVIEW" || cause === "CHANGES_NOT_SENT_FOR_REVIEW";
  // In match order. Prefix = layer: structured identifiers (error.status,
  // errors[].reason, details[].reason) first, then the message text.
  return [
    ...STRUCTURED_CAUSES.filter(([, cause]) => relevant(cause))
      .map(([pattern, cause]) => `structured:/${pattern.source}/${pattern.flags} -> ${cause}`),
    ...PROVIDER_CAUSES.filter(([, cause]) => relevant(cause))
      .map(([pattern, cause]) => `text:/${pattern.source}/${pattern.flags} -> ${cause}`),
  ];
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
const NOT_SENT_TEXT = /changesNotSentForReview|not ?sent for review|unreviewed/i;
const IN_REVIEW_TEXT = /in review|under review|review.*in progress|ERROR_IF_IN_REVIEW/i;

const PROVIDER_CAUSES: Array<[RegExp, string]> = [
  [/multiple.*completed|more than one completed|only one (?:completed|release)/i, "MULTIPLE_COMPLETED"],
  [/draft/i, "DRAFT_APP_RESTRICTION"],
  [/already been (?:used|uploaded)|duplicate/i, "DUPLICATE_VERSION"],
  [/version ?code/i, "VERSION_CODE_CONFLICT"],
  [/not ?found|does not exist|unknown (?:track|package)/i, "NOT_FOUND"],
  // A commit rejected because the app carries unrelated unpublished changes (or a
  // previously rejected submission). Google names this in the message; the remedy is
  // a different commit flag, so it must not read as a generic validation failure.
  // Two edit-state causes with opposite remedies: CHANGES_NOT_SENT_FOR_REVIEW (the
  // app's changes must be sent for review manually -> commit with
  // changesNotSentForReview) and EDIT_IN_REVIEW (another change is in review ->
  // wait; commitEdit sends ERROR_IF_IN_REVIEW). NOT_SENT is checked FIRST, in this
  // text layer and in STRUCTURED_CAUSES alike: its wording is the more specific
  // ("not sent for review"), while the in-review patterns are broad enough to also
  // hit a not-sent message that mentions a review. A message matching BOTH is
  // decided before this list, by remedy (EDIT_IN_REVIEW): see classifyProviderMessage.
  // Tests pin both directions and the overlap.
  [NOT_SENT_TEXT, "CHANGES_NOT_SENT_FOR_REVIEW"],
  [IN_REVIEW_TEXT, "EDIT_IN_REVIEW"],
  // A track whose testers or countries are not configured yet, or a track that does
  // not exist in the console. Both are console-side setup, not a Hands defect.
  // Deliberately does NOT cover "track does not exist": NOT_FOUND above matches
  // "does not exist"/"unknown track" first, so an arm for it here would never run
  // while reading as if it did. A missing track lands in NOT_FOUND, which is just
  // as actionable.
  [/testers|countries|no testers|not configured|invalid track/i, "TRACK_NOT_CONFIGURED"],
  // Release shape rejected before it was ever sent: missing notes, or a status and
  // userFraction combination Play does not allow (e.g. completed with a fraction).
  [/releaseNotes|userFraction|invalid release|status .* not allowed/i, "RELEASE_VALIDATION"],
];

function classifyProviderMessage(message: string): string {
  // A message that says both ("Changes not sent for review because another edit is
  // in review.") is classified by the remedy that works: sending for review by hand
  // would fail while another change is in review, so the actionable answer is to wait.
  if (NOT_SENT_TEXT.test(message) && IN_REVIEW_TEXT.test(message)) return "EDIT_IN_REVIEW";
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
