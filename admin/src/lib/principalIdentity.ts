/**
 * Principal identity display for the admin console.
 *
 * Two accounts can share BOTH `display_name` and `username` while belonging to
 * different Raft servers (e.g. `DiRenJie` on `slock-android` and `DiRenJie` on
 * `raft`). The API already returns `server_slug` for every principal, so the
 * console can tell them apart — it just wasn't showing it.
 *
 * Product rule: show the server only when the rendered list actually has a
 * collision. Adding a server to every row is noise; adding it per-row tends to
 * drift into one-row-labelled/one-row-not in paginated or virtualised lists.
 *
 * THEREFORE: collision detection is computed over the whole visible collection
 * ONCE, before rendering, and every surface shares this helper. Never decide
 * "does this row need a badge?" from a single row — a row cannot see its peers.
 */

/** Minimal shape this module needs from any principal-bearing record. */
export interface PrincipalLike {
  display_name?: string | null | undefined;
  username?: string | null | undefined;
  provider_subject?: string | null | undefined;
  server_slug?: string | null | undefined;
  server_id?: string | null | undefined;
}

/** A principal row with a stable account identity, for collision counting. */
export interface PrincipalRow extends PrincipalLike {
  id?: string | null | undefined;
  account_id?: string | null | undefined;
}

/**
 * The stable, human-meaningful identity of a principal within one server.
 * Mirrors what the tables already render: display name, falling back to the
 * username, then to a truncated provider subject for principals with neither.
 */
export function principalLabel(p: PrincipalLike): string {
  const display = (p.display_name ?? "").trim();
  if (display) return display;
  const username = (p.username ?? "").trim();
  if (username) return username;
  const subject = (p.provider_subject ?? "").trim();
  return subject ? `${subject.slice(0, 16)}…` : "";
}

/** The server a principal belongs to, for display purposes. */
export function principalServer(p: PrincipalLike): string | null {
  const slug = (p.server_slug ?? "").trim();
  if (slug) return slug;
  const id = (p.server_id ?? "").trim();
  return id ? id : null;
}

/**
 * Compute which labels collide within one visible collection.
 *
 * Returns the set of labels that appear on more than one DISTINCT principal.
 * "Distinct" is by account identity (`id`/`account_id`) when present: the same
 * account appearing twice (e.g. a duplicate row) is not a collision and must
 * not trigger badges on both rows.
 *
 * Call this once per rendered collection and pass the result down. It must not
 * be called per row, and it must be given the full collection — not a page.
 */
export function collidingPrincipalLabels(
  items: ReadonlyArray<PrincipalRow>,
): ReadonlySet<string> {
  const owners = new Map<string, Set<string>>();
  items.forEach((item, index) => {
    const label = principalLabel(item);
    if (!label) return;
    // Fall back to the row index so identical-looking rows that carry no id are
    // still counted as separate principals rather than silently merged.
    const identity = item.account_id ?? item.id ?? `#${index}`;
    const seen = owners.get(label);
    if (seen) seen.add(identity);
    else owners.set(label, new Set([identity]));
  });
  return new Set(
    [...owners.entries()]
      .filter(([, identities]) => identities.size > 1)
      .map(([label]) => label),
  );
}

/**
 * Whether this principal needs a server badge, given the collision set.
 *
 * A single-row convenience ONLY for callers that already hold the set. Passing
 * a set computed from a single row defeats the purpose; compute it from the
 * full collection first.
 */
export function needsServerBadge(
  p: PrincipalRow,
  colliding: ReadonlySet<string>,
): boolean {
  const label = principalLabel(p);
  return label !== "" && colliding.has(label);
}
