-- Advisory QA/verification results written back by external systems (e.g.
-- Stamp) after a release:draft_created webhook. One row per (release, source):
-- a source re-posting replaces its previous verdict for that release. Checks
-- are informational only — they never gate publish.
CREATE TABLE release_checks (
  id TEXT PRIMARY KEY,
  release_id TEXT NOT NULL REFERENCES releases(id) ON DELETE CASCADE,
  app_id TEXT NOT NULL,
  source TEXT NOT NULL,
  run_id TEXT,
  run_url TEXT,
  verdict TEXT NOT NULL CHECK (verdict IN ('passed', 'failed', 'warning', 'skipped')),
  cases_total INTEGER,
  cases_passed INTEGER,
  summary TEXT,
  reviewer TEXT,
  reviewed_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (release_id, source)
);

CREATE INDEX IF NOT EXISTS idx_release_checks_release
  ON release_checks(release_id, updated_at);
