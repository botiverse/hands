CREATE TABLE feedback_reporter_ticket_reads (
  app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  reporter_integration_id TEXT NOT NULL
    REFERENCES app_reporter_integrations(id) ON DELETE CASCADE,
  reporter_id TEXT NOT NULL,
  ticket_id TEXT NOT NULL REFERENCES feedback_tickets(id) ON DELETE CASCADE,
  read_through_created_at INTEGER NOT NULL CHECK (read_through_created_at >= 0),
  read_through_comment_id TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (app_id, reporter_integration_id, reporter_id, ticket_id)
);

CREATE INDEX idx_feedback_reporter_ticket_reads_ticket
  ON feedback_reporter_ticket_reads(ticket_id, updated_at);

CREATE TRIGGER feedback_reporter_ticket_reads_owner_insert
BEFORE INSERT ON feedback_reporter_ticket_reads
WHEN NOT EXISTS (
  SELECT 1 FROM feedback_tickets t
  WHERE t.id = NEW.ticket_id
    AND t.app_id = NEW.app_id
    AND t.reporter_integration_id = NEW.reporter_integration_id
    AND t.reporter_id = NEW.reporter_id
)
BEGIN
  SELECT RAISE(ABORT, 'feedback reporter read owner mismatch');
END;

CREATE TRIGGER feedback_reporter_ticket_reads_owner_update
BEFORE UPDATE OF app_id, reporter_integration_id, reporter_id, ticket_id
ON feedback_reporter_ticket_reads
WHEN NOT EXISTS (
  SELECT 1 FROM feedback_tickets t
  WHERE t.id = NEW.ticket_id
    AND t.app_id = NEW.app_id
    AND t.reporter_integration_id = NEW.reporter_integration_id
    AND t.reporter_id = NEW.reporter_id
)
BEGIN
  SELECT RAISE(ABORT, 'feedback reporter read owner mismatch');
END;

ALTER TABLE feedback_attachments RENAME TO feedback_attachments_legacy;

CREATE TABLE feedback_attachments (
  id TEXT PRIMARY KEY,
  ticket_id TEXT NOT NULL REFERENCES feedback_tickets(id) ON DELETE CASCADE,
  comment_id TEXT REFERENCES feedback_comments(id) ON DELETE CASCADE,
  r2_key TEXT NOT NULL,
  filename TEXT NOT NULL,
  content_type TEXT,
  size_bytes INTEGER NOT NULL,
  origin TEXT NOT NULL DEFAULT 'submission'
    CHECK (origin IN ('submission', 'reporter', 'staff', 'system')),
  visibility TEXT NOT NULL DEFAULT 'reporter'
    CHECK (visibility IN ('reporter', 'internal')),
  created_at INTEGER NOT NULL,
  CHECK (
    (origin = 'reporter' AND comment_id IS NOT NULL AND visibility = 'reporter')
    OR origin != 'reporter'
  )
);

INSERT INTO feedback_attachments
  (id, ticket_id, comment_id, r2_key, filename, content_type, size_bytes,
   origin, visibility, created_at)
SELECT id, ticket_id, NULL, r2_key, filename, content_type, size_bytes,
       origin, visibility, created_at
FROM feedback_attachments_legacy;

DROP TABLE feedback_attachments_legacy;

CREATE INDEX idx_feedback_attachments_ticket
  ON feedback_attachments(ticket_id, visibility, origin, created_at, id);

CREATE TRIGGER feedback_reporter_attachments_owner_insert
BEFORE INSERT ON feedback_attachments
WHEN NEW.origin = 'reporter' AND NOT EXISTS (
  SELECT 1 FROM feedback_comments c
  WHERE c.id = NEW.comment_id AND c.ticket_id = NEW.ticket_id
    AND c.author_type = 'reporter' AND c.internal = 0
)
BEGIN
  SELECT RAISE(ABORT, 'feedback reporter attachment owner mismatch');
END;

CREATE TRIGGER feedback_reporter_attachments_owner_update
BEFORE UPDATE OF ticket_id, comment_id, origin, visibility
ON feedback_attachments
WHEN NEW.origin = 'reporter' AND NOT EXISTS (
  SELECT 1 FROM feedback_comments c
  WHERE c.id = NEW.comment_id AND c.ticket_id = NEW.ticket_id
    AND c.author_type = 'reporter' AND c.internal = 0
)
BEGIN
  SELECT RAISE(ABORT, 'feedback reporter attachment owner mismatch');
END;

CREATE TABLE feedback_reporter_r2_cleanup (
  r2_key TEXT PRIMARY KEY,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error TEXT,
  next_attempt_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_feedback_reporter_r2_cleanup_due
  ON feedback_reporter_r2_cleanup(next_attempt_at, r2_key);
