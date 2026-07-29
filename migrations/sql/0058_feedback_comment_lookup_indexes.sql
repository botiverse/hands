-- The reporter ticket list runs three correlated subqueries per returned
-- ticket -- comment count, latest comment time, and unread count -- plus the
-- detail view's unread count. All of them filter feedback_comments by
-- `internal`, and the unread paths additionally by `author_type` and
-- `reporter_sequence`, but the only existing index is
-- idx_feedback_comments_ticket(ticket_id, created_at, id). EXPLAIN QUERY PLAN
-- confirms each subquery narrowed to `ticket_id=?` and then scanned every
-- comment on that ticket to apply the remaining filters, so a 20-ticket page
-- scanned the full comment set of 20 tickets three times over.
--
-- D1 bills and times queries by rows read, so these two covering indexes
-- target that metric directly: after adding them, EXPLAIN reports
-- COVERING INDEX for all three comment subqueries.
--
--   * ..._unread covers the unread predicate (internal + author_type +
--     reporter_sequence) used by both the list and detail paths;
--   * ..._internal_created covers the count and MAX(created_at) subqueries.
--
-- Both are read-side only; feedback_comments is append-mostly, so the write
-- overhead is two index inserts per comment.

CREATE INDEX IF NOT EXISTS idx_feedback_comments_unread
  ON feedback_comments(ticket_id, internal, author_type, reporter_sequence);

CREATE INDEX IF NOT EXISTS idx_feedback_comments_internal_created
  ON feedback_comments(ticket_id, internal, created_at);
