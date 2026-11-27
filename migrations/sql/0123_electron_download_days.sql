-- Download requests to the public Electron update route
-- (/electron/:slug/:channel/:file), one row per served file per UTC day;
-- update metadata (latest*.yml) is not counted. Whole-file requests and Range requests
-- (electron-updater's blockmap differential download) are counted apart, so a
-- patch, a full archive download and a differential download can be told apart
-- for clients that report nothing themselves.
CREATE TABLE IF NOT EXISTS electron_download_days (
  asset_id TEXT NOT NULL,
  day TEXT NOT NULL,                 -- YYYY-MM-DD (UTC)
  app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  build_id TEXT NOT NULL,
  file TEXT NOT NULL,                -- file name as first requested that day
  role TEXT NOT NULL,                -- 'patch' | 'full' | 'blockmap'
  full_requests INTEGER NOT NULL DEFAULT 0,
  range_requests INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (asset_id, day)
);
CREATE INDEX IF NOT EXISTS idx_electron_download_days_app_day
  ON electron_download_days(app_id, day);

-- Distinct requesters per file and day. source_hash is an HMAC of the day, IP
-- and user agent: no raw IP is stored, and the same client hashes differently
-- on different days, so sources cannot be followed across days.
CREATE TABLE IF NOT EXISTS electron_download_day_sources (
  asset_id TEXT NOT NULL,
  day TEXT NOT NULL,
  app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  source_hash TEXT NOT NULL,
  PRIMARY KEY (asset_id, day, source_hash)
);
CREATE INDEX IF NOT EXISTS idx_electron_download_day_sources_app_day
  ON electron_download_day_sources(app_id, day);
