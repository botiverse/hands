export type R2ReadOperation = "head" | "get";

type RetryOptions = {
  delays?: number[];
  sleep?: (ms: number) => Promise<void>;
};

const DEFAULT_DELAYS = [100, 250];

function statusOf(error: unknown): number | null {
  if (!error || typeof error !== "object") return null;
  for (const key of ["status", "statusCode"]) {
    const value = (error as Record<string, unknown>)[key];
    if (typeof value === "number" && Number.isInteger(value)) return value;
  }
  return null;
}

export function isRetryableR2ReadError(error: unknown): boolean {
  const status = statusOf(error);
  if (status !== null) return status >= 500 && status <= 599;
  const message = error instanceof Error ? error.message : String(error);
  return /\((?:10001|5\d{3})\)/.test(message);
}

export async function readR2WithRetry<T>(
  operation: R2ReadOperation,
  read: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const delays = options.delays ?? DEFAULT_DELAYS;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  for (let attempt = 1; ; attempt += 1) {
    try {
      const result = await read();
      if (attempt > 1) {
        console.info("r2_read_retry_succeeded", JSON.stringify({ operation, attempts: attempt }));
      }
      return result;
    } catch (error) {
      if (attempt > delays.length || !isRetryableR2ReadError(error)) throw error;
      await sleep(delays[attempt - 1]!);
    }
  }
}
