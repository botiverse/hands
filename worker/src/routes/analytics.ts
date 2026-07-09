/**
 * Device telemetry (task #84): SDK-facing device registration/heartbeat and
 * admin-facing active-device / version-distribution queries.
 *
 * The public ping upserts one row per (app_id, device_id) — gated by the same
 * client key as feedback. It carries no PII: device_id is a random
 * per-install UUID.
 */
import type { Context } from "hono";
import type { AdminEnv } from "../middleware/auth";

type AdminContext = Context<AdminEnv & { Bindings: Env }>;

const WINDOW_DEFAULT_DAYS = 30;
const WINDOW_MAX_DAYS = 365;
const WINDOW_MAX_MINUTES = WINDOW_MAX_DAYS * 24 * 60;

export async function handleDeviceRegister(c: Context<{ Bindings: Env }>) {
  const slug = c.req.param("slug");
  if (!slug) return c.json({ error: "slug required" }, 400);
  const app = await c.env.DB.prepare(
    "SELECT id, client_key FROM apps WHERE slug = ?1 AND archived = 0",
  )
    .bind(slug)
    .first<{ id: string; client_key: string | null }>();
  if (!app) return c.json({ error: `app '${slug}' not found` }, 404);

  // Same DSN-model client-key gate as feedback.
  const presented =
    c.req.header("X-Hands-Client-Key") ?? c.req.header("X-Quiver-Client-Key") ?? c.req.query("client_key") ?? "";
  if (!app.client_key || presented !== app.client_key) {
    return c.json({ error: "invalid or missing client key" }, 401);
  }

  const deviceId =
    c.req.header("X-Hands-Device-Id") ?? c.req.header("X-Quiver-Device-Id") ?? c.req.query("device_id") ?? "";
  if (!deviceId || deviceId.length > 200) {
    return c.json({ error: "device id required" }, 400);
  }

  let metadata: Record<string, unknown> = {};
  try {
    const raw = await c.req.json();
    if (raw && typeof raw === "object") metadata = raw as Record<string, unknown>;
  } catch {
    // empty/invalid body is fine — headers alone can carry the ping
  }
  const str = (key: string, max = 200): string | null => {
    const v = metadata[key];
    if (v === undefined || v === null) return null;
    return String(v).slice(0, max) || null;
  };
  const versionCodeRaw = metadata["version_code"];
  const versionCode =
    typeof versionCodeRaw === "number" && Number.isFinite(versionCodeRaw)
      ? Math.trunc(versionCodeRaw)
      : Number.isFinite(Number(versionCodeRaw))
        ? Math.trunc(Number(versionCodeRaw))
        : null;

  const now = Date.now();
  // Upsert: first row sets first_seen; subsequent pings update the rest and
  // bump ping_count. Distinct numbered params for the better-sqlite3 mock.
  await c.env.DB.prepare(
    `INSERT INTO device_pings
       (app_id, device_id, version_name, version_code, channel, platform,
        arch, os_version, device_model, locale, first_seen, last_seen, ping_count)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, 1)
     ON CONFLICT(app_id, device_id) DO UPDATE SET
       version_name = excluded.version_name, version_code = excluded.version_code,
       channel = excluded.channel, platform = excluded.platform,
       arch = excluded.arch, os_version = excluded.os_version,
       device_model = excluded.device_model, locale = excluded.locale,
       last_seen = excluded.last_seen, ping_count = device_pings.ping_count + 1`,
  )
    .bind(
      app.id,
      deviceId,
      str("version_name"),
      versionCode,
      str("channel"),
      str("platform"),
      str("arch"),
      str("os_version"),
      str("device_model"),
      str("locale", 40),
      now,
      now,
    )
    .run();

  return c.json({ ok: true }, 202);
}

function windowRange(c: AdminContext): { since: number; windowDays: number; windowMinutes: number } {
  const minuteRaw = c.req.query("window_minutes");
  if (minuteRaw) {
    let minutes = Number(minuteRaw);
    if (!Number.isFinite(minutes) || minutes <= 0) minutes = WINDOW_DEFAULT_DAYS * 24 * 60;
    minutes = Math.min(Math.ceil(minutes), WINDOW_MAX_MINUTES);
    return {
      since: Date.now() - minutes * 60 * 1000,
      windowDays: Math.max(1, Math.ceil(minutes / (24 * 60))),
      windowMinutes: minutes,
    };
  }
  const raw = c.req.query("window_days");
  let days = raw ? Number(raw) : WINDOW_DEFAULT_DAYS;
  if (!Number.isFinite(days) || days <= 0) days = WINDOW_DEFAULT_DAYS;
  days = Math.min(days, WINDOW_MAX_DAYS);
  days = Math.ceil(days);
  return {
    since: Date.now() - days * 24 * 60 * 60 * 1000,
    windowDays: days,
    windowMinutes: days * 24 * 60,
  };
}

/**
 * Active-device analytics: total active devices in the window, plus version,
 * platform, and channel breakdowns. "Active" = last_seen within the window.
 */
/** One device's telemetry row (version, model, seen times, ping count). */
export async function handleDeviceDetail(c: AdminContext) {
  const appId = c.req.param("appId");
  const deviceId = c.req.param("deviceId");
  const row = await c.env.DB.prepare(
    `SELECT device_id, version_name, version_code, channel, platform, arch,
            os_version, device_model, locale, first_seen, last_seen, ping_count
     FROM device_pings WHERE app_id = ?1 AND device_id = ?2`,
  )
    .bind(appId, deviceId)
    .first();
  if (!row) return c.json({ device: null });
  return c.json({ device: row });
}

export async function handleDeviceAnalytics(c: AdminContext) {
  const appId = c.req.param("appId");
  const { since } = windowRange(c);

  const [total, byVersion, byPlatform, byChannel] = await Promise.all([
    c.env.DB.prepare(
      "SELECT COUNT(*) AS n FROM device_pings WHERE app_id = ?1 AND last_seen >= ?2",
    )
      .bind(appId, since)
      .first<{ n: number }>(),
    c.env.DB.prepare(
      `SELECT COALESCE(version_name, 'unknown') AS version_name, version_code,
              COUNT(*) AS devices
       FROM device_pings
       WHERE app_id = ?1 AND last_seen >= ?2
       GROUP BY COALESCE(version_name, 'unknown'), version_code
       ORDER BY COALESCE(version_code, 0) DESC
       LIMIT 30`,
    )
      .bind(appId, since)
      .all<{ version_name: string; version_code: number | null; devices: number }>(),
    c.env.DB.prepare(
      `SELECT COALESCE(platform, 'unknown') AS platform, COUNT(*) AS devices
       FROM device_pings
       WHERE app_id = ?1 AND last_seen >= ?2
       GROUP BY COALESCE(platform, 'unknown')
       ORDER BY devices DESC`,
    )
      .bind(appId, since)
      .all<{ platform: string; devices: number }>(),
    c.env.DB.prepare(
      `SELECT COALESCE(channel, 'unknown') AS channel, COUNT(*) AS devices
       FROM device_pings
       WHERE app_id = ?1 AND last_seen >= ?2
       GROUP BY COALESCE(channel, 'unknown')
       ORDER BY devices DESC`,
    )
      .bind(appId, since)
      .all<{ channel: string; devices: number }>(),
  ]);

  return c.json({
    active_devices: total?.n ?? 0,
    window_start: since,
    by_version: byVersion.results,
    by_platform: byPlatform.results,
    by_channel: byChannel.results,
  });
}

/**
 * Version/release metrics for agents and admins.
 *
 * Sources:
 * - device_pings: active/current installs by version in the selected window
 * - release_metrics: update-check counters recorded when releases are offered
 * - feedback_tickets: feedback/crash volume by version
 * - build_assets: artifact download counters for release builds
 *
 * Release-backed rows are returned first. A trailing set of telemetry-only rows
 * covers versions seen from device pings before/without a matching release row.
 */
export async function handleVersionAnalytics(c: AdminContext) {
  const appId = c.req.param("appId");
  const { since, windowDays, windowMinutes } = windowRange(c);

  const { results } = await c.env.DB.prepare(
    `WITH
       active_devices AS (
         SELECT version_code, COALESCE(channel, 'unknown') AS channel, COUNT(*) AS active_devices
         FROM device_pings
         WHERE app_id = ? AND last_seen >= ?
         GROUP BY version_code, COALESCE(channel, 'unknown')
       ),
       total_devices AS (
         SELECT version_code, COALESCE(channel, 'unknown') AS channel, COUNT(*) AS total_devices
         FROM device_pings
         WHERE app_id = ?
         GROUP BY version_code, COALESCE(channel, 'unknown')
       ),
       feedback AS (
         SELECT version_code, COALESCE(channel, 'unknown') AS channel,
                COUNT(*) AS feedback_count,
                SUM(CASE WHEN kind = 'crash' THEN 1 ELSE 0 END) AS crash_count
         FROM feedback_tickets
         WHERE app_id = ?
         GROUP BY version_code, COALESCE(channel, 'unknown')
       ),
       downloads AS (
         SELECT build_id, SUM(download_count) AS download_count
         FROM build_assets
         GROUP BY build_id
       ),
       release_rows AS (
         SELECT
           r.id AS release_id,
           b.id AS build_id,
           COALESCE(c.slug, 'unknown') AS channel,
           r.product_type,
           r.release_type,
           r.status AS release_status,
           r.rollout_cohort_count,
           b.version_name,
           b.version_code,
           r.created_at AS released_at,
           r.updated_at AS release_updated_at,
           COALESCE(ad.active_devices, 0) AS active_devices,
           COALESCE(td.total_devices, 0) AS total_devices,
           COALESCE(rm.current_count, 0) AS update_current_count,
           COALESCE(rm.offered_count, 0) AS update_offered_count,
           rm.last_checked_at,
           COALESCE(f.feedback_count, 0) AS feedback_count,
           COALESCE(f.crash_count, 0) AS crash_count,
           COALESCE(d.download_count, 0) AS download_count,
           0 AS telemetry_only
         FROM releases r
         JOIN builds b ON b.id = r.build_id
         LEFT JOIN channels c ON c.id = r.channel_id
         LEFT JOIN release_metrics rm ON rm.release_id = r.id
         LEFT JOIN active_devices ad
           ON ad.version_code = b.version_code
          AND ad.channel = COALESCE(c.slug, 'unknown')
         LEFT JOIN total_devices td
           ON td.version_code = b.version_code
          AND td.channel = COALESCE(c.slug, 'unknown')
         LEFT JOIN feedback f
           ON f.version_code = b.version_code
          AND f.channel = COALESCE(c.slug, 'unknown')
         LEFT JOIN downloads d ON d.build_id = b.id
         WHERE r.app_id = ?
       ),
       telemetry_only_rows AS (
         SELECT
           NULL AS release_id,
           NULL AS build_id,
           COALESCE(dp.channel, 'unknown') AS channel,
           NULL AS product_type,
           NULL AS release_type,
           NULL AS release_status,
           NULL AS rollout_cohort_count,
           COALESCE(dp.version_name, 'unknown') AS version_name,
           dp.version_code,
           NULL AS released_at,
           MAX(dp.last_seen) AS release_updated_at,
           COUNT(CASE WHEN dp.last_seen >= ? THEN 1 END) AS active_devices,
           COUNT(*) AS total_devices,
           0 AS update_current_count,
           0 AS update_offered_count,
           NULL AS last_checked_at,
           COALESCE(MAX(f.feedback_count), 0) AS feedback_count,
           COALESCE(MAX(f.crash_count), 0) AS crash_count,
           0 AS download_count,
           1 AS telemetry_only
         FROM device_pings dp
         LEFT JOIN feedback f
           ON f.version_code = dp.version_code
          AND f.channel = COALESCE(dp.channel, 'unknown')
         WHERE dp.app_id = ?
           AND NOT EXISTS (
             SELECT 1
             FROM releases r
             JOIN builds b ON b.id = r.build_id
             LEFT JOIN channels c ON c.id = r.channel_id
             WHERE r.app_id = ?
               AND b.version_code = dp.version_code
               AND COALESCE(c.slug, 'unknown') = COALESCE(dp.channel, 'unknown')
           )
         GROUP BY COALESCE(dp.channel, 'unknown'), dp.version_code, COALESCE(dp.version_name, 'unknown')
       )
     SELECT *
     FROM (
       SELECT * FROM release_rows
       UNION ALL
       SELECT * FROM telemetry_only_rows
     )
     ORDER BY COALESCE(version_code, 0) DESC, telemetry_only ASC, COALESCE(released_at, release_updated_at, 0) DESC
     LIMIT 200`,
  )
    .bind(appId, since, appId, appId, appId, since, appId, appId)
    .all<{
      release_id: string | null;
      build_id: string | null;
      channel: string;
      product_type: string | null;
      release_type: string | null;
      release_status: string | null;
      rollout_cohort_count: number | null;
      version_name: string;
      version_code: number | null;
      released_at: number | null;
      release_updated_at: number | null;
      active_devices: number;
      total_devices: number;
      update_current_count: number;
      update_offered_count: number;
      last_checked_at: number | null;
      feedback_count: number;
      crash_count: number;
      download_count: number;
      telemetry_only: number;
    }>();

  return c.json({
    window_start: since,
    window_days: windowDays,
    window_minutes: windowMinutes,
    versions: results.map((row) => ({
      ...row,
      telemetry_only: Boolean(row.telemetry_only),
    })),
  });
}
