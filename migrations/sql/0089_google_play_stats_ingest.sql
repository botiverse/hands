-- Google Play Console statistics reports ingestion.
--
-- Play Console exports monthly CSVs to a Google-owned Cloud Storage bucket
-- (gs://pubsite_prod_rev_<digits>/stats/..., older accounts pubsite_prod_<digits>).
-- The current month's file is rewritten daily, so a file is processed per
-- (object name, generation): a new generation replaces that month's rows.

-- Per-app bucket setting, kept apart from app_google_play_bindings so
-- reauthorizing or replacing the credential does not drop it.
CREATE TABLE IF NOT EXISTS google_play_stats_settings (
  app_id TEXT PRIMARY KEY REFERENCES apps(id) ON DELETE CASCADE,
  stats_bucket TEXT CHECK (stats_bucket IS NULL OR (
    stats_bucket GLOB 'pubsite_prod_[0-9]*' OR stats_bucket GLOB 'pubsite_prod_rev_[0-9]*')),
  updated_by_actor TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- One row per statistics CSV Hands has tried to read.
CREATE TABLE IF NOT EXISTS google_play_stats_files (
  app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  object_name TEXT NOT NULL,
  -- installs_overview | store_performance_overview
  report_kind TEXT NOT NULL,
  -- YYYY-MM the file covers.
  month TEXT NOT NULL,
  -- Cloud Storage object generation (integer microseconds); a rewrite gets a new one.
  generation INTEGER NOT NULL,
  md5_hash TEXT,
  size_bytes INTEGER NOT NULL DEFAULT 0,
  row_count INTEGER NOT NULL DEFAULT 0,
  -- JSON array of {code, column?, count?}; never URLs, bodies or credentials.
  warnings_json TEXT NOT NULL DEFAULT '[]',
  processed_at INTEGER NOT NULL,
  -- complete: this generation is final. incomplete: rows written but a required
  -- column was missing or rows did not parse. failed: nothing written (download,
  -- checksum, adapter error). over_limit: larger than Hands reads, nothing written.
  -- All but complete are retried once next_attempt_at passes, or at once when a
  -- new generation appears.
  status TEXT NOT NULL CHECK (status IN ('complete', 'incomplete', 'failed', 'over_limit')),
  attempts INTEGER NOT NULL DEFAULT 1,
  -- Whitelisted code only (e.g. missing_column:Daily User Installs, md5_mismatch).
  last_error TEXT,
  next_attempt_at INTEGER,
  PRIMARY KEY (app_id, object_name)
);
CREATE INDEX IF NOT EXISTS idx_google_play_stats_files_month
  ON google_play_stats_files(app_id, report_kind, month, generation);

-- Whole-app daily values from the overview files (one row per date and metric),
-- so the stats read is O(days x metrics). A file replaces its month's rows of
-- its report_kind in one batch.
CREATE TABLE IF NOT EXISTS google_play_stats_daily_totals (
  app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  report_kind TEXT NOT NULL,
  month TEXT NOT NULL,
  date TEXT NOT NULL,
  metric TEXT NOT NULL,
  value REAL NOT NULL,
  PRIMARY KEY (app_id, date, metric)
);
CREATE INDEX IF NOT EXISTS idx_google_play_stats_daily_totals_month
  ON google_play_stats_daily_totals(app_id, report_kind, month);

-- Persisted rotation for the scheduled ingest, like asc_analytics_ingest_schedule.
CREATE TABLE IF NOT EXISTS google_play_stats_ingest_schedule (
  app_id TEXT PRIMARY KEY REFERENCES apps(id) ON DELETE CASCADE,
  next_run_at INTEGER NOT NULL,
  last_run_at INTEGER,
  -- Whitelisted code only (e.g. play_reports_bucket_forbidden), never provider text.
  last_error_code TEXT
);
