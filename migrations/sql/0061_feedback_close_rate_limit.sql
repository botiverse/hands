-- The reporter-close route uses the same durable rate-limit ledger as the
-- existing reporter conversation endpoints. Migration 0051 predates close
-- and its table CHECK therefore rejects endpoint='close' before the handler
-- can reach the owned-ticket mutation.

ALTER TABLE feedback_reporter_rate_windows
  RENAME TO feedback_reporter_rate_windows_legacy;

CREATE TABLE feedback_reporter_rate_windows (
  app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  reporter_integration_id TEXT NOT NULL REFERENCES app_reporter_integrations(id) ON DELETE CASCADE,
  reporter_hash TEXT NOT NULL,
  audit_key_version TEXT NOT NULL,
  endpoint TEXT NOT NULL
    CHECK (endpoint IN ('list', 'detail', 'attachment', 'comment', 'close')),
  window_started_at INTEGER NOT NULL,
  request_count INTEGER NOT NULL DEFAULT 0 CHECK (request_count >= 0),
  last_audited_at INTEGER,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (
    app_id,
    reporter_integration_id,
    reporter_hash,
    audit_key_version,
    endpoint,
    window_started_at
  )
);

INSERT INTO feedback_reporter_rate_windows (
  app_id,
  reporter_integration_id,
  reporter_hash,
  audit_key_version,
  endpoint,
  window_started_at,
  request_count,
  last_audited_at,
  updated_at
)
SELECT
  app_id,
  reporter_integration_id,
  reporter_hash,
  audit_key_version,
  endpoint,
  window_started_at,
  request_count,
  last_audited_at,
  updated_at
FROM feedback_reporter_rate_windows_legacy;

DROP TABLE feedback_reporter_rate_windows_legacy;

CREATE INDEX idx_feedback_reporter_rate_windows_updated
  ON feedback_reporter_rate_windows(updated_at);

-- Keep the durable access-audit endpoint contract aligned with the route
-- endpoint union as well, even though close currently writes its mutation
-- audit to audit_logs rather than this read-audit table.
ALTER TABLE feedback_reporter_access_audits
  RENAME TO feedback_reporter_access_audits_legacy;

CREATE TABLE feedback_reporter_access_audits (
  id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  reporter_integration_id TEXT NOT NULL REFERENCES app_reporter_integrations(id) ON DELETE CASCADE,
  reporter_hash TEXT NOT NULL,
  audit_key_version TEXT NOT NULL,
  endpoint TEXT NOT NULL
    CHECK (endpoint IN ('list', 'detail', 'attachment', 'comment', 'close')),
  ticket_id TEXT,
  attachment_id TEXT,
  throttle_window_started_at INTEGER,
  created_at INTEGER NOT NULL
);

INSERT INTO feedback_reporter_access_audits (
  id,
  app_id,
  reporter_integration_id,
  reporter_hash,
  audit_key_version,
  endpoint,
  ticket_id,
  attachment_id,
  throttle_window_started_at,
  created_at
)
SELECT
  id,
  app_id,
  reporter_integration_id,
  reporter_hash,
  audit_key_version,
  endpoint,
  ticket_id,
  attachment_id,
  throttle_window_started_at,
  created_at
FROM feedback_reporter_access_audits_legacy;

DROP TABLE feedback_reporter_access_audits_legacy;

CREATE INDEX idx_feedback_reporter_access_audits_lookup
  ON feedback_reporter_access_audits(
    app_id, reporter_integration_id, reporter_hash, endpoint, created_at DESC
  );

CREATE INDEX idx_feedback_reporter_access_audits_retention
  ON feedback_reporter_access_audits(created_at);

CREATE UNIQUE INDEX idx_feedback_reporter_access_audits_throttle
  ON feedback_reporter_access_audits(
    app_id, reporter_integration_id, reporter_hash, audit_key_version,
    endpoint, throttle_window_started_at
  )
  WHERE throttle_window_started_at IS NOT NULL;
