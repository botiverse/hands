-- Migration 0004: Login with Raft accounts and sessions.
--
-- Raft identity is scoped by server. The stable account key is
-- (provider, provider_subject, server_id), matching the Login with Raft
-- integration guide.

CREATE TABLE IF NOT EXISTS raft_accounts (
  id                TEXT PRIMARY KEY,
  provider          TEXT NOT NULL DEFAULT 'raft',
  provider_subject  TEXT NOT NULL,
  server_id         TEXT NOT NULL,
  server_slug       TEXT,
  principal_type    TEXT NOT NULL,       -- 'human' | 'agent'
  server_role       TEXT,
  username          TEXT,
  display_name      TEXT NOT NULL,
  avatar_url        TEXT,
  raw_profile       TEXT NOT NULL,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  last_login_at     INTEGER NOT NULL,
  UNIQUE (provider, provider_subject, server_id)
);

CREATE INDEX IF NOT EXISTS idx_raft_accounts_server
  ON raft_accounts(server_id, provider_subject);

CREATE TABLE IF NOT EXISTS raft_sessions (
  id            TEXT PRIMARY KEY,
  account_id    TEXT NOT NULL,
  token_hash    TEXT NOT NULL UNIQUE,
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,
  last_seen_at  INTEGER NOT NULL,
  revoked_at    INTEGER,
  FOREIGN KEY (account_id) REFERENCES raft_accounts(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_raft_sessions_account
  ON raft_sessions(account_id, expires_at DESC);

CREATE INDEX IF NOT EXISTS idx_raft_sessions_token
  ON raft_sessions(token_hash);
