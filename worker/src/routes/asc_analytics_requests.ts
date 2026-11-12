/**
 * Start App Store Connect Analytics Reports for an app.
 *
 * Apple only produces analytics reports (installs, deletions, sessions, active
 * devices) after an analyticsReportRequest exists for the app, and the request
 * can only be created through the API. This route creates the two kinds Hands
 * reads: ONGOING (daily from now on) and ONE_TIME_SNAPSHOT (history). It never
 * duplicates a request that is already active, and touches nothing else on the
 * App Store Connect side.
 *
 * `handleIngestAscAnalytics` runs one bounded, read-only ingest of the
 * resulting reports on demand (the cron does the same on its own schedule).
 */
import type { Context } from "hono";
import type { AdminEnv } from "../middleware/auth";
import { getAscCredentials } from "../lib/asc_credentials";
import { AscApiError, ascRequest } from "../lib/asc_api";
import { insertAuditLog } from "../lib/permissions";
import { ASC_ANALYTICS_NOTE, SCHEDULED_BUDGET, ingestAscAnalyticsForApp, type IngestBudget } from "../lib/asc_analytics_ingest";

type AdminContext = Context<AdminEnv & { Bindings: Env }>;

export const ANALYTICS_ACCESS_TYPES = ["ONGOING", "ONE_TIME_SNAPSHOT"] as const;
type AccessType = (typeof ANALYTICS_ACCESS_TYPES)[number];

/** A manual run may do a little more than one cron tick, still bounded. */
const MANUAL_BUDGET: IngestBudget = { ...SCHEDULED_BUDGET, maxInstances: 10 };

type RequestRow = { id: string; access_type: string | null; stopped_due_to_inactivity: boolean };

export async function handleEnableAscAnalyticsReports(c: AdminContext) {
  const appId = c.req.param("appId") ?? "";
  if (!c.env.ASC_CRED_ENC_KEY) {
    return c.json({ error: "App Store Connect credentials are not available on this server", code: "ASC_NOT_CONFIGURED" }, 503);
  }
  const creds = await getAscCredentials(c.env.DB, c.env.ASC_CRED_ENC_KEY, appId).catch(() => null);
  if (!creds) {
    return c.json({ error: "this app has no App Store Connect API key", code: "ASC_NOT_CONFIGURED" }, 409);
  }
  const channel = await c.env.DB.prepare("SELECT bundle_id FROM channels WHERE app_id = ?1 AND slug = 'main' LIMIT 1")
    .bind(appId)
    .first<{ bundle_id: string | null }>();
  const bundleId = channel?.bundle_id?.trim();
  // A write must target exactly this app's bundle; never fall back to "first app on the key".
  if (!bundleId) {
    return c.json({
      error: "the main channel has no App Store bundle id",
      code: "BUNDLE_ID_NOT_CONFIGURED",
      next_action: `set it with: hands channels update ${appId} main --bundle-id <bundle id>`,
    }, 409);
  }

  const results: Array<{ access_type: AccessType; id: string; created: boolean }> = [];
  try {
    // Compare the bundle id exactly: this is a write, so a loose filter match must
    // never select another app on the same team key.
    const apps = await ascRequest<{ data?: Array<{ id: string; attributes?: { bundleId?: string } }> }>(creds, "GET",
      `/v1/apps?filter[bundleId]=${encodeURIComponent(bundleId)}&fields[apps]=bundleId&limit=50`);
    const ascAppId = (apps.data ?? []).find((a) => a.attributes?.bundleId === bundleId)?.id ?? null;
    if (!ascAppId) {
      return c.json({ error: `no App Store Connect app has bundle id ${bundleId}`, code: "ASC_APP_NOT_FOUND" }, 404);
    }
    const listed = await ascRequest<{
      data?: Array<{ id: string; attributes?: { accessType?: string; stoppedDueToInactivity?: boolean } }>;
    }>(creds, "GET", `/v1/apps/${encodeURIComponent(ascAppId)}/analyticsReportRequests?limit=200`);
    const existing: RequestRow[] = (listed.data ?? []).map((r) => ({
      id: r.id,
      access_type: r.attributes?.accessType ?? null,
      stopped_due_to_inactivity: Boolean(r.attributes?.stoppedDueToInactivity),
    }));

    // Audit each creation as it happens, so a later failure cannot hide an earlier write.
    const audit = (id: string, accessType: AccessType) => insertAuditLog(c.env.DB, c, {
      app_id: appId,
      action: "asc.analytics_report_requests.create",
      payload: { asc_app_id: ascAppId, id, access_type: accessType },
    });
    for (const accessType of ANALYTICS_ACCESS_TYPES) {
      // A snapshot is one-off and stays useful once made; an ONGOING request Apple
      // stopped for inactivity no longer produces reports, so it is replaced.
      const active = existing.find((r) => r.access_type === accessType
        && (accessType === "ONE_TIME_SNAPSHOT" || !r.stopped_due_to_inactivity));
      if (active) {
        results.push({ access_type: accessType, id: active.id, created: false });
        continue;
      }
      const created = await ascRequest<{ data: { id: string } }>(creds, "POST", "/v1/analyticsReportRequests", {
        data: {
          type: "analyticsReportRequests",
          attributes: { accessType },
          relationships: { app: { data: { type: "apps", id: ascAppId } } },
        },
      });
      results.push({ access_type: accessType, id: created.data.id, created: true });
      await audit(created.data.id, accessType);
    }
    return c.json({ asc_app_id: ascAppId, bundle_id: bundleId, requests: results });
  } catch (err) {
    if (err instanceof AscApiError) {
      return c.json({
        error: "App Store Connect rejected the request",
        requests: results,
        code: "ASC_API_REJECTED",
        provider_status: err.status,
        provider_code: err.code,
        detail: err.detail,
      }, 502);
    }
    throw err;
  }
}

/** Manual, bounded run of the same ingest the cron performs, for one app. */
export async function handleIngestAscAnalytics(c: AdminContext) {
  const appId = c.req.param("appId") ?? "";
  if (!c.env.ASC_CRED_ENC_KEY) {
    return c.json({ error: "App Store Connect credentials are not available on this server", code: "ASC_NOT_CONFIGURED" }, 503);
  }
  try {
    const summary = await ingestAscAnalyticsForApp(c.env, appId, MANUAL_BUDGET);
    if (summary.status === "not_configured") {
      return c.json({ error: "this app has no App Store Connect API key", code: "ASC_NOT_CONFIGURED" }, 409);
    }
    if (summary.status === "bundle_id_missing") {
      return c.json({ error: "the main channel has no App Store bundle id", code: "BUNDLE_ID_NOT_CONFIGURED" }, 409);
    }
    if (summary.status === "asc_app_not_found") {
      return c.json({ error: "no App Store Connect app has the main channel bundle id", code: "ASC_APP_NOT_FOUND" }, 404);
    }
    await insertAuditLog(c.env.DB, c, {
      app_id: appId,
      action: "asc.analytics_reports.ingest",
      payload: { instances_processed: summary.instances_processed, failed: summary.instances_failed.length },
    });
    return c.json({ ...summary, note: ASC_ANALYTICS_NOTE });
  } catch (err) {
    if (err instanceof AscApiError) {
      return c.json({
        error: "App Store Connect rejected the request",
        code: "ASC_API_REJECTED",
        provider_status: err.status,
        provider_code: err.code,
      }, 502);
    }
    throw err;
  }
}
