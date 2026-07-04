CREATE TABLE IF NOT EXISTS feedback_tickets (
  id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'feedback' CHECK (kind IN ('feedback', 'bug', 'crash')),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'resolved', 'closed')),
  message TEXT NOT NULL,
  contact TEXT,
  version_name TEXT,
  version_code INTEGER,
  channel TEXT,
  device_id TEXT,
  device_model TEXT,
  os_version TEXT,
  arch TEXT,
  locale TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  client_ip_hash TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_feedback_tickets_app
  ON feedback_tickets(app_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_feedback_tickets_rate
  ON feedback_tickets(app_id, client_ip_hash, created_at);

CREATE TABLE IF NOT EXISTS feedback_attachments (
  id TEXT PRIMARY KEY,
  ticket_id TEXT NOT NULL REFERENCES feedback_tickets(id) ON DELETE CASCADE,
  r2_key TEXT NOT NULL,
  filename TEXT NOT NULL,
  content_type TEXT,
  size_bytes INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_feedback_attachments_ticket
  ON feedback_attachments(ticket_id);

CREATE TABLE IF NOT EXISTS feedback_comments (
  id TEXT PRIMARY KEY,
  ticket_id TEXT NOT NULL REFERENCES feedback_tickets(id) ON DELETE CASCADE,
  author_actor TEXT NOT NULL,
  body TEXT NOT NULL,
  internal INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_feedback_comments_ticket
  ON feedback_comments(ticket_id, created_at);
