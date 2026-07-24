-- Exact per-release update-check UVs. Existing release_metrics counters remain
-- the all-time request/event totals (PV). Historical UV cannot be reconstructed
-- from those aggregates, so this set starts collecting at migration time.
CREATE TABLE IF NOT EXISTS release_metric_devices (
  release_id     TEXT NOT NULL REFERENCES releases(id) ON DELETE CASCADE,
  metric_kind    TEXT NOT NULL CHECK(metric_kind IN ('current', 'offered')),
  device_id      TEXT NOT NULL,
  first_checked_at INTEGER NOT NULL,
  last_checked_at  INTEGER NOT NULL,
  PRIMARY KEY (release_id, metric_kind, device_id)
);

CREATE INDEX IF NOT EXISTS idx_release_metric_devices_release_kind
  ON release_metric_devices(release_id, metric_kind);
