/** Whitelisted Play diagnostics for webhook and Raft notification consumers.
 * Provider prose, metadata and unknown identifiers must not cross this boundary. */
const CAUSES: Readonly<Record<string, string>> = {
  EDIT_IN_REVIEW: "Google Play has changes in review. Wait for review to finish before submitting again.",
  CHANGES_NOT_SENT_FOR_REVIEW: "Google Play reports changes that have not been sent for review. Check the publishing overview.",
  APP_REVIEW_NOT_MANAGED: "Google Play rejected the review submission setting. Check the publishing settings.",
  DUPLICATE_VERSION: "Google Play reported a version that was already used or uploaded. Check the version code.",
  VERSION_CODE_CONFLICT: "Google Play reported an issue related to the version code. Check the details before changing it.",
  MULTIPLE_COMPLETED: "Google Play rejected the release configuration because multiple releases were completed.",
  DRAFT_APP_RESTRICTION: "Google Play reported a restriction related to the app's draft state.",
  TRACK_NOT_CONFIGURED: "Google Play reported a track configuration issue. Check its testers and countries.",
  RELEASE_VALIDATION: "Google Play rejected the release configuration. Check its details in Play Console.",
  NOT_FOUND: "Google Play could not find a requested resource. Check the package and track in Play Console.",
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** Only constants produced by our adapter classifier are exposed to webhooks. */
export function playFailureNotificationFields(details: unknown): Record<string, string> {
  const cause = record(record(details).cause);
  const code = cause.provider_cause;
  if (typeof code !== "string" || !Object.hasOwn(CAUSES, code)) return {};
  const fields: Record<string, string> = { play_failure_cause: code };
  if (cause.cause_source === "structured" || cause.cause_source === "message") {
    fields.play_failure_cause_source = cause.cause_source;
  }
  // This specific Google identifier is documented and useful to operators.
  // Do not forward arbitrary identifiers, metadata or provider text.
  const identifiers = record(cause.provider_identifiers);
  if (code === "EDIT_IN_REVIEW" && cause.cause_source === "structured" && Array.isArray(identifiers.details)
      && identifiers.details.some((entry) => record(entry).reason === "CHANGES_ALREADY_IN_REVIEW")) {
    fields.play_failure_reason = "CHANGES_ALREADY_IN_REVIEW";
  }
  return fields;
}

/** Validate again at presentation, because a signed webhook can contain old
 * or malformed data. Message-derived classifications are explicitly tentative. */
export function playFailureNotificationLines(payload: Record<string, unknown>): string[] {
  const cause = payload.play_failure_cause;
  if (typeof cause !== "string" || !Object.hasOwn(CAUSES, cause)) return [];
  const structured = payload.play_failure_cause_source === "structured";
  const label = structured ? "Reason" : payload.play_failure_cause_source === "message"
    ? "Possible reason (inferred)" : "Possible reason (source unconfirmed)";
  const lines = [`${label}: ${CAUSES[cause]}`];
  if (structured && cause === "EDIT_IN_REVIEW" && payload.play_failure_reason === "CHANGES_ALREADY_IN_REVIEW") {
    lines.push("Play reason code: CHANGES_ALREADY_IN_REVIEW");
  }
  return lines;
}
