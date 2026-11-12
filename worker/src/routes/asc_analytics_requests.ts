/**
 * Start App Store Connect Analytics Reports for an app.
 *
 * Apple only produces analytics reports (installs, deletions, sessions, active
 * devices) after an analyticsReportRequest exists for the app, and the request
 * can only be created through the API. This route creates the two kinds Hands
 * reads: ONGOING (daily from now on) and ONE_TIME_SNAPSHOT (history). It never
 * duplicates a request that is already active, and touches nothing else on the
 * App Store Connect side.
 */
import type { Context } from "hono";
import type { AdminEnv } from "../middleware/auth";
import { getAscCredentials } from "../lib/asc_credentials";
import { AscApiError, ascRequest, resolveAscAppId } from "../lib/asc_api";
import { insertAuditLog } from "../lib/permissions";

type AdminContext = Context<AdminEnv & { Bindings: Env }>;

export const ANALYTICS_ACCESS_TYPES = ["ONGOING", "ONE_TIME_SNAPSHOT"] as const;
type AccessType = (typeof ANALYTICS_ACCESS_TYPES)[number];

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

  try {
    const ascAppId = await resolveAscAppId(creds, bundleId);
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

    const results: Array<{ access_type: AccessType; id: string; created: boolean }> = [];
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
    }

    if (results.some((r) => r.created)) {
      await insertAuditLog(c.env.DB, c, {
        app_id: appId,
        action: "asc.analytics_report_requests.create",
        payload: { asc_app_id: ascAppId, created: results.filter((r) => r.created).map((r) => ({ id: r.id, access_type: r.access_type })) },
      });
    }
    return c.json({ asc_app_id: ascAppId, bundle_id: bundleId, requests: results });
  } catch (err) {
    if (err instanceof AscApiError) {
      return c.json({
        error: "App Store Connect rejected the request",
        code: "ASC_API_REJECTED",
        provider_status: err.status,
        provider_code: err.code,
        detail: err.detail,
      }, 502);
    }
    throw err;
  }
}
