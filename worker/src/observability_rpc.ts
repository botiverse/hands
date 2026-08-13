import { getHandsObservabilityOverview } from "./observability_data";

const OVERVIEW_CACHE_TTL_MS = 60_000;
let cachedOverview: { expiresAt: number; value: Awaited<ReturnType<typeof getHandsObservabilityOverview>> } | undefined;
let pendingOverview: Promise<Awaited<ReturnType<typeof getHandsObservabilityOverview>>> | undefined;

export async function getCachedHandsObservabilityOverview(env: Env) {
  const now = Date.now();
  if (cachedOverview && cachedOverview.expiresAt > now) return cachedOverview.value;
  if (pendingOverview) return pendingOverview;

  pendingOverview = getHandsObservabilityOverview(env).then((value) => {
    cachedOverview = { expiresAt: Date.now() + OVERVIEW_CACHE_TTL_MS, value };
    return value;
  }).finally(() => {
    pendingOverview = undefined;
  });
  return pendingOverview;
}

export function resetHandsObservabilityCacheForTest() {
  cachedOverview = undefined;
  pendingOverview = undefined;
}
