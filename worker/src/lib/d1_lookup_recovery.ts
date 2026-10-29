// Only use for idempotent lookup batches: never replay rate counters or
// business writes. The caller must decide how an exhausted outage is exposed.
export function isTransientD1LookupError(error: unknown): boolean {
  const messages: string[] = [];
  let current = error;
  for (let depth = 0; depth < 4 && current instanceof Error; depth++) {
    messages.push(current.message);
    current = current.cause;
  }
  const text = messages.join("\n");
  // Terminal first: a constraint or schema error will never succeed on retry, so it must
  // not be reported as a temporary outage.
  if (/SQLITE_CONSTRAINT|constraint failed|no such (?:table|column)|has no column named|D1_TYPE_ERROR/i.test(text)) return false;
  // Transient. This list is deliberately the same one `isTransientUploadError`
  // (routes/build_asset_uploads.ts) already uses for the upload path, plus the D1-specific
  // wording this module was written for. It previously covered less than that one, so a
  // `database is locked` or `temporarily unavailable` outage on the reporter routes was
  // reported as a 500 instead of a 503 with Retry-After -- telling the caller "we are
  // broken" when the condition is retryable. Keep the two lists aligned: same condition,
  // same answer, whichever route hits it.
  return /Network connection lost|network error|fetch failed|storage caused object to be reset|reset because its code was updated|D1 DB is unavailable|D1_ERROR.*(?:overloaded|reset|timeout)|temporarily unavailable|database is (?:locked|busy)|overloaded|connection reset|timed? ?out/i.test(text);
}
export async function recoverIdempotentD1Lookup<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (!isTransientD1LookupError(error)) throw error;
    await new Promise(resolve => setTimeout(resolve, 50 + Math.floor(Math.random() * 50)));
    return operation(); // Exactly one retry, including when the second attempt fails.
  }
}
