-- Migration 0074 — the next free number in main's migrations/sql sequence at the time this
-- landed. Numbers are assigned by the order migrations actually enter main, not by when their PRs
-- were opened: #534 (app creator becomes admin) is still open, so it takes whatever number is
-- free when it lands, not this one.
--
-- App purge left no trace: `audit_logs.app_id` cascades from `apps`, so deleting an app deleted
-- its own audit rows, and `handlePurgeApp` wrote no purge record of its own. After a purge there
-- was no way to answer "who deleted this, and when" - for an irreversible operation that also
-- deletes stored files. That is how it surfaced: a test app disappeared and no record existed to
-- say who removed it or when.
--
-- This table is deliberately NOT keyed to `apps`, and carries no foreign keys at all: the whole
-- point is to outlive the rows it describes. (Unlike `hands_admin_access_audit` (0063), which
-- uses ON DELETE SET NULL for its actor, nothing here is nulled - a NULLed actor would erase the
-- subject of the audit, which is the opposite of what this table is for. See `actor_id` below.)
--
-- The app id, slug and org are stored as plain values, not foreign keys. Storing the org matters
-- even though nothing reads it yet: once the app is gone, this row is the ONLY surviving link
-- between the purge and an organisation, so a future read path cannot be authorised per-org
-- without it. A value captured now cannot be back-filled later.
--
-- `status` is what keeps the record honest. The purge spans two systems - R2 object deletion and
-- the D1 row delete - and cannot be atomic across them. A single row written at the end would
-- claim a completed purge whenever the final DELETE failed, which is worse than no record: it
-- would read as "purged" while the app still existed. So the row is opened as 'started' before
-- anything destructive happens and closed as 'completed' only when the app delete commits.

CREATE TABLE IF NOT EXISTS app_purge_records (
  id                  TEXT PRIMARY KEY,
  app_id              TEXT NOT NULL,          -- the deleted app's id, kept as a value, not an FK
  app_slug            TEXT NOT NULL,          -- the deleted app's slug, kept as a value
  org_id              TEXT,                   -- snapshot: the only surviving link to an org
  actor               TEXT NOT NULL,          -- display string, as it was at purge time
  -- An immutable snapshot of the actor at purge time, kept as a plain value with NO foreign key.
  -- A FK with ON DELETE SET NULL (the 0063 pattern) would null out the subject of the audit once
  -- the account is gone - erasing exactly what this table exists to preserve. A reader MAY
  -- LEFT JOIN the account for display, but this original value stays authoritative: failing to
  -- join it means the account was deleted, not that the actor is unknown.
  actor_id            TEXT,
  -- 'system' is included because currentActorInfo() returns it when neither an account nor a
  -- deploy token is present; restricting to human/agent would make the record fail to write in
  -- exactly the case where knowing the actor matters most.
  actor_type          TEXT NOT NULL CHECK (actor_type IN ('human', 'agent', 'system')),
  status              TEXT NOT NULL CHECK (status IN ('started', 'completed', 'failed')),
  -- A closed, DB-enforced set, and deliberately containing only values the code can actually
  -- produce. An intent-write failure is NOT one: the durable intent never existed, so per the
  -- fail-closed rule no destructive step ran and there is nothing for the receipt to describe.
  -- That case is a request-level log/alert fact, not a state transition of this row. Keeping an
  -- unreachable value here would invite code to "handle" a state that cannot occur.
  failure_class       TEXT CHECK (failure_class IS NULL OR failure_class IN (
                        'r2_delete_failed',
                        'db_finalize_failed',
                        'app_delete_unverified'
                      )),
  -- Two counts, split by what is actually CONFIRMED rather than by what was attempted.
  --
  -- `deleted` counts keys in batches whose delete RESOLVED: the R2 contract guarantees a resolved
  -- batch's keys are gone, so those are confirmed removed.
  -- `unconfirmed` counts everything else - batches never started, plus the batch in flight when
  -- the rejection happened. A rejection carries no per-key outcome, so those keys' state is not
  -- established, and "not established" is exactly what must be recorded.
  --
  -- The names describe evidence, not intention: a batch that was merely attempted is not thereby
  -- "failed". Together the two sum to the total the purge set out to delete, so the record answers
  -- "what is left behind" without overstating either direction.
  r2_objects_deleted      INTEGER NOT NULL DEFAULT 0 CHECK (r2_objects_deleted >= 0),
  r2_objects_unconfirmed  INTEGER NOT NULL DEFAULT 0 CHECK (r2_objects_unconfirmed >= 0),
  started_at          INTEGER NOT NULL,
  completed_at        INTEGER
);

-- The row's state machine, enforced completely on INSERT and on UPDATE.
--
-- An earlier version guarded only the two cases I happened to test (completed without a time,
-- failed without a class), which left every other illegal COMBINATION reachable - a completed row
-- could later be given a failure_class, a failed row a completed_at, a started row a
-- failure_class. Enumerating examples is not the same as stating the invariant, so the whole
-- machine is stated once here and every write is checked against it.
--
--   started    : no completed_at, no failure_class
--   completed  : completed_at set,   no failure_class
--   failed     : failure_class set,  no completed_at
--
-- `status` is a record of what happened, not a mutable field: once settled it cannot change.
CREATE TRIGGER IF NOT EXISTS trg_app_purge_records_state_machine_insert
BEFORE INSERT ON app_purge_records
WHEN NOT (
  (NEW.status = 'started'   AND NEW.completed_at IS NULL AND NEW.failure_class IS NULL)
  OR (NEW.status = 'completed' AND NEW.completed_at IS NOT NULL AND NEW.completed_at > 0 AND NEW.failure_class IS NULL)
  OR (NEW.status = 'failed' AND NEW.failure_class IS NOT NULL AND NEW.completed_at IS NULL)
)
BEGIN
  SELECT RAISE(ABORT, 'invalid purge record state');
END;

CREATE TRIGGER IF NOT EXISTS trg_app_purge_records_state_machine_update
BEFORE UPDATE ON app_purge_records
WHEN NOT (
  (NEW.status = 'started'   AND NEW.completed_at IS NULL AND NEW.failure_class IS NULL)
  OR (NEW.status = 'completed' AND NEW.completed_at IS NOT NULL AND NEW.completed_at > 0 AND NEW.failure_class IS NULL)
  OR (NEW.status = 'failed' AND NEW.failure_class IS NOT NULL AND NEW.completed_at IS NULL)
)
BEGIN
  SELECT RAISE(ABORT, 'invalid purge record state');
END;

-- A settled record is history: it may not be walked back or reclassified.
CREATE TRIGGER IF NOT EXISTS trg_app_purge_records_settled_is_final
BEFORE UPDATE ON app_purge_records
WHEN OLD.status IN ('completed', 'failed') AND NEW.status <> OLD.status
BEGIN
  SELECT RAISE(ABORT, 'a settled purge record cannot change status');
END;

-- Reads are "recent purges", "was this slug purged" and (later) per-org authorisation.
CREATE INDEX IF NOT EXISTS idx_app_purge_records_started_at
  ON app_purge_records(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_app_purge_records_slug
  ON app_purge_records(app_slug, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_app_purge_records_org
  ON app_purge_records(org_id, started_at DESC);
