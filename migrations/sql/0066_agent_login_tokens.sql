-- Generic CLI agent login (RFC 057) — Hands first instance, server-side storage.
-- Two additive tables:
--   * one-time proof-key grants, issued at the `agent-login` action and consumed
--     atomically at exchange (verifier proof checked against code_challenge);
--   * revocable / rotating refresh tokens.
-- Both bind the authenticated Raft identity (server/agent/integration/service).
-- Only digests/hashes are stored — never the raw grant, refresh token, or verifier.

CREATE TABLE agent_login_grants (
  grant_digest   TEXT PRIMARY KEY,        -- digest of the opaque grant; raw never stored
  server_id      TEXT NOT NULL,           -- identity fields come from the authenticated
  agent_id       TEXT NOT NULL,           -- Agent Login invoke context, never the request body:
                                          --   agent_id  = authenticated_account.provider_subject (Raft agent identity)
  account_id     TEXT NOT NULL,           --   account_id = authenticated_account.id (Hands-local account row)
  integration    TEXT NOT NULL,
  service        TEXT NOT NULL,
  code_challenge TEXT NOT NULL,           -- S256; verified against the exchange verifier
  nonce          TEXT NOT NULL,
  issued_at      INTEGER NOT NULL,
  expires_at     INTEGER NOT NULL,        -- <= issued_at + 300s
  consumed_at    INTEGER,                 -- set atomically with mint; enforces single-use
  consumed_by    TEXT                     -- unique attempt id of the winning exchange; the
                                          -- ownership token the mint INSERTs guard on (NOT the
                                          -- timestamp — same-ms concurrent losers would collide)
);

CREATE INDEX idx_agent_login_grants_identity
  ON agent_login_grants (server_id, agent_id, service);

CREATE INDEX idx_agent_login_grants_expiry
  ON agent_login_grants (expires_at);

CREATE TABLE agent_refresh_tokens (
  id           TEXT PRIMARY KEY,
  token_hash   TEXT NOT NULL UNIQUE,      -- hash of the refresh token; raw never stored
  server_id    TEXT NOT NULL,
  agent_id     TEXT NOT NULL,             -- authenticated_account.provider_subject (Raft agent identity)
  account_id   TEXT NOT NULL,             -- authenticated_account.id (Hands-local account row)
  integration  TEXT NOT NULL,
  service      TEXT NOT NULL,
  app_scope    TEXT,                       -- present when the access is app-scoped
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  rotated_from TEXT REFERENCES agent_refresh_tokens(id) ON DELETE SET NULL,
  revoked_at   INTEGER,
  revoked_by   TEXT                        -- unique attempt id of the rotation that fenced this
                                           -- token; the ownership token the successor mint guards
                                           -- on (NOT the timestamp). NULL for chain/admin revokes.
);

-- Revoke-by-identity (agent lifecycle / admin) and expiry sweeps.
CREATE INDEX idx_agent_refresh_tokens_identity
  ON agent_refresh_tokens (server_id, agent_id, service);

CREATE INDEX idx_agent_refresh_tokens_expiry
  ON agent_refresh_tokens (expires_at);
