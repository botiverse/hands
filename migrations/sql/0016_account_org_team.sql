-- Migration 0016: account / organization / team / invite schema.
--
-- Organizations are aligned 1:1 with Raft server_id. Humans and agents are
-- both first-class principals via raft_accounts; membership shape is the same
-- and only default role differs.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS organizations (
  id                 TEXT PRIMARY KEY,
  slug               TEXT NOT NULL UNIQUE,
  name               TEXT NOT NULL,
  external_provider  TEXT NOT NULL DEFAULT 'raft',
  external_id        TEXT NOT NULL,
  created_at         INTEGER NOT NULL,
  archived           INTEGER NOT NULL DEFAULT 0,
  UNIQUE (external_provider, external_id)
);

CREATE INDEX IF NOT EXISTS idx_organizations_external
  ON organizations(external_provider, external_id);

CREATE TABLE IF NOT EXISTS org_members (
  id          TEXT PRIMARY KEY,
  org_id      TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  account_id  TEXT NOT NULL REFERENCES raft_accounts(id) ON DELETE CASCADE,
  org_role    TEXT NOT NULL,
  invited_by  TEXT REFERENCES raft_accounts(id) ON DELETE SET NULL,
  joined_at   INTEGER NOT NULL,
  UNIQUE (org_id, account_id)
);

CREATE INDEX IF NOT EXISTS idx_org_members_account
  ON org_members(account_id);

CREATE INDEX IF NOT EXISTS idx_org_members_role
  ON org_members(org_id, org_role);

CREATE TABLE IF NOT EXISTS app_members (
  id          TEXT PRIMARY KEY,
  app_id      TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  account_id  TEXT NOT NULL REFERENCES raft_accounts(id) ON DELETE CASCADE,
  app_role    TEXT NOT NULL,
  invited_by  TEXT REFERENCES raft_accounts(id) ON DELETE SET NULL,
  joined_at   INTEGER NOT NULL,
  UNIQUE (app_id, account_id)
);

CREATE INDEX IF NOT EXISTS idx_app_members_account
  ON app_members(account_id);

CREATE INDEX IF NOT EXISTS idx_app_members_role
  ON app_members(app_id, app_role);

CREATE TABLE IF NOT EXISTS invites (
  id           TEXT PRIMARY KEY,
  org_id       TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  app_id       TEXT REFERENCES apps(id) ON DELETE CASCADE,
  email        TEXT NOT NULL,
  role         TEXT NOT NULL,
  token        TEXT NOT NULL UNIQUE,
  invited_by   TEXT NOT NULL REFERENCES raft_accounts(id) ON DELETE CASCADE,
  status       TEXT NOT NULL DEFAULT 'pending',
  message      TEXT,
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  accepted_at  INTEGER,
  accepted_by  TEXT REFERENCES raft_accounts(id) ON DELETE SET NULL,
  revoked_at   INTEGER,
  revoked_by   TEXT REFERENCES raft_accounts(id) ON DELETE SET NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_invites_pending_email
  ON invites(org_id, email)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_invites_token
  ON invites(token);

CREATE INDEX IF NOT EXISTS idx_invites_org_status
  ON invites(org_id, status, expires_at);

CREATE INDEX IF NOT EXISTS idx_invites_app_status
  ON invites(app_id, status, expires_at)
  WHERE app_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_invites_email
  ON invites(email);

ALTER TABLE apps ADD COLUMN org_id TEXT REFERENCES organizations(id);

CREATE INDEX IF NOT EXISTS idx_apps_org
  ON apps(org_id, created_at DESC);

ALTER TABLE audit_logs ADD COLUMN actor_id TEXT REFERENCES raft_accounts(id);
ALTER TABLE audit_logs ADD COLUMN actor_type TEXT;

CREATE INDEX IF NOT EXISTS idx_audit_actor_created
  ON audit_logs(actor_id, created_at DESC)
  WHERE actor_id IS NOT NULL;

-- Existing Raft servers become deterministic Quiver organizations.
INSERT OR IGNORE INTO organizations
  (id, slug, name, external_provider, external_id, created_at, archived)
SELECT
  'raft_' || server_id,
  COALESCE(NULLIF(server_slug, ''), 'raft') || '-' || substr(server_id, 1, 8),
  COALESCE(NULLIF(server_slug, ''), 'Raft server ' || substr(server_id, 1, 8)),
  'raft',
  server_id,
  MIN(created_at),
  0
FROM raft_accounts
GROUP BY server_id;

-- Empty installs still get a local fallback org so apps can be created with
-- dev-token auth before the first Raft login.
INSERT OR IGNORE INTO organizations
  (id, slug, name, external_provider, external_id, created_at, archived)
SELECT 'default', 'default', 'Default', 'local', 'default', strftime('%s', 'now') * 1000, 0
WHERE NOT EXISTS (SELECT 1 FROM organizations);

-- Attach existing accounts to their Raft-server org. First human per server is
-- owner. If a server has only agents so far, the first principal is admin so
-- the org is not orphaned. Subsequent humans default member; agents default viewer.
INSERT OR IGNORE INTO org_members
  (id, org_id, account_id, org_role, invited_by, joined_at)
SELECT
  'orgmem_' || a.id,
  'raft_' || a.server_id,
  a.id,
  CASE
    WHEN a.principal_type = 'human'
      AND a.created_at = (
        SELECT MIN(h.created_at)
        FROM raft_accounts h
        WHERE h.server_id = a.server_id AND h.principal_type = 'human'
      )
      THEN 'owner'
    WHEN NOT EXISTS (
        SELECT 1
        FROM raft_accounts h
        WHERE h.server_id = a.server_id AND h.principal_type = 'human'
      )
      AND a.created_at = (
        SELECT MIN(f.created_at)
        FROM raft_accounts f
        WHERE f.server_id = a.server_id
      )
      THEN 'admin'
    WHEN LOWER(COALESCE(a.server_role, '')) IN ('owner', 'admin')
      THEN 'admin'
    WHEN a.principal_type = 'agent'
      THEN 'viewer'
    ELSE 'member'
  END,
  NULL,
  a.created_at
FROM raft_accounts a;

-- Existing apps belong to the first known Raft org. If there is no Raft account
-- yet, keep them in the local default org until an admin rehomes them.
UPDATE apps
SET org_id = COALESCE(
  (
    SELECT 'raft_' || server_id
    FROM raft_accounts
    ORDER BY created_at ASC
    LIMIT 1
  ),
  'default'
)
WHERE org_id IS NULL;

-- Preserve pre-RBAC access to existing data: humans get app admin, agents get
-- app viewer. Future accounts join the org automatically and can be promoted.
INSERT OR IGNORE INTO app_members
  (id, app_id, account_id, app_role, invited_by, joined_at)
SELECT
  'appmem_' || apps.id || '_' || raft_accounts.id,
  apps.id,
  raft_accounts.id,
  CASE WHEN raft_accounts.principal_type = 'agent' THEN 'viewer' ELSE 'admin' END,
  NULL,
  raft_accounts.created_at
FROM apps
JOIN raft_accounts ON apps.org_id = 'raft_' || raft_accounts.server_id;

UPDATE audit_logs
SET
  actor_id = (
    SELECT id
    FROM raft_accounts
    WHERE display_name = audit_logs.actor
       OR username = audit_logs.actor
       OR ('raft:' || COALESCE(username, display_name) || '@' || COALESCE(server_slug, server_id)) = audit_logs.actor
    ORDER BY last_login_at DESC
    LIMIT 1
  ),
  actor_type = COALESCE(
    (
      SELECT principal_type
      FROM raft_accounts
      WHERE display_name = audit_logs.actor
         OR username = audit_logs.actor
         OR ('raft:' || COALESCE(username, display_name) || '@' || COALESCE(server_slug, server_id)) = audit_logs.actor
      ORDER BY last_login_at DESC
      LIMIT 1
    ),
    CASE WHEN actor IN ('system', 'dev-token', 'admin') THEN 'system' ELSE NULL END
  )
WHERE actor_id IS NULL;
