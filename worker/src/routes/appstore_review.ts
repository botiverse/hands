/**
 * App Store review status (read-only).
 *
 * GET /api/apps/:appId/appstore-review
 *   Surfaces the App Store review state of this iOS app's recent versions and
 *   the TestFlight beta-review state of its recent builds, straight from App
 *   Store Connect. Read-only — it never touches the release/publish flow.
 *
 *   Reuses the TestFlight ASC integration end-to-end: same encrypted
 *   credentials, same bundle-id → ASC app resolution. iOS-only; other
 *   platforms get { applicable: false } so the admin can skip the panel.
 *
 *   Apple hiccups never 500 this endpoint — they come back as
 *   { configured: true, error } with a 200 so the panel can show the message.
 */
import type { Context } from "hono";
import type { AdminEnv } from "../middleware/auth";
import { getAscCredentials } from "../lib/asc_credentials";
import {
  AscApiError,
  getAppStoreVersions,
  getBetaReviewStates,
  resolveAscAppId,
} from "../lib/asc_api";

type AdminContext = Context<AdminEnv & { Bindings: Env }>;

export async function handleAppStoreReview(c: AdminContext) {
  const appId = c.req.param("appId") ?? "";
  const encKey = c.env.ASC_CRED_ENC_KEY;
  if (!encKey) return c.json({ error: "server is missing ASC_CRED_ENC_KEY" }, 500);

  const app = await c.env.DB.prepare(
    "SELECT platform FROM apps WHERE id = ?1",
  )
    .bind(appId)
    .first<{ platform: string }>();
  if (!app) return c.json({ error: "app not found" }, 404);

  // The App Store review panel only applies to iOS apps.
  if (app.platform !== "ios") {
    return c.json({ platform: app.platform, applicable: false });
  }

  const creds = await getAscCredentials(c.env.DB, encKey, appId);
  if (!creds) return c.json({ configured: false });

  // Use the production ("main") channel's bundle id — the App Store record is the
  // production app. We deliberately do NOT fall back to preview/nightly channels:
  // those carry beta bundle ids (e.g. foo.preview) that are not real App Store
  // records, and silently guessing one is misleading. If main has no bundle id,
  // report that it needs configuring rather than inventing one.
  const bundleRow = await c.env.DB.prepare(
    `SELECT bundle_id FROM channels WHERE app_id = ?1 AND slug = 'main' LIMIT 1`,
  )
    .bind(appId)
    .first<{ bundle_id: string | null }>();
  const bundleId = (bundleRow?.bundle_id ?? "").trim() || null;
  if (!bundleId) {
    return c.json({
      configured: true,
      applicable: true,
      bundle_id: null,
      needs_bundle_id: true,
      error: "No App Store bundle id is set on the main channel.",
    });
  }

  try {
    const ascAppId = await resolveAscAppId(creds, bundleId);
    if (!ascAppId) {
      return c.json({
        configured: true,
        bundle_id: bundleId,
        error: `no App Store Connect app record for bundle id ${bundleId}`,
      });
    }
    // Fetch the two review surfaces independently: a failure on one (e.g. an ASC
    // parameter rejection on builds) still shows the other. Surface the ASC error
    // detail, which names the offending parameter, not just the generic title.
    const [versionsR, buildsR] = await Promise.allSettled([
      getAppStoreVersions(creds, ascAppId),
      getBetaReviewStates(creds, ascAppId),
    ]);
    return c.json({
      configured: true,
      applicable: true,
      bundle_id: bundleId,
      asc_app_id: ascAppId,
      app_store_versions: versionsR.status === "fulfilled" ? versionsR.value : [],
      testflight_builds: buildsR.status === "fulfilled" ? buildsR.value : [],
      app_store_versions_error:
        versionsR.status === "rejected" ? ascErrorText(versionsR.reason) : null,
      testflight_builds_error:
        buildsR.status === "rejected" ? ascErrorText(buildsR.reason) : null,
    });
  } catch (e) {
    return c.json({
      configured: true,
      bundle_id: bundleId,
      error: ascErrorText(e),
    });
  }
}

function ascErrorText(e: unknown): string {
  if (e instanceof AscApiError) {
    return e.detail ? `${e.message} — ${e.detail}` : e.message;
  }
  return e instanceof Error ? e.message : String(e);
}
