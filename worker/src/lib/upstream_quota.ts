/**
 * Upstream quotas Hands has to share between its own callers.
 *
 * Some upstream calls are rationed per scope (Google Play allows
 * tracks.releases.list about 12 times per package per hour). Several Hands paths
 * spend the same allowance and could not see each other, so a background poll
 * could use up what a promotion needed a minute later. Each registered quota
 * has a limit per window, split into tiers by how much a caller is waiting on
 * the answer:
 *
 *   gate         a write is waiting on the read (promote pre-check): up to limit
 *   interactive  a person or agent asked (review-status live, stats first read):
 *                up to limit - reserve.gate
 *   background   nobody is waiting (the hourly poll):
 *                up to limit - reserve.gate - reserve.interactive
 *
 * Usage lives in D1 (upstream_quota_usage, one row per key, scope and window).
 * A take is one atomic statement: it either spends the whole cost within the
 * tier's ceiling or spends nothing. When the upstream itself says the quota is
 * used up, markExhausted blocks every tier until the window resets, because the
 * upstream's count may include calls Hands did not make.
 */

export type QuotaTier = "gate" | "interactive" | "background";
export type QuotaWindow = { kind: "hourly"; resetMinute: number };
export type QuotaDefinition = {
  service: string;
  operation: string;
  limit: number;
  window: QuotaWindow;
  /** What the scope key names, e.g. a Google Play package. */
  scope: "package";
  /** Where the limit comes from. */
  source: string;
  reserve: { gate: number; interactive: number };
};

export const PLAY_RELEASES_LIST = "google_play:tracks.releases.list";

export const UPSTREAM_QUOTAS: Readonly<Record<string, QuotaDefinition>> = {
  [PLAY_RELEASES_LIST]: {
    service: "google_play",
    operation: "tracks.releases.list",
    limit: 12,
    window: { kind: "hourly", resetMinute: 10 },
    scope: "package",
    source: "measured 2026-11-22",
    reserve: { gate: 4, interactive: 4 },
  },
};

export type TakeResult =
  | { ok: true; used: number; limit: number; reset_at: number }
  | { ok: false; used: number; limit: number; reset_at: number; reason: "budget" | "exhausted" };

const HOUR_MS = 60 * 60_000;
const PRUNE_AFTER_MS = 2 * 24 * HOUR_MS;

function definition(key: string): QuotaDefinition {
  const found = UPSTREAM_QUOTAS[key];
  if (!found) throw new Error(`unknown upstream quota: ${key}`);
  return found;
}

/** The window holding `now`: [start, reset_at). Hourly windows start at :resetMinute. */
export function quotaWindow(window: QuotaWindow, now: number): { start: number; reset_at: number } {
  const offset = window.resetMinute * 60_000;
  const start = Math.floor((now - offset) / HOUR_MS) * HOUR_MS + offset;
  return { start, reset_at: start + HOUR_MS };
}

/** The most a caller in `tier` may bring `used` up to. */
export function tierCeiling(def: QuotaDefinition, tier: QuotaTier): number {
  const ceiling = tier === "gate" ? def.limit
    : tier === "interactive" ? def.limit - def.reserve.gate
    : def.limit - def.reserve.gate - def.reserve.interactive;
  return Math.max(0, ceiling);
}

type UsageRow = { used: number; exhausted_until: number | null };

async function usageRow(db: D1Database, key: string, scopeKey: string, windowStart: number): Promise<UsageRow | null> {
  return db.prepare(`SELECT used, exhausted_until FROM upstream_quota_usage
    WHERE quota_key = ?1 AND scope_key = ?2 AND window_start = ?3`)
    .bind(key, scopeKey, windowStart).first<UsageRow>();
}

/**
 * Spend `cost` calls if `tier` still has room and the upstream has not said the
 * quota is used up. A refused take spends nothing.
 */
export async function take(db: D1Database, key: string, scopeKey: string, tier: QuotaTier, cost: number, now: number): Promise<TakeResult> {
  const def = definition(key);
  const { start, reset_at } = quotaWindow(def.window, now);
  const max = tierCeiling(def, tier);
  // One statement: a fresh window inserts only when the cost fits; an existing
  // row updates only when the sum fits and no exhaustion is in force. Either
  // way RETURNING yields a row only when the cost was spent.
  const spent = await db.prepare(`INSERT INTO upstream_quota_usage
      (quota_key, scope_key, window_start, used, exhausted_until, updated_at)
    SELECT ?1, ?2, ?3, ?4, NULL, ?6 WHERE ?4 <= ?5
    ON CONFLICT (quota_key, scope_key, window_start) DO UPDATE SET
      used = upstream_quota_usage.used + excluded.used, updated_at = excluded.updated_at
    WHERE upstream_quota_usage.used + excluded.used <= ?5
      AND (upstream_quota_usage.exhausted_until IS NULL OR upstream_quota_usage.exhausted_until <= ?6)
    RETURNING used`).bind(key, scopeKey, start, cost, max, now).first<{ used: number }>();
  if (spent) return { ok: true, used: Number(spent.used), limit: def.limit, reset_at };
  const row = await usageRow(db, key, scopeKey, start);
  const exhausted = row?.exhausted_until != null && row.exhausted_until > now;
  return { ok: false, used: Number(row?.used ?? 0), limit: def.limit, reset_at, reason: exhausted ? "exhausted" : "budget" };
}

/** Count calls Hands made without gating them (e.g. inside an adapter operation). */
export async function record(db: D1Database, key: string, scopeKey: string, cost: number, now: number): Promise<void> {
  const { start } = quotaWindow(definition(key).window, now);
  await db.prepare(`INSERT INTO upstream_quota_usage
      (quota_key, scope_key, window_start, used, exhausted_until, updated_at)
    VALUES (?1, ?2, ?3, ?4, NULL, ?5)
    ON CONFLICT (quota_key, scope_key, window_start) DO UPDATE SET
      used = upstream_quota_usage.used + excluded.used, updated_at = excluded.updated_at`)
    .bind(key, scopeKey, start, cost, now).run();
}

/** The upstream said the quota is used up: nobody in Hands calls again before the reset. */
export async function markExhausted(db: D1Database, key: string, scopeKey: string, now: number): Promise<number> {
  const { start, reset_at } = quotaWindow(definition(key).window, now);
  await db.prepare(`INSERT INTO upstream_quota_usage
      (quota_key, scope_key, window_start, used, exhausted_until, updated_at)
    VALUES (?1, ?2, ?3, 0, ?4, ?5)
    ON CONFLICT (quota_key, scope_key, window_start) DO UPDATE SET
      exhausted_until = excluded.exhausted_until, updated_at = excluded.updated_at`)
    .bind(key, scopeKey, start, reset_at, now).run();
  return reset_at;
}

export type QuotaStatus = {
  key: string;
  service: string;
  operation: string;
  scope: QuotaDefinition["scope"];
  limit: number;
  used: number;
  remaining: Record<QuotaTier, number>;
  reset_at: number;
  exhausted_until: number | null;
  source: string;
};

/** What every registered quota looks like for one scope right now. */
export async function status(db: D1Database, scopeKey: string, now: number, keys: string[] = Object.keys(UPSTREAM_QUOTAS)): Promise<QuotaStatus[]> {
  const out: QuotaStatus[] = [];
  for (const key of keys) {
    const def = definition(key);
    const { start, reset_at } = quotaWindow(def.window, now);
    const row = await usageRow(db, key, scopeKey, start);
    const used = Number(row?.used ?? 0);
    const exhaustedUntil = row?.exhausted_until != null && row.exhausted_until > now ? Number(row.exhausted_until) : null;
    const left = (tier: QuotaTier) => exhaustedUntil ? 0 : Math.max(0, tierCeiling(def, tier) - used);
    out.push({
      key, service: def.service, operation: def.operation, scope: def.scope, limit: def.limit, used,
      remaining: { gate: left("gate"), interactive: left("interactive"), background: left("background") },
      reset_at, exhausted_until: exhaustedUntil, source: def.source,
    });
  }
  return out;
}

/** Drop windows older than two days; usage is only meaningful within its window. */
export async function pruneQuotaUsage(db: D1Database, now: number): Promise<void> {
  await db.prepare("DELETE FROM upstream_quota_usage WHERE window_start < ?1").bind(now - PRUNE_AFTER_MS).run();
}
