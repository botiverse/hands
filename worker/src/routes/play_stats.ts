/**
 * Google Play statistics reports: the per-app bucket setting and a manual,
 * bounded run of the same read-only ingest the cron performs.
 *
 *   GET  /api/apps/:appId/google-play/stats-bucket
 *   PUT  /api/apps/:appId/google-play/stats-bucket   {"stats_bucket": "pubsite_prod_rev_123" | null}
 *   POST /api/apps/:appId/stats/google-play/ingest
 */
import type { Context } from "hono";
import { currentActor, type AdminEnv } from "../middleware/auth";
import { insertAuditLog } from "../lib/permissions";
import {
  PLAY_STATS_MANUAL_BUDGET,
  PLAY_STATS_NOTE,
  PlayStatsError,
  getPlayStatsBucket,
  ingestGooglePlayStatsForApp,
  normalizePlayStatsBucket,
  playStatsBucketHint,
  setPlayStatsBucket,
} from "../lib/play_stats_ingest";
import { requireAndroidApp } from "./google_play_bindings";

type AdminContext = Context<AdminEnv & { Bindings: Env }>;

export async function handleGetPlayStatsBucket(c: AdminContext) {
  const invalid = await requireAndroidApp(c);
  if (invalid) return invalid;
  return c.json({ stats_bucket: await getPlayStatsBucket(c.env.DB, c.req.param("appId") ?? "") });
}

export async function handlePutPlayStatsBucket(c: AdminContext) {
  const invalid = await requireAndroidApp(c);
  if (invalid) return invalid;
  const appId = c.req.param("appId") ?? "";
  let body: { stats_bucket?: unknown };
  try { body = await c.req.json(); } catch { return c.json({ code: "INVALID_STATS_BUCKET", error: "valid JSON body required" }, 400); }
  if (!body || typeof body !== "object" || Array.isArray(body) || !("stats_bucket" in body)) {
    return c.json({ code: "INVALID_STATS_BUCKET", error: "stats_bucket is required (string or null)" }, 400);
  }
  let bucket: string | null;
  try {
    bucket = normalizePlayStatsBucket(body.stats_bucket);
  } catch (err) {
    return c.json({ code: "INVALID_STATS_BUCKET", error: err instanceof Error ? err.message : "invalid stats_bucket" }, 400);
  }
  const previous = await getPlayStatsBucket(c.env.DB, appId);
  await setPlayStatsBucket(c.env.DB, appId, bucket, currentActor(c));
  await insertAuditLog(c.env.DB, c, {
    app_id: appId,
    action: "google_play.stats_bucket.update",
    payload: { previous, stats_bucket: bucket },
  });
  return c.json({ stats_bucket: bucket });
}

const STATUS_RESPONSES = {
  service_unavailable: [503, "PLAY_STATS_SERVICE_UNAVAILABLE", "The Google Play adapter on this server cannot read statistics reports yet"],
  not_configured: [409, "PLAY_BINDING_NOT_READY", "Google Play is not connected, verified and enabled for this app"],
  bucket_not_configured: [409, "PLAY_STATS_BUCKET_NOT_CONFIGURED", "Set the Play reports bucket first: PUT /api/apps/:appId/google-play/stats-bucket"],
} as const;

/** Manual, bounded run of the same ingest the cron performs, for one app. */
export async function handleIngestPlayStats(c: AdminContext) {
  const invalid = await requireAndroidApp(c);
  if (invalid) return invalid;
  const appId = c.req.param("appId") ?? "";
  try {
    const summary = await ingestGooglePlayStatsForApp(c.env, appId, PLAY_STATS_MANUAL_BUDGET);
    if (summary.status !== "ok") {
      const [status, code, error] = STATUS_RESPONSES[summary.status];
      return c.json({ error, code }, status);
    }
    await insertAuditLog(c.env.DB, c, {
      app_id: appId,
      action: "google_play.stats.ingest",
      payload: { files_processed: summary.files_processed, failed: summary.files_failed.length, incomplete: summary.files_incomplete.length },
    });
    return c.json({ ...summary, note: PLAY_STATS_NOTE });
  } catch (err) {
    if (err instanceof PlayStatsError) {
      const bucket = await getPlayStatsBucket(c.env.DB, appId).catch(() => null);
      return c.json({
        error: "Google Play statistics reports could not be listed",
        code: "PLAY_STATS_LIST_FAILED",
        provider_code: err.code,
        hint: playStatsBucketHint(bucket, err.code),
      }, 502);
    }
    throw err;
  }
}
