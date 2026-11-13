-- A separate Google authorization for Play Console statistics reports.
--
-- Reading the reports bucket needs devstorage.read_only, a Google Cloud scope.
-- Workspace "Google Cloud session control" makes a grant holding a Cloud scope
-- expire after the organization's reauthentication interval, and the whole
-- refresh token stops working, publishing included. Publishing therefore keeps
-- its own androidpublisher-only grant in app_google_play_bindings, and the
-- reports grant lives here: if it expires, only statistics stop.
CREATE TABLE IF NOT EXISTS google_play_reports_grants (
  app_id TEXT PRIMARY KEY REFERENCES apps(id) ON DELETE CASCADE,
  account_email TEXT NOT NULL,
  credential_fingerprint TEXT NOT NULL,
  credential_ciphertext_b64 TEXT NOT NULL,
  credential_iv_b64 TEXT NOT NULL,
  credential_key_version TEXT NOT NULL,
  created_by_actor TEXT NOT NULL,
  updated_by_actor TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Which authorization a pending OAuth request is for.
ALTER TABLE google_play_oauth_requests ADD COLUMN purpose TEXT NOT NULL DEFAULT 'publishing'
  CHECK (purpose IN ('publishing', 'reports'));
