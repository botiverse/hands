-- A sequenced release check (sequence IS NOT NULL) may only be replaced by a
-- write with a larger sequence and a different, non-NULL decision_id. Any
-- other update of such a row aborts the statement, so a Worker version that
-- predates sequence ordering cannot rewrite a sequenced row in place.
CREATE TRIGGER IF NOT EXISTS trg_release_checks_sequence_guard
BEFORE UPDATE ON release_checks
WHEN OLD.sequence IS NOT NULL AND NOT (
  NEW.sequence IS NOT NULL
  AND NEW.sequence > OLD.sequence
  AND NEW.decision_id IS NOT NULL
  AND NEW.decision_id IS NOT OLD.decision_id
)
BEGIN
  SELECT RAISE(ABORT, 'release_checks: a sequenced check is replaced only by a larger sequence with another decision_id');
END;
