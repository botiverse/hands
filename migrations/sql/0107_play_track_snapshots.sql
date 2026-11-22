-- The last full answer Google Play gave for each bound track
-- (tracks.releases.list), whoever asked: the hourly poll or a live read.
-- Google allows that call about 12 times per app per hour, so review-status and
-- stats serve this snapshot, with its read time, unless a live read is asked for.
CREATE TABLE google_play_track_snapshots (
  app_id TEXT NOT NULL,
  package_name TEXT NOT NULL,
  play_track TEXT NOT NULL,
  releases_json TEXT NOT NULL,
  read_at INTEGER NOT NULL,
  PRIMARY KEY (app_id, package_name, play_track)
);
