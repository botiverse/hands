import { afterEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { parseQueryParams, resolvePlayApiBody, registerPlayCommands } from "./play.js";
import { formatAppStatsReport, formatAppStoreAnalytics, formatGooglePlayReports, registerStatsCommands } from "./stats.js";

const APP_ID = "a78f3891-f980-4f48-80d7-2a58e93a99aa";

vi.mock("../lib/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api.js")>();
  return {
    ...actual,
    apiRequest: async (path: string, opts: { method?: string; body?: unknown; query?: Record<string, unknown> } = {}) => {
      const state = globalThis as unknown as {
        __PLAY_STATS_CALLS: Array<{ method: string; path: string; body?: unknown; query?: Record<string, unknown> }>;
      };
      state.__PLAY_STATS_CALLS.push({
        method: (opts.method ?? "GET").toUpperCase(),
        path: String(path),
        body: opts.body,
        query: opts.query,
      });
      if (path === "/api/apps") {
        return {
          apps: [{ id: APP_ID, slug: "raft-android", name: "Raft Android", platform: "android" }],
        } as never;
      }
      if (String(path).endsWith("/distributions/play/api")) {
        return {
          receipt_id: "rcpt-1",
          operation_id: "op-1",
          package_name: "build.raft.app",
          method: (opts.body as { method?: string })?.method ?? "GET",
          path: "/androidpublisher/v3/applications/build.raft.app/reviews",
          status: 200,
          data: { reviews: [] },
        } as never;
      }
      if (String(path).endsWith("/stats")) {
        return {
          app: { id: APP_ID, slug: "raft-android", name: "Raft Android", platform: "android" },
          window_days: 30,
          window_start: 1700000000000,
          channel_filter: null,
          direct: {
            devices: { active_window: 12, active_7d: 8, active_24h: 4, new_window: 3, total_all_time: 20 },
            downloads: {
              public_unique_window: 5,
              public_unique_all_time: 15,
              console_asset_downloads: 2,
              update_checks_current: 40,
              update_checks_offered: 10,
              update_checks_unique_devices: 11,
              last_update_check_at: 1700000000000,
            },
            by_version: [
              { version_name: "1.23.0", version_code: 12300, channel: "main", active_devices: 10, total_devices: 15 },
            ],
            by_channel: [{ channel: "main", active_devices: 12, total_devices: 20 }],
            by_platform: [{ platform: "android", active_devices: 12, total_devices: 20 }],
          },
          stores: {
            google_play: {
              configured: true,
              package_name: "build.raft.app",
              verification_state: "verified",
              tracks_configured: { internal: "qa", closed: "closed", production: "production" },
              promoted_releases: [],
              live_tracks: [
                {
                  hands_track: "production",
                  play_track: "production",
                  releases: [{ release_name: "1.23.0", version_codes: [12300], lifecycle_state: "completed" }],
                },
              ],
              live_error: null,
              download_reports: { available: false, source: "google_play_androidpublisher_v3", note: "note" },
            },
            app_store: null,
          },
        } as never;
      }
      return {} as never;
    },
  };
});

describe("hands play api & hands stats CLI", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("parses query params and typed body fields for hands play api", async () => {
    expect(parseQueryParams(["maxResults=20", "tag=a", "tag=b"])).toEqual({
      maxResults: "20",
      tag: ["a", "b"],
    });
    const body = await resolvePlayApiBody({
      field: ["changesNotSentForReview=true", "userFraction=0.25", 'releases=[{"status":"completed"}]'],
      rawField: ["name=1.23.0"],
    });
    expect(body).toEqual({
      changesNotSentForReview: true,
      userFraction: 0.25,
      releases: [{ status: "completed" }],
      name: "1.23.0",
    });
  });

  it("calls POST /api/apps/:appId/distributions/play/api and GET /api/apps/:appId/stats", async () => {
    const calls: Array<{ method: string; path: string; body?: unknown; query?: Record<string, unknown> }> = [];
    (globalThis as unknown as { __PLAY_STATS_CALLS: typeof calls }).__PLAY_STATS_CALLS = calls;

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const program = new Command();
    program.exitOverride();
    registerPlayCommands(program);
    registerStatsCommands(program);

    await program.parseAsync([
      "node",
      "hands",
      "play",
      "api",
      "raft-android",
      "POST",
      "edits/123/tracks/production",
      "-F",
      "status=completed",
      "-q",
      "changesNotSentForReview=true",
      "--note",
      "promote track",
    ]);

    expect(calls).toContainEqual({
      method: "POST",
      path: `/api/apps/${APP_ID}/distributions/play/api`,
      body: {
        method: "POST",
        path: "edits/123/tracks/production",
        query: { changesNotSentForReview: "true" },
        body: { status: "completed" },
        note: "promote track",
      },
      query: undefined,
    });

    await program.parseAsync(["node", "hands", "stats", "raft-android", "--days", "14"]);
    expect(calls).toContainEqual({
      method: "GET",
      path: `/api/apps/${APP_ID}/stats`,
      body: undefined,
      query: { window_days: "14" },
    });

    logSpy.mockRestore();
    errSpy.mockRestore();
  });

  it("formats human-readable stats report with direct devices and store tracks", () => {
    const text = formatAppStatsReport({
      app: { id: APP_ID, slug: "raft-android", name: "Raft Android", platform: "android" },
      window_days: 30,
      window_start: 1700000000000,
      channel_filter: null,
      direct: {
        devices: { active_window: 12, active_7d: 8, active_24h: 4, new_window: 3, total_all_time: 20 },
        downloads: {
          public_unique_window: 5,
          public_unique_all_time: 15,
          console_asset_downloads: 2,
          update_checks_current: 40,
          update_checks_offered: 10,
          update_checks_unique_devices: 11,
          last_update_check_at: 1700000000000,
        },
        by_version: [
          { version_name: "1.23.0", version_code: 12300, channel: "main", active_devices: 10, total_devices: 15 },
        ],
        by_channel: [{ channel: "main", active_devices: 12, total_devices: 20 }],
        by_platform: [{ platform: "android", active_devices: 12, total_devices: 20 }],
      },
      stores: {
        google_play: {
          configured: true,
          package_name: "build.raft.app",
          verification_state: "verified",
          tracks_configured: { internal: "qa", closed: "closed", production: "production" },
          promoted_releases: [],
          live_tracks: [
            {
              hands_track: "production",
              play_track: "production",
              releases: [{ release_name: "1.23.0", version_codes: [12300], lifecycle_state: "completed" }],
            },
          ],
          live_error: null,
          download_reports: { available: false, source: "google_play_androidpublisher_v3", note: "note" },
        },
        app_store: null,
      },
    });
    expect(text).toContain("Raft Android (raft-android, android)");
    expect(text).toContain("Active Devices: 12 (30d)");
    expect(text).toContain("Track production (production): 1.23.0 [12300] (completed)");
  });

  it("prints ingested App Store daily metrics, totals, warnings and the privacy note", () => {
    const lines = formatAppStoreAnalytics({
      configured: true, bundle_id: "build.raft.app", key_id: "K", versions: null, builds: null, analytics_reports: null,
      daily: [
        { date: "2026-11-09", downloads_first_time: null, downloads_redownload: null, installations: null, deletions: null, sessions: 8, active_devices: 3 },
        { date: "2026-11-10", downloads_first_time: 7, downloads_redownload: 3, installations: 6, deletions: 1, sessions: 15, active_devices: 6 },
      ],
      totals: { downloads_first_time: 7, downloads_redownload: 3, installations: 6, deletions: 1, sessions: 23, active_devices_peak_daily: 6 },
      analytics_ingest: { instances_processed: 5, instances_incomplete: 1, instances_failed: 0, instances_over_limit: 2, last_processed_at: 1, latest_processing_date: "2026-11-10", last_run_at: 1, last_error_code: "missing_column:Unique Devices",
        warnings: [{ report_name: "App Sessions Standard", code: "missing_column", column: "Unique Devices" }] },
      analytics_note: "Only users who agreed to share analytics.",
    }, 30);
    const text = lines.join("\n");
    expect(text).toContain("App Store Analytics (30d): 7 first-time downloads, 3 redownloads | 6 installations, 1 deletions | 23 sessions | peak 6 active devices/day");
    expect(text).toMatch(/2026-11-09\s+-\s+-\s+-\s+-\s+8\s+3/);
    expect(text).toMatch(/2026-11-10\s+7\s+3\s+6\s+1\s+15\s+6/);
    expect(text).toContain("Warning: App Sessions Standard: missing_column Unique Devices");
    expect(text).toContain("Retrying: 1 incomplete, 0 failed, 2 over size limit report instances (last: missing_column:Unique Devices)");
    expect(text).toContain("Note: Only users who agreed to share analytics.");
  });

  const gpBase = {
    configured: true, package_name: "build.raft.app", verification_state: "verified", tracks_configured: null,
    promoted_releases: [], live_tracks: null, live_error: null,
    download_reports: { available: true, source: "google_play_androidpublisher_v3", note: "note" },
  };
  const ingest = { stats_bucket: "pubsite_prod_1", files_processed: 3, files_incomplete: 1, files_failed: 1, files_over_limit: 0,
    last_processed_at: 1, latest_data_date: "2026-11-03", last_run_at: 1, last_error_code: "md5_mismatch", hint: null, problems: [],
    warnings: [{ report_kind: "installs_overview", code: "missing_column", column: "Install events" }] };

  it("prints ingested Google Play statistics, totals, warnings, retries and the metric note", () => {
    const row = (date: string, n: number) => ({ date, device_installs: n + 10, device_uninstalls: 1, device_upgrades: 2, user_installs: n,
      user_uninstalls: 1, total_user_installs: 5000, active_device_installs: 1000 + n, install_events: null, update_events: null,
      uninstall_events: null, store_listing_visitors: n === 1 ? 1000 : null, store_listing_acquisitions: n === 1 ? 2 : null });
    const text = formatGooglePlayReports({
      ...gpBase,
      daily: [row("2026-11-01", 1), row("2026-11-02", 2)],
      totals: { device_installs: 23, device_uninstalls: 2, device_upgrades: 4, user_installs: 3, user_uninstalls: 2, install_events: null,
        update_events: null, uninstall_events: null, store_listing_visitors: 1000, store_listing_acquisitions: 2,
        store_listing_conversion_rate: 0.002, active_device_installs_latest: 1002, active_device_installs_latest_date: "2026-11-02",
        total_user_installs_latest: 5000 },
      reports_ingest: ingest,
      reports_note: "Google publishes them with a delay of about 3 to 7 days.",
    }, 30).join("\n");
    expect(text).toContain("Play statistics (30d): 3 user installs, 2 user uninstalls | 23 device installs, 2 device uninstalls, 4 upgrades | " +
      "active device installs 1002 on 2026-11-02 | store listing 1000 visitors, 2 acquisitions (0.20%)");
    expect(text).toMatch(/2026-11-01\s+1\s+1\s+11\s+1\s+2\s+1001\s+1000\s+2/);
    expect(text).toMatch(/2026-11-02\s+2\s+1\s+12\s+1\s+2\s+1002\s+-\s+-/);
    expect(text).toContain("Warning: installs_overview: missing_column Install events");
    expect(text).toContain("Retrying: 1 incomplete, 1 failed, 0 over size limit report files (last run: md5_mismatch)");
    expect(text).toContain("Note: Google publishes them with a delay of about 3 to 7 days.");
  });

  it("says how to set the Play reports bucket, and shows the bucket hint when listing fails", () => {
    expect(formatGooglePlayReports({ ...gpBase, daily: [], totals: null, reports_note: "n",
      reports_ingest: { ...ingest, stats_bucket: null, files_processed: 0, last_error_code: null, warnings: [] } }, 30))
      .toEqual(["  - Play statistics reports: bucket not set (hands api PUT /api/apps/<appId>/google-play/stats-bucket)"]);
    expect(formatGooglePlayReports({ ...gpBase, daily: [], totals: null, reports_note: "n",
      reports_ingest: { ...ingest, last_error_code: "play_reports_bucket_forbidden", hint: "Newer accounts use pubsite_prod_rev_<digits>.", warnings: [] } }, 30))
      .toEqual([
        "  - Play statistics reports: no data in this window yet (last run: play_reports_bucket_forbidden)",
        "    Hint: Newer accounts use pubsite_prod_rev_<digits>.",
      ]);
    // An older server without the fields prints nothing extra.
    expect(formatGooglePlayReports(gpBase as any, 30)).toEqual([]);
  });

  it("says when no App Store report was ingested yet", () => {
    expect(formatAppStoreAnalytics({ configured: true, bundle_id: null, key_id: null, versions: null, builds: null, analytics_reports: null,
      daily: [], totals: null, analytics_note: "n",
      analytics_ingest: { instances_processed: 0, last_processed_at: null, latest_processing_date: null, last_run_at: 1, last_error_code: "asc_api_403", warnings: [] } }, 30))
      .toEqual(["  - App Store Analytics: no reports ingested yet (last run: asc_api_403)"]);
  });
});
