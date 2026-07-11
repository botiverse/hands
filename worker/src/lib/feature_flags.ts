/**
 * Server-side feature gate ("feature flags").
 *
 * A reusable, fail-safe-OFF gate: the flag is OFF unless a matching row says
 * otherwise. Evaluated per request so a flag can target a single device before
 * an app-wide rollout. The first consumer is delta-update *offers*
 * (routes/public_v2.ts findDeltaPatch). See docs/feature-gate-design.md.
 *
 * Kept dependency-free and pure (evaluateFlag) so it is trivially unit-testable.
 */

/**
 * The subset of a feature_flags row needed to evaluate a gate. The JSON array
 * columns are the raw stored strings; they are parsed defensively at eval time.
 */
export interface FeatureFlagRow {
  default_enabled: number;
  rollout_percent: number;
  allow_device_ids: string;
  deny_device_ids: string;
  allow_cohorts: string;
  platforms: string;
}

export interface FeatureContext {
  appId: string;
  deviceId?: string | null;
  cohort?: string | null;
  platform?: string | null;
}

/**
 * Stable 32-bit FNV-1a hash. Mirrors rolloutBucket() in routes/public_v2.ts so
 * a device keeps the same bucket for a given flag while the rollout climbs.
 * Kept local so this module stays pure and dependency-free.
 */
function fnv1a32(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Parse a JSON array-of-strings column defensively; any error → []. */
function parseStringArray(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === "string");
  } catch {
    return [];
  }
}

/**
 * Evaluate a loaded flag row against a context. Pure & synchronous. First match
 * wins:
 *  1. device in deny list        → false
 *  2. device in allow list       → true
 *  3. cohort in allow_cohorts    → true
 *  4. platforms set & no match   → false
 *  5. rollout_percent > 0 (needs a device id; stable per-device bucket) → maybe
 *  6. else default_enabled === 1
 */
export function evaluateFlag(
  row: FeatureFlagRow,
  key: string,
  ctx: FeatureContext,
): boolean {
  const deviceId = ctx.deviceId ?? null;

  // 1. explicit deny by device.
  if (deviceId && parseStringArray(row.deny_device_ids).includes(deviceId)) {
    return false;
  }
  // 2. explicit allow by device.
  if (deviceId && parseStringArray(row.allow_device_ids).includes(deviceId)) {
    return true;
  }
  // 3. allow by cohort.
  if (ctx.cohort && parseStringArray(row.allow_cohorts).includes(ctx.cohort)) {
    return true;
  }
  // 4. platform restriction: when platforms is non-empty, a client whose
  //    platform is unknown or not listed is gated out.
  const platforms = parseStringArray(row.platforms);
  if (platforms.length > 0 && (!ctx.platform || !platforms.includes(ctx.platform))) {
    return false;
  }
  // 5. percentage rollout — only applies when we have a device id to bucket on.
  const rollout = row.rollout_percent;
  if (rollout > 0 && deviceId) {
    if (rollout >= 100) return true;
    if (fnv1a32(`${key}:${deviceId}`) % 100 < rollout) return true;
  }
  // 6. default.
  return row.default_enabled === 1;
}

const LOAD_FLAG_SQL = `SELECT default_enabled, rollout_percent, allow_device_ids,
       deny_device_ids, allow_cohorts, platforms
  FROM feature_flags WHERE key = ?1 AND app_id IS ?2`;

/**
 * Load the flag row for (app_id, key), falling back to the global row
 * (app_id IS NULL, key). Returns null when neither exists.
 */
async function loadFlag(
  db: D1Database,
  key: string,
  appId: string,
): Promise<FeatureFlagRow | null> {
  const perApp = await db
    .prepare(LOAD_FLAG_SQL)
    .bind(key, appId)
    .first<FeatureFlagRow>();
  if (perApp) return perApp;
  return db.prepare(LOAD_FLAG_SQL).bind(key, null).first<FeatureFlagRow>();
}

/**
 * True when `key` is enabled for the given context. Missing row or any parse
 * error → false (fail-safe OFF).
 */
export async function isFeatureEnabled(
  db: D1Database,
  key: string,
  ctx: FeatureContext,
): Promise<boolean> {
  const row = await loadFlag(db, key, ctx.appId);
  if (!row) return false; // fail-safe OFF.
  return evaluateFlag(row, key, ctx);
}
