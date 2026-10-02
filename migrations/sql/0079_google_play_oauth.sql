ALTER TABLE app_google_play_bindings ADD COLUMN credential_kind TEXT NOT NULL DEFAULT 'service_account' CHECK (credential_kind IN ('service_account', 'authorized_user'));

CREATE TABLE google_play_oauth_requests (
  state_hash TEXT PRIMARY KEY,
  app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES raft_accounts(id) ON DELETE CASCADE,
  authenticated_account_id TEXT NOT NULL REFERENCES raft_accounts(id) ON DELETE CASCADE,
  org_id TEXT,
  client_id TEXT NOT NULL,
  package_name TEXT NOT NULL,
  tracks_json TEXT NOT NULL,
  expected_binding_version TEXT,
  verifier_ciphertext_b64 TEXT NOT NULL,
  verifier_iv_b64 TEXT NOT NULL,
  verifier_key_version TEXT NOT NULL,
  consumed_at INTEGER,
  expires_at INTEGER NOT NULL
);
CREATE INDEX google_play_oauth_requests_expiry ON google_play_oauth_requests(expires_at);
