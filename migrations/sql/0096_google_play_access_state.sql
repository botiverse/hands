-- Google Play access health per app: statistics reports (the stats grant) and
-- publishing (release status polling). A row exists only while access is
-- failing; alerted_at records the one alert sent for this failure, and the row
-- is removed (with a "restored" notice if an alert went out) on the next success.
CREATE TABLE IF NOT EXISTS google_play_access_state (
  app_id          TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  access          TEXT NOT NULL CHECK (access IN ('statistics', 'publishing')),
  failing_since   INTEGER NOT NULL,
  last_failure_at INTEGER NOT NULL,
  last_error_code TEXT NOT NULL,
  alerted_at      INTEGER,
  PRIMARY KEY (app_id, access)
);
