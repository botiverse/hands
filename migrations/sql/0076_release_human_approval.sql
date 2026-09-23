-- Per-app "release must be approved by a human" gate (task #239).
--
-- When apps.release_requires_human_approval is on, a publish requested by an
-- agent (app deploy token, no human admin session) is NOT executed. Instead a
-- durable release_approval_requests row is written and the agent receives a
-- pending_approval response. A human (app admin / org admin) later approves or
-- rejects it from the admin console; approving re-executes the publish under
-- the exact preconditions the agent requested. Human-initiated publishes are
-- never gated. Default off; the toggle is per-app.
ALTER TABLE apps ADD COLUMN release_requires_human_approval INTEGER NOT NULL DEFAULT 0;

-- One durable intent per agent-requested publish. The state machine is enforced
-- in the schema (mirroring 0074_app_purge_records): a request is either pending
-- (no decision recorded) or decided (approved/rejected with a human decider and
-- a positive timestamp). Every other combination is rejected at INSERT/UPDATE.
CREATE TABLE release_approval_requests (
  id                        TEXT PRIMARY KEY,
  app_id                    TEXT NOT NULL,
  release_id                TEXT NOT NULL,
  requested_by_actor        TEXT NOT NULL,
  requested_by_token_id     TEXT,
  expected_revision         INTEGER NOT NULL,
  expected_scopes           TEXT NOT NULL,          -- JSON array of {scope_type, scope_value}
  required_external_targets TEXT,                   -- JSON, nullable
  status                    TEXT NOT NULL DEFAULT 'pending'
                            CHECK (status IN ('pending', 'approved', 'rejected')),
  decided_by                TEXT,
  decided_at                INTEGER,
  decision_note             TEXT,
  created_at                INTEGER NOT NULL,
  CHECK (
    (status = 'pending' AND decided_by IS NULL AND decided_at IS NULL)
    OR (status IN ('approved', 'rejected') AND decided_by IS NOT NULL
        AND decided_at IS NOT NULL AND decided_at > 0)
  ),
  FOREIGN KEY (app_id) REFERENCES apps(id) ON DELETE CASCADE,
  FOREIGN KEY (release_id) REFERENCES releases(id) ON DELETE CASCADE
);

CREATE INDEX idx_release_approval_requests_app_status
  ON release_approval_requests(app_id, status);
CREATE INDEX idx_release_approval_requests_release
  ON release_approval_requests(release_id);

-- At most one pending request per release: a re-request while pending is
-- idempotent (the handler returns the existing row) rather than creating a
-- duplicate the approver would have to untangle.
CREATE UNIQUE INDEX idx_release_approval_requests_one_pending
  ON release_approval_requests(release_id) WHERE status = 'pending';
