-- Migration 0002: operation_logs
-- Per-app operation history for upload / parse / publish tasks.
-- Records every task attempt including failures, with retry metadata.

CREATE TABLE IF NOT EXISTS operation_logs (
  id              TEXT PRIMARY KEY,
  app_id          TEXT NOT NULL,
  kind            TEXT NOT NULL,           -- 'parse' | 'upload' | 'publish' | 'signed_url'
  status          TEXT NOT NULL,           -- 'pending' | 'in_progress' | 'success' | 'failed' | 'cancelled'
  parent_op_id    TEXT,                    -- links parse→upload→publish as a chain
  step_number     INTEGER,                 -- 1, 2, 3 within a chain
  actor           TEXT NOT NULL DEFAULT 'admin',
  input           TEXT NOT NULL DEFAULT '{}',  -- JSON: filename, size, channel, etc.
  output          TEXT NOT NULL DEFAULT '{}',  -- JSON: parsed metadata, r2_key, version_id
  error           TEXT,
  progress        REAL NOT NULL DEFAULT 0,  -- 0..1
  retry_count     INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  completed_at    INTEGER,
  FOREIGN KEY (app_id) REFERENCES apps(id) ON DELETE CASCADE,
  FOREIGN KEY (parent_op_id) REFERENCES operation_logs(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_oplogs_app_created ON operation_logs(app_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_oplogs_app_status ON operation_logs(app_id, status);
CREATE INDEX IF NOT EXISTS idx_oplogs_parent ON operation_logs(parent_op_id);