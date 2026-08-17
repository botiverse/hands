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
  args: { appId: string; channelId: string; productType?: string | null | undefined },
): Promise<ActiveReleaseCandidate[]> {
  const withProduct = Boolean(args.productType);
  const statement = db.prepare(
    `SELECT r.id, r.build_id, r.created_at,
            COALESCE(r.activated_at, r.created_at) AS activated_at,
            r.product_type, r.rollout_cohort_count, r.changelog
     FROM releases r
     JOIN builds b ON b.id = r.build_id
     WHERE r.app_id = ?1 AND r.channel_id = ?2
       ${withProduct ? "AND r.product_type = ?3" : ""}
       AND r.status = 'active'
       AND b.product_type != 'ios-simulator-qa' AND b.release_type != 'qa'
     ORDER BY COALESCE(r.activated_at, r.created_at) DESC`,
  );
  const result = await (withProduct
    ? statement.bind(args.appId, args.channelId, args.productType)
    : statement.bind(args.appId, args.channelId)
  ).all<ActiveReleaseCandidate>();
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
