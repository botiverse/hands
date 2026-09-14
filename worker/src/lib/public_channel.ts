/**
 * Public channel aliases (inbound only) — single resolution point.
 *
 * The Raft installer and Computer runtime call the stable channel `latest`;
 * Hands stores it as `main`. Everything downstream — DB lookup, receipts, and
 * the `channel` field in response bodies — uses the canonical slug, so clients
 * that validate the echoed channel name (the Computer updater does) see exactly
 * what they see today when they ask for `main`.
 *
 * Two rules, both load-bearing:
 *
 * 1. Aliases never invent channels. An alias whose canonical channel does not
 *    exist still answers `channel_not_found`.
 * 2. A real channel always wins over an alias of the same name. Channel slugs
 *    are not validated at creation, so an app owner can create a genuine
 *    `latest` channel; that channel must never be shadowed by the alias.
 *
 * `canonicalPublicChannel` is the pure, DB-free mapping used where no app
 * context is available. `resolvePublicChannelSlug` adds rule 2 by consulting
 * the app's real channels first. Both keep unknown names unchanged.
 *
 * Raft task #proj-hands #204 (alias) and #206 (shadowing + consistency).
 */

/** Alias name -> canonical channel slug. */
export const PUBLIC_CHANNEL_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  latest: "main",
});

/**
 * Pure inbound alias mapping. Does NOT consult the database, so it cannot
 * honor rule 2; prefer `resolvePublicChannelSlug` whenever an app id is known.
 */
export function canonicalPublicChannel(requested: string): string {
  return PUBLIC_CHANNEL_ALIASES[requested] ?? requested;
}

/**
 * Resolve a requested public channel slug for an app.
 *
 * A real channel with the requested slug wins; only when it does not exist
 * does the request fall back to the alias target. Unknown names are returned
 * unchanged so the caller's existing not-found path is preserved.
 *
 * Callers that already looked the channel up by slug can pass that result as
 * `requestedExists` to avoid a duplicate query.
 */
export async function resolvePublicChannelSlug(
  db: D1Database,
  appId: string,
  requested: string,
  requestedExists?: boolean,
): Promise<string> {
  const alias = PUBLIC_CHANNEL_ALIASES[requested];
  if (!alias) return requested;

  const exists =
    requestedExists ?? (await publicChannelExists(db, appId, requested));
  // A genuine channel named `latest` must not be shadowed by the alias.
  if (exists) return requested;
  return alias;
}

/** Whether an app has a real channel with this exact slug. */
export async function publicChannelExists(
  db: D1Database,
  appId: string,
  slug: string,
): Promise<boolean> {
  const row = await db
    .prepare("SELECT id FROM channels WHERE app_id = ?1 AND slug = ?2 LIMIT 1")
    .bind(appId, slug)
    .first<{ id: string }>();
  return row !== null;
}
