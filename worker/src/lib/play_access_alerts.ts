/**
 * Alerts when Hands loses access to Google Play for an app, and when it gets it
 * back. A rejected or missing authorization alerts at once; any other failure
 * alerts once it has lasted an hour. One alert per failure episode; the
 * episode ends (with a "restored" notice if an alert went out) on the next
 * successful call.
 */

import { playDeliveryStatement } from "./play_notifications";

export type PlayAccess = "statistics" | "publishing";

/** Codes that mean someone must reauthorize; waiting will not fix them. */
const AUTHORIZATION_CODES = new Set([
  "play_token_rejected",
  "play_reports_token_rejected",
  "play_reports_not_authorized",
  "play_reports_scope_missing",
]);
export const PLAY_ACCESS_ALERT_AFTER_MS = 60 * 60 * 1000;

const ACCESS_LABEL: Record<PlayAccess, string> = {
  statistics: "statistics reports",
  publishing: "release status",
};

function hint(access: PlayAccess, code: string): string {
  if (code === "play_reports_token_rejected" || code === "play_reports_not_authorized" || code === "play_reports_scope_missing") {
    return "An app admin chooses \"Authorize statistics reports\" in the app's Google Play settings in Hands. Publishing is not affected.";
  }
  if (code === "play_token_rejected") {
    return access === "publishing"
      ? "An app admin reconnects Google Play (\"Reauthorize\") in the app's Google Play settings in Hands."
      : "An app admin reauthorizes Google Play in the app's Google Play settings in Hands.";
  }
  return "Google Play has been failing for over an hour; check the app's Google Play settings in Hands and Google Play Console.";
}

type StateRow = { failing_since: number; last_error_code: string; alerted_at: number | null };

async function readState(db: D1Database, appId: string, access: PlayAccess) {
  return db.prepare(
    "SELECT failing_since, last_error_code, alerted_at FROM google_play_access_state WHERE app_id = ?1 AND access = ?2",
  ).bind(appId, access).first<StateRow>();
}

/** The app's Google Play settings page, where authorizations are redone. */
export function playSettingsUrl(dashboardOrigin: string | null, appId: string): string | null {
  return dashboardOrigin ? `${dashboardOrigin.replace(/\/+$/, "")}/apps/${encodeURIComponent(appId)}/integrations` : null;
}

export async function recordPlayAccessFailure(
  db: D1Database, appId: string, access: PlayAccess, code: string, now = Date.now(), dashboardOrigin: string | null = null,
) {
  await db.prepare(
    `INSERT INTO google_play_access_state (app_id, access, failing_since, last_failure_at, last_error_code)
     VALUES (?1, ?2, ?3, ?3, ?4)
     ON CONFLICT (app_id, access) DO UPDATE SET last_failure_at = excluded.last_failure_at, last_error_code = excluded.last_error_code`,
  ).bind(appId, access, now, code).run();
  const state = await readState(db, appId, access);
  if (!state || state.alerted_at !== null) return;
  if (!AUTHORIZATION_CODES.has(code) && now - state.failing_since < PLAY_ACCESS_ALERT_AFTER_MS) return;
  // The claim and the delivery commit together: an episode is marked alerted
  // only if its alert was queued, and only one concurrent caller queues it.
  await db.batch([
    db.prepare(
      "UPDATE google_play_access_state SET alerted_at = ?1 WHERE app_id = ?2 AND access = ?3 AND alerted_at IS NULL AND failing_since = ?4",
    ).bind(now, appId, access, state.failing_since),
    playDeliveryStatement(db, appId, "google_play:access_failed",
      `hands-play-access:${appId}:${access}:${state.failing_since}:failed`, {
        access,
        access_label: ACCESS_LABEL[access],
        error_code: code,
        failing_since: new Date(state.failing_since).toISOString(),
        hint: hint(access, code),
        settings_url: playSettingsUrl(dashboardOrigin, appId),
        occurred_at: new Date(now).toISOString(),
      }, now,
      "SELECT 1 FROM google_play_access_state WHERE app_id = ?6 AND access = ?7 AND alerted_at = ?8 AND failing_since = ?9",
      [appId, access, now, state.failing_since]),
  ]);
}

export async function recordPlayAccessSuccess(db: D1Database, appId: string, access: PlayAccess, now = Date.now()) {
  // Read alerted_at from the deleted row itself, so an alert claimed concurrently is not missed.
  const state = await db.prepare(
    "DELETE FROM google_play_access_state WHERE app_id = ?1 AND access = ?2 RETURNING failing_since, last_error_code, alerted_at",
  ).bind(appId, access).first<StateRow>();
  if (!state || state.alerted_at === null) return;
  await playDeliveryStatement(db, appId, "google_play:access_restored",
    `hands-play-access:${appId}:${access}:${state.failing_since}:restored`, {
      access,
      access_label: ACCESS_LABEL[access],
      previous_error_code: state.last_error_code,
      failing_since: new Date(state.failing_since).toISOString(),
      occurred_at: new Date(now).toISOString(),
    }, now, "SELECT 1", []).run();
}
