-- The first message of a feedback thread that starts with an update (a comment
-- or status change on a ticket this destination never announced) is built from
-- the ticket. It is saved with the thread claim, so a retry of an uncertain
-- send repeats the same content under the same idempotency key.
ALTER TABLE raft_notification_threads ADD COLUMN root_content TEXT;
