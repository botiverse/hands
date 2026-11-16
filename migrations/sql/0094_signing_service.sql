-- Hands signing service. Signing identities (keys and certificates) belong to
-- an organization and are encrypted at rest; apps are granted the identities
-- they may sign with; every signing request is a job with an audit trail.
CREATE TABLE signing_identities (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  -- android_keystore | apple_developer_id | apple_ios_distribution
  kind TEXT NOT NULL CHECK (kind IN ('android_keystore', 'apple_developer_id', 'apple_ios_distribution')),
  name TEXT NOT NULL,
  -- generated (created inside Hands) | uploaded
  origin TEXT NOT NULL CHECK (origin IN ('generated', 'uploaded')),
  -- Public facts only: certificate subject, SHA-256 fingerprint, not_after,
  -- key alias, Apple team id, notary key id. Never key material.
  metadata_json TEXT NOT NULL,
  -- AES-GCM over the JSON secret bundle (key store / p12 / passwords / notary key).
  secret_ciphertext_b64 TEXT NOT NULL,
  secret_iv_b64 TEXT NOT NULL,
  -- Set once a one-time backup of a generated key has been downloaded.
  backup_exported_at INTEGER,
  created_by TEXT REFERENCES raft_accounts(id) ON DELETE SET NULL,
  created_by_actor TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);

CREATE INDEX idx_signing_identities_org ON signing_identities(org_id, revoked_at);

CREATE TABLE signing_identity_apps (
  identity_id TEXT NOT NULL REFERENCES signing_identities(id) ON DELETE CASCADE,
  app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  created_by_actor TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (identity_id, app_id)
);

CREATE INDEX idx_signing_identity_apps_app ON signing_identity_apps(app_id);

CREATE TABLE signing_jobs (
  id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  identity_id TEXT NOT NULL REFERENCES signing_identities(id),
  -- apk | aab | macos | ipa
  artifact_type TEXT NOT NULL CHECK (artifact_type IN ('apk', 'aab', 'macos', 'ipa')),
  status TEXT NOT NULL CHECK (status IN ('awaiting_upload', 'signing', 'notarizing', 'stapling', 'succeeded', 'failed')),
  filename TEXT NOT NULL,
  input_r2_key TEXT NOT NULL,
  input_size INTEGER NOT NULL,
  input_sha256 TEXT NOT NULL,
  output_r2_key TEXT,
  output_size INTEGER,
  output_sha256 TEXT,
  notarize INTEGER NOT NULL DEFAULT 0,
  notary_submission_id TEXT,
  notary_status TEXT,
  error_code TEXT,
  error_message TEXT,
  actor TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_signing_jobs_app ON signing_jobs(app_id, created_at);
