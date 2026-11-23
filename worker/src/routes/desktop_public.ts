/**
 * Public desktop update endpoints (platform `desktop`).
 *
 *   GET /public/v2/apps/:slug/desktop/update?target=&channel=&current_version_code=
 *   GET /public/v2/apps/:slug/files/:sha256
 *
 * The update check resolves a release the way `/public/v2/apps/:slug/latest` does
 * (scopes by priority, staged rollout by device id, public channel aliases), and in
 * addition only considers releases that are visible now (not hidden, availability_at
 * reached) and whose build carries a ready desktop manifest for the requested target.
 *
 * The file route serves one content-addressed bundle file. It answers only for a
 * digest that a validated manifest of an active or superseded, non-hidden release of
 * the same app references; anything else is a 404, so the route cannot be used to
 * probe for bytes that were uploaded but never published.
 */

import type { Context } from "hono";
import { requestOrigin } from "../lib/origin";
import { presignR2DownloadUrl } from "../lib/r2_presign";
import { PUBLIC_CHANNEL_ALIASES } from "../lib/public_channel";
import { DESKTOP_INSTALLER, equivalentsOf, rolloutIncludes } from "../lib/release_resolver";
import {
  DESKTOP_ARCHIVE_KIND,
  DESKTOP_MANIFEST_KIND,
  desktopFileKey,
  isDesktopTarget,
  isSha256,
  splitDesktopTarget,
} from "../lib/desktop_manifest";
import {
  SCOPE_PRIORITY,
  bumpReleaseMetric,
  generateSignedR2Url,
  matchesScope,
} from "./public_v2";

type PublicContext = Context<{ Bindings: Env }>;

interface DesktopCandidate {
  id: string;
  build_id: string;
  activated_at: number;
  rollout_cohort_count: number | null;
  version_name: string;
  version_code: number;
  force_update: number;
  released_at: number;
}

interface DesktopAssetRow {
  artifact_kind: string;
  filetype: string;
  r2_key: string;
  file_hash: string;
  size_bytes: number;
}

function headerOrQuery(c: PublicContext, headers: string[], query: string): string | null {
  for (const name of headers) {
    const value = c.req.header(name);
    if (value) return value;
  }
  return c.req.query(query) ?? null;
}

export async function handlePublicDesktopUpdate(c: PublicContext) {
  const slug = c.req.param("slug") ?? "";
  const target = c.req.query("target") ?? "";
  const requestedChannel = c.req.query("channel") ?? "main";
  const productTypes = equivalentsOf(c.req.query("product_type") ?? DESKTOP_INSTALLER);
  const currentRaw = c.req.query("current_version_code")
    ?? c.req.header("X-Hands-Current-Version-Code") ?? null;
  const currentVersionCode = Number(currentRaw);
  if (!isDesktopTarget(target)) {
    return c.json({ error: "target must be one of darwin-arm64, darwin-x64, win32-x64, win32-arm64, linux-x64, linux-arm64", code: "target_invalid" }, 400);
  }
  if (currentRaw === null || currentRaw === "" || !Number.isSafeInteger(currentVersionCode) || currentVersionCode < 0) {
    return c.json({ error: "current_version_code must be a non-negative integer", code: "current_version_code_invalid" }, 400);
  }
  const rawDeviceId = headerOrQuery(c, ["X-Hands-Device-Id", "X-Quiver-Device-Id"], "device_id")?.trim() ?? "";
  const deviceId = rawDeviceId.length > 0 && rawDeviceId.length <= 256 ? rawDeviceId : null;
  const cohort = c.req.header("X-Hands-Cohort") ?? c.req.header("X-Quiver-Cohort") ?? null;
  // A platform scope names a machine target; the requested target is the client's.
  const clientPlatform = c.req.header("X-Hands-Client-Platform") ?? c.req.header("X-Quiver-Client-Platform") ?? target;
  const clientIp = c.req.header("CF-Connecting-IP") ?? null;

  const app = await c.env.DB.prepare("SELECT id, slug FROM apps WHERE slug = ?1")
    .bind(slug).first<{ id: string; slug: string }>();
  if (!app) return c.json({ error: `app '${slug}' not found`, code: "app_not_found" }, 404);
  // A real channel named like an alias wins over the alias, as on /latest.
  const channel = await c.env.DB.prepare(
    `SELECT id, slug FROM channels WHERE app_id = ?1 AND slug IN (?2, ?3)
     ORDER BY slug = ?2 DESC LIMIT 1`,
  ).bind(app.id, requestedChannel, PUBLIC_CHANNEL_ALIASES[requestedChannel] ?? requestedChannel)
    .first<{ id: string; slug: string }>();
  if (!channel) {
    return c.json({ error: `channel '${requestedChannel}' not found for app '${slug}'`, code: "channel_not_found" }, 404);
  }

  const { platform, arch } = splitDesktopTarget(target);
  const now = Date.now();
  const productParams = productTypes.map((_, index) => `?${index + 6}`).join(", ");
  const { results: candidates } = await c.env.DB.prepare(
    `SELECT r.id, r.build_id, COALESCE(r.activated_at, r.created_at) AS activated_at,
            r.rollout_cohort_count, b.version_name, b.version_code,
            (r.should_force_update = 1 OR b.should_force_update = 1) AS force_update,
            COALESCE(b.completed_at, b.created_at) AS released_at
       FROM releases r
       JOIN builds b ON b.id = r.build_id
      WHERE r.app_id = ?1 AND r.channel_id = ?2
        AND r.status = 'active' AND r.hidden = 0
        AND (r.availability_at IS NULL OR r.availability_at <= ?3)
        AND b.status = 'succeeded'
        AND b.release_type != 'qa' AND r.release_type != 'qa'
        AND r.product_type IN (${productParams})
        AND EXISTS (
          SELECT 1 FROM build_assets ba
           WHERE ba.build_id = b.id AND ba.artifact_kind = 'desktop-manifest'
             AND ba.platform = ?4 AND ba.arch = ?5
             AND json_extract(ba.metadata_json, '$.upload_state') = 'ready'
        )
      ORDER BY COALESCE(r.activated_at, r.created_at) DESC, r.id ASC`,
  ).bind(app.id, channel.id, now, platform, arch, ...productTypes).all<DesktopCandidate>();

  const winner = await pickRelease(c, app.id, candidates, { deviceId, cohort, clientPlatform, clientIp });
  if (!winner) {
    return c.json({
      update_available: false,
      channel: channel.slug,
      target,
      current_version_code: currentVersionCode,
      latest_version_code: null,
    });
  }
  if (winner.version_code <= currentVersionCode) {
    if (winner.version_code === currentVersionCode) bumpReleaseMetric(c, winner.id, "current", deviceId);
    return c.json({
      update_available: false,
      channel: channel.slug,
      target,
      current_version_code: currentVersionCode,
      latest_version_code: winner.version_code,
    });
  }

  const { results: assets } = await c.env.DB.prepare(
    `SELECT artifact_kind, filetype, r2_key, file_hash, size_bytes
       FROM build_assets
      WHERE build_id = ?1 AND platform = ?2 AND arch = ?3
        AND artifact_kind IN ('desktop-manifest', 'desktop-archive', 'installable')
        AND json_extract(metadata_json, '$.upload_state') = 'ready'
      ORDER BY created_at ASC, id ASC`,
  ).bind(winner.build_id, platform, arch).all<DesktopAssetRow>();
  const manifest = assets.find((a) => a.artifact_kind === DESKTOP_MANIFEST_KIND);
  if (!manifest) {
    // The candidate query required one; a concurrent delete is the only way here.
    return c.json({ error: "matched release has no desktop manifest for this target", code: "manifest_missing" }, 409);
  }
  const archive = assets.find((a) => a.artifact_kind === DESKTOP_ARCHIVE_KIND) ?? null;
  const wantedInstaller = c.req.query("installer_filetype");
  const installers = assets.filter((a) => a.artifact_kind === "installable");
  const installer = (wantedInstaller ? installers.find((a) => a.filetype === wantedInstaller) : installers[0]) ?? null;

  const ttl = Number(c.env.SIGNED_URL_TTL_SECONDS ?? "3600");
  const origin = requestOrigin(c);
  const signed = async (asset: DesktopAssetRow) => ({
    url: await generateSignedR2Url(c.env, asset.r2_key, ttl, origin),
    sha256: asset.file_hash,
    size: Number(asset.size_bytes),
  });
  bumpReleaseMetric(c, winner.id, "offered", deviceId);
  return c.json({
    update_available: true,
    channel: channel.slug,
    target,
    current_version_code: currentVersionCode,
    release: {
      id: winner.id,
      version: winner.version_name,
      version_code: winner.version_code,
      notes_url: `${origin}/apps/${encodeURIComponent(app.slug)}/v/${encodeURIComponent(winner.version_name)}`,
      force_update: Boolean(winner.force_update),
      released_at: winner.released_at,
    },
    manifest: await signed(manifest),
    full_archive: archive ? await signed(archive) : null,
    installer: installer ? { ...await signed(installer), filetype: installer.filetype } : null,
    files_url_template: `${origin}/public/v2/apps/${encodeURIComponent(app.slug)}/files/{sha256}`,
    expires_in: ttl,
  });
}

/**
 * The same choice /latest makes among eligible releases: the most specific matching
 * scope wins, then the latest activation, then the release id. A staged release is
 * eligible for a device only inside its rollout percentage, except through a
 * device-group scope, which is a mandatory override.
 */
async function pickRelease(
  c: PublicContext,
  appId: string,
  candidates: DesktopCandidate[],
  client: { deviceId: string | null; cohort: string | null; clientPlatform: string | null; clientIp: string | null },
): Promise<DesktopCandidate | null> {
  if (candidates.length === 0) return null;
  const ids = candidates.map((candidate) => candidate.id);
  const { results: scopes } = await c.env.DB.prepare(
    `SELECT release_id, scope_type, scope_value FROM release_scopes
      WHERE release_id IN (SELECT value FROM json_each(?1))`,
  ).bind(JSON.stringify(ids)).all<{ release_id: string; scope_type: string; scope_value: string }>();
  const groups = new Set<string>();
  if (client.deviceId) {
    const { results } = await c.env.DB.prepare(
      `SELECT m.group_id FROM device_group_members m
         JOIN device_groups g ON g.id = m.group_id
        WHERE g.app_id = ?1 AND m.device_id = ?2`,
    ).bind(appId, client.deviceId).all<{ group_id: string }>();
    for (const row of results) groups.add(row.group_id);
  }
  let best: { candidate: DesktopCandidate; priority: number } | null = null;
  for (const candidate of candidates) {
    const inRollout = rolloutIncludes(candidate.id, candidate.rollout_cohort_count, client.deviceId);
    for (const scope of scopes) {
      if (scope.release_id !== candidate.id) continue;
      if (!matchesScope(scope.scope_type, scope.scope_value, client.cohort, client.clientPlatform, client.clientIp, groups)) continue;
      if (scope.scope_type !== "device_group" && !inRollout) continue;
      const priority = SCOPE_PRIORITY[scope.scope_type as keyof typeof SCOPE_PRIORITY] ?? 0;
      if (
        !best
        || priority > best.priority
        || (priority === best.priority && (
          candidate.activated_at > best.candidate.activated_at
          || (candidate.activated_at === best.candidate.activated_at && candidate.id < best.candidate.id)
        ))
      ) {
        best = { candidate, priority };
      }
    }
  }
  return best?.candidate ?? null;
}

export async function handlePublicDesktopFile(c: PublicContext) {
  const slug = c.req.param("slug") ?? "";
  const sha256 = (c.req.param("sha256") ?? "").toLowerCase();
  if (!isSha256(sha256)) return c.json({ error: "file not found", code: "file_not_found" }, 404);
  const row = await c.env.DB.prepare(
    `SELECT a.id AS app_id, f.size_bytes
       FROM apps a
       JOIN desktop_files f ON f.app_id = a.id AND f.sha256 = ?2
      WHERE a.slug = ?1
        AND EXISTS (
          SELECT 1
            FROM desktop_manifest_files m
            JOIN build_assets ba ON ba.id = m.build_asset_id
            JOIN releases r ON r.build_id = ba.build_id
           WHERE m.app_id = a.id AND m.sha256 = f.sha256
             AND r.app_id = a.id
             AND r.status IN ('active', 'superseded') AND r.hidden = 0
        )
      LIMIT 1`,
  ).bind(slug, sha256).first<{ app_id: string; size_bytes: number }>();
  if (!row) return c.json({ error: "file not found", code: "file_not_found" }, 404);
  const key = desktopFileKey(row.app_id, sha256);
  const ttl = Number(c.env.SIGNED_URL_TTL_SECONDS ?? "3600");
  // Straight to R2 when presigning is configured (one hop per file matters when an
  // update fetches thousands of them); otherwise through the HMAC-signed Worker route.
  const direct = await presignR2DownloadUrl(c.env, {
    key,
    filetype: "bin",
    contentDisposition: `attachment; filename="${sha256}"`,
  }, Number(c.env.R2_PRESIGNED_DOWNLOAD_TTL_SECONDS ?? ttl));
  const url = direct ?? await generateSignedR2Url(c.env, key, ttl, requestOrigin(c));
  c.header("Cache-Control", "private, max-age=0, no-store");
  c.header("X-Hands-File-Size", String(row.size_bytes));
  return c.redirect(url, 302);
}
