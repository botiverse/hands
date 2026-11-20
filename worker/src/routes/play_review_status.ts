/**
 * App-wide Google Play release states: for every track bound to the app, each
 * release Play holds with its lifecycle state (DRAFT, IN_REVIEW,
 * APPROVED_NOT_PUBLISHED, NOT_APPROVED, PUBLISHED, ...) and versionCodes.
 *
 * Read live from Play (tracks.releases.list, read-only, the same call the
 * five-minute poll makes). A track Play refuses to list falls back to the
 * last states the poll stored, marked as such with when they were observed,
 * so a caller can tell a live answer from a remembered one.
 */
import type { Context } from "hono";
import type { AdminEnv } from "../middleware/auth";
import { getGooglePlayBinding, hasGooglePlayConfiguration } from "../lib/google_play_bindings";
import { listReleaseStatesWithRetry } from "../lib/play_release_poll";
import { playStateLabel } from "../lib/play_notifications";

type AdminContext = Context<AdminEnv & { Bindings: Env }>;
type HandsTrack = "internal" | "closed" | "production";
const HANDS_TRACKS: HandsTrack[] = ["internal", "closed", "production"];

type ReleaseRow = { release_name: string | null; state: string; state_label: string; version_codes: number[]; observed_at?: number };
type TrackStatus = {
  hands_track: HandsTrack;
  play_track: string;
  source: "live" | "stored" | "unavailable";
  releases: ReleaseRow[];
  error_code?: string;
};

/** PUBLISHED, not APPROVED_NOT_PUBLISHED. */
const isPublished = (state: string) => state.endsWith("_PUBLISHED") && !state.endsWith("NOT_PUBLISHED");

export async function handleGetPlayReviewStatus(c: AdminContext) {
  const appId = c.req.param("appId") ?? "";
  const binding = await getGooglePlayBinding(c.env.DB, appId, c.env.PLAY_CRED_ENC_KEYS).catch(() => null);
  if (!binding || !hasGooglePlayConfiguration(binding) || binding.enabled !== 1 || binding.verification_state !== "verified" || !binding.tracks) {
    return c.json({ error: "Google Play is not connected and verified for this app", code: "play_binding_not_ready" }, 409);
  }
  const service = c.env.PLAY_RELEASE_SERVICE;
  const packageName = binding.package_name!;
  const tracks: TrackStatus[] = [];
  const seen = new Set<string>();
  for (const handsTrack of HANDS_TRACKS) {
    const playTrack = binding.tracks[handsTrack];
    if (seen.has(playTrack)) continue;
    seen.add(playTrack);
    let errorCode = service ? null : "play_service_unavailable";
    if (service) {
      const reply = await listReleaseStatesWithRetry(service, { credential: binding.credential, packageName, tracks: binding.tracks, handsTrack });
      if (reply.ok) {
        tracks.push({
          hands_track: handsTrack,
          play_track: playTrack,
          source: "live",
          releases: reply.value.filter((r) => r.track === playTrack).map((r) => ({
            release_name: r.releaseName || null,
            state: r.releaseLifecycleState,
            state_label: playStateLabel(r.releaseLifecycleState),
            version_codes: r.activeArtifacts.map((a) => a.versionCode).sort((a, b) => b - a),
          })),
        });
        continue;
      }
      errorCode = reply.error.code;
    }
    const { results: observed } = await c.env.DB.prepare(
      `SELECT version_code, state, observed_at FROM google_play_release_observations
       WHERE app_id = ?1 AND package_name = ?2 AND play_track = ?3 ORDER BY version_code DESC LIMIT 50`,
    ).bind(appId, packageName, playTrack).all<{ version_code: number; state: string; observed_at: number }>();
    // The poll records a versionCode's state only when it changes, so a
    // release that left the track keeps its last state forever. A newer
    // published release supersedes everything below it on a track: keep
    // that one and anything newer.
    const newestPublished = observed.find((r) => isPublished(r.state))?.version_code ?? 0;
    const results = observed.filter((r) => r.version_code >= newestPublished);
    tracks.push({
      hands_track: handsTrack,
      play_track: playTrack,
      source: results.length ? "stored" : "unavailable",
      error_code: errorCode ?? "play_unavailable",
      releases: results.map((r) => ({
        release_name: null, state: r.state, state_label: playStateLabel(r.state), version_codes: [r.version_code], observed_at: r.observed_at,
      })),
    });
  }
  const inReview = tracks.flatMap((t) => t.releases.filter((r) => r.state.endsWith("IN_REVIEW"))
    .map((r) => ({ hands_track: t.hands_track, play_track: t.play_track, version_codes: r.version_codes, release_name: r.release_name, source: t.source })));
  const production = tracks.find((t) => t.hands_track === "production");
  const publishedProduction = production?.releases.filter((r) => isPublished(r.state)).flatMap((r) => r.version_codes) ?? [];
  const access = await c.env.DB.prepare(
    "SELECT failing_since, last_error_code FROM google_play_access_state WHERE app_id = ?1 AND access = 'publishing'",
  ).bind(appId).first<{ failing_since: number; last_error_code: string }>().catch(() => null);
  return c.json({
    package_name: packageName,
    read_at: Date.now(),
    tracks,
    in_review: inReview,
    production_version_code: publishedProduction.length ? Math.max(...publishedProduction) : null,
    publishing_access: access ? { failing_since: access.failing_since, last_error_code: access.last_error_code } : null,
  });
}
