-- Every channel and version a device used on a UTC day, one row each,
-- recorded from every ping (POST /api/v1/analytics/ping). device_ping_days
-- keeps only the first ping of the day, so a device that upgrades that day
-- counts only on the old version there; this table counts it on both. The
-- daily background system kill summary uses it as the active-device
-- denominator, so the denominator does not depend on whether a device
-- reported an exit.
CREATE TABLE IF NOT EXISTS device_version_days (
  app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  day TEXT NOT NULL,           -- YYYY-MM-DD (UTC)
  channel TEXT NOT NULL,       -- 'unknown' when the ping named none
  version_code INTEGER NOT NULL,
  device_id TEXT NOT NULL,
  PRIMARY KEY (app_id, day, channel, version_code, device_id)
);
