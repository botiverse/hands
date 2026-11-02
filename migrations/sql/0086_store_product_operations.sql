-- Serialize Hands operations on the same provider app. No time-only expiry:
-- a lost response may still represent an in-flight provider mutation.
CREATE TABLE IF NOT EXISTS store_product_locks (
  provider TEXT NOT NULL,
  target_hash TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  acquired_at INTEGER NOT NULL,
  PRIMARY KEY (provider, target_hash)
);

-- A group-create timeout must not turn a retry into a duplicate group.
CREATE TABLE IF NOT EXISTS store_apple_group_intents (
  target_hash TEXT NOT NULL,
  group_hash TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (target_hash, group_hash)
);
