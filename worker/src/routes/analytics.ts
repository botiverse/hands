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
    c.req.header("X-Quiver-Client-Key") ?? c.req.query("client_key") ?? "";
  if (!app.client_key || presented !== app.client_key) {
    return c.json({ error: "invalid or missing client key" }, 401);
  }

  const deviceId =
    c.req.header("X-Quiver-Device-Id") ?? c.req.query("device_id") ?? "";
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

function windowStart(c: AdminContext): number {
  const raw = c.req.query("window_days");
  let days = raw ? Number(raw) : WINDOW_DEFAULT_DAYS;
  if (!Number.isFinite(days) || days <= 0) days = WINDOW_DEFAULT_DAYS;
  days = Math.min(days, WINDOW_MAX_DAYS);
  return Date.now() - days * 24 * 60 * 60 * 1000;
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
  const since = windowStart(c);

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
