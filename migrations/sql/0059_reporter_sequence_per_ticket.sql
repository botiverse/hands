-- The reporter comment sequence was a single database-wide counter advanced by
-- EVERY comment insert, and it reaches reporters inside the pagination cursor.
-- Differencing two of a reporter's own cursors revealed how much comment
-- activity happened in between — across tenants, and including activity the
-- reporter cannot see. Volume and timing only; no content.
--
-- The principle: a sequence shown to a reporter must not be advanced by events
-- that reporter cannot see. Applying it exactly determines the scope.
--
-- A reporter sees the non-internal comments of their OWN ticket. Not the app's
-- other tickets — those belong to other reporters — and not internal notes. So
-- the sequence is scoped PER TICKET, which is precisely that visibility domain:
-- from here on a reporter's own comments are numbered 1, 2, 3 … with no gaps to
-- interpret, because nothing they cannot see consumes a number.
--
-- Two narrower scopes were tried first and both still leaked (@Volta found each):
--
--   * global-but-visible-only still counted every app's activity;
--   * per-app still counted OTHER reporters in the same app — Alice sees 1 then
--     3, and the gap is Bob's invisible comment.
--
-- EXISTING VALUES ARE LEFT EXACTLY AS THEY ARE, so in-flight pagination cursors
-- stay valid and read receipts are never rewritten. That matters because the
-- deploy applies migrations BEFORE the new Worker is live
-- (.github/workflows/deploy-hands-server.yml), so a renumber would leave the old
-- Worker comparing large pre-renumber cursors against small new values and
-- silently returning nothing. Nothing requires the old values to change: every
-- comparison on this column already happens within a single ticket
-- (reporter_feedback.ts unread predicate and comment paging). Each ticket simply
-- continues above its own current maximum, so historical gaps remain but no new
-- ones are created.
--
-- Cloudflare's remote D1 migration parser requires trigger bodies on one
-- physical line (workers-sdk#4998 / CFSQL-1402). Keep these compact.

-- 1. Remove the global-counter machinery.
DROP TRIGGER IF EXISTS feedback_comments_reporter_sequence_insert;
DROP TRIGGER IF EXISTS feedback_comments_reporter_sequence_managed;

-- 2. Uniqueness becomes per ticket. The old index was globally unique, which is
--    incompatible with independent counters: once each ticket numbers itself,
--    the same value legitimately appears in many tickets. Existing values are
--    globally unique already, so they satisfy the narrower constraint unchanged.
--    This index also serves the MAX lookup the insert trigger performs.
DROP INDEX IF EXISTS idx_feedback_comments_reporter_sequence;

CREATE UNIQUE INDEX idx_feedback_comments_ticket_reporter_sequence
  ON feedback_comments(ticket_id, reporter_sequence);

-- 3. Assignment: reporter-visible comments only, numbered within their ticket.
--    The next value is read from the ticket's own comments, so no counter table
--    has to be seeded, backfilled, or kept consistent — the data is the counter.
--    The row being inserted still has a NULL sequence here, so it cannot affect
--    its own MAX.
CREATE TRIGGER feedback_comments_reporter_sequence_managed BEFORE INSERT ON feedback_comments WHEN NEW.reporter_sequence IS NOT NULL BEGIN SELECT RAISE(ABORT, 'feedback comment sequence is managed'); END;

CREATE TRIGGER feedback_comments_reporter_sequence_insert AFTER INSERT ON feedback_comments WHEN NEW.internal = 0 BEGIN UPDATE feedback_comments SET reporter_sequence = (SELECT COALESCE(MAX(c.reporter_sequence), 0) + 1 FROM feedback_comments c WHERE c.ticket_id = NEW.ticket_id) WHERE rowid = NEW.rowid; END;

-- 4. The old global counter is now unused.
DROP TRIGGER IF EXISTS feedback_comment_sequence_state_monotonic;
DROP TRIGGER IF EXISTS feedback_comment_sequence_state_no_delete;
DROP TABLE IF EXISTS feedback_comment_sequence_state;
