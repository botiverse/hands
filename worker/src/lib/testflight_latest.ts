/**
 * The newest build an app currently has in EXTERNAL TestFlight testing, kept
 * per app in `testflight_latest_builds` so an unauthenticated TestFlight build
 * can ask "is there a newer one?" (GET /public/v2/apps/:slug/testflight/latest)
 * without Hands calling Apple on the public path.
 *
 * Two writers observe a specific ASC build's external state and report it here:
 * the Apple `buildBetaDetailExternalBuildStateUpdated` webhook and the
 * testflight-publish / testflight-publish status readbacks. Both are
 * best-effort: callers wrap this in try/catch so a storage failure never costs
 * a notification or an admin response.
 *
 * Rules:
 *   - IN_BETA_TESTING with a plain-integer build number: upsert, but only when
 *     nothing is stored or the build number is >= the stored one (numeric
 *     comparison; the stored row never moves backwards).
 *   - Any other state for the build that is stored (same asc_build_id): delete
 *     the row. A later readback or webhook for another testing build fills it
 *     again. A different build leaving testing does not touch the row.
 */

export const EXTERNAL_TESTING_STATE = "IN_BETA_TESTING";

/**
 * Apple's build number is CFBundleVersion, a string that may be dotted
 * ("1.2.3"). Only a plain integer has an unambiguous numeric order, so
 * anything else is not stored. 15 digits keeps it inside Number's exact range.
 */
export function parseBuildNumber(raw: unknown): number | null {
  const text = typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 0 ? String(raw) : raw;
  if (typeof text !== "string" || !/^\d{1,15}$/.test(text)) return null;
  return Number(text);
}

export interface ExternalBuildObservation {
  appId: string;
  ascBuildId: string | null | undefined;
  versionName: string | null | undefined;
  buildNumber: string | number | null | undefined;
  externalBuildState: string | null | undefined;
  now?: number;
}

export type TestflightLatestOutcome = "upserted" | "removed" | "ignored";

export async function recordExternalBuildState(
  db: D1Database,
  obs: ExternalBuildObservation,
): Promise<TestflightLatestOutcome> {
  const ascBuildId = typeof obs.ascBuildId === "string" && obs.ascBuildId.trim() ? obs.ascBuildId : null;
  const state = typeof obs.externalBuildState === "string" && obs.externalBuildState ? obs.externalBuildState : null;
  // Without the exact build and its state there is nothing safe to conclude.
  if (!ascBuildId || !state) return "ignored";

  if (state !== EXTERNAL_TESTING_STATE) {
    const res = await db
      .prepare("DELETE FROM testflight_latest_builds WHERE app_id = ?1 AND asc_build_id = ?2")
      .bind(obs.appId, ascBuildId)
      .run();
    return (res.meta?.changes ?? 0) > 0 ? "removed" : "ignored";
  }

  const versionCode = parseBuildNumber(obs.buildNumber);
  const versionName = typeof obs.versionName === "string" ? obs.versionName.trim() : "";
  if (versionCode === null || !versionName) return "ignored";

  // One statement so two concurrent writers cannot interleave a read and a
  // write: the conflict branch only applies when the incoming build is not older.
  const res = await db
    .prepare(
      `INSERT INTO testflight_latest_builds
         (app_id, version_name, version_code, asc_build_id, external_build_state, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)
       ON CONFLICT(app_id) DO UPDATE SET
         version_name = excluded.version_name,
         version_code = excluded.version_code,
         asc_build_id = excluded.asc_build_id,
         external_build_state = excluded.external_build_state,
         updated_at = excluded.updated_at
       WHERE excluded.version_code >= testflight_latest_builds.version_code`,
    )
    .bind(obs.appId, versionName, versionCode, ascBuildId, state, obs.now ?? Date.now())
    .run();
  return (res.meta?.changes ?? 0) > 0 ? "upserted" : "ignored";
}

/**
 * Best-effort wrapper for the observation points: never throws, logs instead.
 */
export async function recordExternalBuildStateBestEffort(
  db: D1Database,
  obs: ExternalBuildObservation,
  source: string,
): Promise<TestflightLatestOutcome | null> {
  try {
    return await recordExternalBuildState(db, obs);
  } catch (error) {
    console.warn(
      `testflight_latest: ${source} update failed for app=${obs.appId}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}

export interface TestflightLatestRow {
  version_name: string;
  version_code: number;
  external_build_state: string;
  updated_at: number;
}

export async function loadTestflightLatest(db: D1Database, appId: string): Promise<TestflightLatestRow | null> {
  return db
    .prepare(
      `SELECT version_name, version_code, external_build_state, updated_at
       FROM testflight_latest_builds WHERE app_id = ?1`,
    )
    .bind(appId)
    .first<TestflightLatestRow>();
}
