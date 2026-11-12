-- App Store Connect Analytics Reports ingestion.
--
-- Each Apple report instance is ingested until it is complete. Its parsed rows are
-- stored per instance, so writing an instance again replaces its own rows
-- instead of adding to them. Readers pick one instance per (report, date):
-- an ONGOING and a ONE_TIME_SNAPSHOT request can both cover the same day, and
-- summing both would double count.
CREATE TABLE IF NOT EXISTS asc_analytics_instances (
  app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  instance_id TEXT NOT NULL,
  report_id TEXT NOT NULL,
  report_name TEXT NOT NULL,
  granularity TEXT NOT NULL,
  processing_date TEXT NOT NULL,
  segment_count INTEGER NOT NULL DEFAULT 0,
  row_count INTEGER NOT NULL DEFAULT 0,
  -- JSON array of {code, column?, values?, count?}; never URLs or credentials.
  warnings_json TEXT NOT NULL DEFAULT '[]',
  processed_at INTEGER NOT NULL,
  -- complete: never read again. incomplete: rows written but a required column
  -- was missing or values were unmapped. failed: nothing written (download,
  -- checksum, API error). over_limit: more segments/bytes than Hands reads in one
  -- go, nothing written. All but complete are retried once next_attempt_at passes.
  status TEXT NOT NULL DEFAULT 'complete' CHECK (status IN ('complete', 'incomplete', 'failed', 'over_limit')),
  attempts INTEGER NOT NULL DEFAULT 1,
  -- Whitelisted code only (e.g. missing_column:Unique Devices, segment_checksum_mismatch).
  last_error TEXT,
  next_attempt_at INTEGER,
  PRIMARY KEY (app_id, instance_id)
);

-- One row per (instance, day, metric, dimension). dimension_key is the
-- territory code ('' when the report has no Territory column) so the key stays
-- usable in a primary key; NULL would never conflict.
CREATE TABLE IF NOT EXISTS asc_analytics_daily (
  app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  instance_id TEXT NOT NULL,
  report_name TEXT NOT NULL,
  processing_date TEXT NOT NULL,
  date TEXT NOT NULL,
  metric TEXT NOT NULL,
  dimension_key TEXT NOT NULL DEFAULT '',
  value INTEGER NOT NULL,
  PRIMARY KEY (app_id, instance_id, date, metric, dimension_key)
);
CREATE INDEX IF NOT EXISTS idx_asc_analytics_daily_app_date
  ON asc_analytics_daily(app_id, date, report_name);

-- The same rows summed over dimension_key, written in the same batch. The stats
-- read uses only this table, so it touches (days x metrics x instances) rows
-- instead of one row per territory.
CREATE TABLE IF NOT EXISTS asc_analytics_daily_totals (
  app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  instance_id TEXT NOT NULL,
  report_name TEXT NOT NULL,
  processing_date TEXT NOT NULL,
  date TEXT NOT NULL,
  metric TEXT NOT NULL,
  value INTEGER NOT NULL,
  PRIMARY KEY (app_id, instance_id, date, metric)
);
-- Covers the per-(report, date) winner selection.
CREATE INDEX IF NOT EXISTS idx_asc_analytics_daily_totals_winner
  ON asc_analytics_daily_totals(app_id, date, report_name, processing_date, instance_id);

-- Persisted rotation for the scheduled ingest, like google_play_poll_schedule.
CREATE TABLE IF NOT EXISTS asc_analytics_ingest_schedule (
  app_id TEXT PRIMARY KEY REFERENCES apps(id) ON DELETE CASCADE,
  next_run_at INTEGER NOT NULL,
  last_run_at INTEGER,
  -- Whitelisted code only (e.g. asc_api_403), never provider text or URLs.
  last_error_code TEXT
);
