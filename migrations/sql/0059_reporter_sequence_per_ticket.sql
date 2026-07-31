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
-- continues above its own current VISIBLE maximum, so gaps already baked into
-- history remain visible, and no new gap is created after this migration.
--
-- An earlier revision said the same thing while taking the maximum over all
-- rows, which was false: a pre-migration internal row's global number would be
-- inherited by the next visible comment and become a fresh gap.
--
-- Cloudflare's remote D1 migration parser requires trigger bodies on one
-- physical line (workers-sdk#4998 / CFSQL-1402). Keep these compact.

-- 1. Remove the global-counter machinery.
DROP TRIGGER IF EXISTS feedback_comments_reporter_sequence_insert;
DROP TRIGGER IF EXISTS feedback_comments_reporter_sequence_managed;

-- 2. Uniqueness becomes per ticket, over reporter-visible rows only. Two
--    reasons it must be partial: the old index was globally unique, which
--    independent counters break by design; and internal rows keep their old
--    global numbers, so a new visible number can legitimately equal an internal
--    row's number in the same ticket. Constraining only `internal = 0` is also
--    exactly the set the sequence now describes. This index serves the MAX
--    lookup the insert trigger performs, whose WHERE matches its predicate.
DROP INDEX IF EXISTS idx_feedback_comments_reporter_sequence;

CREATE UNIQUE INDEX idx_feedback_comments_ticket_reporter_sequence
  ON feedback_comments(ticket_id, reporter_sequence)
  WHERE internal = 0;

-- 3. Assignment: reporter-visible comments only, numbered within their ticket.
--    The next value is read from the ticket's own comments, so no counter table
--    has to be seeded, backfilled, or kept consistent — the data is the counter.
--    The row being inserted still has a NULL sequence here, so it cannot affect
--    its own MAX.
--
--    The MAX is taken over VISIBLE rows only. Internal rows from before this
--    migration still carry numbers from the old global counter, and those
--    numbers encode platform-wide activity. Including them would let the first
--    post-migration comment jump past one — a NEW gap, created after the
--    migration, carrying exactly the cross-tenant information this change
--    exists to stop leaking. Reproduced by @Volta: visible 1, internal 2, and
--    the next visible comment landing on 3.
CREATE TRIGGER feedback_comments_reporter_sequence_managed BEFORE INSERT ON feedback_comments WHEN NEW.reporter_sequence IS NOT NULL BEGIN SELECT RAISE(ABORT, 'feedback comment sequence is managed'); END;

CREATE TRIGGER feedback_comments_reporter_sequence_insert AFTER INSERT ON feedback_comments WHEN NEW.internal = 0 BEGIN UPDATE feedback_comments SET reporter_sequence = (SELECT COALESCE(MAX(c.reporter_sequence), 0) + 1 FROM feedback_comments c WHERE c.ticket_id = NEW.ticket_id AND c.internal = 0) WHERE rowid = NEW.rowid; END;

-- 4. The old global counter is now unused.
DROP TRIGGER IF EXISTS feedback_comment_sequence_state_monotonic;
DROP TRIGGER IF EXISTS feedback_comment_sequence_state_no_delete;
DROP TABLE IF EXISTS feedback_comment_sequence_state;
