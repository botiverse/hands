const DEFAULT_LOOKUP_BUDGET_MS = 3500;
const DEADLINE_ERROR = "D1 lookup deadline exceeded";
const TERMINAL_D1_ERROR = /SQLITE_CONSTRAINT|constraint failed|no such (?:table|column)|has no column named|D1_TYPE_ERROR|D1_COLUMN_NOTFOUND/i;
const TRANSIENT_D1_ERROR = /D1 lookup deadline exceeded|network connection lost|network error|fetch failed|storage caused object to be reset|reset because its code was updated|D1 DB is unavailable|D1_ERROR.*(?:overloaded|reset|timeout|internal error)|temporarily unavailable|database is (?:locked|busy)|\bSQLITE_(?:BUSY|LOCKED)\b|overloaded|connection reset|timed? ?out/i;

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
  // Constraint, schema, and type failures win even if a wrapper also contains
  // network-like text. Generic transport wording is only meaningful at a D1
  // call site; reporterErrorHandler checks the request stage before using it.
  if (TERMINAL_D1_ERROR.test(text)) return false;
  return TRANSIENT_D1_ERROR.test(text);
}

async function withinBudget<T>(operation: () => Promise<T>, remainingMs: number): Promise<T> {
  if (remainingMs <= 0) throw new Error(DEADLINE_ERROR);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(DEADLINE_ERROR)), remainingMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function recoverIdempotentD1Lookup<T>(
  operation: () => Promise<T>,
  options: { budgetMs?: number; deadline?: number } = {},
): Promise<T> {
  const deadline = options.deadline ?? Date.now() + (options.budgetMs ?? DEFAULT_LOOKUP_BUDGET_MS);
  const remaining = () => Math.max(0, deadline - Date.now());
  try {
    return await withinBudget(operation, remaining());
  } catch (error) {
    if (!isTransientD1LookupError(error)) throw error;
    await new Promise(resolve => setTimeout(resolve, 50 + Math.floor(Math.random() * 50)));
    // Exactly one retry within the same total response budget. A deadline only
    // bounds the response; the underlying read is not cancellable, so this
    // helper must never be used for ambiguous business writes.
    return withinBudget(operation, remaining());
  }
}
