-- General server-side feature-gate ("feature flags") system. A reusable,
-- fail-safe-OFF gate evaluated per request with per-device targeting. The first
-- consumer is delta-update *offers* (routes/public_v2.ts findDeltaPatch), so we
-- can enable delta for one test device before an app-wide rollout. Note: delta
-- *generation* stays gated by apps.delta_updates_enabled (routes/delta.ts) —
-- generation has no device context. See docs/feature-gate-design.md.
--
-- A row with app_id = NULL is the global default for a key; a row with a
-- concrete app_id overrides it for that app. Uniqueness is on (app_id, key).
CREATE TABLE feature_flags (
  id TEXT PRIMARY KEY,
  app_id TEXT,                 -- nullable: NULL = global default row
  key TEXT NOT NULL,           -- e.g. 'delta_updates'
  default_enabled INTEGER NOT NULL DEFAULT 0,
  rollout_percent INTEGER NOT NULL DEFAULT 0,   -- 0..100
  allow_device_ids TEXT NOT NULL DEFAULT '[]',  -- JSON array of device_id strings
  deny_device_ids TEXT NOT NULL DEFAULT '[]',   -- JSON array
  allow_cohorts TEXT NOT NULL DEFAULT '[]',     -- JSON array (optional dimension)
  platforms TEXT NOT NULL DEFAULT '[]',         -- JSON array; empty = all platforms
  updated_at INTEGER NOT NULL,
  updated_by TEXT,
  FOREIGN KEY (app_id) REFERENCES apps(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX idx_feature_flags_app_key ON feature_flags(app_id, key);
-- Seed delta_updates from the existing per-app column so current behaviour is
-- preserved: apps that already opted into delta keep offering it.
INSERT INTO feature_flags (id, app_id, key, default_enabled, updated_at)
SELECT lower(hex(randomblob(16))), id, 'delta_updates', delta_updates_enabled, 0 FROM apps;
