/**
 * `hands stats [app]` — unified download, active-device, and store distribution
 * statistics across Hands direct-install, Google Play, and App Store Connect.
 */

import type { Command } from "commander";
import { apiRequest } from "../lib/api.js";
import { jsonRequested } from "../lib/json_output.js";

type AppRow = { id: string; slug: string; name: string; platform: string | null };

export interface AppStatsResponse {
  app: {
    id: string;
    slug: string;
    name: string;
    platform: string | null;
  };
  window_days: number;
  window_start: number;
  channel_filter: string | null;
  direct: {
    devices: {
      active_window: number;
      active_7d: number;
      active_24h: number;
      new_window: number;
      total_all_time: number;
    };
    downloads: {
      public_unique_window: number;
      public_unique_all_time: number;
      console_asset_downloads: number;
      update_checks_current: number;
      update_checks_offered: number;
      update_checks_unique_devices: number;
      last_update_check_at: number | null;
    };
    by_version: Array<{
      version_name: string;
      version_code: number | null;
      channel: string;
      active_devices: number;
      total_devices: number;
    }>;
    by_channel: Array<{
      channel: string;
      active_devices: number;
      total_devices: number;
    }>;
    by_platform: Array<{
      platform: string;
      active_devices: number;
      total_devices: number;
    }>;
  };
  stores: {
    google_play: {
      configured: boolean;
      package_name: string | null;
      verification_state: string | null;
      tracks_configured: Record<string, string> | null;
      promoted_releases: Array<{
        release_id: string;
        package_name: string;
        play_track: string;
        version_code: number;
        rollout_state: string;
        rollout_fraction: number | null;
        last_receipt_id: string | null;
        updated_at: number;
        version_name: string | null;
      }>;
      live_tracks: Array<{
        hands_track: string;
        play_track: string;
        releases: Array<{
          release_name: string;
          version_codes: number[];
          lifecycle_state: string;
        }>;
      }> | null;
      live_error: string | null;
      download_reports: {
        available: boolean;
        source: string;
        note: string;
      };
    } | null;
    app_store: {
      configured: boolean;
      bundle_id: string | null;
      key_id: string | null;
      asc_app_id?: string | null;
      versions: Array<{
        id: string;
        version_string: string | null;
        platform: string | null;
        state: string | null;
        release_type: string | null;
        created_date: string | null;
      }> | null;
      builds: Array<{
        id: string;
        build_number: string | null;
        uploaded_date: string | null;
        processing_state: string | null;
        expired: boolean;
      }> | null;
      analytics_reports: {
        requests: Array<{
          id: string;
          access_type: string | null;
          stopped_due_to_inactivity: boolean;
        }>;
        reports: Array<{
          report_id: string;
          name: string | null;
          category: string | null;
          granularity: string | null;
          latest_instance_date: string | null;
        }>;
        error: string | null;
        note: string | null;
      } | null;
      live_error?: string | null;
    } | null;
  };
}

async function resolveTargetApps(appIdOrSlug: string | undefined, all: boolean): Promise<AppRow[]> {
  const { apps } = await apiRequest<{ apps: AppRow[] }>("/api/apps");
  if (all || !appIdOrSlug) return apps;
  const found = apps.find((a) => a.id === appIdOrSlug || a.slug === appIdOrSlug);
  if (found) return [found];
  if (/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(appIdOrSlug)) {
    return [{ id: appIdOrSlug, slug: appIdOrSlug, name: appIdOrSlug, platform: null }];
  }
  throw new Error(`App not found: ${appIdOrSlug}`);
}

export function formatAppStatsReport(stats: AppStatsResponse): string {
  const lines: string[] = [];
  const { app, window_days, direct, stores } = stats;
  const title = `${app.name} (${app.slug}${app.platform ? `, ${app.platform}` : ""})`;
  lines.push(`=== ${title} — Window: last ${window_days}d ===`);
  lines.push(
    `Active Devices: ${direct.devices.active_window} (${window_days}d) | ${direct.devices.active_7d} (7d) | ${direct.devices.active_24h} (24h) | ${direct.devices.new_window} new (${window_days}d) | ${direct.devices.total_all_time} total all-time`,
  );
  lines.push(
    `Direct Downloads & Checks: ${direct.downloads.public_unique_window} unique public downloads (${window_days}d), ${direct.downloads.public_unique_all_time} all-time | ${direct.downloads.console_asset_downloads} console/API asset downloads | ${direct.downloads.update_checks_offered} updates offered (${direct.downloads.update_checks_unique_devices} unique check devices)`,
  );

  if (direct.by_channel.length > 0) {
    const chSummary = direct.by_channel
      .map((c) => `${c.channel}: ${c.active_devices} active / ${c.total_devices} total`)
      .join(", ");
    lines.push(`By Channel: ${chSummary}`);
  }

  if (direct.by_version.length > 0) {
    lines.push("Top Versions (SDK Telemetry):");
    for (const v of direct.by_version.slice(0, 10)) {
      const codeStr = v.version_code !== null ? ` (${v.version_code})` : "";
      lines.push(
        `  - ${v.version_name}${codeStr} [${v.channel}]: ${v.active_devices} active / ${v.total_devices} total`,
      );
    }
  }

  if (stores.google_play) {
    const gp = stores.google_play;
    lines.push(
      `Google Play (${gp.package_name ?? "unconfigured"}): ${gp.configured ? "connected" : "not connected"}`,
    );
    if (gp.live_tracks && gp.live_tracks.length > 0) {
      for (const t of gp.live_tracks) {
        const rels =
          t.releases.length > 0
            ? t.releases
                .map((r) => `${r.release_name || "-"} [${r.version_codes.join(",")}] (${r.lifecycle_state})`)
                .join("; ")
            : "empty";
        lines.push(`  - Track ${t.hands_track} (${t.play_track}): ${rels}`);
      }
    } else if (gp.promoted_releases.length > 0) {
      for (const r of gp.promoted_releases.slice(0, 5)) {
        lines.push(
          `  - Promoted ${r.version_name ?? "?"} (${r.version_code}) on ${r.play_track}: ${r.rollout_state}`,
        );
      }
    }
    if (gp.live_error) {
      lines.push(`  - Play live query warning: ${gp.live_error}`);
    }
  }

  if (stores.app_store) {
    const asc = stores.app_store;
    lines.push(
      `App Store Connect (${asc.bundle_id ?? "unconfigured"}): ${asc.configured ? "connected" : "not connected"}`,
    );
    if (asc.versions && asc.versions.length > 0) {
      for (const v of asc.versions.slice(0, 5)) {
        lines.push(
          `  - App Store Version ${v.version_string ?? "?"} (${v.platform ?? "IOS"}): ${v.state ?? "UNKNOWN"}`,
        );
      }
    }
    if (asc.builds && asc.builds.length > 0) {
      const bSummary = asc.builds
        .slice(0, 5)
        .map((b) => `#${b.build_number ?? "?"} (${b.processing_state ?? "?"}${b.expired ? ", expired" : ""})`)
        .join(", ");
      lines.push(`  - TestFlight Builds: ${bSummary}`);
    }
    if (asc.analytics_reports) {
      const reqCount = asc.analytics_reports.requests.length;
      const repCount = asc.analytics_reports.reports.length;
      if (reqCount > 0) {
        lines.push(`  - Analytics Report Requests: ${reqCount} active (${repCount} usage/engagement reports)`);
      } else if (asc.analytics_reports.note) {
        lines.push(`  - Analytics Reports: ${asc.analytics_reports.note}`);
      }
    }
    if (asc.live_error) {
      lines.push(`  - ASC live query warning: ${asc.live_error}`);
    }
  }

  return lines.join("\n");
}

export function registerStatsCommands(program: Command): void {
  program
    .command("stats [appIdOrSlug]")
    .description(
      "Show unified download, active-device, and store distribution stats across Hands direct-install, Google Play, and App Store Connect.",
    )
    .option("-d, --days <days>", "Window in days (1-365).", "30")
    .option("-c, --channel <slug>", "Filter direct-install stats by channel slug (e.g. main, preview, nightly).")
    .option("--no-live", "Skip live Google Play / App Store Connect API queries and return cached/D1 state only.")
    .option("--all", "Query all visible apps.", false)
    .option("--json", "Output raw JSON.", false)
    .action(
      async (
        appIdOrSlug: string | undefined,
        opts: {
          days?: string;
          channel?: string;
          live?: boolean;
          all?: boolean;
          json?: boolean;
        },
      ) => {
        const targets = await resolveTargetApps(appIdOrSlug, Boolean(opts.all));
        const results: AppStatsResponse[] = [];
        for (const target of targets) {
          const res = await apiRequest<AppStatsResponse>(`/api/apps/${target.id}/stats`, {
            query: {
              window_days: opts.days ?? "30",
              ...(opts.channel ? { channel: opts.channel } : {}),
              ...(opts.live === false ? { live: "false" } : {}),
            },
          });
          results.push(res);
        }

        if (jsonRequested(program, opts.json)) {
          console.log(JSON.stringify(results.length === 1 && appIdOrSlug && !opts.all ? results[0] : { apps: results }, null, 2));
          return;
        }

        if (results.length === 0) {
          console.log("No apps found.");
          return;
        }
        console.log(results.map(formatAppStatsReport).join("\n\n"));
      },
    );
}
