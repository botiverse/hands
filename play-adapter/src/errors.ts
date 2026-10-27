/**
 * Structured, provider-safe detail for a rejection.
 *
 * Every value is a constant this adapter chose: the stage it failed at and a
 * classified cause. Google's own text never travels in here, so it is safe to
 * return to the caller and to persist in a receipt. That matters because the
 * operator log is not reachable by everyone who can read a receipt -- putting the
 * cause here means whoever triggers the next failure can read it themselves,
 * instead of needing someone with observability scope to go and fetch a log line.
 */
export type PlayErrorCause = {
  stage?: string;
  provider_cause?: string;
  /** Where provider_cause came from: Google's structured identifiers, or the message text. */
  cause_source?: "structured" | "message";
  /**
   * Correlation for an unmatched provider message: sha256 + length of Google's
   * text, never the text itself (provider_errors.ts boundary rule).
   */
  message_sha256?: string;
  message_length?: number;
  /** For play_edit_state_unknown: the patterns Hands tried, as its own constant descriptions. */
  tried?: string[];
  /**
   * What the bundle lookup saw, when the failure depends on it.
   *
   * Only integers and versionCode values we derived ourselves -- never Google's
   * text. Present because the skip-upload decision is unverifiable from a receipt
   * otherwise: "we decided Google did not have it" and "Google returned nothing"
   * produce the same user-visible failure, and only this tells them apart.
   */
  bundle_lookup?: {
    /** -1 when the list call failed before returning anything. */
    count: number;
    version_codes: number[];
    wanted: number;
    /** Present only when count is -1: why the list call failed. */
    error?: string;
  };
};

export class PlayAdapterError extends Error {
  constructor(
    public readonly status: 400 | 403 | 409 | 413 | 502 | 503,
    public readonly code: string,
    message: string,
    public readonly cause_detail?: PlayErrorCause,
  ) {
    super(message);
  }
}

export function safeErrorResponse(error: unknown, operationId: string | null): Response {
  const known = error instanceof PlayAdapterError;
  const status = known ? error.status : 502;
  const code = known ? error.code : "play_adapter_error";
  const message = known ? error.message : "Google Play adapter request failed";
  console.error(JSON.stringify({
    event: "google_play_adapter_error",
    operation_id: operationId,
    code,
    status,
  }));
  return Response.json({ error: { code, message } }, { status });
}
