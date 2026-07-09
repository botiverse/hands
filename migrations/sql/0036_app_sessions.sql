-- Session events for release health (crash-free rate) — sdk-parity P0.1.
-- One row per client session. `start` inserts; `end` (or a next-launch
-- crash marker) updates the same row. device_id is the same random
-- per-install UUID device_pings uses — no PII.
CREATE TABLE app_sessions (
  app_id TEXT NOT NULL REFERENCES apps(id),
  session_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  version_name TEXT,
  version_code INTEGER,
  channel TEXT,
  platform TEXT,
  os_version TEXT,
  device_model TEXT,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  duration_ms INTEGER,
  crashed INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (app_id, session_id)
);

CREATE INDEX idx_app_sessions_app_started ON app_sessions(app_id, started_at);
CREATE INDEX idx_app_sessions_app_version ON app_sessions(app_id, version_code, started_at);
