-- The reporter comment sequence was a single database-wide counter advanced by
-- EVERY comment insert, including internal (`internal = 1`) staff notes, and it
-- reaches reporters inside the pagination cursor. Two of a reporter's own
-- cursors could therefore be differenced to learn how many comments were
-- created platform-wide in between — across tenants, and including internal
-- activity. Volume and timing only; no content.
--
-- Root cause is narrower than "the counter is global": a sequence shown to
-- reporters was advanced by events reporters cannot see. So this migration does
-- both halves:
--
--   * assign `reporter_sequence` ONLY to reporter-visible comments; internal
--     comments keep NULL. Nothing reads them — every reporter-path use of the
--     column is already paired with `internal = 0` — so they only consumed
--     numbers and leaked;
--   * number per app instead of globally, so a future exposure is bounded to
--     one tenant.
--
-- Read receipts store `read_through_sequence` in the OLD numbering. They are
-- recomputed from `read_through_comment_id`, which the same row already
-- carries, and the migration aborts if any receipt fails to resolve rather than
-- silently corrupting unread counts.
--
-- Cloudflare's remote D1 migration parser requires trigger bodies on one
-- physical line (workers-sdk#4998 / CFSQL-1402). Keep these compact.

-- 1. Remove the old machinery. The immutability trigger would otherwise block
--    renumbering, and the managed/insert triggers reference the old state table.
DROP TRIGGER IF EXISTS feedback_comments_reporter_sequence_immutable;
DROP TRIGGER IF EXISTS feedback_comments_reporter_sequence_insert;
DROP TRIGGER IF EXISTS feedback_comments_reporter_sequence_managed;

-- 2. Per-app numbering needs the app on the comment row; it was only reachable
--    through the ticket.
ALTER TABLE feedback_comments ADD COLUMN app_id TEXT;

UPDATE feedback_comments
SET app_id = (SELECT t.app_id FROM feedback_tickets t WHERE t.id = feedback_comments.ticket_id);

-- 3. Internal comments stop carrying a reporter-visible number.
UPDATE feedback_comments SET reporter_sequence = NULL WHERE internal = 1;

-- 4. Renumber reporter-visible comments per app, preserving existing relative
--    order. The old unique index is dropped first: values collide across apps
--    once numbering restarts per app.
DROP INDEX IF EXISTS idx_feedback_comments_reporter_sequence;

WITH renumbered AS (
  SELECT id, ROW_NUMBER() OVER (PARTITION BY app_id ORDER BY reporter_sequence, id) AS seq
  FROM feedback_comments
  WHERE internal = 0 AND app_id IS NOT NULL
)
UPDATE feedback_comments
SET reporter_sequence = (SELECT seq FROM renumbered WHERE renumbered.id = feedback_comments.id)
WHERE internal = 0 AND app_id IS NOT NULL;

CREATE UNIQUE INDEX idx_feedback_comments_app_reporter_sequence
  ON feedback_comments(app_id, reporter_sequence);

-- 5. Re-point read receipts at the new numbering via the comment id they
--    already store, so "read through here" keeps its exact meaning.
UPDATE feedback_reporter_ticket_reads
SET read_through_sequence = (
  SELECT c.reporter_sequence FROM feedback_comments c
  WHERE c.id = feedback_reporter_ticket_reads.read_through_comment_id
)
WHERE EXISTS (
  SELECT 1 FROM feedback_comments c
  WHERE c.id = feedback_reporter_ticket_reads.read_through_comment_id
    AND c.reporter_sequence IS NOT NULL
);

-- 6. Fail closed if any receipt did not resolve. Comments are never deleted and
--    cascade only with their ticket — whose receipts cascade too — so this
--    should be unreachable. If it fires, the reasoning above is wrong and the
--    migration must stop rather than leave unread counts silently wrong.
CREATE TABLE _reporter_sequence_migration_assert (
  ok INTEGER NOT NULL CHECK (ok = 1)
);

INSERT INTO _reporter_sequence_migration_assert (ok)
SELECT CASE WHEN EXISTS (
  SELECT 1 FROM feedback_reporter_ticket_reads r
  LEFT JOIN feedback_comments c ON c.id = r.read_through_comment_id
  WHERE c.id IS NULL OR c.reporter_sequence IS NULL
) THEN 0 ELSE 1 END;

DROP TABLE _reporter_sequence_migration_assert;

-- 7. Per-app high-water, seeded from the renumbered data.
CREATE TABLE feedback_comment_app_sequence_state (
  app_id TEXT PRIMARY KEY REFERENCES apps(id) ON DELETE CASCADE,
  high_water INTEGER NOT NULL CHECK (high_water >= 0)
);

INSERT INTO feedback_comment_app_sequence_state (app_id, high_water)
SELECT app_id, COALESCE(MAX(reporter_sequence), 0)
FROM feedback_comments
WHERE app_id IS NOT NULL AND internal = 0
GROUP BY app_id;

CREATE TRIGGER feedback_comment_app_sequence_no_delete BEFORE DELETE ON feedback_comment_app_sequence_state WHEN EXISTS (SELECT 1 FROM apps WHERE id = OLD.app_id) BEGIN SELECT RAISE(ABORT, 'feedback comment sequence state is durable'); END;

CREATE TRIGGER feedback_comment_app_sequence_monotonic BEFORE UPDATE ON feedback_comment_app_sequence_state WHEN NEW.app_id != OLD.app_id OR NEW.high_water != OLD.high_water + 1 BEGIN SELECT RAISE(ABORT, 'feedback comment sequence high-water must advance by one'); END;

-- 8. Assignment: reporter-visible comments only, numbered within their app.
--    `app_id` is derived from the ticket, never supplied by the caller.
CREATE TRIGGER feedback_comments_reporter_sequence_managed BEFORE INSERT ON feedback_comments WHEN NEW.reporter_sequence IS NOT NULL BEGIN SELECT RAISE(ABORT, 'feedback comment sequence is managed'); END;

CREATE TRIGGER feedback_comments_app_id_derived AFTER INSERT ON feedback_comments BEGIN UPDATE feedback_comments SET app_id = (SELECT t.app_id FROM feedback_tickets t WHERE t.id = NEW.ticket_id) WHERE rowid = NEW.rowid; END;

CREATE TRIGGER feedback_comments_reporter_sequence_insert AFTER INSERT ON feedback_comments WHEN NEW.internal = 0 BEGIN INSERT INTO feedback_comment_app_sequence_state (app_id, high_water) SELECT t.app_id, 0 FROM feedback_tickets t WHERE t.id = NEW.ticket_id AND NOT EXISTS (SELECT 1 FROM feedback_comment_app_sequence_state s WHERE s.app_id = t.app_id); UPDATE feedback_comment_app_sequence_state SET high_water = high_water + 1 WHERE app_id = (SELECT t.app_id FROM feedback_tickets t WHERE t.id = NEW.ticket_id); UPDATE feedback_comments SET reporter_sequence = (SELECT s.high_water FROM feedback_comment_app_sequence_state s JOIN feedback_tickets t ON t.app_id = s.app_id WHERE t.id = NEW.ticket_id) WHERE rowid = NEW.rowid; END;

CREATE TRIGGER feedback_comments_reporter_sequence_immutable BEFORE UPDATE OF reporter_sequence ON feedback_comments WHEN OLD.reporter_sequence IS NOT NULL BEGIN SELECT RAISE(ABORT, 'feedback comment sequence is immutable'); END;

-- 9. The old global counter is now unused.
DROP TRIGGER IF EXISTS feedback_comment_sequence_state_monotonic;
DROP TRIGGER IF EXISTS feedback_comment_sequence_state_no_delete;
DROP TABLE IF EXISTS feedback_comment_sequence_state;
