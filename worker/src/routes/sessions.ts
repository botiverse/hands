/**
 * Session events → release health (sdk-parity P0.1).
 *
 * SDKs post `start` when the app comes to the foreground and `end` when it
 * backgrounds; a crash found on next launch is reported as `end` with
 * crashed=true (or a bare `crash` marker when the end never made it out).
 * Sessions are the denominator that makes crash-free rate computable —
 * device pings alone can't provide it.
 */
import type { Context } from "hono";
import type { AdminEnv } from "../middleware/auth";

type AdminContext = Context<AdminEnv & { Bindings: Env }>;

const WINDOW_DEFAULT_DAYS = 30;
const WINDOW_MAX_DAYS = 365;

export async function handleSessionEvent(c: Context<{ Bindings: Env }>) {
  const slug = c.req.param("slug");
  if (!slug) return c.json({ error: "slug required" }, 400);
  const app = await c.env.DB.prepare(
    "SELECT id, client_key FROM apps WHERE slug = ?1 AND archived = 0",
  )
    .bind(slug)
    .first<{ id: string; client_key: string | null }>();
  if (!app) return c.json({ error: `app '${slug}' not found` }, 404);

  // Same DSN-model client-key gate as feedback/metrics.
  const presented =
    c.req.header("X-Hands-Client-Key") ?? c.req.header("X-Quiver-Client-Key") ?? "";
  if (!app.client_key || presented !== app.client_key) {
    return c.json({ error: "invalid or missing client key" }, 401);
  }

  let body: Record<string, unknown> = {};
  try {
    const raw = await c.req.json();
    if (raw && typeof raw === "object") body = raw as Record<string, unknown>;
  } catch {
    return c.json({ error: "JSON body required" }, 400);
  }

  const str = (key: string, max = 200): string | null => {
    const v = body[key];
    if (v === undefined || v === null) return null;
    return String(v).slice(0, max) || null;
  };
  const num = (key: string): number | null => {
    const v = body[key];
    const n = typeof v === "number" ? v : Number(v);
    return Number.isFinite(n) ? Math.trunc(n) : null;
  };

  const sessionId = str("session_id", 100);
  const deviceId = str("device_id", 200);
  const event = str("event", 20);
  if (!sessionId) return c.json({ error: "session_id required" }, 400);
  if (!deviceId) return c.json({ error: "device_id required" }, 400);
  if (event !== "start" && event !== "end" && event !== "crash") {
    return c.json({ error: "event must be start, end, or crash" }, 400);
  }

  const now = Date.now();
  const crashed = event === "crash" || body["crashed"] === true ? 1 : 0;

  if (event === "start") {
    await c.env.DB.prepare(
      `INSERT INTO app_sessions
         (app_id, session_id, device_id, version_name, version_code, channel,
          platform, os_version, device_model, started_at, crashed)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 0)
       ON CONFLICT(app_id, session_id) DO NOTHING`,
    )
      .bind(
        app.id,
        sessionId,
        deviceId,
        str("version_name"),
        num("version_code"),
        str("channel"),
        str("platform"),
        str("os_version"),
        str("device_model"),
        num("started_at") ?? now,
      )
      .run();
    return c.json({ ok: true }, 202);
  }

  // end / crash: update the existing row, or insert a stub when the start
  // event was lost (offline, crash before flush) so the session still counts.
  await c.env.DB.prepare(
    `INSERT INTO app_sessions
       (app_id, session_id, device_id, version_name, version_code, channel,
        platform, os_version, device_model, started_at, ended_at, duration_ms, crashed)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
     ON CONFLICT(app_id, session_id) DO UPDATE SET
       ended_at = excluded.ended_at,
       duration_ms = COALESCE(excluded.duration_ms, app_sessions.duration_ms),
       crashed = MAX(app_sessions.crashed, excluded.crashed)`,
  )
    .bind(
      app.id,
      sessionId,
      deviceId,
      str("version_name"),
      num("version_code"),
      str("channel"),
      str("platform"),
      str("os_version"),
      str("device_model"),
      num("started_at") ?? now,
      now,
      num("duration_ms"),
      crashed,
    )
    .run();
  return c.json({ ok: true }, 202);
}

/**
 * Admin release-health rollup: per version, session/device counts and
 * crash-free percentages over a window (?window_days=, default 30, max 365).
 */
export async function handleReleaseHealth(c: AdminContext) {
  const appId = c.req.param("appId") ?? "";
  const daysRaw = Number(c.req.query("window_days"));
  const windowDays =
    Number.isFinite(daysRaw) && daysRaw > 0
      ? Math.min(Math.ceil(daysRaw), WINDOW_MAX_DAYS)
      : WINDOW_DEFAULT_DAYS;
  const since = Date.now() - windowDays * 24 * 60 * 60 * 1000;

  const { results } = await c.env.DB.prepare(
    `SELECT version_code, version_name, channel,
            COUNT(*) AS sessions,
            SUM(crashed) AS crashed_sessions,
            COUNT(DISTINCT device_id) AS devices,
            COUNT(DISTINCT CASE WHEN crashed = 1 THEN device_id END) AS crashed_devices
     FROM app_sessions
     WHERE app_id = ?1 AND started_at >= ?2
     GROUP BY version_code, version_name, channel
     ORDER BY version_code DESC`,
  )
    .bind(appId, since)
    .all<{
      version_code: number | null;
      version_name: string | null;
      channel: string | null;
      sessions: number;
      crashed_sessions: number | null;
      devices: number;
      crashed_devices: number | null;
    }>();

  const versions = (results ?? []).map((r) => {
    const crashedSessions = r.crashed_sessions ?? 0;
    const crashedDevices = r.crashed_devices ?? 0;
    return {
      version_code: r.version_code,
      version_name: r.version_name,
      channel: r.channel,
      sessions: r.sessions,
      crashed_sessions: crashedSessions,
      crash_free_sessions_pct:
        r.sessions > 0 ? Math.round((1 - crashedSessions / r.sessions) * 10000) / 100 : null,
      devices: r.devices,
      crashed_devices: crashedDevices,
      crash_free_devices_pct:
        r.devices > 0 ? Math.round((1 - crashedDevices / r.devices) * 10000) / 100 : null,
    };
  });

  const totals = await c.env.DB.prepare(
    `SELECT COUNT(*) AS sessions,
            SUM(crashed) AS crashed_sessions,
            COUNT(DISTINCT device_id) AS devices,
            COUNT(DISTINCT CASE WHEN crashed = 1 THEN device_id END) AS crashed_devices
     FROM app_sessions
     WHERE app_id = ?1 AND started_at >= ?2`,
  )
    .bind(appId, since)
    .first<{
      sessions: number;
      crashed_sessions: number | null;
      devices: number;
      crashed_devices: number;
    }>();
  const totalSessions = totals?.sessions ?? 0;
  const totalCrashedSessions = totals?.crashed_sessions ?? 0;
  const totalDevices = totals?.devices ?? 0;
  const totalCrashedDevices = totals?.crashed_devices ?? 0;

  return c.json({
    window_days: windowDays,
    since,
    totals: {
      sessions: totalSessions,
      crashed_sessions: totalCrashedSessions,
      crash_free_sessions_pct:
        totalSessions > 0
          ? Math.round((1 - totalCrashedSessions / totalSessions) * 10000) / 100
          : null,
      devices: totalDevices,
      crashed_devices: totalCrashedDevices,
      crash_free_devices_pct:
        totalDevices > 0
          ? Math.round((1 - totalCrashedDevices / totalDevices) * 10000) / 100
          : null,
    },
    versions,
  });
}
