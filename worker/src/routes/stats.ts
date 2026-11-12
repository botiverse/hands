/**
 * Unified app download, active-device, and store distribution statistics (`GET /api/apps/:appId/stats`).
 *
 * Aggregates:
 * 1. Hands direct-install & SDK telemetry (`device_pings`, `build_asset_download_events`,
 *    `build_assets.download_count`, `release_metrics`, `release_metric_devices`).
 * 2. Google Play distribution state & live track/release status via the app's stored
 *    Google Play binding (without exposing credentials).
 * 3. App Store Connect live versions, TestFlight builds, and Analytics Report Requests
 *    via the app's stored ASC credentials (without exposing credentials), plus the
 *    daily App Store metrics Hands ingested from Analytics Reports (D1, no live call).
 */
import type { Context } from "hono";
import type { AdminEnv } from "../middleware/auth";
import { getGooglePlayBinding, hasGooglePlayConfiguration } from "../lib/google_play_bindings";
import { getAscCredentials, getAscCredentialsMeta } from "../lib/asc_credentials";
import { ascRequest, resolveAscAppId, type AscApiCredentials } from "../lib/asc_api";
import { queryAscAnalyticsDaily } from "../lib/asc_analytics_ingest";

type AdminContext = Context<AdminEnv & { Bindings: Env }>;

const WINDOW_DEFAULT_DAYS = 30;
const WINDOW_MAX_DAYS = 365;

function parseWindowDays(raw: string | undefined): { since: number; windowDays: number } {
  let days = raw ? Number(raw) : WINDOW_DEFAULT_DAYS;
  if (!Number.isFinite(days) || days <= 0) days = WINDOW_DEFAULT_DAYS;
  days = Math.min(Math.ceil(days), WINDOW_MAX_DAYS);
  return {
    since: Date.now() - days * 24 * 60 * 60 * 1000,
    windowDays: days,
  };
}

async function queryDirectStats(
  db: D1Database,
  appId: string,
  since: number,
  channelFilter: string | null,
) {
  const dayStart7d = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const dayStart1d = Date.now() - 24 * 60 * 60 * 1000;

  const [
    deviceSummary,
    byVersion,
    byChannel,
    byPlatform,
    assetDownloads,
    publicDownloadsWindow,
    publicDownloadsAll,
    updateChecks,
  ] = await Promise.all([
    db
      .prepare(
        `SELECT
           COUNT(*) AS total_devices_all_time,
           SUM(CASE WHEN last_seen >= ?2 THEN 1 ELSE 0 END) AS active_devices_window,
           SUM(CASE WHEN last_seen >= ?3 THEN 1 ELSE 0 END) AS active_devices_7d,
           SUM(CASE WHEN last_seen >= ?4 THEN 1 ELSE 0 END) AS active_devices_24h,
           SUM(CASE WHEN first_seen >= ?2 THEN 1 ELSE 0 END) AS new_devices_window
         FROM device_pings
         WHERE app_id = ?1
           AND (?5 IS NULL OR COALESCE(channel, 'unknown') = ?5)`,
      )
      .bind(appId, since, dayStart7d, dayStart1d, channelFilter)
      .first<{
        total_devices_all_time: number | null;
        active_devices_window: number | null;
        active_devices_7d: number | null;
        active_devices_24h: number | null;
        new_devices_window: number | null;
      }>(),
    db
      .prepare(
        `SELECT
           COALESCE(version_name, 'unknown') AS version_name,
           version_code,
           COALESCE(channel, 'unknown') AS channel,
           COUNT(*) AS total_devices,
           SUM(CASE WHEN last_seen >= ?2 THEN 1 ELSE 0 END) AS active_devices
         FROM device_pings
         WHERE app_id = ?1
           AND (?3 IS NULL OR COALESCE(channel, 'unknown') = ?3)
         GROUP BY COALESCE(version_name, 'unknown'), version_code, COALESCE(channel, 'unknown')
         ORDER BY COALESCE(version_code, 0) DESC, active_devices DESC
         LIMIT 25`,
      )
      .bind(appId, since, channelFilter)
      .all<{
        version_name: string;
        version_code: number | null;
        channel: string;
        total_devices: number;
        active_devices: number;
      }>(),
    db
      .prepare(
        `SELECT
           COALESCE(channel, 'unknown') AS channel,
           COUNT(*) AS total_devices,
           SUM(CASE WHEN last_seen >= ?2 THEN 1 ELSE 0 END) AS active_devices
         FROM device_pings
         WHERE app_id = ?1
         GROUP BY COALESCE(channel, 'unknown')
         ORDER BY active_devices DESC, total_devices DESC`,
      )
      .bind(appId, since)
      .all<{ channel: string; total_devices: number; active_devices: number }>(),
    db
      .prepare(
        `SELECT
           COALESCE(platform, 'unknown') AS platform,
           COUNT(*) AS total_devices,
           SUM(CASE WHEN last_seen >= ?2 THEN 1 ELSE 0 END) AS active_devices
         FROM device_pings
         WHERE app_id = ?1
         GROUP BY COALESCE(platform, 'unknown')
         ORDER BY active_devices DESC, total_devices DESC`,
      )
      .bind(appId, since)
      .all<{ platform: string; total_devices: number; active_devices: number }>(),
    db
      .prepare(
        `SELECT
           COALESCE(SUM(ba.download_count), 0) AS admin_or_console_downloads,
           COUNT(DISTINCT b.id) AS builds_count
         FROM builds b
         LEFT JOIN build_assets ba ON ba.build_id = b.id
         WHERE b.app_id = ?1`,
      )
      .bind(appId)
      .first<{ admin_or_console_downloads: number | null; builds_count: number | null }>(),
    db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM build_asset_download_events bade
         JOIN builds b ON b.id = bade.build_id
         WHERE b.app_id = ?1 AND bade.created_at >= ?2`,
      )
      .bind(appId, since)
      .first<{ count: number | null }>()
      .catch(() => ({ count: 0 })),
    db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM build_asset_download_events bade
         JOIN builds b ON b.id = bade.build_id
         WHERE b.app_id = ?1`,
      )
      .bind(appId)
      .first<{ count: number | null }>()
      .catch(() => ({ count: 0 })),
    db
      .prepare(
        `SELECT
           COALESCE(SUM(rm.current_count), 0) AS current_count,
           COALESCE(SUM(rm.offered_count), 0) AS offered_count,
           MAX(rm.last_checked_at) AS last_checked_at
         FROM releases r
         LEFT JOIN channels c ON c.id = r.channel_id
         LEFT JOIN release_metrics rm ON rm.release_id = r.id
         WHERE r.app_id = ?1
           AND (?2 IS NULL OR COALESCE(c.slug, 'unknown') = ?2)`,
      )
      .bind(appId, channelFilter)
      .first<{
        current_count: number | null;
        offered_count: number | null;
        last_checked_at: number | null;
      }>(),
  ]);

  let updateCheckUniqueDevices = 0;
  try {
    const uvRow = await db
      .prepare(
        `SELECT COUNT(DISTINCT rmd.device_id) AS uv
         FROM release_metric_devices rmd
         JOIN releases r ON r.id = rmd.release_id
         LEFT JOIN channels c ON c.id = r.channel_id
         WHERE r.app_id = ?1
           AND (?2 IS NULL OR COALESCE(c.slug, 'unknown') = ?2)`,
      )
      .bind(appId, channelFilter)
      .first<{ uv: number | null }>();
    updateCheckUniqueDevices = Number(uvRow?.uv ?? 0);
  } catch {
    updateCheckUniqueDevices = 0;
  }

  return {
    devices: {
      active_window: Number(deviceSummary?.active_devices_window ?? 0),
      active_7d: Number(deviceSummary?.active_devices_7d ?? 0),
      active_24h: Number(deviceSummary?.active_devices_24h ?? 0),
      new_window: Number(deviceSummary?.new_devices_window ?? 0),
      total_all_time: Number(deviceSummary?.total_devices_all_time ?? 0),
    },
    downloads: {
      public_unique_window: Number(publicDownloadsWindow?.count ?? 0),
      public_unique_all_time: Number(publicDownloadsAll?.count ?? 0),
      console_asset_downloads: Number(assetDownloads?.admin_or_console_downloads ?? 0),
      update_checks_current: Number(updateChecks?.current_count ?? 0),
      update_checks_offered: Number(updateChecks?.offered_count ?? 0),
      update_checks_unique_devices: updateCheckUniqueDevices,
      last_update_check_at: updateChecks?.last_checked_at ?? null,
    },
    by_version: byVersion.results.map((r) => ({
      version_name: r.version_name,
      version_code: r.version_code,
      channel: r.channel,
      active_devices: Number(r.active_devices ?? 0),
      total_devices: Number(r.total_devices ?? 0),
    })),
    by_channel: byChannel.results.map((r) => ({
      channel: r.channel,
      active_devices: Number(r.active_devices ?? 0),
      total_devices: Number(r.total_devices ?? 0),
    })),
    by_platform: byPlatform.results.map((r) => ({
      platform: r.platform,
      active_devices: Number(r.active_devices ?? 0),
      total_devices: Number(r.total_devices ?? 0),
    })),
  };
}

async function queryGooglePlayStats(
  c: AdminContext,
  appId: string,
  appPlatform: string | null,
  includeStoreLive: boolean,
) {
  const localDistributions = await c.env.DB.prepare(
    `SELECT
       pds.release_id,
       pds.package_name,
       pds.track AS play_track,
       pds.version_code,
       pds.state AS rollout_state,
       CASE
         WHEN pds.rollout_percent IS NULL THEN NULL
         ELSE CAST(pds.rollout_percent AS REAL) / 100.0
       END AS rollout_fraction,
       pds.last_receipt_id,
       pds.updated_at,
       b.version_name
     FROM play_distribution_state pds
     LEFT JOIN releases r ON r.id = pds.release_id AND r.app_id = pds.app_id
     LEFT JOIN builds b ON b.id = r.build_id
     WHERE pds.app_id = ?1
     ORDER BY pds.version_code DESC, pds.updated_at DESC
     LIMIT 20`,
  )
    .bind(appId)
    .all<{
      release_id: string;
      package_name: string;
      play_track: string;
      version_code: number;
      rollout_state: string;
      rollout_fraction: number | null;
      last_receipt_id: string | null;
      updated_at: number;
      version_name: string | null;
    }>()
    .catch(() => ({ results: [] }));

  let binding = null;
  try {
    binding = await getGooglePlayBinding(c.env.DB, appId, c.env.PLAY_CRED_ENC_KEYS);
  } catch {
    binding = null;
  }

  const configured = Boolean(
    binding &&
      hasGooglePlayConfiguration(binding) &&
      binding.enabled === 1 &&
      binding.verification_state === "verified" &&
      binding.package_name,
  );

  if (!configured && localDistributions.results.length === 0 && appPlatform !== "android") {
    return null;
  }

  let liveTracks: Array<{
    hands_track: string;
    play_track: string;
    releases: Array<{
      release_name: string;
      version_codes: number[];
      lifecycle_state: string;
    }>;
  }> | null = null;
  let liveError: string | null = null;

  if (configured && includeStoreLive && c.env.PLAY_RELEASE_SERVICE && binding && binding.tracks && binding.package_name) {
    const tracks = binding.tracks;
    const pkgName = binding.package_name;
    liveTracks = [];
    for (const handsTrack of ["production", "closed", "internal"] as const) {
      try {
        const res = await c.env.PLAY_RELEASE_SERVICE.listReleaseStates({
          credential: binding.credential,
          packageName: pkgName,
          tracks,
          handsTrack,
        });
        if (res.ok) {
          liveTracks.push({
            hands_track: handsTrack,
            play_track: tracks[handsTrack],
            releases: res.value.map((rel) => ({
              release_name: rel.releaseName,
              version_codes: rel.activeArtifacts.map((a) => a.versionCode),
              lifecycle_state: rel.releaseLifecycleState,
            })),
          });
        } else {
          liveError = res.error.message;
        }
      } catch (err) {
        liveError = err instanceof Error ? err.message : "Failed to query Google Play track state";
      }
    }
  }

  return {
    configured,
    package_name: binding?.package_name ?? localDistributions.results[0]?.package_name ?? null,
    verification_state: binding?.verification_state ?? null,
    tracks_configured: binding?.tracks ?? null,
    promoted_releases: localDistributions.results,
    live_tracks: liveTracks,
    live_error: liveError,
    download_reports: {
      available: false,
      source: "google_play_androidpublisher_v3",
      note:
        "Google Play Android Publisher v3 API exposes track, release, bundle, and rollout states. " +
        "Aggregate store install/acquisition CSV exports live in Play Console Cloud Storage (gs://pubsite_prod_rev_*) " +
        "or Play Developer Reporting API; active installed devices across all channels (including Play installs) are tracked in `direct.devices` via Hands SDK telemetry (`device_pings`).",
    },
  };
}

async function queryAppStoreStats(
  c: AdminContext,
  appId: string,
  appPlatform: string | null,
  includeStoreLive: boolean,
  since: number,
) {
  const live = await queryAppStoreLiveStats(c, appId, appPlatform, includeStoreLive);
  if (!live) return null;
  // Ingested daily metrics come from D1, so they are shown with or without `live`.
  const analytics = await queryAscAnalyticsDaily(c.env.DB, appId, new Date(since).toISOString().slice(0, 10))
    .catch(() => null);
  return {
    ...live,
    daily: analytics?.daily ?? [],
    totals: analytics?.totals ?? null,
    analytics_ingest: analytics?.ingest ?? null,
    analytics_note: analytics?.note ?? null,
  };
}

async function queryAppStoreLiveStats(
  c: AdminContext,
  appId: string,
  appPlatform: string | null,
  includeStoreLive: boolean,
) {
  const meta = await getAscCredentialsMeta(c.env.DB, appId).catch(() => null);
  const mainChannel = await c.env.DB.prepare(
    "SELECT bundle_id FROM channels WHERE app_id = ?1 AND slug = 'main' LIMIT 1",
  )
    .bind(appId)
    .first<{ bundle_id: string | null }>()
    .catch(() => null);

  if (!meta && appPlatform !== "ios" && appPlatform !== "macos") {
    return null;
  }

  if (!meta || !c.env.ASC_CRED_ENC_KEY) {
    return {
      configured: false,
      bundle_id: mainChannel?.bundle_id ?? null,
      key_id: meta?.key_id ?? null,
      versions: null,
      builds: null,
      analytics_reports: null,
    };
  }

  if (!includeStoreLive) {
    return {
      configured: true,
      bundle_id: mainChannel?.bundle_id ?? null,
      key_id: meta.key_id,
      versions: null,
      builds: null,
      analytics_reports: null,
    };
  }

  let creds: AscApiCredentials | null = null;
  try {
    creds = await getAscCredentials(c.env.DB, c.env.ASC_CRED_ENC_KEY, appId);
  } catch {
    creds = null;
  }
  if (!creds) {
    return {
      configured: false,
      bundle_id: mainChannel?.bundle_id ?? null,
      key_id: meta.key_id,
      versions: null,
      builds: null,
      analytics_reports: null,
    };
  }

  let ascAppId: string | null = null;
  let liveError: string | null = null;
  try {
    if (mainChannel?.bundle_id) {
      ascAppId = await resolveAscAppId(creds, mainChannel.bundle_id);
    }
    if (!ascAppId) {
      const appsRes = await ascRequest<{
        data?: Array<{ id: string; attributes?: { bundleId?: string; name?: string } }>;
      }>(creds, "GET", "/v1/apps?limit=10");
      const first = appsRes.data?.[0];
      if (first) ascAppId = first.id;
    }
  } catch (err) {
    liveError = err instanceof Error ? err.message : String(err);
  }

  if (!ascAppId) {
    return {
      configured: true,
      bundle_id: mainChannel?.bundle_id ?? null,
      key_id: meta.key_id,
      asc_app_id: null,
      versions: null,
      builds: null,
      analytics_reports: null,
      live_error: liveError ?? "Could not resolve App Store Connect app ID",
    };
  }

  const [versionsRes, buildsRes, analyticsReqRes] = await Promise.all([
    ascRequest<{
      data?: Array<{
        id: string;
        attributes?: {
          versionString?: string;
          platform?: string;
          appVersionState?: string;
          appStoreState?: string;
          releaseType?: string;
          createdDate?: string;
        };
      }>;
    }>(
      creds,
      "GET",
      `/v1/apps/${encodeURIComponent(ascAppId)}/appStoreVersions?limit=10`,
    ).catch((err: unknown) => ({
      data: undefined,
      error: err instanceof Error ? err.message : String(err),
    })),
    ascRequest<{
      data?: Array<{
        id: string;
        attributes?: {
          version?: string;
          uploadedDate?: string;
          processingState?: string;
          expired?: boolean;
        };
      }>;
    }>(
      creds,
      "GET",
      `/v1/builds?filter[app]=${encodeURIComponent(ascAppId)}&sort=-uploadedDate&limit=10`,
    ).catch((err: unknown) => ({
      data: undefined,
      error: err instanceof Error ? err.message : String(err),
    })),
    ascRequest<{
      data?: Array<{
        id: string;
        attributes?: {
          accessType?: string;
          stoppedDueToInactivity?: boolean;
        };
      }>;
    }>(
      creds,
      "GET",
      `/v1/apps/${encodeURIComponent(ascAppId)}/analyticsReportRequests?limit=10`,
    ).catch((err: unknown) => ({
      data: undefined,
      error: err instanceof Error ? err.message : String(err),
    })),
  ]);

  const versions = (versionsRes.data ?? []).map((v) => ({
    id: v.id,
    version_string: v.attributes?.versionString ?? null,
    platform: v.attributes?.platform ?? null,
    state: v.attributes?.appVersionState ?? v.attributes?.appStoreState ?? null,
    release_type: v.attributes?.releaseType ?? null,
    created_date: v.attributes?.createdDate ?? null,
  }));

  const builds = (buildsRes.data ?? []).map((b) => ({
    id: b.id,
    build_number: b.attributes?.version ?? null,
    uploaded_date: b.attributes?.uploadedDate ?? null,
    processing_state: b.attributes?.processingState ?? null,
    expired: Boolean(b.attributes?.expired),
  }));

  const reportRequests = (analyticsReqRes.data ?? []).map((r) => ({
    id: r.id,
    access_type: r.attributes?.accessType ?? null,
    stopped_due_to_inactivity: Boolean(r.attributes?.stoppedDueToInactivity),
  }));

  // If there is an active analyticsReportRequest, fetch its APP_USAGE / APP_STORE_ENGAGEMENT reports summary
  let downloadAndUsageInstances: Array<{
    report_id: string;
    name: string | null;
    category: string | null;
    granularity: string | null;
    latest_instance_date: string | null;
  }> = [];

  const activeReq = reportRequests.find((r) => !r.stopped_due_to_inactivity) ?? reportRequests[0];
  if (activeReq) {
    try {
      const reportsRes = await ascRequest<{
        data?: Array<{
          id: string;
          attributes?: {
            name?: string;
            category?: string;
          };
        }>;
      }>(
        creds,
        "GET",
        `/v1/analyticsReportRequests/${encodeURIComponent(activeReq.id)}/reports?filter[category]=APP_USAGE,APP_STORE_ENGAGEMENT&limit=20`,
      );
      for (const rep of (reportsRes.data ?? []).slice(0, 8)) {
        downloadAndUsageInstances.push({
          report_id: rep.id,
          name: rep.attributes?.name ?? null,
          category: rep.attributes?.category ?? null,
          granularity: null,
          latest_instance_date: null,
        });
      }
    } catch {
      // Optional enrichment; ignore if key lacks analytics report read scope
    }
  }

  return {
    configured: true,
    bundle_id: mainChannel?.bundle_id ?? null,
    key_id: meta.key_id,
    asc_app_id: ascAppId,
    versions,
    builds,
    analytics_reports: {
      requests: reportRequests,
      reports: downloadAndUsageInstances,
      error: "error" in analyticsReqRes ? analyticsReqRes.error : null,
      note:
        reportRequests.length === 0
          ? "No App Store Connect Analytics Report Request is active yet for this app (or the API key does not have Analytics/Sales report scope). Active iOS devices are tracked in `direct.devices` via Hands SDK telemetry (`device_pings`)."
          : null,
    },
    live_error:
      ("error" in versionsRes ? versionsRes.error : null) ??
      ("error" in buildsRes ? buildsRes.error : null),
  };
}

export async function handleAppStats(c: AdminContext) {
  const appId = c.req.param("appId") ?? "";
  const app = await c.env.DB.prepare(
    "SELECT id, slug, name, platform, org_id FROM apps WHERE id = ?1 AND archived = 0",
  )
    .bind(appId)
    .first<{
      id: string;
      slug: string;
      name: string;
      platform: string | null;
      org_id: string | null;
    }>();
  if (!app) return c.json({ error: "app not found" }, 404);

  const { since, windowDays } = parseWindowDays(c.req.query("window_days"));
  const channelFilter = c.req.query("channel")?.trim() || null;
  const includeStoreLive = c.req.query("live") !== "false" && c.req.query("live") !== "0";

  const [direct, googlePlay, appStore] = await Promise.all([
    queryDirectStats(c.env.DB, appId, since, channelFilter),
    queryGooglePlayStats(c, appId, app.platform, includeStoreLive),
    queryAppStoreStats(c, appId, app.platform, includeStoreLive, since),
  ]);

  return c.json({
    app: {
      id: app.id,
      slug: app.slug,
      name: app.name,
      platform: app.platform,
    },
    window_days: windowDays,
    window_start: since,
    channel_filter: channelFilter,
    direct,
    stores: {
      google_play: googlePlay,
      app_store: appStore,
    },
  });
}
