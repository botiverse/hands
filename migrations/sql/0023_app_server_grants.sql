CREATE TABLE IF NOT EXISTS app_server_grants (
  id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  server_id TEXT,
  server_slug TEXT,
  app_role TEXT NOT NULL CHECK (app_role IN ('admin', 'publisher', 'viewer')),
  granted_by TEXT REFERENCES raft_accounts(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (server_id IS NOT NULL OR server_slug IS NOT NULL),
  UNIQUE (app_id, server_id),
  UNIQUE (app_id, server_slug)
);

CREATE INDEX IF NOT EXISTS idx_app_server_grants_server
  ON app_server_grants(server_id, app_role);

CREATE INDEX IF NOT EXISTS idx_app_server_grants_server_slug
  ON app_server_grants(server_slug, app_role);
