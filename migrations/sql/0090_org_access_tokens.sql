-- Org-level fine-grained access tokens (GitHub fine-grained PAT style).
--
-- An org admin mints a token that carries an explicit permission set (v1:
-- app:read and/or feedback:read only) over either a chosen set of the org's
-- apps or every app in the org (all_apps = 1, which also covers apps created
-- later). Only the sha256 hash of the bearer is stored; the plaintext
-- (prefix qvot_) is returned once at creation.
--
-- Additive only: existing tables are untouched.

CREATE TABLE IF NOT EXISTS org_access_tokens (
  id               TEXT PRIMARY KEY,
  org_id           TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name             TEXT NOT NULL,
  token_prefix     TEXT NOT NULL,
  token_hash       TEXT NOT NULL UNIQUE,
  scopes_json      TEXT NOT NULL,
  all_apps         INTEGER NOT NULL DEFAULT 0 CHECK (all_apps IN (0, 1)),
  created_by       TEXT REFERENCES raft_accounts(id) ON DELETE SET NULL,
  created_by_actor TEXT NOT NULL,
  created_at       INTEGER NOT NULL,
  expires_at       INTEGER,
  last_used_at     INTEGER,
  revoked_at       INTEGER
);

CREATE INDEX IF NOT EXISTS idx_org_access_tokens_org
  ON org_access_tokens(org_id, revoked_at);

-- Explicit app selection. Unused when the token has all_apps = 1.
CREATE TABLE IF NOT EXISTS org_access_token_apps (
  token_id TEXT NOT NULL REFERENCES org_access_tokens(id) ON DELETE CASCADE,
  app_id   TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  PRIMARY KEY (token_id, app_id)
);

CREATE INDEX IF NOT EXISTS idx_org_access_token_apps_app
  ON org_access_token_apps(app_id);
