/**
 * Desktop installers were originally seeded as `electron-installer`, which stopped
 * describing them once a non-Electron desktop target (a jpackage .dmg) existed.
 * `desktop-installer` is the name new apps use; the old one keeps resolving because
 * every release that already exists carries it, and a client in the field still asks
 * for it. Both are the same product, so anything comparing product_type directly must
 * go through equivalentsOf() rather than string equality.
 */
export const DESKTOP_INSTALLER = "desktop-installer";
export const LEGACY_ELECTRON_INSTALLER = "electron-installer";

/** Every product_type string that denotes the same product as `name`. */
export function equivalentsOf(name: string | null | undefined): string[] {
  if (!name) return [];
  if (name === DESKTOP_INSTALLER || name === LEGACY_ELECTRON_INSTALLER) {
    return [DESKTOP_INSTALLER, LEGACY_ELECTRON_INSTALLER];
  }
  return [name];
}

export type ActiveReleaseCandidate = {
  id: string;
  build_id: string;
  created_at: number;
  activated_at: number;
  product_type: string;
  rollout_cohort_count: number | null;
  changelog: string | null;
};

/** One canonical active/non-QA candidate query for every public download surface. */
export async function loadActiveReleaseCandidates(
  db: D1Database,
  args: {
    appId: string; channelId: string; productType?: string | null | undefined;
    /** Restrict to already-available, fully public releases at this time. */
    fullPublicAt?: number | undefined;
    /** Use when only the newest eligible release can be consumed. */
    mostRecentOnly?: boolean | undefined;
  },
): Promise<ActiveReleaseCandidate[]> {
  const withProduct = Boolean(args.productType);
  // Match every equivalent name at once: a channel may hold releases seeded before the
  // rename and after it, and the resolver must see both or it will report "no active
  // release" for a product that plainly has one.
  const productNames = equivalentsOf(args.productType);
  const bindValues: Array<string | number> = [args.appId, args.channelId, ...productNames];
  const fullPublic = args.fullPublicAt !== undefined;
  if (args.fullPublicAt !== undefined) bindValues.push(args.fullPublicAt);
  const publicTimeParam = `?${bindValues.length}`;
  const statement = db.prepare(
    `SELECT r.id, r.build_id, r.created_at,
            COALESCE(r.activated_at, r.created_at) AS activated_at,
            r.product_type, r.rollout_cohort_count, r.changelog
     FROM releases r
     JOIN builds b ON b.id = r.build_id
     WHERE r.app_id = ?1 AND r.channel_id = ?2
       ${withProduct ? `AND r.product_type IN (${productNames.map((_, i) => `?${i + 3}`).join(",")})` : ""}
       AND r.status = 'active'
       AND b.product_type != 'ios-simulator-qa' AND b.release_type != 'qa'
       ${fullPublic ? `AND b.status = 'succeeded' AND r.hidden = 0
         AND (r.rollout_cohort_count IS NULL OR r.rollout_cohort_count >= 100)
         AND (r.availability_at IS NULL OR r.availability_at <= ${publicTimeParam})
         AND EXISTS (SELECT 1 FROM release_scopes s
                     WHERE s.release_id = r.id AND s.scope_type = 'full' AND s.scope_value = 'all')` : ""}
     -- Total order, deliberately: without the id tie-break two releases activated in the same
     -- millisecond come back in planner order, so callers would see a different "current
     -- release" run to run. This is the resolver behind the installer path.
     ORDER BY COALESCE(r.activated_at, r.created_at) DESC, r.id ASC
     ${args.mostRecentOnly ? "LIMIT 1" : ""}`,
  );
  const result = await statement.bind(...bindValues).all<ActiveReleaseCandidate>();
  return result.results;
}

export function selectBestAsset<T extends {
  platform: string;
  arch: string | null;
  filetype: string;
}>(
  assets: T[],
  requested: { platform: string | null; arch: string | null; filetype: string },
): T | null {
  const filetypeMatches = assets.filter((asset) => asset.filetype === requested.filetype);
  if (filetypeMatches.length === 0) return null;
  const parsed = splitPlatformArch(requested.platform);
  const platform = parsed.platform;
  const arch = requested.arch ?? parsed.arch;
  const platformMatches = platform
    ? filetypeMatches.filter((asset) => asset.platform === platform)
    : filetypeMatches;
  const candidates = platformMatches.length > 0 ? platformMatches : filetypeMatches;
  if (arch) {
    const archMatch = candidates.find((asset) => asset.arch === arch);
    if (archMatch) return archMatch;
  }
  return candidates.find((asset) => asset.arch === null) ?? candidates[0] ?? null;
}

function splitPlatformArch(value: string | null): { platform: string | null; arch: string | null } {
  if (!value) return { platform: null, arch: null };
  const knownPlatforms = ["android", "darwin", "win32", "linux", "ios", "ohos"];
  for (const platform of knownPlatforms) {
    if (value === platform) return { platform, arch: null };
    const prefix = `${platform}-`;
    if (value.startsWith(prefix)) {
      return { platform, arch: value.slice(prefix.length) || null };
    }
  }
  return { platform: value, arch: null };
}

export function fnv1a32(input: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index++) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function rolloutBucket(releaseId: string, key: string): number {
  return fnv1a32(`${releaseId}:${key}`) % 100;
}

export function rolloutIncludes(
  releaseId: string,
  cohortCount: number | null,
  key: string | null,
): boolean {
  if (cohortCount === null || cohortCount === undefined) return true;
  if (cohortCount >= 100) return true;
  if (cohortCount <= 0 || !key) return false;
  return rolloutBucket(releaseId, key) < cohortCount;
}

/**
 * Whether a build's artifacts live in the Hands bucket, decided from DECLARED placement.
 *
 * `builds.artifact_mode` is the authoritative column (migration 0073): `hands_r2` means the
 * bytes are objects under `build_assets`, `external` means they are declared in
 * `external_build_targets`. The distinction matters while a build is being migrated, because
 * its rows can exist BEFORE the switch is final and every public read must keep describing the
 * build as external until then. Inferring from row presence alone would let a migration leak
 * hosted identities (signed R2 URLs) while the download route is still serving the declared
 * external URL - the surfaces would disagree about one release.
 *
 * Pure by design: callers already read these two facts in their own queries, so this adds no
 * round trip and cannot drift from what they selected on. A build with no mode predates the
 * column, so there the presence of installable rows is the only available signal.
 */
export function usesHostedAssets(
  artifactMode: string | null,
  hasHostedAssets: boolean,
): boolean {
  if (artifactMode === "external") return false;
  if (artifactMode === "hands_r2") return true;
  return hasHostedAssets;
}
