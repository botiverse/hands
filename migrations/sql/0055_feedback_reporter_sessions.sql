-- Short-lived reporter-session mint quotas. Session signing keys and session
-- bytes never enter D1; this table stores only opaque ids and audit-HMAC
-- pseudonyms needed to bound full-auth mint amplification.
CREATE TABLE feedback_reporter_session_mint_rate_windows (
  app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  reporter_integration_id TEXT NOT NULL
    REFERENCES app_reporter_integrations(id) ON DELETE CASCADE,
  deploy_token_id TEXT NOT NULL REFERENCES app_deploy_tokens(id) ON DELETE CASCADE,
  reporter_hash TEXT NOT NULL,
  audit_key_version TEXT NOT NULL,
  window_started_at INTEGER NOT NULL,
  request_count INTEGER NOT NULL DEFAULT 0 CHECK (request_count >= 0),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (
    app_id,
    reporter_integration_id,
    deploy_token_id,
    reporter_hash,
    audit_key_version,
    window_started_at
  )
);

CREATE INDEX idx_feedback_reporter_session_mint_rate_updated
  ON feedback_reporter_session_mint_rate_windows(updated_at);
