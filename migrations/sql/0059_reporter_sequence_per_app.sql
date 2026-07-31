-- The reporter comment sequence was a single database-wide counter advanced by
-- EVERY comment insert, internal (`internal = 1`) staff notes included, and it
-- reaches reporters inside the pagination cursor. Two of a reporter's own
-- cursors could be differenced to learn how many comments were created
-- platform-wide in between — across tenants, and including internal activity.
-- Volume and timing only; no content.
--
-- The root cause is narrower than "the counter is global": a sequence shown to
-- reporters was advanced by events reporters cannot see. So future assignment
-- changes in two ways — only reporter-visible comments consume a number, and
-- each app numbers independently.
--
-- EXISTING VALUES ARE LEFT EXACTLY AS THEY ARE. An earlier draft renumbered
-- history, which was wrong twice over (both found by @Volta's review):
--
--   * the deploy applies migrations BEFORE the new Worker goes live
--     (.github/workflows/deploy-hands-server.yml), so between those steps — and
--     after any Worker-only rollback — the old Worker would compare a cursor's
--     large pre-renumber value against small new values and silently return no
--     further comments;
--   * read receipts store `read_through_comment_id` with no constraint tying it
--     to their own ticket, so recomputing by id alone could import another
--     ticket's number and change which comments count as unread.
--
-- Not rewriting history removes both hazards: in-flight cursors stay valid,
-- receipts keep their meaning untouched, and no ordering constraint is imposed
-- on the deploy. Nothing requires the old values to be renumbered — every
-- comparison on this column happens within a single ticket
-- (reporter_feedback.ts unread predicate and comment paging), so the numbering
-- only has to be monotonic per app, never globally comparable.
--
-- Historical rows therefore keep numbers drawn from the old global counter, and
-- each app's counter continues above its own current maximum. That leaves the
-- values sparse, which costs nothing, and closes the leak going forward: from
-- here on, a reporter differencing two cursors sees only their own app's
-- reporter-visible comment activity.
--
-- Cloudflare's remote D1 migration parser requires trigger bodies on one
-- physical line (workers-sdk#4998 / CFSQL-1402). Keep these compact.

-- 1. Remove the global-counter machinery.
DROP TRIGGER IF EXISTS feedback_comments_reporter_sequence_insert;
DROP TRIGGER IF EXISTS feedback_comments_reporter_sequence_managed;

-- 2. Per-app numbering needs the app on the comment row; it was only reachable
--    through the ticket. Backfilled for existing rows, derived on insert.
ALTER TABLE feedback_comments ADD COLUMN app_id TEXT;

UPDATE feedback_comments
SET app_id = (SELECT t.app_id FROM feedback_tickets t WHERE t.id = feedback_comments.ticket_id);

-- 3. Uniqueness becomes per app. The old index was globally unique, which is
--    incompatible with independent counters: once two apps number themselves,
--    the same value legitimately appears in both. Existing values are globally
--    unique already, so they satisfy the narrower constraint unchanged.
DROP INDEX IF EXISTS idx_feedback_comments_reporter_sequence;

CREATE UNIQUE INDEX idx_feedback_comments_app_reporter_sequence
  ON feedback_comments(app_id, reporter_sequence);

-- 4. Per-app high-water, seeded above each app's current maximum so new numbers
--    can never collide with the historical ones this migration leaves in place.
--    Seeded from ALL comments, including internal ones, because those hold
--    historical numbers too.
CREATE TABLE feedback_comment_app_sequence_state (
  app_id TEXT PRIMARY KEY REFERENCES apps(id) ON DELETE CASCADE,
  high_water INTEGER NOT NULL CHECK (high_water >= 0)
);

INSERT INTO feedback_comment_app_sequence_state (app_id, high_water)
SELECT app_id, COALESCE(MAX(reporter_sequence), 0)
FROM feedback_comments
WHERE app_id IS NOT NULL
GROUP BY app_id;

CREATE TRIGGER feedback_comment_app_sequence_monotonic BEFORE UPDATE ON feedback_comment_app_sequence_state WHEN NEW.app_id != OLD.app_id OR NEW.high_water != OLD.high_water + 1 BEGIN SELECT RAISE(ABORT, 'feedback comment sequence high-water must advance by one'); END;

-- 5. Assignment: reporter-visible comments only, numbered within their app.
--    `app_id` is derived from the ticket, never supplied by the caller.
CREATE TRIGGER feedback_comments_reporter_sequence_managed BEFORE INSERT ON feedback_comments WHEN NEW.reporter_sequence IS NOT NULL BEGIN SELECT RAISE(ABORT, 'feedback comment sequence is managed'); END;

CREATE TRIGGER feedback_comments_app_id_derived AFTER INSERT ON feedback_comments BEGIN UPDATE feedback_comments SET app_id = (SELECT t.app_id FROM feedback_tickets t WHERE t.id = NEW.ticket_id) WHERE rowid = NEW.rowid; END;

CREATE TRIGGER feedback_comments_reporter_sequence_insert AFTER INSERT ON feedback_comments WHEN NEW.internal = 0 BEGIN INSERT INTO feedback_comment_app_sequence_state (app_id, high_water) SELECT t.app_id, 0 FROM feedback_tickets t WHERE t.id = NEW.ticket_id AND NOT EXISTS (SELECT 1 FROM feedback_comment_app_sequence_state s WHERE s.app_id = t.app_id); UPDATE feedback_comment_app_sequence_state SET high_water = high_water + 1 WHERE app_id = (SELECT t.app_id FROM feedback_tickets t WHERE t.id = NEW.ticket_id); UPDATE feedback_comments SET reporter_sequence = (SELECT s.high_water FROM feedback_comment_app_sequence_state s JOIN feedback_tickets t ON t.app_id = s.app_id WHERE t.id = NEW.ticket_id) WHERE rowid = NEW.rowid; END;

-- 6. The old global counter is now unused. Its state table is dropped last so
--    the seeding above could still read from the data it produced.
DROP TRIGGER IF EXISTS feedback_comment_sequence_state_monotonic;
DROP TRIGGER IF EXISTS feedback_comment_sequence_state_no_delete;
DROP TABLE IF EXISTS feedback_comment_sequence_state;
