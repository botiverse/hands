/**
 * App Store Connect's request quota, shared by every Hands path that uses one
 * API key (RFC: upstream quota layer, phase 2).
 *
 * Apple allows each API key a number of requests per rolling hour (3,600 by
 * default) and reports it on every response (`X-Rate-Limit: user-hour-lim:N;
 * user-hour-rem:M;`). That count includes calls made outside Hands with the
 * same key, so Hands records what Apple says instead of counting its own
 * calls. A background caller (the scheduled analytics import) holds back when
 * little is left or for a few minutes after a 429, so people and the writes
 * they wait on keep the rest. ascQuotaAllows also answers for interactive
 * callers, which no path consults yet.
 */
import type { AscApiCredentials, AscRateLimit } from "./asc_api";

export const ASC_API_QUOTA = "app_store_connect:api";
/** Apple's documented default; the observed `limit` wins when present. */
export const ASC_DEFAULT_HOURLY_LIMIT = 3600;
/** Below this share of the limit, background callers wait. */
const BACKGROUND_FLOOR = 0.1;
/** After a 429 nobody but a gate caller calls for this long. */
const REFUSED_BACKOFF_MS = 5 * 60_000;
const HOUR_MS = 60 * 60_000;
/** Write at most this often per key unless the quota is getting low. */
const WRITE_EVERY_MS = 30_000;

const lastWrite = new Map<string, number>();

export type AscQuotaObservation = {
  limit: number;
  remaining: number;
  observed_at: number;
  exhausted_until: number | null;
};

export async function recordAscRateLimit(db: D1Database, keyId: string, rl: AscRateLimit, refused: boolean): Promise<void> {
  const now = rl.observed_at;
  const low = rl.limit > 0 && rl.remaining < rl.limit * BACKGROUND_FLOOR;
  if (!refused && !low && now - (lastWrite.get(keyId) ?? 0) < WRITE_EVERY_MS) return;
  lastWrite.set(keyId, now);
  if (refused) {
    await db.prepare(`INSERT INTO upstream_quota_observations
        (quota_key, scope_key, limit_value, remaining, observed_at, exhausted_until)
      VALUES (?1, ?2, ?3, 0, ?4, ?5)
      ON CONFLICT (quota_key, scope_key) DO UPDATE SET
        remaining = 0, observed_at = excluded.observed_at, exhausted_until = excluded.exhausted_until,
        limit_value = CASE WHEN excluded.limit_value > 0 THEN excluded.limit_value ELSE upstream_quota_observations.limit_value END`)
      .bind(ASC_API_QUOTA, keyId, rl.limit || ASC_DEFAULT_HOURLY_LIMIT, now, now + REFUSED_BACKOFF_MS).run();
    return;
  }
  await db.prepare(`INSERT INTO upstream_quota_observations
      (quota_key, scope_key, limit_value, remaining, observed_at, exhausted_until)
    VALUES (?1, ?2, ?3, ?4, ?5, NULL)
    ON CONFLICT (quota_key, scope_key) DO UPDATE SET
      limit_value = excluded.limit_value, remaining = excluded.remaining, observed_at = excluded.observed_at`)
    .bind(ASC_API_QUOTA, keyId, rl.limit, rl.remaining, now).run();
}

export async function ascQuotaObservation(db: D1Database, keyId: string): Promise<AscQuotaObservation | null> {
  const row = await db.prepare(`SELECT limit_value, remaining, observed_at, exhausted_until FROM upstream_quota_observations
    WHERE quota_key = ?1 AND scope_key = ?2`).bind(ASC_API_QUOTA, keyId)
    .first<{ limit_value: number; remaining: number; observed_at: number; exhausted_until: number | null }>();
  return row ? { limit: Number(row.limit_value), remaining: Number(row.remaining), observed_at: Number(row.observed_at),
    exhausted_until: row.exhausted_until == null ? null : Number(row.exhausted_until) } : null;
}

export type AscQuotaTier = "gate" | "interactive" | "background";

/**
 * Whether a caller in `tier` should call App Store Connect with this key now.
 * Gate callers always may. An observation older than an hour says nothing
 * (the rolling hour has passed).
 */
export function ascQuotaAllows(observation: AscQuotaObservation | null, tier: AscQuotaTier, now = Date.now()):
  { ok: true } | { ok: false; reason: "exhausted" | "low"; retry_at: number } {
  if (tier === "gate" || !observation) return { ok: true };
  if (observation.exhausted_until !== null && observation.exhausted_until > now) {
    return { ok: false, reason: "exhausted", retry_at: observation.exhausted_until };
  }
  if (tier === "background" && now - observation.observed_at < HOUR_MS
    && observation.remaining < observation.limit * BACKGROUND_FLOOR) {
    return { ok: false, reason: "low", retry_at: observation.observed_at + HOUR_MS };
  }
  return { ok: true };
}

/** Credentials that report Apple's quota for their key into D1 after every call. */
export function withAscQuota<T extends AscApiCredentials>(db: D1Database, creds: T): T {
  return { ...creds, onRateLimit: (rl, refused) => recordAscRateLimit(db, creds.key_id, rl, refused) };
}

/** For tests. */
export function resetAscQuotaWrites() {
  lastWrite.clear();
}
