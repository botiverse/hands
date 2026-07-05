CREATE TABLE IF NOT EXISTS release_metrics (
  release_id TEXT PRIMARY KEY REFERENCES releases(id) ON DELETE CASCADE,
  offered_count INTEGER NOT NULL DEFAULT 0,
  current_count INTEGER NOT NULL DEFAULT 0,
  last_checked_at INTEGER
);
