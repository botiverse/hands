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
-- Write cost, measured rather than assumed: inserting one comment is not a
-- single row write. Migration 0054's feedback_comments_reporter_sequence_insert
-- is an AFTER INSERT trigger that UPDATEs reporter_sequence on the row just
-- inserted, and reporter_sequence is a column of ..._unread. So per comment the
-- two indexes here add 3 index inserts and 1 index delete: both indexes take an
-- entry on the INSERT (..._unread with reporter_sequence still NULL), then the
-- trigger's UPDATE deletes and re-inserts the ..._unread entry under its final
-- sequence. ..._internal_created holds no updated column and is untouched by
-- that UPDATE. Verified by opcode delta on EXPLAIN of the insert against the
-- full migration set: IdxInsert 8 -> 11, IdxDelete 1 -> 2.
--
-- That cost is accepted: feedback_comments is append-mostly and a comment
-- insert is a single user action, whereas the read path pays per ticket on
-- every page of every list request.

CREATE INDEX IF NOT EXISTS idx_feedback_comments_unread
  ON feedback_comments(ticket_id, internal, author_type, reporter_sequence);

CREATE INDEX IF NOT EXISTS idx_feedback_comments_internal_created
  ON feedback_comments(ticket_id, internal, created_at);
