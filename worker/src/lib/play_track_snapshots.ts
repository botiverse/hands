/**
 * The last full tracks.releases.list answer per bound track. Google rations that
 * call (about 12 per app per hour), so every successful read is kept here and
 * readers that do not need a fresh answer use it, with its read time.
 */
export type SnapshotRelease = { releaseName: string; track: string; activeArtifacts: Array<{ versionCode: number }>; releaseLifecycleState: string };
export type TrackSnapshot = { releases: SnapshotRelease[]; read_at: number };

/** Keeps only this track's releases; an older read never replaces a newer one. */
export async function saveTrackSnapshot(db: D1Database, appId: string, packageName: string, playTrack: string,
  releases: SnapshotRelease[], readAt: number): Promise<void> {
  const kept = releases.filter((r) => r.track === playTrack).slice(0, 20).map((r) => ({
    releaseName: r.releaseName, track: r.track, releaseLifecycleState: r.releaseLifecycleState,
    activeArtifacts: r.activeArtifacts.map((a) => ({ versionCode: a.versionCode })),
  }));
  await db.prepare(`INSERT INTO google_play_track_snapshots (app_id, package_name, play_track, releases_json, read_at)
    VALUES (?1, ?2, ?3, ?4, ?5)
    ON CONFLICT (app_id, package_name, play_track) DO UPDATE SET releases_json = excluded.releases_json, read_at = excluded.read_at
    WHERE google_play_track_snapshots.read_at <= excluded.read_at`)
    .bind(appId, packageName, playTrack, JSON.stringify(kept), readAt).run();
}

export async function loadTrackSnapshots(db: D1Database, appId: string, packageName: string): Promise<Map<string, TrackSnapshot>> {
  const { results } = await db.prepare(`SELECT play_track, releases_json, read_at FROM google_play_track_snapshots
    WHERE app_id = ?1 AND package_name = ?2`).bind(appId, packageName)
    .all<{ play_track: string; releases_json: string; read_at: number }>();
  const out = new Map<string, TrackSnapshot>();
  for (const row of results) {
    try {
      const releases = JSON.parse(row.releases_json) as SnapshotRelease[];
      if (Array.isArray(releases)) out.set(row.play_track, { releases, read_at: row.read_at });
    } catch { /* an unreadable row is treated as absent */ }
  }
  return out;
}
