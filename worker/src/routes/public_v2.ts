/**
 * /public/v2/* routes — client-facing endpoints with scope resolution.
 *
 * Implements publish-architecture.md §5.4:
 *   GET /public/v2/apps/:slug/latest?channel=&product_type=&cohort=
 *   Headers: X-Quiver-Client-Platform, X-Quiver-Cohort, (cf.clientIp for ip_range)
 *
 * Server picks the most specific matching scope:
 *   1. ip_range    (priority 4) — CIDR match on cf.clientIp
 *   2. user_cohort (priority 3) — exact match on X-Quiver-Cohort header
 *   3. platform    (priority 2) — CSV match on X-Quiver-Client-Platform
 *   4. full        (priority 1) — catch-all
 *
 * Within a priority level, ties broken by created_at DESC, then release_id.
 *
 * Backward compat: v1 /public/apps/:slug/latest still uses the legacy
 * `versions` table and is unchanged. v2 only kicks in when the app has
 * any rows in the `releases` table.
 */

import type { Context } from "hono";

interface ScopedResolution {
  release_id: string;
  scope_type: "full" | "platform" | "user_cohort" | "ip_range";
  scope_value: string;
  priority: number;
  release_created_at: number;
}

type PublicAssetResponse = {
  platform: string;
  arch: string | null;
  variant: string | null;
  filetype: string;
  size_bytes: number;
  signature: string | null;
  download_url: string;
};

type PublicLatestResponse = {
  app: { slug: string; platform: string };
  channel: string;
  build: {
    id: string;
    version: string;
    version_code: number;
    release_type: string;
    changelog: string | null;
    force_update: boolean;
    released_at: number;
  };
  assets: PublicAssetResponse[];
  scoped: {
    scope_type: "full" | "platform" | "user_cohort" | "ip_range";
    scope_value: string;
    release_id: string;
  };
  fallback_release: unknown | null;
  expires_in: number;
};

const PRIORITY = {
  ip_range: 4,
  user_cohort: 3,
  platform: 2,
  full: 1,
} as const;

export async function handlePublicV2Latest(c: Context<{ Bindings: Env }>) {
  const slug = c.req.param("slug");
  const channel = c.req.query("channel") ?? "main";
  const productType = c.req.query("product_type"); // optional; if null, picks most recent across all
  const cohort = c.req.header("X-Quiver-Cohort") ?? null;
  const clientPlatform = effectiveClientPlatform(c);
  // cf.clientIp is server-only (we never trust X-Forwarded-For here).
  const clientIp =
    (c.req.raw?.cf as { clientIp?: string } | undefined)?.clientIp ?? null;

  if (!slug) return c.json({ error: "slug required" }, 400);

  const app = await c.env.DB.prepare(
    "SELECT id, slug, platform FROM apps WHERE slug = ?",
  )
    .bind(slug)
    .first<{ id: string; slug: string; platform: string }>();
  if (!app) return c.json({ error: `app '${slug}' not found` }, 404);

  // Channel lookup
  const channelRow = await c.env.DB.prepare(
    `SELECT id FROM channels WHERE app_id = ?1 AND slug = ?2 LIMIT 1`,
  )
    .bind(app.id, channel)
    .first<{ id: string }>();
  if (!channelRow) {
    return c.json(
      { error: `channel '${channel}' not found for app '${slug}'` },
      404,
    );
  }

  // Candidates: active releases on (channel, [product_type]) within last 30 days.
  const since = Date.now() - 30 * 24 * 3600 * 1000;
  const candidateSql = productType
    ? `SELECT id, build_id, created_at, product_type
       FROM releases
       WHERE app_id = ?1 AND channel_id = ?2 AND product_type = ?3
         AND status = 'active' AND created_at > ?4
       ORDER BY created_at DESC`
    : `SELECT id, build_id, created_at, product_type
       FROM releases
       WHERE app_id = ?1 AND channel_id = ?2
         AND status = 'active' AND created_at > ?3
       ORDER BY created_at DESC`;
  const candidateStmt = c.env.DB.prepare(candidateSql);
  const candidates = await (productType
    ? candidateStmt.bind(app.id, channelRow.id, productType, since)
    : candidateStmt.bind(app.id, channelRow.id, since)
  ).all<{
    id: string;
    build_id: string;
    created_at: number;
    product_type: string;
  }>();
  if (candidates.results.length === 0) {
    return c.json(
      {
        error: `no active release for this client on channel '${channel}'`,
        app: { slug: app.slug, platform: app.platform },
        channel,
      },
      404,
    );
  }

  // Pull all scopes for those releases in one query.
  const candidateIds = candidates.results.map((r) => r.id);
  if (candidateIds.length === 0) {
    return c.json({ error: "no candidates" }, 404);
  }
  const placeholders = candidateIds.map(() => "?").join(",");
  const { results: scopes } = await c.env.DB.prepare(
    `SELECT release_id, scope_type, scope_value
     FROM release_scopes
     WHERE release_id IN (${placeholders})`,
  )
    .bind(...candidateIds)
    .all<{ release_id: string; scope_type: string; scope_value: string }>();

  // Build match list (release, scope, priority).
  const matched: ScopedResolution[] = [];
  for (const release of candidates.results) {
    for (const s of scopes) {
      if (s.release_id !== release.id) continue;
      const ok = matchesScope(
        s.scope_type,
        s.scope_value,
        cohort,
        clientPlatform,
        clientIp,
      );
      if (!ok) continue;
      const prio =
        PRIORITY[s.scope_type as keyof typeof PRIORITY] ?? 0;
      matched.push({
        release_id: release.id,
        scope_type: s.scope_type as ScopedResolution["scope_type"],
        scope_value: s.scope_value,
        priority: prio,
        release_created_at: release.created_at,
      });
    }
  }

  if (matched.length === 0) {
    return c.json(
      {
        error: "no active release matches this client",
        app: { slug: app.slug, platform: app.platform },
        channel,
        client: { platform: clientPlatform, ip: clientIp, cohort },
      },
      404,
    );
  }

  // Sort by priority DESC, created_at DESC, release_id ASC (deterministic tie-break).
  matched.sort((a, b) => {
    if (a.priority !== b.priority) return b.priority - a.priority;
    if (a.release_created_at !== b.release_created_at) {
      return b.release_created_at - a.release_created_at;
    }
    return a.release_id < b.release_id ? -1 : 1;
  });

  const winner = matched[0]!;

  // Build the response: build + assets + scoped block + fallback release.
  const build = await c.env.DB.prepare(
    `SELECT id, version_name, version_code, status,
            changelog, should_force_update, created_at, completed_at
     FROM builds
     WHERE id = ?1`,
  )
    .bind(
      candidates.results.find((r) => r.id === winner.release_id)?.build_id ??
        null,
    )
    .first<{
      id: string;
      version_name: string;
      version_code: number;
      status: string;
      changelog: string | null;
      should_force_update: number;
      created_at: number;
      completed_at: number | null;
    }>();
  if (!build) {
    return c.json({ error: "matched release has no build row" }, 500);
  }

  // Pick the best matching asset for the client (filter by client_platform).
  const assets = await c.env.DB.prepare(
    `SELECT id, platform, arch, variant, filetype, r2_key, file_hash,
            size_bytes, signature
     FROM build_assets
     WHERE build_id = ?1
     ORDER BY platform ASC, arch ASC, filetype ASC`,
  )
    .bind(build.id)
    .all<{
      id: string;
      platform: string;
      arch: string | null;
      variant: string | null;
      filetype: string;
      r2_key: string;
      file_hash: string;
      size_bytes: number;
      signature: string | null;
    }>();

  const filteredAssets = clientPlatform
    ? assets.results.filter((a) => {
        const parsed = splitPlatformArch(clientPlatform);
        if (a.platform === parsed.platform && parsed.arch === null) return true;
        if (a.platform === parsed.platform && a.arch === parsed.arch) return true;
        return false;
      })
    : assets.results;

  const ttl = Number(c.env.SIGNED_URL_TTL_SECONDS ?? "3600");
  const assetsWithUrls = await Promise.all(
    filteredAssets.map(async (a) => ({
      platform: a.platform,
      arch: a.arch,
      variant: a.variant,
      filetype: a.filetype,
      size_bytes: a.size_bytes,
      signature: a.signature,
      download_url: await generateSignedR2Url(c.env, a.r2_key, ttl),
    })),
  );

  // Optional fallback_release: if the winner is NOT `full`, look for the
  // next-most-specific `full` match for the same client so we can warn
  // users on old versions.
  let fallbackRelease: Awaited<
    ReturnType<typeof buildFallbackRelease>
  > | null = null;
  if (winner.scope_type !== "full") {
    fallbackRelease = await buildFallbackRelease(
      c,
      candidateIds,
      winner,
      productType ?? null,
    );
  }

  return c.json({
    app: { slug: app.slug, platform: app.platform },
    channel,
    build: {
      id: build.id,
      version: build.version_name,
      version_code: build.version_code,
      release_type: "stable",
      changelog: build.changelog,
      force_update: Boolean(build.should_force_update),
      released_at: build.completed_at ?? build.created_at,
    },
    assets: assetsWithUrls,
    scoped: {
      scope_type: winner.scope_type,
      scope_value: winner.scope_value,
      release_id: winner.release_id,
    },
    fallback_release: fallbackRelease,
    expires_in: ttl,
  });
}

export async function handlePublicV2UpdateCheck(c: Context<{ Bindings: Env }>) {
  const currentVersionCodeRaw =
    c.req.query("current_version_code") ??
    c.req.query("currentVersionCode") ??
    c.req.header("X-Quiver-Current-Version-Code");
  const currentVersionCode = Number(currentVersionCodeRaw);
  if (
    !currentVersionCodeRaw ||
    !Number.isFinite(currentVersionCode) ||
    currentVersionCode < 0
  ) {
    return c.json(
      { error: "current_version_code must be a non-negative number" },
      400,
    );
  }

  const latestResponse = await handlePublicV2Latest(c);
  if (latestResponse.status !== 200) return latestResponse;
  const latest = (await latestResponse.json()) as PublicLatestResponse;

  if (latest.build.version_code <= currentVersionCode) {
    return c.json({
      update_available: false,
      app: latest.app,
      channel: latest.channel,
      current_version_code: currentVersionCode,
      latest_version_code: latest.build.version_code,
      scoped: latest.scoped,
      checked_at: Date.now(),
    });
  }

  const requestedPlatform =
    c.req.query("platform") ??
    c.req.query("client_platform") ??
    c.req.header("X-Quiver-Client-Platform") ??
    latest.app.platform;
  const requestedArch =
    c.req.query("arch") ??
    c.req.header("X-Quiver-Client-Arch") ??
    splitPlatformArch(requestedPlatform).arch;
  const requestedFiletype = c.req.query("filetype") ?? "apk";
  const asset = selectBestAsset(latest.assets, {
    platform: requestedPlatform,
    arch: requestedArch,
    filetype: requestedFiletype,
  });
  if (!asset) {
    return c.json(
      {
        error: "matched release has no compatible asset",
        app: latest.app,
        channel: latest.channel,
        build: latest.build,
        requested: {
          platform: requestedPlatform,
          arch: requestedArch,
          filetype: requestedFiletype,
        },
      },
      404,
    );
  }

  return c.json({
    update_available: true,
    app: latest.app,
    channel: latest.channel,
    current_version_code: currentVersionCode,
    latest: {
      build_id: latest.build.id,
      version: latest.build.version,
      version_code: latest.build.version_code,
      changelog: latest.build.changelog,
      force_update: latest.build.force_update,
      released_at: latest.build.released_at,
    },
    asset,
    scoped: latest.scoped,
    expires_in: latest.expires_in,
  });
}

export function selectBestAsset(
  assets: PublicAssetResponse[],
  requested: {
    platform: string | null;
    arch: string | null;
    filetype: string;
  },
): PublicAssetResponse | null {
  const filetypeMatches = assets.filter((a) => a.filetype === requested.filetype);
  if (filetypeMatches.length === 0) return null;
  const pool = filetypeMatches;
  const parsed = splitPlatformArch(requested.platform);
  const platform = parsed.platform;
  const arch = requested.arch ?? parsed.arch;
  const platformMatches = platform
    ? pool.filter((a) => a.platform === platform)
    : pool;
  const candidates = platformMatches.length > 0 ? platformMatches : pool;
  if (arch) {
    const archMatch = candidates.find((a) => a.arch === arch);
    if (archMatch) return archMatch;
  }
  return candidates.find((a) => a.arch === null) ?? candidates[0] ?? null;
}

function splitPlatformArch(value: string | null): {
  platform: string | null;
  arch: string | null;
} {
  if (!value) return { platform: null, arch: null };
  const knownPlatforms = ["android", "darwin", "win32", "linux", "ios"];
  for (const platform of knownPlatforms) {
    if (value === platform) return { platform, arch: null };
    const prefix = `${platform}-`;
    if (value.startsWith(prefix)) {
      return { platform, arch: value.slice(prefix.length) || null };
    }
  }
  return { platform: value, arch: null };
}

function effectiveClientPlatform(c: Context<{ Bindings: Env }>): string | null {
  const explicit =
    c.req.header("X-Quiver-Client-Platform") ??
    c.req.query("client_platform");
  if (explicit) return explicit;
  const platform = c.req.query("platform");
  const arch = c.req.query("arch") ?? c.req.header("X-Quiver-Client-Arch");
  if (platform && arch) return `${platform}-${arch}`;
  return platform ?? null;
}

function matchesScope(
  scopeType: string,
  scopeValue: string,
  cohort: string | null,
  clientPlatform: string | null,
  clientIp: string | null,
): boolean {
  switch (scopeType) {
    case "full":
      return true;
    case "user_cohort":
      return !!cohort && scopeValue === cohort;
    case "platform": {
      if (!clientPlatform) return false;
      const tokens = scopeValue.split(",").map((s) => s.trim());
      return tokens.includes(clientPlatform);
    }
    case "ip_range": {
      if (!clientIp) return false;
      return cidrContains(scopeValue, clientIp);
    }
    default:
      return false;
  }
}

/**
 * Lightweight CIDR containment check (IPv4 only for v1).
 * Returns true if `clientIp` falls inside `cidr` (e.g. "10.0.0.0/8").
 */
function cidrContains(cidr: string, clientIp: string): boolean {
  const [base, maskStr] = cidr.split("/");
  if (!base || !maskStr) return false;
  const mask = Number(maskStr);
  if (!Number.isFinite(mask) || mask < 0 || mask > 32) return false;
  const baseNum = ipToInt(base);
  const ipNum = ipToInt(clientIp);
  if (baseNum === null || ipNum === null) return false;
  if (mask === 0) return true;
  const maskBits = (~0 << (32 - mask)) >>> 0;
  return (baseNum & maskBits) === (ipNum & maskBits);
}

function ipToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let acc = 0;
  for (const p of parts) {
    const n = Number(p);
    if (!Number.isFinite(n) || n < 0 || n > 255) return null;
    acc = (acc << 8) | n;
  }
  return acc >>> 0;
}

async function buildFallbackRelease(
  c: Context<{ Bindings: Env }>,
  candidateIds: string[],
  winner: ScopedResolution,
  productType: string | null,
): Promise<{
  build: { version: string; version_code: number; platform: string };
  assets: Array<{ platform: string; download_url: string }>;
} | null> {
  // Look for a `full` match in the same candidate set, excluding the winner.
  const fallbackSql = productType
    ? `SELECT r.id AS release_id, r.build_id, r.product_type,
              s.scope_type, s.scope_value
       FROM releases r
       JOIN release_scopes s ON s.release_id = r.id
       WHERE r.id IN (${candidateIds.map(() => "?").join(",")})
         AND r.id != ?
         AND s.scope_type = 'full' AND s.scope_value = 'all'`
    : `SELECT r.id AS release_id, r.build_id, r.product_type,
              s.scope_type, s.scope_value
       FROM releases r
       JOIN release_scopes s ON s.release_id = r.id
       WHERE r.id IN (${candidateIds.map(() => "?").join(",")})
         AND r.id != ?
         AND s.scope_type = 'full' AND s.scope_value = 'all'`;
  const stmt = c.env.DB.prepare(fallbackSql);
  const params = productType
    ? [...candidateIds, winner.release_id]
    : [...candidateIds, winner.release_id];
  const fb = await stmt.bind(...params).first<{
    release_id: string;
    build_id: string;
    product_type: string;
  }>();
  if (!fb) return null;
  const fbBuild = await c.env.DB.prepare(
    `SELECT version_name, version_code FROM builds WHERE id = ?1`,
  )
    .bind(fb.build_id)
    .first<{ version_name: string; version_code: number }>();
  if (!fbBuild) return null;
  const fbAssets = await c.env.DB.prepare(
    `SELECT platform, r2_key FROM build_assets WHERE build_id = ?1 LIMIT 5`,
  )
    .bind(fb.build_id)
    .all<{ platform: string; r2_key: string }>();
  const ttl = Number(c.env.SIGNED_URL_TTL_SECONDS ?? "3600");
  const urls = await Promise.all(
    fbAssets.results.map(async (a) => ({
      platform: a.platform,
      download_url: await generateSignedR2Url(c.env, a.r2_key, ttl),
    })),
  );
  return {
    build: {
      version: fbBuild.version_name,
      version_code: fbBuild.version_code,
      platform: fb.product_type,
    },
    assets: urls,
  };
}

async function generateSignedR2Url(
  env: Env,
  key: string,
  ttlSeconds: number,
): Promise<string> {
  // Same placeholder as the v1 endpoint — real R2 signed URLs land in
  // P3.5 alongside the asset rewrite.
  return `/api/r2/${encodeURIComponent(key)}?expires=${Math.floor(Date.now() / 1000) + ttlSeconds}`;
}
