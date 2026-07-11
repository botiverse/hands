ALTER TABLE app_agc_credentials RENAME TO app_agc_credentials_api_client;

CREATE TABLE app_agc_credentials (
  id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL UNIQUE REFERENCES apps(id) ON DELETE CASCADE,
  credential_kind TEXT NOT NULL CHECK (credential_kind IN ('api_client', 'service_account')),
  developer_id TEXT,
  project_id TEXT,
  client_id TEXT,
  key_id TEXT,
  sub_account TEXT,
  configuration_version TEXT,
  region TEXT,
  credential_fingerprint TEXT NOT NULL,
  credential_ciphertext_b64 TEXT NOT NULL,
  credential_iv_b64 TEXT NOT NULL,
  created_by_actor TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

INSERT INTO app_agc_credentials
  (id, app_id, credential_kind, developer_id, project_id, client_id,
   configuration_version, region, credential_fingerprint,
   credential_ciphertext_b64, credential_iv_b64, created_by_actor,
   created_at, updated_at)
SELECT id, app_id, credential_kind, developer_id, project_id, client_id,
       configuration_version, region, credential_fingerprint,
       credential_ciphertext_b64, credential_iv_b64, created_by_actor,
       created_at, updated_at
FROM app_agc_credentials_api_client;

DROP TABLE app_agc_credentials_api_client;
