import { HANDS_PLAY_TRACKS, type HandsPlayTrack } from "../lib/play_tracks";
/**
 * App-wide Google Play release states: for every track bound to the app, each
 * release Play holds with its lifecycle state (DRAFT, IN_REVIEW,
 * APPROVED_NOT_PUBLISHED, NOT_APPROVED, PUBLISHED, ...) and versionCodes.
 *
 * By default each track is served from the last answer Play gave Hands
 * (google_play_track_snapshots: the hourly poll or any live read), marked
 * `cached` with its `read_at`, because Google allows tracks.releases.list only
 * about 12 times per app per hour. `?live=1` reads Play (read-only) and stores
 * the answer; a track with no snapshot yet is read live too. A track Play refuses to list falls back to the
 * last states the poll stored, marked as such with when they were observed,
 * so a caller can tell a live answer from a remembered one. It also gets the
 * track's current contents read through an edit (`track_contents`): release
 * status and versionCodes as Play holds them now, without review state.
 */
import type { Context } from "hono";
import type { AdminEnv } from "../middleware/auth";
import { getGooglePlayBinding, hasGooglePlayConfiguration } from "../lib/google_play_bindings";
import { listReleaseStatesWithRetry } from "../lib/play_release_poll";
import { playStateLabel } from "../lib/play_notifications";
import { loadTrackSnapshots, saveTrackSnapshot, type SnapshotRelease, type TrackSnapshot } from "../lib/play_track_snapshots";
import { upstreamFromPlayCause, type UpstreamDetail } from "../lib/upstream_error";

type AdminContext = Context<AdminEnv & { Bindings: Env }>;
type HandsTrack = HandsPlayTrack;
const HANDS_TRACKS: readonly HandsTrack[] = HANDS_PLAY_TRACKS;

type ReleaseRow = { release_name: string | null; state: string; state_label: string; version_codes: number[]; observed_at?: number };
type TrackContent = { release_name: string | null; status: string; version_codes: number[]; user_fraction?: number };
type TrackStatus = {
  hands_track: HandsTrack;
  play_track: string;
  source: "live" | "cached" | "stored" | "unavailable";
  /** When Play gave this answer (live and cached). */
  read_at?: number;
  releases: ReleaseRow[];
  error_code?: string;
  /** What Google said when the live read failed (lib/upstream_error.ts). */
  upstream?: UpstreamDetail;
  /** Only when the release-state read was refused and the edit read worked. */
  track_contents?: TrackContent[];
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
  const wantLive = ["1", "true"].includes(c.req.query("live") ?? "");
  const snapshots: Map<string, TrackSnapshot> = await loadTrackSnapshots(c.env.DB, appId, packageName).catch(() => new Map());
  const rows = (releases: SnapshotRelease[], playTrack: string) => releases.filter((r) => r.track === playTrack).map((r) => ({
    release_name: r.releaseName || null,
    state: r.releaseLifecycleState,
    state_label: playStateLabel(r.releaseLifecycleState),
    version_codes: r.activeArtifacts.map((a) => a.versionCode).sort((a, b) => b - a),
  }));
  for (const handsTrack of HANDS_TRACKS) {
    const playTrack = binding.tracks[handsTrack];
    if (seen.has(playTrack)) continue;
    seen.add(playTrack);
    const snapshot = snapshots.get(playTrack);
    if (snapshot && !wantLive) {
      tracks.push({ hands_track: handsTrack, play_track: playTrack, source: "cached", read_at: snapshot.read_at, releases: rows(snapshot.releases, playTrack) });
      continue;
    }
    let errorCode = service ? null : "play_service_unavailable";
    let upstream: UpstreamDetail | undefined;
    if (service) {
      const reply = await listReleaseStatesWithRetry(service, { credential: binding.credential, packageName, tracks: binding.tracks, handsTrack });
      if (reply.ok) {
        const readAt = Date.now();
        await saveTrackSnapshot(c.env.DB, appId, packageName, playTrack, reply.value, readAt).catch(() => undefined);
        tracks.push({ hands_track: handsTrack, play_track: playTrack, source: "live", read_at: readAt, releases: rows(reply.value, playTrack) });
        continue;
      }
      errorCode = reply.error.code;
      upstream = upstreamFromPlayCause(reply.error.cause);
    }
    if (snapshot) {
      // The live read failed; the last answer Play gave is still the best one.
      tracks.push({ hands_track: handsTrack, play_track: playTrack, source: "cached", read_at: snapshot.read_at,
        error_code: errorCode ?? "play_unavailable", ...(upstream ? { upstream } : {}), releases: rows(snapshot.releases, playTrack) });
      continue;
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
    let trackContents: TrackContent[] | undefined;
    if (service?.readTrackContents) {
      const contents = await service.readTrackContents({ credential: binding.credential, packageName, tracks: binding.tracks, handsTrack })
        .catch(() => null);
      if (contents?.ok) {
        trackContents = contents.value.map((r) => ({
          release_name: r.name, status: r.status, version_codes: r.version_codes,
          ...(r.user_fraction !== undefined ? { user_fraction: r.user_fraction } : {}),
        }));
      }
    }
    tracks.push({
      hands_track: handsTrack,
      play_track: playTrack,
      source: results.length ? "stored" : "unavailable",
      error_code: errorCode ?? "play_unavailable",
      ...(upstream ? { upstream } : {}),
      releases: results.map((r) => ({
        release_name: null, state: r.state, state_label: playStateLabel(r.state), version_codes: [r.version_code], observed_at: r.observed_at,
      })),
      ...(trackContents ? { track_contents: trackContents } : {}),
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
