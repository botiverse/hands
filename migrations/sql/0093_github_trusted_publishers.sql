-- GitHub Actions trusted publishers: a workflow in a named repository, on a
-- matching ref, may exchange its GitHub OIDC token for a short-lived app
-- deploy token. No long-lived secret is stored in the repository.
CREATE TABLE app_github_trusted_publishers (
  id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  -- owner/repo, lower-cased; matched against the token's `repository` claim.
  repository TEXT NOT NULL,
  -- GitHub's numeric repository id, pinned on first use when not given, so a
  -- deleted and re-created repository of the same name cannot publish.
  repository_id TEXT,
  -- The owner's numeric id, pinned the same way.
  repository_owner_id TEXT,
  -- Path of the calling workflow inside the repository, e.g.
  -- .github/workflows/desktop.yml; matched against `workflow_ref`.
  workflow_path TEXT NOT NULL,
  -- JSON array of ref patterns (refs/heads/main, refs/tags/v*); `*` matches
  -- any run of characters except `/`.
  ref_patterns_json TEXT NOT NULL,
  -- Optional GitHub environment the job must run in.
  environment TEXT,
  app_role TEXT NOT NULL DEFAULT 'publisher' CHECK (app_role IN ('publisher', 'viewer')),
  created_by TEXT REFERENCES raft_accounts(id) ON DELETE SET NULL,
  created_by_actor TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at INTEGER
);

CREATE INDEX idx_app_github_trusted_publishers_app
  ON app_github_trusted_publishers(app_id, revoked_at);

-- One exchange per GitHub token (`jti`), so a leaked OIDC token cannot be
-- replayed for more Hands tokens. Rows are useless after expires_at.
CREATE TABLE github_oidc_exchanges (
  jti TEXT PRIMARY KEY,
  publisher_id TEXT NOT NULL,
  deploy_token_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_github_oidc_exchanges_expires
  ON github_oidc_exchanges(expires_at);
