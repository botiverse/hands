-- Migration 0045: app-scoped Apple notarization submissions.
--
-- Hands keeps the App Store Connect private key encrypted and submits signed
-- macOS artifacts to Apple's Notary API on behalf of CI. Persisting the
-- submission/app binding prevents a publisher on one app from using a known
-- Apple submission id to read another app's status or developer log.

CREATE TABLE IF NOT EXISTS app_notarizations (
  id                   TEXT PRIMARY KEY,
  app_id               TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  operation_id         TEXT REFERENCES operation_logs(id) ON DELETE SET NULL,
  idempotency_key      TEXT NOT NULL,
  apple_submission_id  TEXT,
  submission_name      TEXT NOT NULL,
  source_r2_key        TEXT NOT NULL,
  source_sha256        TEXT NOT NULL,
  source_size_bytes    INTEGER NOT NULL,
  status               TEXT NOT NULL,
  log_json             TEXT,
  binding_verified     INTEGER NOT NULL DEFAULT 0,
  created_by_actor     TEXT NOT NULL,
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL,
  completed_at         INTEGER,
  UNIQUE (app_id, idempotency_key),
  UNIQUE (apple_submission_id)
);

CREATE INDEX IF NOT EXISTS idx_app_notarizations_app_created
  ON app_notarizations(app_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_app_notarizations_app_status
  ON app_notarizations(app_id, status, updated_at DESC);
