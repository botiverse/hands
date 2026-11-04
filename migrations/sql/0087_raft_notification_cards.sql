-- Opt in per destination; existing subscriptions keep their text behavior.
ALTER TABLE raft_notification_subscriptions
  ADD COLUMN card_updates INTEGER NOT NULL DEFAULT 0 CHECK (card_updates IN (0, 1));

-- A pending request is persisted before calling Raft, so a response lost in
-- transit is retried with the same body and idempotency key. The lease fences
-- concurrent deliveries for one object; Raft's expectedRevision is the second
-- fence if a former lease holder finishes after takeover.
CREATE TABLE raft_notification_cards (
  subscription_id TEXT NOT NULL REFERENCES raft_notification_subscriptions(id) ON DELETE CASCADE,
  object_key TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'retired')),
  message_id TEXT,
  revision INTEGER NOT NULL DEFAULT 0,
  message_created_at INTEGER,
  last_event_ms INTEGER,
  last_event_hash TEXT,
  pending_json TEXT,
  pending_uncertain INTEGER NOT NULL DEFAULT 0 CHECK (pending_uncertain IN (0, 1)),
  lease_token TEXT,
  lease_expires_at INTEGER,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (subscription_id, object_key)
);
