-- Migration 0003: make operation_logs.app_id nullable + drop FK constraint.
--
-- Rationale:
--   `parse` operations (pre-upload APK metadata extraction via the
--   ApkParserContainer) are inherently app-less: the user uploads a file
--   from the Upload dialog before associating it with an appId. Earlier
--   code used a placeholder UUID ("00000000-0000-0000-0000-000000000000"),
--   but operation_logs.app_id had NOT NULL + FK to apps(id), so the
--   placeholder insert failed with FOREIGN KEY constraint violation
--   (SQLITE_CONSTRAINT_FOREIGNKEY) and the entire parse request returned
--   a 500 with no body — masking the real container error path.
--
-- This migration:
--   1. Renames operation_logs → _operation_logs_old
--   2. Recreates without NOT NULL on app_id + without FK to apps
--   3. Copies rows
--   4. Drops old + re-creates indexes
--
-- Wrangler D1 doesn't allow raw BEGIN TRANSACTION (must use DO storage
-- transaction API). D1 executes each statement atomically; the rename +
-- recreate + insert + drop sequence is safe because each is its own
-- statement and the table is briefly inaccessible only during migration.

ALTER TABLE operation_logs RENAME TO _operation_logs_old;

CREATE TABLE operation_logs (
  id              TEXT PRIMARY KEY,
  app_id          TEXT,
  kind            TEXT NOT NULL,
  status          TEXT NOT NULL,
  parent_op_id    TEXT,
  step_number     INTEGER,
  actor           TEXT NOT NULL DEFAULT 'admin',
  input           TEXT NOT NULL DEFAULT '{}',
  output          TEXT NOT NULL DEFAULT '{}',
  error           TEXT,
  progress        REAL NOT NULL DEFAULT 0,
  retry_count     INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  completed_at    INTEGER
);

INSERT INTO operation_logs
  SELECT * FROM _operation_logs_old;

DROP TABLE _operation_logs_old;

CREATE INDEX IF NOT EXISTS idx_oplogs_app_created ON operation_logs(app_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_oplogs_app_status ON operation_logs(app_id, status);
CREATE INDEX IF NOT EXISTS idx_oplogs_parent ON operation_logs(parent_op_id);