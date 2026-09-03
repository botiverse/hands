-- Migration 0071: one encrypted, app-scoped Google Play binding per Android app.
--
-- Private service-account material is encrypted by the Hands Worker with an
-- application-bound AES-GCM additional-data value. Only non-secret identity,
-- configuration, validation state, and audit metadata are stored in plaintext.

CREATE TABLE IF NOT EXISTS app_google_play_bindings (
  id                         TEXT PRIMARY KEY,
  app_id                     TEXT NOT NULL UNIQUE REFERENCES apps(id) ON DELETE CASCADE,
  enabled                    INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  package_name               TEXT NOT NULL,
  internal_track             TEXT NOT NULL,
  closed_track               TEXT NOT NULL,
  production_track           TEXT NOT NULL,
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
  updated_at                 INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_app_google_play_bindings_enabled
  ON app_google_play_bindings(enabled, app_id);
