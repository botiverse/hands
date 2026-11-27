-- A feedback event's screenshots are forwarded to its Raft thread as one reply
-- carrying them as Raft attachments. The uploaded Raft attachment ids are kept
-- per event so a retry sends the same reply (same ids, same idempotency key)
-- instead of uploading again; message_id marks the reply as sent.
CREATE TABLE IF NOT EXISTS raft_notification_attachment_sends (
  subscription_id TEXT NOT NULL,
  event_hash TEXT NOT NULL,
  attachment_ids_json TEXT,
  message_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (subscription_id, event_hash)
);
