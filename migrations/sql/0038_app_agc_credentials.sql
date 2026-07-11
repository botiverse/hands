CREATE TABLE app_agc_credentials (
  id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL UNIQUE REFERENCES apps(id) ON DELETE CASCADE,
  credential_kind TEXT NOT NULL CHECK (credential_kind IN ('api_client')),
  developer_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  configuration_version TEXT,
  region TEXT,
  credential_fingerprint TEXT NOT NULL,
  credential_ciphertext_b64 TEXT NOT NULL,
  credential_iv_b64 TEXT NOT NULL,
  created_by_actor TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
