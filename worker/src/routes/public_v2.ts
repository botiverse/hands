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
 * `/public/apps/:slug/latest` is also wired to this resolver so Quiver has
 * a single release-backed public lookup path.
 */

import type { Context } from "hono";
import { requestOrigin } from "../lib/origin";
import { presignR2DownloadUrl } from "../lib/r2_presign";
import { parseReleaseNotes, resolveReleaseNote, type ReleaseNotes } from "../lib/release_notes";

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
    release_notes: ReleaseNotes | null;
    force_update: boolean;
    released_at: number;
  };
  assets: PublicAssetResponse[];
  scoped: {
    scope_type: "full" | "platform" | "user_cohort" | "ip_range";
    scope_value: string;
    release_id: string;
    rollout_cohort_count?: number | null;
  };
  fallback_release: unknown | null;
  expires_in: number;
};

const PUBLIC_DOWNLOAD_PREFIX = "/public/r2";

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
  const cohort = c.req.header("X-Hands-Cohort") ?? c.req.header("X-Quiver-Cohort") ?? null;
  const deviceId =
    c.req.header("X-Hands-Device-Id") ?? c.req.header("X-Quiver-Device-Id") ?? c.req.query("device_id") ?? null;
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

  // Candidates: active releases on (channel, [product_type]). No time window:
  // an active release must stay resolvable no matter how old it is.
  const candidateSql = productType
    ? `SELECT id, build_id, created_at, product_type, rollout_cohort_count, changelog
       FROM releases
       WHERE app_id = ?1 AND channel_id = ?2 AND product_type = ?3
         AND status = 'active'
       ORDER BY created_at DESC`
    : `SELECT id, build_id, created_at, product_type, rollout_cohort_count, changelog
       FROM releases
       WHERE app_id = ?1 AND channel_id = ?2
         AND status = 'active'
       ORDER BY created_at DESC`;
  const candidateStmt = c.env.DB.prepare(candidateSql);
  const allCandidates = await (productType
    ? candidateStmt.bind(app.id, channelRow.id, productType)
    : candidateStmt.bind(app.id, channelRow.id)
  ).all<{
    id: string;
    build_id: string;
    created_at: number;
    product_type: string;
    rollout_cohort_count: number | null;
    changelog: string | null;
  }>();

  // Rollout gate: a release with rollout_cohort_count < 100 is only served to
  // clients whose stable per-release bucket falls below the percentage.
  // Clients that do not send a device id only ever see fully rolled-out
  // releases. Gated-out clients fall through to the previous active release.
  const candidates = {
    results: allCandidates.results.filter((release) =>
      rolloutIncludes(release.id, release.rollout_cohort_count, deviceId),
    ),
  };
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
       AND artifact_kind = 'installable'
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
  const origin = publicRequestOrigin(c);
  const assetsWithUrls = await Promise.all(
    filteredAssets.map(async (a) => ({
      platform: a.platform,
      arch: a.arch,
      variant: a.variant,
      filetype: a.filetype,
      size_bytes: a.size_bytes,
      signature: a.signature,
      download_url: await generateSignedR2Url(c.env, a.r2_key, ttl, origin),
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

  const rawChangelog =
    candidates.results.find((r) => r.id === winner.release_id)?.changelog ??
      build.changelog;

  return c.json({
    app: { slug: app.slug, platform: app.platform },
    channel,
    build: {
      id: build.id,
      version: build.version_name,
      version_code: build.version_code,
      release_type: "stable",
      // The reviewed (release-level, possibly bilingual) changelog wins over
      // the raw build changelog generated by CI — same precedence as the
      // public history page.
      changelog: resolveChangelog(rawChangelog, requestedLang(c)),
      release_notes: parseReleaseNotes(rawChangelog),
      force_update: Boolean(build.should_force_update),
      released_at: build.completed_at ?? build.created_at,
    },
    assets: assetsWithUrls,
    scoped: {
      scope_type: winner.scope_type,
      scope_value: winner.scope_value,
      release_id: winner.release_id,
      rollout_cohort_count:
        candidates.results.find((r) => r.id === winner.release_id)
          ?.rollout_cohort_count ?? null,
    },
    fallback_release: fallbackRelease,
    expires_in: ttl,
  });
}

/**
 * Best-effort per-release counter: `current` when the client is already on
 * this release, `offered` when it is being offered an update to it. Runs in
 * the background; never affects the response.
 */
function bumpReleaseMetric(
  c: Context<{ Bindings: Env }>,
  releaseId: string | undefined,
  kind: "offered" | "current",
): void {
  if (!releaseId) return;
  const column = kind === "offered" ? "offered_count" : "current_count";
  const now = Date.now();
  const run = c.env.DB.prepare(
    `INSERT INTO release_metrics (release_id, ${column}, last_checked_at)
     VALUES (?1, 1, ?2)
     ON CONFLICT(release_id) DO UPDATE SET
       ${column} = ${column} + 1,
       last_checked_at = ?3`,
  )
    .bind(releaseId, now, now)
    .run();
  try {
    c.executionCtx.waitUntil(run.catch(() => {}));
  } catch {
    void run.catch(() => {});
  }
}

export async function handlePublicV2UpdateCheck(c: Context<{ Bindings: Env }>) {
  const currentVersionCodeRaw =
    c.req.query("current_version_code") ??
    c.req.query("currentVersionCode") ??
    c.req.header("X-Hands-Current-Version-Code") ?? c.req.header("X-Quiver-Current-Version-Code");
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
    if (latest.build.version_code === currentVersionCode) {
      bumpReleaseMetric(c, latest.scoped?.release_id, "current");
    }
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
    c.req.header("X-Hands-Client-Platform") ?? c.req.header("X-Quiver-Client-Platform") ??
    latest.app.platform;
  const requestedArch =
    c.req.query("arch") ??
    c.req.header("X-Hands-Client-Arch") ?? c.req.header("X-Quiver-Client-Arch") ??
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

  bumpReleaseMetric(c, latest.scoped?.release_id, "offered");
  // Delta (differential) download offer: if the client's installed version has
  // a patch to the latest build for its arch, and that patch is meaningfully
  // smaller than the full APK, offer it. The full `asset` stays the fallback;
  // old SDKs ignore the extra `patch` field. See docs/delta-download-design.md.
  const patch =
    currentVersionCode > 0
      ? await findDeltaPatch(c, {
          buildId: latest.build.id,
          fromVersionCode: currentVersionCode,
          arch: requestedArch,
          fullSizeBytes: asset.size_bytes,
          origin: publicRequestOrigin(c),
          ttl: latest.expires_in,
        })
      : null;

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
      release_notes: latest.build.release_notes,
      force_update: latest.build.force_update,
      released_at: latest.build.released_at,
    },
    asset,
    ...(patch ? { patch } : {}),
    scoped: latest.scoped,
    expires_in: latest.expires_in,
  });
}

/** Fraction of the full APK a patch must beat to be worth offering. */
const DELTA_MAX_SIZE_RATIO = 0.7;

/**
 * Find a delta-patch asset on the target build that upgrades the client's
 * installed version for its arch, returning a signed offer only when the patch
 * is small enough to be a win. Patch assets carry
 * metadata_json = {from_version_code, to_version_code, algorithm, target_sha256}.
 */
async function findDeltaPatch(
  c: Context<{ Bindings: Env }>,
  args: {
    buildId: string;
    fromVersionCode: number;
    arch: string | null;
    fullSizeBytes: number;
    origin: string;
    ttl: number;
  },
): Promise<{
  from_version_code: number;
  algorithm: string;
  download_url: string;
  size_bytes: number;
  target_sha256: string | null;
} | null> {
  const row = await c.env.DB.prepare(
    `SELECT r2_key, size_bytes, arch,
            json_extract(metadata_json, '$.algorithm') AS algorithm,
            json_extract(metadata_json, '$.target_sha256') AS target_sha256
     FROM build_assets
     WHERE build_id = ?1
       AND artifact_kind = 'delta-patch'
       AND CAST(json_extract(metadata_json, '$.from_version_code') AS INTEGER) = ?2
       AND (arch = ?3 OR arch IS NULL)
     ORDER BY (arch = ?4) DESC
     LIMIT 1`,
  )
    .bind(args.buildId, args.fromVersionCode, args.arch, args.arch)
    .first<{
      r2_key: string;
      size_bytes: number;
      arch: string | null;
      algorithm: string | null;
      target_sha256: string | null;
    }>();
  if (!row) return null;
  // Only a win if it's meaningfully smaller than the full download.
  if (row.size_bytes > args.fullSizeBytes * DELTA_MAX_SIZE_RATIO) return null;
  return {
    from_version_code: args.fromVersionCode,
    algorithm: row.algorithm ?? "archive-patcher-v1",
    download_url: await generateSignedR2Url(c.env, row.r2_key, args.ttl, args.origin),
    size_bytes: row.size_bytes,
    target_sha256: row.target_sha256,
  };
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

/**
 * Stable 32-bit FNV-1a hash. Deterministic across runtimes so a device keeps
 * the same bucket for a given release while the rollout percentage climbs.
 */
export function fnv1a32(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Bucket in [0, 100). Salted by release id so cohorts reshuffle per release. */
export function rolloutBucket(releaseId: string, deviceId: string): number {
  return fnv1a32(`${releaseId}:${deviceId}`) % 100;
}

/**
 * true when the release should be served to this client.
 * - null / >=100 cohort count: fully rolled out, everyone matches.
 * - gated release + no device id: excluded (legacy clients only get full
 *   releases; they fall through to the previous active release).
 * - gated release + device id: stable bucket must fall under the percentage.
 */
export function rolloutIncludes(
  releaseId: string,
  cohortCount: number | null,
  deviceId: string | null,
): boolean {
  if (cohortCount === null || cohortCount === undefined) return true;
  if (cohortCount >= 100) return true;
  if (cohortCount <= 0) return false;
  if (!deviceId) return false;
  return rolloutBucket(releaseId, deviceId) < cohortCount;
}

/**
 * Changelog may be plain text (legacy, treated as en) or a JSON object of
 * BCP-47-ish keys ({"en": "...", "zh-CN": "..."}). Resolve to the closest
 * language, falling back en -> first available.
 */
/**
 * Minimal, safe markdown for changelogs on public pages: escapes HTML first,
 * then supports "- " bullet lists, **bold**, `code`, and paragraphs. No raw
 * HTML, images, or links pass through.
 */
export function changelogToHtml(raw: string): string {
  const escape = (t: string) =>
    t
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
  const inline = (t: string) =>
    escape(t)
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/`([^`]+)`/g, "<code>$1</code>");
  const lines = raw.split(/\r?\n/);
  const out: string[] = [];
  let list: string[] = [];
  const flushList = () => {
    if (list.length > 0) {
      out.push(`<ul>${list.map((li) => `<li>${li}</li>`).join("")}</ul>`);
      list = [];
    }
  };
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("- ") || trimmed.startsWith("* ")) {
      list.push(inline(trimmed.slice(2)));
    } else if (trimmed.length === 0) {
      flushList();
    } else {
      flushList();
      out.push(`<p>${inline(trimmed)}</p>`);
    }
  }
  flushList();
  return out.join("");
}

export function resolveChangelog(raw: string | null, lang: string | null): string | null {
  return resolveReleaseNote(raw, lang);
}

export function requestedLang(c: Context<{ Bindings: Env }>): string | null {
  const explicit = c.req.query("lang") ?? c.req.header("X-Hands-Lang") ?? c.req.header("X-Quiver-Lang");
  if (explicit) return explicit;
  const accept = c.req.header("accept-language");
  if (!accept) return null;
  return accept.split(",")[0]?.trim().split(";")[0] ?? null;
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
    c.req.header("X-Hands-Client-Platform") ?? c.req.header("X-Quiver-Client-Platform") ??
    c.req.query("client_platform");
  if (explicit) return explicit;
  const platform = c.req.query("platform");
  const arch = c.req.query("arch") ?? c.req.header("X-Hands-Client-Arch") ?? c.req.header("X-Quiver-Client-Arch");
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
    `SELECT platform, r2_key
     FROM build_assets
     WHERE build_id = ?1 AND artifact_kind = 'installable'
     LIMIT 5`,
  )
    .bind(fb.build_id)
    .all<{ platform: string; r2_key: string }>();
  const ttl = Number(c.env.SIGNED_URL_TTL_SECONDS ?? "3600");
  const origin = publicRequestOrigin(c);
  const urls = await Promise.all(
    fbAssets.results.map(async (a) => ({
      platform: a.platform,
      download_url: await generateSignedR2Url(c.env, a.r2_key, ttl, origin),
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

export async function generateSignedR2Url(
  env: Env,
  key: string,
  ttlSeconds: number,
  origin?: string,
): Promise<string> {
  const expires = Math.floor(Date.now() / 1000) + ttlSeconds;
  const sig = await signDownloadUrl(env, key, expires);
  const path = `${PUBLIC_DOWNLOAD_PREFIX}/${encodeURIComponent(key)}?expires=${expires}&sig=${sig}`;
  return origin ? new URL(path, origin).toString() : path;
}

const INTERNAL_DOWNLOAD_PREFIX = "/internal/r2";

/**
 * Sign an internal R2 fetch URL (same HMAC scheme as the public one, different
 * path + no release-status gate). Used by the delta-patch container to fetch
 * source APKs from R2 by key — the request body to the container stays tiny
 * (two URLs) instead of pushing tens of MB of APK bytes through container.fetch.
 */
export async function generateInternalR2Url(
  env: Env,
  key: string,
  ttlSeconds: number,
  origin?: string,
): Promise<string> {
  const expires = Math.floor(Date.now() / 1000) + ttlSeconds;
  const sig = await signDownloadUrl(env, key, expires);
  const path = `${INTERNAL_DOWNLOAD_PREFIX}/${encodeURIComponent(key)}?expires=${expires}&sig=${sig}`;
  return origin ? new URL(path, origin).toString() : path;
}

/**
 * Serve an R2 object by key given a valid HMAC signature. The signature (over
 * key+expiry with SIGNED_URL_SECRET) is the authorization — only the Worker can
 * mint one — so this serves any object regardless of release status, unlike the
 * public download. Internal use: the delta-patch container fetches source APKs.
 */
export async function handleInternalR2Download(c: Context<{ Bindings: Env }>) {
  const key = c.req.param("key");
  const expires = Number(c.req.query("expires"));
  const sig = c.req.query("sig") ?? "";
  if (!key) return c.json({ error: "key required" }, 400);
  if (!Number.isFinite(expires)) {
    return c.json({ error: "expires must be a unix timestamp" }, 400);
  }
  if (expires < Math.floor(Date.now() / 1000)) {
    return c.json({ error: "download URL expired" }, 403);
  }
  const expectedSig = await signDownloadUrl(c.env, key, expires);
  if (!sig || !constantTimeEqual(sig, expectedSig)) {
    return c.json({ error: "invalid download signature" }, 403);
  }
  const object = await c.env.APK_BUCKET.get(key);
  if (!object) return c.json({ error: "object not found" }, 404);
  const headers = new Headers();
  headers.set("content-type", "application/octet-stream");
  headers.set("content-length", String(object.size));
  headers.set("cache-control", "private, max-age=0, no-store");
  return new Response(object.body, { headers });
}

function publicRequestOrigin(c: Context<{ Bindings: Env }>): string {
  return requestOrigin(c);
}

export async function handlePublicR2Download(c: Context<{ Bindings: Env }>) {
  const key = c.req.param("key");
  const expires = Number(c.req.query("expires"));
  const sig = c.req.query("sig") ?? "";
  if (!key) return c.json({ error: "key required" }, 400);
  if (!Number.isFinite(expires)) {
    return c.json({ error: "expires must be a unix timestamp" }, 400);
  }
  if (expires < Math.floor(Date.now() / 1000)) {
    return c.json({ error: "download URL expired" }, 403);
  }
  const expectedSig = await signDownloadUrl(c.env, key, expires);
  if (!sig || !constantTimeEqual(sig, expectedSig)) {
    return c.json({ error: "invalid download signature" }, 403);
  }

  const asset = await c.env.DB.prepare(
    `SELECT ba.filetype, ba.size_bytes, ba.variant,
            b.version_name, b.version_code,
            a.slug AS app_slug
     FROM build_assets ba
     JOIN builds b ON b.id = ba.build_id
     JOIN apps a ON a.id = b.app_id
     JOIN releases r ON r.build_id = b.id
     WHERE ba.r2_key = ?1
       AND ba.artifact_kind = 'installable'
       AND r.status IN ('active', 'draft')
     LIMIT 1`,
  )
    .bind(key)
    .first<{
      filetype: string;
      size_bytes: number;
      variant: string | null;
      version_name: string;
      version_code: number;
      app_slug: string;
    }>();
  if (!asset) {
    // Not a build asset — the HMAC signature (key + expiry) already proves
    // this URL came from an authenticated presign call, so also serve
    // feedback attachments (task #123: agents fetch binaries via signed URL
    // because agent transports corrupt raw bytes).
    const attachment = await c.env.DB.prepare(
      `SELECT filename, content_type, size_bytes FROM feedback_attachments WHERE r2_key = ?1 LIMIT 1`,
    )
      .bind(key)
      .first<{ filename: string; content_type: string | null; size_bytes: number | null }>();
    if (!attachment) return c.json({ error: "asset not found" }, 404);
    const object = await c.env.APK_BUCKET.get(key);
    if (!object) return c.json({ error: "object not found" }, 404);
    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set("etag", object.httpEtag);
    headers.set("cache-control", "private, max-age=0, no-store");
    headers.set("content-type", attachment.content_type ?? "application/octet-stream");
    if (attachment.size_bytes != null) headers.set("content-length", String(attachment.size_bytes));
    headers.set(
      "content-disposition",
      `attachment; filename*=UTF-8''${encodeURIComponent(attachment.filename)}`,
    );
    return new Response(object.body, { headers });
  }

  const contentDisposition = contentDispositionForAsset(asset);
  const directUrl = await presignR2DownloadUrl(c.env, {
    key,
    filetype: asset.filetype,
    contentDisposition,
  }, Math.min(
    Number(c.env.R2_PRESIGNED_DOWNLOAD_TTL_SECONDS ?? c.env.SIGNED_URL_TTL_SECONDS ?? "3600"),
    Math.max(1, expires - Math.floor(Date.now() / 1000)),
  ));
  if (directUrl) {
    const objectHead = await c.env.APK_BUCKET.head(key);
    if (!objectHead) return c.json({ error: "object not found" }, 404);
    return c.redirect(directUrl, 302);
  }

  const object = await c.env.APK_BUCKET.get(key);
  if (!object) return c.json({ error: "object not found" }, 404);

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("cache-control", "private, max-age=0, no-store");
  headers.set("content-type", contentTypeForAsset(asset.filetype));
  headers.set("content-length", String(asset.size_bytes));
  headers.set("content-disposition", contentDisposition);
  return new Response(object.body, { headers });
}

function contentDispositionForAsset(asset: {
  app_slug: string;
  version_name: string;
  version_code: number;
  variant: string | null;
  filetype: string;
}): string {
  const variant =
    asset.variant && asset.variant !== "release"
      ? `-${safeFilenameSegment(asset.variant)}`
      : "";
  const extension = safeFilenameSegment(asset.filetype || "bin");
  const filename = `${safeFilenameSegment(asset.app_slug)}-${safeFilenameSegment(asset.version_name)}-${asset.version_code}${variant}.${extension}`;
  return `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

function safeFilenameSegment(value: string): string {
  const normalized = value
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || "artifact";
}

function contentTypeForAsset(filetype: string): string {
  switch (filetype) {
    case "apk":
      return "application/vnd.android.package-archive";
    case "aab":
      return "application/octet-stream";
    case "zip":
      return "application/zip";
    default:
      return "application/octet-stream";
  }
}

async function signDownloadUrl(
  env: Env,
  key: string,
  expires: number,
): Promise<string> {
  const secret = env.SIGNED_URL_SECRET || env.ADMIN_API_TOKEN || env.RAFT_CLIENT_SECRET;
  if (!secret) {
    throw new Error("SIGNED_URL_SECRET, ADMIN_API_TOKEN, or RAFT_CLIENT_SECRET must be configured");
  }
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    cryptoKey,
    new TextEncoder().encode(`${key}:${expires}`),
  );
  return Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i += 1) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}
