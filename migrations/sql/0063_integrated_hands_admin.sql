-- Keep the Raft access token encrypted at rest so /admin can re-check the
-- caller's live server membership and role on every request.
ALTER TABLE raft_sessions ADD COLUMN raft_access_token_ciphertext TEXT;

CREATE TABLE hands_admin_access_audit (
  id                TEXT PRIMARY KEY,
  actor_account_id  TEXT,
  actor_type        TEXT NOT NULL CHECK (actor_type IN ('human', 'agent')),
  server_id         TEXT NOT NULL,
  action            TEXT NOT NULL CHECK (action = 'overview.view'),
  created_at        INTEGER NOT NULL,
  FOREIGN KEY (actor_account_id) REFERENCES raft_accounts(id) ON DELETE SET NULL
);

CREATE INDEX idx_hands_admin_access_audit_created
  ON hands_admin_access_audit(created_at DESC);
