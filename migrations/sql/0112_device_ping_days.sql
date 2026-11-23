-- One row per device per UTC day it pinged (POST /api/v1/analytics/ping), so
-- stats can give daily active devices and a per-country split for any date
-- range. device_pings keeps only each device's latest ping.
CREATE TABLE IF NOT EXISTS device_ping_days (
  app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  day TEXT NOT NULL,          -- YYYY-MM-DD (UTC)
  device_id TEXT NOT NULL,
  channel TEXT,
  platform TEXT,
  version_code INTEGER,
  country TEXT,               -- ISO 3166-1 alpha-2 from Cloudflare at the first ping that day; NULL when unknown
  PRIMARY KEY (app_id, day, device_id)
);
CREATE INDEX IF NOT EXISTS idx_device_ping_days_app_day ON device_ping_days(app_id, day);
