/**
 * Which installable asset a public "download" affordance should serve when one
 * build/version carries several of them.
 *
 * Before this existed, share and landing queries ordered by
 * `ba.filetype = 'apk' DESC, ba.created_at ASC`. That single boolean encoded an
 * Android-only preference and then fell back to "oldest created", which is
 * arbitrary for any other product type. On OHOS it picked the AppGallery
 * bundle (`app`, distribution=appgallery) over the sideload bundle (`hap`,
 * distribution=sideload) purely because the `.app` row was inserted 18 seconds
 * earlier — and the download was then named `.hap` while containing `.app`
 * bytes, so `hdc install` failed with "install parse no profile".
 *
 * The rule is now explicit and shared, so a fix in one place cannot miss
 * another query: prefer the artefact a human would side-load, then the store
 * bundle, then anything installable.
 */

/** Columns needed to rank one installable asset. */
export interface InstallableCandidate {
  filetype: string;
  /** `sideload` | `appgallery` | null — from metadata_json.distribution. */
  distribution?: string | null;
  variant?: string | null;
  created_at?: number | null;
}

/**
 * Lower is better. Product-type aware on purpose:
 *  - apk  : Android sideload artefact — the original intent of the old
 *           `filetype = 'apk' DESC` term, kept first so Android behaviour is
 *           unchanged by the OHOS fix.
 *  - hap  : OHOS sideload artefact. Outranks `app` (AppGallery store bundle),
 *           which is not something a share link should hand out.
 *  - ipa  : iOS artefact.
 *  - app  : OHOS AppGallery bundle — usable, but only when no sideload bundle
 *           exists for this release.
 *  - rest : any other installable (never dropped; just last).
 */
export function installableRank(asset: InstallableCandidate): number {
  const filetype = (asset.filetype ?? "").toLowerCase();
  const distribution = (asset.distribution ?? asset.variant ?? "").toLowerCase();

  if (filetype === "apk") return 0;
  if (filetype === "hap") return 1;
  if (filetype === "ipa") return 2;
  if (filetype === "app") return distribution === "sideload" ? 1 : 3;
  // Unknown filetype: prefer a sideload artefact, otherwise last.
  return distribution === "sideload" ? 1 : 4;
}

/**
 * Pick the best candidate, breaking ties by ascending `created_at` (stable and
 * deterministic, matching the previous secondary sort) then by input order.
 * Returns null for an empty list.
 */
export function selectInstallable<T extends InstallableCandidate>(
  candidates: readonly T[],
): T | null {
  let best: T | null = null;
  let bestRank = Number.POSITIVE_INFINITY;
  let bestCreated = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    const rank = installableRank(candidate);
    const created = candidate.created_at ?? Number.POSITIVE_INFINITY;
    if (rank < bestRank || (rank === bestRank && created < bestCreated)) {
      best = candidate;
      bestRank = rank;
      bestCreated = created;
    }
  }
  return best;
}

/**
 * SQL expression mirroring `installableRank`, for the queries that must select
 * the asset in the database rather than in JS. Keep the two in sync — the unit
 * tests assert they agree on the same fixtures.
 *
 * Expects the build_assets alias to be `ba` and `ba.metadata_json` to be
 * available.
 */
export const INSTALLABLE_RANK_SQL = `CASE
  WHEN lower(ba.filetype) = 'apk' THEN 0
  WHEN lower(ba.filetype) = 'hap' THEN 1
  WHEN lower(ba.filetype) = 'ipa' THEN 2
  WHEN lower(ba.filetype) = 'app' THEN
    CASE WHEN lower(coalesce(json_extract(ba.metadata_json, '$.distribution'), ba.variant, '')) = 'sideload'
      THEN 1 ELSE 3 END
  WHEN lower(coalesce(json_extract(ba.metadata_json, '$.distribution'), ba.variant, '')) = 'sideload'
    THEN 1
  ELSE 4
END`;

/**
 * ORDER BY terms implementing the ranking, plus the stable tie-breaks.
 * `ba.created_at IS NULL` sorts before the value so NULLs behave like the
 * JS helper (treated as +infinity → last within the same rank).
 */
export const INSTALLABLE_ORDER_BY = `${INSTALLABLE_RANK_SQL} ASC, ba.created_at IS NULL ASC, ba.created_at ASC`;
