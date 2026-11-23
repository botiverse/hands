import { HANDS_PLAY_TRACKS } from "./play_tracks";
import { settingsOrigin } from "./play_access_origin";
import { enqueueDueDeliveries } from "../routes/webhooks";
import { getGooglePlayBinding, hasGooglePlayConfiguration } from "./google_play_bindings";
import { playDeliveryStatement, playStateLabel } from "./play_notifications";
import { recordPlayAccessFailure, recordPlayAccessSuccess } from "./play_access_alerts";
import { saveTrackSnapshot } from "./play_track_snapshots";
import { upstreamFromPlayCause, type UpstreamDetail } from "./upstream_error";
import { PLAY_RELEASES_LIST, markExhausted, pruneQuotaUsage, take, type QuotaTier } from "./upstream_quota";

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
        AND updated_at=?9 AND ?3 IN (internal_track,closed_track,production_track,'beta'))
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

/**
 * Google rations tracks.releases.list per app ("Listing releases quota
 * exceeded."): measured on 2026-11-22 at 12 calls an hour, resetting around
 * minute :10. A full read is one call per track (four), so the poll reads each
 * app once an hour, within the background tier of the shared ledger
 * (lib/upstream_quota.ts), which leaves the rest for interactive reads
 * (review-status, stats) and the in-review gate before a promotion. When the
 * ledger has no room, the app is skipped and polled again just after the
 * window resets. The cron still ticks every five minutes; at most four apps
 * are claimed per tick. Persisted scheduling rotates through tenants; outages
 * never become state.
 */
export const POLL_INTERVAL_MS = 60 * 60_000;
/** How long after a quota window resets a skipped app is polled again. */
export const QUOTA_RESET_OFFSET_MS = 60_000;

export async function pollGooglePlayReleases(env: Env, now = Date.now()) {
  if (!env.PLAY_RELEASE_SERVICE) return;
  await pruneQuotaUsage(env.DB, now).catch(() => undefined);
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
      WHERE app_id=?2 AND next_poll_at=?3`).bind((Math.floor(now / 300_000) * 300_000) + POLL_INTERVAL_MS, row.app_id, row.next_poll_at).run();
    if (claim.meta.changes !== 1) continue;
    try {
      const binding = await getGooglePlayBinding(env.DB, row.app_id, env.PLAY_CRED_ENC_KEYS);
      if (!binding || !hasGooglePlayConfiguration(binding) || binding.enabled !== 1 || binding.verification_state !== "verified") continue;
      const packageName = binding.package_name;
      const reschedule = (resetAt: number) => env.DB.prepare(`UPDATE google_play_poll_schedule SET next_poll_at=?1
        WHERE app_id=?2`).bind(resetAt + QUOTA_RESET_OFFSET_MS, row.app_id).run().catch(() => undefined);
      const handsTracks = HANDS_PLAY_TRACKS.filter((handsTrack, index) =>
        HANDS_PLAY_TRACKS.findIndex((other) => binding.tracks[other] === binding.tracks[handsTrack]) === index);
      // The whole round is paid for up front: a partial read is not worth starting.
      const budget = await take(env.DB, PLAY_RELEASES_LIST, packageName, "background", handsTracks.length, now);
      if (!budget.ok) {
        console.warn("hands_play_poll_skipped", JSON.stringify({ code: "play_quota_budget", reason: budget.reason }));
        await reschedule(budget.reset_at);
        continue;
      }
      const retryBudget = () => take(env.DB, PLAY_RELEASES_LIST, packageName, "background", 1, now).then((r) => r.ok, () => false);
      let failureCode: string | null = null;
      let failureUpstream: UpstreamDetail | undefined;
      let quotaExhausted = false;
      for (const handsTrack of handsTracks) {
        const track = binding.tracks[handsTrack];
        const reply = await listReleaseStatesWithRetry(env.PLAY_RELEASE_SERVICE, { credential: binding.credential,
          packageName, tracks: binding.tracks, handsTrack }, 1500, retryBudget);
        if (!reply.ok) {
          console.warn("hands_play_poll_failure", JSON.stringify({ code: reply.error.code }));
          // Quota is not access: no alert, and no further reads this round. Google
          // may count calls Hands did not make, so nothing in Hands reads again
          // before the window resets.
          if (reply.error.code === "play_quota_exceeded") {
            quotaExhausted = true;
            const resetAt = await markExhausted(env.DB, PLAY_RELEASES_LIST, packageName, now).catch(() => null);
            if (resetAt !== null) await reschedule(resetAt);
            break;
          }
          if (!failureCode) { failureCode = reply.error.code; failureUpstream = upstreamFromPlayCause(reply.error.cause); }
          continue;
        }
        await saveTrackSnapshot(env.DB, row.app_id, packageName, track, reply.value, now).catch(() => undefined);
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
          await observePlayRelease(env.DB, row.app_id, packageName, track, release,
            version, binding.updated_at, now);
      }
      if (quotaExhausted && !failureCode) continue;
      if (failureCode) await recordPlayAccessFailure(env.DB, row.app_id, "publishing", failureCode, now, settingsOrigin(env), failureUpstream).catch(() => undefined);
      else await recordPlayAccessSuccess(env.DB, row.app_id, "publishing", now).catch(() => undefined);
    } catch {
      // No credential, URL, provider message or release content in logs.
      console.warn("hands_play_poll_failure", JSON.stringify({ code: "poll_unavailable" }));
      await recordPlayAccessFailure(env.DB, row.app_id, "publishing", "poll_unavailable", now, settingsOrigin(env)).catch(() => undefined);
    }
  }
  await enqueueDueDeliveries(env, Date.now()).catch(() => 0);
}

type ReleaseStateService = Pick<NonNullable<Env["PLAY_RELEASE_SERVICE"]>, "listReleaseStates">;

/**
 * A refusal (play_api_rejected) is retried once after a short pause; the read
 * has no side effects. An exhausted quota (play_quota_exceeded) is not retried.
 * The retry spends quota too: `mayRetry` takes it from the ledger, and when it
 * answers false the first answer stands.
 */
export async function listReleaseStatesWithRetry(
  service: ReleaseStateService,
  input: Parameters<ReleaseStateService["listReleaseStates"]>[0],
  pauseMs = 1500,
  mayRetry: () => Promise<boolean> = async () => true,
) {
  const first = await service.listReleaseStates(input);
  if (first.ok || first.error.code !== "play_api_rejected") return first;
  if (!(await mayRetry())) return first;
  await new Promise((resolve) => setTimeout(resolve, pauseMs));
  return service.listReleaseStates(input);
}

/** Why a release-state read did not reach Google, or what Google said about quota. */
export type PlayQuotaNote = { used: number; limit: number; reset_at: number; source: "hands_budget" | "google" };
type ReleaseStatesReply = Awaited<ReturnType<ReleaseStateService["listReleaseStates"]>>;

/**
 * One track's release states, paid for from the shared ledger (one call, and
 * one more for a retry). When the tier has no room Google is not called: the
 * reply is a play_quota_exceeded failure with `quota.source = "hands_budget"`.
 * When Google says the quota is used up, the ledger is marked exhausted until
 * the window resets and `quota.source = "google"`.
 */
export async function listReleaseStatesBudgeted(
  db: D1Database,
  service: ReleaseStateService,
  input: Parameters<ReleaseStateService["listReleaseStates"]>[0],
  tier: QuotaTier,
  clock: () => number = Date.now,
  pauseMs = 1500,
): Promise<{ reply: ReleaseStatesReply; quota?: PlayQuotaNote }> {
  const scope = input.packageName;
  const budget = await take(db, PLAY_RELEASES_LIST, scope, tier, 1, clock());
  if (!budget.ok) {
    return {
      reply: { ok: false, error: { status: 429, code: "play_quota_exceeded",
        message: `Hands' budget for Google Play release reads on this app is used up until ${new Date(budget.reset_at).toISOString()}` } },
      quota: { used: budget.used, limit: budget.limit, reset_at: budget.reset_at, source: "hands_budget" },
    };
  }
  let used = budget.used;
  const reply = await listReleaseStatesWithRetry(service, input, pauseMs, async () => {
    const more = await take(db, PLAY_RELEASES_LIST, scope, tier, 1, clock()).catch(() => null);
    if (more?.ok) used = more.used;
    return Boolean(more?.ok);
  });
  if (!reply.ok && reply.error.code === "play_quota_exceeded") {
    const resetAt = await markExhausted(db, PLAY_RELEASES_LIST, scope, clock()).catch(() => budget.reset_at);
    return { reply, quota: { used, limit: budget.limit, reset_at: resetAt, source: "google" } };
  }
  return { reply };
}
