/**
 * /public/* routes — client-facing endpoints (no auth required).
 *
 * Designed for Slock Android clients that need to look up the latest APK by
 * app slug (human-readable) instead of internal app UUID. Returns signed R2
 * URLs so clients can `DownloadManager.download()` directly.
 *
 * Example:
 *   GET /public/apps/myapp-android/versions?channel=production
 *   → { version: { version_name: "1.2.3", version_code: 42, ... }, download_url: "..." }
 */

import type { Context } from "hono";

export async function handlePublicGetLatestVersion(
  c: Context<{ Bindings: Env }>,
) {
  const slug = c.req.param("slug");
  const channel = c.req.query("channel") ?? "production";

  if (!slug) {
    return c.json({ error: "slug required" }, 400);
  }

  // Look up the app by slug, then the latest version for the channel
  // (filtered to enabled=1), then generate a signed R2 URL for download.
  const app = await c.env.DB.prepare(
    "SELECT id, slug, platform FROM apps WHERE slug = ?",
  )
    .bind(slug)
    .first<{ id: string; slug: string; platform: string }>();

  if (!app) {
    return c.json({ error: `app '${slug}' not found` }, 404);
  }

  const version = await c.env.DB.prepare(
    `SELECT id, version_name, version_code, package_name,
            signature_sha256, min_sdk, target_sdk, size_bytes, file_hash,
            enabled, created_at
     FROM versions
     WHERE app_id = ?1 AND channel = ?2 AND enabled = 1
     ORDER BY version_code DESC, created_at DESC
     LIMIT 1`,
  )
    .bind(app.id, channel)
    .first<{
      id: string;
      version_name: string;
      version_code: number;
      package_name: string;
      signature_sha256: string;
      min_sdk: number | null;
      target_sdk: number | null;
      size_bytes: number;
      file_hash: string;
      enabled: number;
      created_at: number;
    }>();

  if (!version) {
    return c.json(
      { error: `no enabled version for channel '${channel}'` },
      404,
    );
  }

  const ttl = Number(c.env.SIGNED_URL_TTL_SECONDS ?? "3600");
  const r2Key = `apps/${app.id}/versions/${version.id}/binary.apk`;
  const downloadUrl = await generateSignedR2Url(c.env, r2Key, ttl);

  return c.json({
    app: { slug: app.slug, platform: app.platform },
    version,
    download_url: downloadUrl,
    expires_in: ttl,
  });
}

export async function handlePublicListChannels(
  c: Context<{ Bindings: Env }>,
) {
  const slug = c.req.param("slug");
  if (!slug) return c.json({ error: "slug required" }, 400);

  const app = await c.env.DB.prepare(
    "SELECT id, slug FROM apps WHERE slug = ?",
  )
    .bind(slug)
    .first<{ id: string; slug: string }>();

  if (!app) return c.json({ error: `app '${slug}' not found` }, 404);

  const { results } = await c.env.DB.prepare(
    `SELECT slug, name FROM channels WHERE app_id = ?1 ORDER BY slug`,
  )
    .bind(app.id)
    .all();

  return c.json({ app: app.slug, channels: results });
}

async function generateSignedR2Url(
  env: Env,
  key: string,
  ttlSeconds: number,
): Promise<string> {
  // TODO: replace with real R2 signed URL (S3 presigner w/ R2 access keys).
  // For now we return a Worker-proxied URL that does the same thing internally.
  return `/api/r2/${encodeURIComponent(key)}?expires=${Math.floor(Date.now() / 1000) + ttlSeconds}`;
}