-- Migration 0033: device_pings
-- Lightweight active-device / version-distribution telemetry. The SDK sends
-- a throttled (≤1/day/device) ping on launch; the server upserts one row per
-- (app_id, device_id). Row count converges to the active device count, so no
-- retention job is needed. device_id is a random per-install UUID, not a
-- hardware id — no PII.

CREATE TABLE IF NOT EXISTS device_pings (
  app_id        TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  device_id     TEXT NOT NULL,
  version_name  TEXT,
  version_code  INTEGER,
  channel       TEXT,
  platform      TEXT,
  arch          TEXT,
  os_version    TEXT,
  device_model  TEXT,
  locale        TEXT,
  first_seen    INTEGER NOT NULL,
  last_seen     INTEGER NOT NULL,
  ping_count    INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (app_id, device_id)
);

CREATE INDEX IF NOT EXISTS idx_device_pings_app_seen
  ON device_pings(app_id, last_seen DESC);
CREATE INDEX IF NOT EXISTS idx_device_pings_app_version
  ON device_pings(app_id, version_code);
