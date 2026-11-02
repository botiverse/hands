/**
 * Feedback bundle IDs are client-reported and are a triage hint, not identity.
 * The app's configured channel bundle IDs are the comparison set. This policy is
 * opt-in per app, so existing integrations keep their previous behaviour until
 * an app publisher enables it. Nothing is removed or rewritten.
 */
export const FEEDBACK_BUILD_ORIGIN_FLAG = "feedback_build_origin_filter";
export type FeedbackBuildOrigin = "configured" | "external" | "unknown";
export type FeedbackBuildScope = "standard" | "external" | "all";

/** These fragments are used only with the fixed internal SQL alias `t`. */
export const FEEDBACK_BUILD_ORIGIN_ENABLED_SQL = `EXISTS (
  SELECT 1 FROM feature_flags origin_flag
  JOIN apps origin_app ON origin_app.id = origin_flag.app_id
  WHERE origin_flag.app_id = t.app_id
    AND origin_flag.key = '${FEEDBACK_BUILD_ORIGIN_FLAG}'
    AND origin_flag.default_enabled = 1
    AND origin_app.platform = 'ios'
)`;

// Guard JSON functions with CASE (not AND): malformed historical JSON must be
// classified as unknown, not make a whole page of feedback fail. Apple bundle
// IDs are ASCII and case-insensitive; metadata is still untrusted client input.
export const FEEDBACK_BUILD_ORIGIN_SQL = `CASE
  WHEN NOT EXISTS (
    SELECT 1 FROM channels origin_channel
    WHERE origin_channel.app_id = t.app_id
      AND length(COALESCE(origin_channel.bundle_id, '')) BETWEEN 1 AND 255
      AND origin_channel.bundle_id NOT GLOB '*[^A-Za-z0-9.-]*'
      AND origin_channel.bundle_id GLOB '*[A-Za-z0-9]*'
  ) THEN 'unknown'
  WHEN NOT json_valid(t.metadata_json) THEN 'unknown'
  ELSE CASE
    WHEN json_type(t.metadata_json, '$.bundle_id') IS NOT 'text' THEN 'unknown'
    WHEN length(json_extract(t.metadata_json, '$.bundle_id')) NOT BETWEEN 1 AND 255 THEN 'unknown'
    WHEN json_extract(t.metadata_json, '$.bundle_id') GLOB '*[^A-Za-z0-9.-]*' THEN 'unknown'
    WHEN json_extract(t.metadata_json, '$.bundle_id') NOT GLOB '*[A-Za-z0-9]*' THEN 'unknown'
    WHEN EXISTS (
      SELECT 1 FROM channels origin_channel
      WHERE origin_channel.app_id = t.app_id
        AND origin_channel.bundle_id = json_extract(t.metadata_json, '$.bundle_id') COLLATE NOCASE
    ) THEN 'configured'
    ELSE 'external'
  END
END`;

/** Null means the app has not enabled the feature; otherwise this is a hint. */
export const FEEDBACK_BUILD_ORIGIN_FIELD_SQL = `CASE
  WHEN ${FEEDBACK_BUILD_ORIGIN_ENABLED_SQL} THEN ${FEEDBACK_BUILD_ORIGIN_SQL}
  ELSE NULL
END`;

/** Default/standard hides only confidently mismatching reported bundle IDs. */
export function feedbackBuildScopeClause(scope: FeedbackBuildScope): string {
  if (scope === "all") return "1 = 1";
  if (scope === "external") {
    return `(${FEEDBACK_BUILD_ORIGIN_ENABLED_SQL} AND ${FEEDBACK_BUILD_ORIGIN_SQL} = 'external')`;
  }
  return `(NOT ${FEEDBACK_BUILD_ORIGIN_ENABLED_SQL} OR ${FEEDBACK_BUILD_ORIGIN_SQL} != 'external')`;
}

export function feedbackBuildScope(value: string | undefined): FeedbackBuildScope | null {
  if (value === undefined || value === "" || value === "standard") return "standard";
  return value === "external" || value === "all" ? value : null;
}

/** Resolve the exact same classification for a new submission before its insert. */
export async function feedbackSubmissionBuildOrigin(
  db: D1Database,
  appId: string,
  metadata: Record<string, unknown>,
): Promise<FeedbackBuildOrigin | null> {
  const row = await db.prepare(
    `SELECT ${FEEDBACK_BUILD_ORIGIN_FIELD_SQL} AS build_origin
     FROM (SELECT ?1 AS app_id, ?2 AS metadata_json) t`,
  ).bind(appId, JSON.stringify(metadata)).first<{ build_origin: FeedbackBuildOrigin | null }>();
  return row?.build_origin ?? null;
}
