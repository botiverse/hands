import { enqueueDueDeliveries } from "../routes/webhooks";
import { getGooglePlayBinding, hasGooglePlayConfiguration } from "./google_play_bindings";
import { playDeliveryStatement, playStateLabel } from "./play_notifications";

type Summary = { releaseName: string; track: string; activeArtifacts: Array<{ versionCode: number }>; releaseLifecycleState: string };
/** A changed observation and its deliveries commit atomically. The nonce and
 * revision guard stop overlapping polls from publishing stale transitions. */
export async function observePlayRelease(db: D1Database, appId: string, packageName: string,
  track: string, release: Summary, versionCode: number, bindingRevision: number, now: number) {
  const old = await db.prepare(`SELECT state,revision FROM google_play_release_observations
    WHERE app_id=?1 AND package_name=?2 AND play_track=?3 AND version_code=?4`)
    .bind(appId, packageName, track, versionCode).first<{ state: string; revision: number }>();
  if (old?.state === release.releaseLifecycleState) return;
  const nonce = crypto.randomUUID();
  const revision = (old?.revision ?? 0) + 1;
  const upsert = db.prepare(`INSERT INTO google_play_release_observations
    (app_id,package_name,play_track,version_code,state,revision,nonce,observed_at)
    SELECT ?1,?2,?3,?4,?5,?6,?7,?8 WHERE EXISTS (SELECT 1 FROM app_google_play_bindings
      WHERE app_id=?1 AND package_name=?2 AND enabled=1 AND verification_state='verified'
        AND updated_at=?9 AND ?3 IN (internal_track,closed_track,production_track))
    ON CONFLICT(app_id,package_name,play_track,version_code) DO UPDATE SET
      state=excluded.state,revision=excluded.revision,nonce=excluded.nonce,observed_at=excluded.observed_at
    WHERE google_play_release_observations.revision=?10
      AND google_play_release_observations.observed_at<=?8`)
    .bind(appId, packageName, track, versionCode, release.releaseLifecycleState,
      revision, nonce, now, bindingRevision, old?.revision ?? 0);
  const event = "google_play:release_state_changed";
  const eventId = `hands-play-state:${appId}:${packageName}:${track}:${versionCode}:${revision}`;
  await db.batch([upsert, playDeliveryStatement(db, appId, event, eventId, {
    source: "google_play_release_lifecycle", platform: "ANDROID", package_name: packageName,
    track, version: release.releaseName, version_code: versionCode,
    previous_state: old?.state ?? null, state: release.releaseLifecycleState,
    state_label: playStateLabel(release.releaseLifecycleState),
    observation: old ? "transition" : "initial_snapshot",
    observation_display: old ? "状态变化" : "首次查询快照（不是刚发生的审核变化）", occurred_at: new Date(now).toISOString(),
  }, now, `SELECT 1 FROM google_play_release_observations WHERE app_id=?5
    AND package_name=?6 AND play_track=?7 AND version_code=?8 AND nonce=?9`,
    [packageName, track, versionCode, nonce])]);
}

/** At most four apps / twelve read-only track calls per five-minute tick.
 * Persisted scheduling rotates through tenants; outages never become state. */
export async function pollGooglePlayReleases(env: Env, now = Date.now()) {
  if (!env.PLAY_RELEASE_SERVICE) return;
  await env.DB.prepare(`INSERT OR IGNORE INTO google_play_poll_schedule(app_id,next_poll_at)
    SELECT app_id,0 FROM app_google_play_bindings WHERE enabled=1 AND verification_state='verified'
      AND package_name IS NOT NULL`).run();
  const { results } = await env.DB.prepare(`SELECT s.app_id,s.next_poll_at FROM google_play_poll_schedule s
    JOIN app_google_play_bindings b ON b.app_id=s.app_id WHERE s.next_poll_at<=?1
    AND b.enabled=1 AND b.verification_state='verified' AND b.package_name IS NOT NULL
    ORDER BY s.next_poll_at,s.app_id LIMIT 4`).bind(now).all<{ app_id: string; next_poll_at: number }>();
  for (const row of results) {
    // Anchor cooldown to cron slots: a few milliseconds of invocation jitter
    // must not suppress the next five-minute tick. The CAS still claims once.
    const claim = await env.DB.prepare(`UPDATE google_play_poll_schedule SET next_poll_at=?1
      WHERE app_id=?2 AND next_poll_at=?3`).bind((Math.floor(now / 300_000) + 1) * 300_000, row.app_id, row.next_poll_at).run();
    if (claim.meta.changes !== 1) continue;
    try {
      const binding = await getGooglePlayBinding(env.DB, row.app_id, env.PLAY_CRED_ENC_KEYS);
      if (!binding || !hasGooglePlayConfiguration(binding) || binding.enabled !== 1 || binding.verification_state !== "verified") continue;
      const seenTracks = new Set<string>();
      for (const handsTrack of ["internal", "closed", "production"] as const) {
        const track = binding.tracks[handsTrack];
        if (seenTracks.has(track)) continue;
        seenTracks.add(track);
        const reply = await env.PLAY_RELEASE_SERVICE.listReleaseStates({ credential: binding.credential,
          packageName: binding.package_name, tracks: binding.tracks, handsTrack });
        if (!reply.ok) {
          console.warn("hands_play_poll_failure", JSON.stringify({ code: reply.error.code }));
          continue;
        }
        // Duplicate version codes with conflicting states are ambiguous: omit
        // them, rather than guessing which release represents this artifact.
        const versions = new Map<number, Summary | null>();
        for (const release of reply.value) {
          if (release.track !== track) continue;
          for (const artifact of release.activeArtifacts) {
            const prior = versions.get(artifact.versionCode);
            versions.set(artifact.versionCode, prior === null
              || (prior && prior.releaseLifecycleState !== release.releaseLifecycleState) ? null : release);
          }
        }
        for (const [version, release] of versions) if (release)
          await observePlayRelease(env.DB, row.app_id, binding.package_name, track, release,
            version, binding.updated_at, now);
      }
    } catch {
      // No credential, URL, provider message or release content in logs.
      console.warn("hands_play_poll_failure", JSON.stringify({ code: "poll_unavailable" }));
    }
  }
  await enqueueDueDeliveries(env, Date.now()).catch(() => 0);
}
