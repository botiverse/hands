CREATE TABLE access_audit (
  id TEXT PRIMARY KEY,
  actor_subject TEXT NOT NULL,
  server_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action = 'overview.view'),
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_access_audit_created ON access_audit(created_at DESC);
