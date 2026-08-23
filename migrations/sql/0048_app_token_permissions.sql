CREATE TABLE app_deploy_tokens_v2 (
  id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  token_prefix TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  app_role TEXT CHECK (app_role IN ('publisher', 'viewer')),
  scopes_json TEXT,
  created_by TEXT REFERENCES raft_accounts(id) ON DELETE SET NULL,
  created_by_actor TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  last_used_at INTEGER,
  revoked_at INTEGER,
  CHECK (app_role IS NOT NULL OR scopes_json IS NOT NULL)
);

INSERT INTO app_deploy_tokens_v2
  (id, app_id, name, token_prefix, token_hash, app_role, scopes_json,
   created_by, created_by_actor, created_at, expires_at, last_used_at, revoked_at)
SELECT id, app_id, name, token_prefix, token_hash, app_role, NULL,
       created_by, created_by_actor, created_at, expires_at, last_used_at, revoked_at
FROM app_deploy_tokens;

DROP TABLE app_deploy_tokens;
ALTER TABLE app_deploy_tokens_v2 RENAME TO app_deploy_tokens;

CREATE INDEX idx_app_deploy_tokens_app
  ON app_deploy_tokens(app_id, revoked_at, expires_at);

CREATE INDEX idx_app_deploy_tokens_hash
  ON app_deploy_tokens(token_hash);
