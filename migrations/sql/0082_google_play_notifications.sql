-- Observations are provider readbacks, never inferred from promotion receipts.
CREATE TABLE google_play_release_observations (
 app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
 package_name TEXT NOT NULL,
 play_track TEXT NOT NULL,
 version_code INTEGER NOT NULL,
 state TEXT NOT NULL,
 revision INTEGER NOT NULL,
 nonce TEXT NOT NULL,
 observed_at INTEGER NOT NULL,
 PRIMARY KEY(app_id,package_name,play_track,version_code)
);
CREATE TABLE google_play_poll_schedule (
 app_id TEXT PRIMARY KEY REFERENCES apps(id) ON DELETE CASCADE,
 next_poll_at INTEGER NOT NULL DEFAULT 0
);
