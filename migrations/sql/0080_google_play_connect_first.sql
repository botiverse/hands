-- OAuth may connect before package/track configuration. Preserve all existing bindings and pending authorizations.
CREATE TABLE app_google_play_bindings_new (
  id                         TEXT PRIMARY KEY,
  app_id                     TEXT NOT NULL UNIQUE REFERENCES apps(id) ON DELETE CASCADE,
  enabled                    INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  package_name               TEXT,
  internal_track             TEXT,
  closed_track               TEXT,
  production_track           TEXT,
  service_account_email      TEXT NOT NULL,
  service_account_project_id TEXT,
  private_key_id             TEXT,
  credential_fingerprint     TEXT NOT NULL,
  credential_ciphertext_b64  TEXT NOT NULL,
  credential_iv_b64          TEXT NOT NULL,
  credential_key_version     TEXT NOT NULL,
  verification_state         TEXT NOT NULL CHECK (verification_state IN ('verified', 'stale')),
  verified_at                INTEGER,
  created_by_actor           TEXT NOT NULL,
  updated_by_actor           TEXT NOT NULL,
  created_at                 INTEGER NOT NULL,
  updated_at                 INTEGER NOT NULL,
  credential_kind TEXT NOT NULL DEFAULT 'service_account' CHECK (credential_kind IN ('service_account', 'authorized_user')),
  CHECK ((package_name IS NOT NULL AND internal_track IS NOT NULL AND closed_track IS NOT NULL AND production_track IS NOT NULL)
    OR (package_name IS NULL AND internal_track IS NULL AND closed_track IS NULL AND production_track IS NULL AND enabled=0 AND verification_state='stale' AND verified_at IS NULL AND credential_kind='authorized_user'))
);

INSERT INTO app_google_play_bindings_new (id, app_id, enabled, package_name, internal_track, closed_track, production_track, service_account_email, service_account_project_id, private_key_id, credential_fingerprint, credential_ciphertext_b64, credential_iv_b64, credential_key_version, verification_state, verified_at, created_by_actor, updated_by_actor, created_at, updated_at, credential_kind) SELECT id, app_id, enabled, package_name, internal_track, closed_track, production_track, service_account_email, service_account_project_id, private_key_id, credential_fingerprint, credential_ciphertext_b64, credential_iv_b64, credential_key_version, verification_state, verified_at, created_by_actor, updated_by_actor, created_at, updated_at, credential_kind FROM app_google_play_bindings;
DROP TABLE app_google_play_bindings;
ALTER TABLE app_google_play_bindings_new RENAME TO app_google_play_bindings;
CREATE INDEX idx_app_google_play_bindings_enabled ON app_google_play_bindings(enabled, app_id);

CREATE TABLE google_play_oauth_requests_new (
  state_hash TEXT PRIMARY KEY,
  app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES raft_accounts(id) ON DELETE CASCADE,
  authenticated_account_id TEXT NOT NULL REFERENCES raft_accounts(id) ON DELETE CASCADE,
  org_id TEXT,
  client_id TEXT NOT NULL,
  package_name TEXT,
  tracks_json TEXT,
  expected_binding_version TEXT,
  verifier_ciphertext_b64 TEXT NOT NULL,
  verifier_iv_b64 TEXT NOT NULL,
  verifier_key_version TEXT NOT NULL,
  consumed_at INTEGER,
  expires_at INTEGER NOT NULL,
  CHECK ((package_name IS NULL) = (tracks_json IS NULL))
);
INSERT INTO google_play_oauth_requests_new SELECT * FROM google_play_oauth_requests;
DROP TABLE google_play_oauth_requests;
ALTER TABLE google_play_oauth_requests_new RENAME TO google_play_oauth_requests;
CREATE INDEX google_play_oauth_requests_expiry ON google_play_oauth_requests(expires_at);
