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
  if (/SQLITE_CONSTRAINT|constraint failed|no such (?:table|column)|has no column named|D1_TYPE_ERROR/i.test(text)) return false;
  return /Network connection lost|storage caused object to be reset|reset because its code was updated|D1 DB is unavailable|D1_ERROR.*(?:overloaded|reset|timeout)/i.test(text);
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
