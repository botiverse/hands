/**
 * GET /api/apps/:appId/stats/electron-downloads?days=14
 *
 * Daily request counts on the public Electron update route, per file and per
 * file role (patch, full, blockmap). Update metadata is not counted. `full_requests` are requests
 * without a Range header; `range_requests` carry one (electron-updater's
 * differential download). `sources` is the number of distinct requesters
 * (per-day hash of IP and user agent). It is approximate: clients sharing an
 * address and user agent count once, and a client that changes network during
 * the day counts twice.
 */
import type { Context } from "hono";
import { utcDay } from "../lib/electron_download_stats";

const DEFAULT_DAYS = 14;
const MAX_DAYS = 90;

export async function handleElectronDownloadStats(c: Context<{ Bindings: Env }>) {
  const appId = c.req.param("appId") ?? "";
  const rawDays = c.req.query("days");
  const days = rawDays === undefined ? DEFAULT_DAYS : Number(rawDays);
  if (!Number.isInteger(days) || days < 1 || days > MAX_DAYS) {
    return c.json({ error: `days must be an integer from 1 to ${MAX_DAYS}` }, 400);
  }
  const now = Date.now();
  const to = utcDay(now);
  const from = utcDay(now - (days - 1) * 86_400_000);

  const [files, roles] = await Promise.all([
    c.env.DB.prepare(
      `SELECT d.day, d.file, d.role, b.version_name AS version,
              d.full_requests, d.range_requests,
              (SELECT COUNT(*) FROM electron_download_day_sources s
                WHERE s.asset_id = d.asset_id AND s.day = d.day) AS sources
         FROM electron_download_days d
         LEFT JOIN builds b ON b.id = d.build_id
        WHERE d.app_id = ?1 AND d.day >= ?2 AND d.day <= ?3
        ORDER BY d.day DESC, d.role ASC, d.file ASC`,
    ).bind(appId, from, to).all<{
      day: string; file: string; role: string; version: string | null;
      full_requests: number; range_requests: number; sources: number;
    }>(),
    c.env.DB.prepare(
      `SELECT d.day, d.role,
              SUM(d.full_requests) AS full_requests,
              SUM(d.range_requests) AS range_requests,
              (SELECT COUNT(DISTINCT s.source_hash)
                 FROM electron_download_day_sources s
                 JOIN electron_download_days d2 ON d2.asset_id = s.asset_id AND d2.day = s.day
                WHERE s.app_id = ?1 AND s.day = d.day AND d2.role = d.role) AS sources
         FROM electron_download_days d
        WHERE d.app_id = ?1 AND d.day >= ?2 AND d.day <= ?3
        GROUP BY d.day, d.role
        ORDER BY d.day DESC, d.role ASC`,
    ).bind(appId, from, to).all<{
      day: string; role: string; full_requests: number; range_requests: number; sources: number;
    }>(),
  ]);

  return c.json({
    from,
    to,
    by_role: roles.results ?? [],
    files: files.results ?? [],
  });
}
