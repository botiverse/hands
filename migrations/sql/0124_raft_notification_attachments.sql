-- A feedback event's screenshots are forwarded to its Raft thread as one reply
-- carrying them as Raft attachments (worker/src/lib/raft_feedback_attachments.ts).
-- attachment_ids_json: the Raft id of each uploaded attachment, saved as soon as
-- it exists, so an interrupted attempt does not upload it again. reply_json: the
-- reply's text and ids, fixed once (first writer wins), so every retry sends the
-- same message under the same idempotency key. message_id: the reply was sent.
CREATE TABLE IF NOT EXISTS raft_notification_attachment_sends (
  subscription_id TEXT NOT NULL,
  event_hash TEXT NOT NULL,
  attachment_ids_json TEXT,
  reply_json TEXT,
  message_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (subscription_id, event_hash)
);
