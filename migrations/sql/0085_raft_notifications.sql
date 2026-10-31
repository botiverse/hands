-- Hands-managed Raft App Bot destinations.
--
-- A bot installation is one encrypted credential per (Hands app, Raft server).
-- A notification subscription owns a hidden generic webhook row so every
-- existing webhook producer gets the same queue/retry behavior.  The hidden
-- row is deliberately linked here instead of exposing the bot credential or
-- an internal URL through the ordinary webhook UI.

CREATE TABLE IF NOT EXISTS raft_bot_installations (
  id                    TEXT PRIMARY KEY,
  app_id                TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  server_id             TEXT NOT NULL,
  installation_id       TEXT NOT NULL,
  credential_id         TEXT NOT NULL,
  agent_id              TEXT,
  handle                TEXT,
  key_ciphertext_b64    TEXT NOT NULL,
  key_iv_b64            TEXT NOT NULL,
  state                 TEXT NOT NULL DEFAULT 'active',
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL,
  UNIQUE (app_id, server_id)
);

CREATE INDEX IF NOT EXISTS idx_raft_bot_installations_server
  ON raft_bot_installations(server_id, state);

CREATE TABLE IF NOT EXISTS raft_notification_subscriptions (
  id                    TEXT PRIMARY KEY,
  app_id                TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  server_id             TEXT NOT NULL,
  channel_target        TEXT NOT NULL,
  events_json           TEXT NOT NULL DEFAULT '[]',
  enabled               INTEGER NOT NULL DEFAULT 1,
  webhook_id            TEXT NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
  created_by            TEXT REFERENCES raft_accounts(id) ON DELETE SET NULL,
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL,
  archived_at           INTEGER
);

CREATE INDEX IF NOT EXISTS idx_raft_notification_subscriptions_app
  ON raft_notification_subscriptions(app_id, archived_at, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS uq_raft_notification_subscriptions_active
  ON raft_notification_subscriptions(app_id, channel_target)
  WHERE archived_at IS NULL;

CREATE TABLE IF NOT EXISTS raft_notification_threads (
  subscription_id       TEXT NOT NULL REFERENCES raft_notification_subscriptions(id) ON DELETE CASCADE,
  object_key            TEXT NOT NULL,
  parent_message_id     TEXT NOT NULL,
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL,
  PRIMARY KEY (subscription_id, object_key)
);

CREATE INDEX IF NOT EXISTS idx_raft_notification_threads_updated
  ON raft_notification_threads(updated_at);
