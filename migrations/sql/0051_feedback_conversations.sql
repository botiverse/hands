CREATE TABLE app_reporter_integrations (
  id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  archived_at INTEGER,
  UNIQUE(app_id, name)
);

CREATE INDEX idx_app_reporter_integrations_app
  ON app_reporter_integrations(app_id, archived_at, created_at);

ALTER TABLE app_deploy_tokens
  ADD COLUMN reporter_integration_id TEXT REFERENCES app_reporter_integrations(id) ON DELETE SET NULL;

ALTER TABLE feedback_tickets
  ADD COLUMN reporter_integration_id TEXT REFERENCES app_reporter_integrations(id) ON DELETE CASCADE;

INSERT OR IGNORE INTO app_reporter_integrations
  (id, app_id, name, created_at, updated_at, archived_at)
SELECT 'legacy-feedback:' || a.id,
       a.id,
       'Legacy feedback integration',
       COALESCE(MIN(t.created_at), MIN(dt.created_at), a.created_at),
       COALESCE(MIN(t.created_at), MIN(dt.created_at), a.created_at),
       NULL
FROM apps a
LEFT JOIN feedback_tickets t
  ON t.app_id = a.id AND t.reporter_id IS NOT NULL
LEFT JOIN app_deploy_tokens dt
  ON dt.app_id = a.id
 AND dt.app_role IS NULL
 AND dt.scopes_json IS NOT NULL
 AND json_valid(dt.scopes_json)
 AND EXISTS (
   SELECT 1 FROM json_each(dt.scopes_json)
   WHERE json_each.value = 'feedback:write'
 )
WHERE t.id IS NOT NULL OR dt.id IS NOT NULL
GROUP BY a.id;

UPDATE feedback_tickets
SET reporter_integration_id = 'legacy-feedback:' || app_id
WHERE reporter_id IS NOT NULL;

UPDATE app_deploy_tokens
SET reporter_integration_id = 'legacy-feedback:' || app_id
WHERE app_role IS NULL
  AND scopes_json IS NOT NULL
  AND json_valid(scopes_json)
  AND EXISTS (
    SELECT 1 FROM json_each(scopes_json)
    WHERE json_each.value = 'feedback:write'
  );

DROP INDEX IF EXISTS idx_feedback_tickets_submission;
DROP INDEX IF EXISTS idx_feedback_tickets_reporter;

CREATE UNIQUE INDEX idx_feedback_tickets_submission_direct
  ON feedback_tickets(app_id, submission_id)
  WHERE submission_id IS NOT NULL AND reporter_integration_id IS NULL;

CREATE UNIQUE INDEX idx_feedback_tickets_submission_reporter
  ON feedback_tickets(app_id, reporter_integration_id, submission_id)
  WHERE submission_id IS NOT NULL AND reporter_integration_id IS NOT NULL;

CREATE INDEX idx_feedback_tickets_reporter
  ON feedback_tickets(app_id, reporter_integration_id, reporter_id, created_at DESC, id DESC)
  WHERE reporter_integration_id IS NOT NULL AND reporter_id IS NOT NULL;

ALTER TABLE feedback_comments RENAME TO feedback_comments_legacy;

CREATE TABLE feedback_comments (
  id TEXT PRIMARY KEY,
  ticket_id TEXT NOT NULL REFERENCES feedback_tickets(id) ON DELETE CASCADE,
  author_actor TEXT NOT NULL,
  author_type TEXT NOT NULL DEFAULT 'staff'
    CHECK (author_type IN ('reporter', 'staff', 'system')),
  body TEXT NOT NULL,
  internal INTEGER NOT NULL DEFAULT 0 CHECK (internal IN (0, 1)),
  reporter_integration_id TEXT REFERENCES app_reporter_integrations(id) ON DELETE CASCADE,
  reporter_id TEXT,
  submission_id TEXT,
  submission_fingerprint TEXT,
  created_at INTEGER NOT NULL,
  CHECK (
    (
      author_type = 'reporter'
      AND internal = 0
      AND reporter_integration_id IS NOT NULL
      AND reporter_id IS NOT NULL
      AND submission_id IS NOT NULL
      AND submission_fingerprint IS NOT NULL
    )
    OR
    (
      author_type IN ('staff', 'system')
      AND reporter_integration_id IS NULL
      AND reporter_id IS NULL
      AND submission_id IS NULL
      AND submission_fingerprint IS NULL
    )
  )
);

INSERT INTO feedback_comments
  (id, ticket_id, author_actor, author_type, body, internal,
   reporter_integration_id, reporter_id, submission_id,
   submission_fingerprint, created_at)
SELECT id, ticket_id, author_actor, 'staff', body, internal,
       NULL, NULL, NULL, NULL, created_at
FROM feedback_comments_legacy;

DROP TABLE feedback_comments_legacy;

CREATE INDEX idx_feedback_comments_ticket
  ON feedback_comments(ticket_id, created_at, id);

CREATE UNIQUE INDEX idx_feedback_comments_reporter_submission
  ON feedback_comments(ticket_id, reporter_integration_id, reporter_id, submission_id)
  WHERE author_type = 'reporter';

ALTER TABLE feedback_attachments RENAME TO feedback_attachments_legacy;

CREATE TABLE feedback_attachments (
  id TEXT PRIMARY KEY,
  ticket_id TEXT NOT NULL REFERENCES feedback_tickets(id) ON DELETE CASCADE,
  r2_key TEXT NOT NULL,
  filename TEXT NOT NULL,
  content_type TEXT,
  size_bytes INTEGER NOT NULL,
  origin TEXT NOT NULL DEFAULT 'submission'
    CHECK (origin IN ('submission', 'staff', 'system')),
  visibility TEXT NOT NULL DEFAULT 'reporter'
    CHECK (visibility IN ('reporter', 'internal')),
  created_at INTEGER NOT NULL
);

INSERT INTO feedback_attachments
  (id, ticket_id, r2_key, filename, content_type, size_bytes,
   origin, visibility, created_at)
SELECT id, ticket_id, r2_key, filename, content_type, size_bytes,
       'submission', 'reporter', created_at
FROM feedback_attachments_legacy;

DROP TABLE feedback_attachments_legacy;

CREATE INDEX idx_feedback_attachments_ticket
  ON feedback_attachments(ticket_id, visibility, origin, created_at, id);

CREATE TABLE feedback_events (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL
    CHECK (event_type IN ('feedback:comment_created', 'feedback:status_changed')),
  app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  ticket_id TEXT NOT NULL REFERENCES feedback_tickets(id) ON DELETE CASCADE,
  reporter_integration_id TEXT NOT NULL REFERENCES app_reporter_integrations(id) ON DELETE CASCADE,
  reporter_id TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_feedback_events_ticket
  ON feedback_events(ticket_id, created_at, id);

CREATE TRIGGER feedback_events_no_update BEFORE UPDATE ON feedback_events BEGIN SELECT RAISE(ABORT, 'feedback_events are immutable'); END;

ALTER TABLE webhook_deliveries
  ADD COLUMN event_id TEXT REFERENCES feedback_events(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX idx_webhook_deliveries_event
  ON webhook_deliveries(webhook_id, event_id)
  WHERE event_id IS NOT NULL;

CREATE TABLE feedback_reporter_rate_windows (
  app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  reporter_integration_id TEXT NOT NULL REFERENCES app_reporter_integrations(id) ON DELETE CASCADE,
  reporter_hash TEXT NOT NULL,
  audit_key_version TEXT NOT NULL,
  endpoint TEXT NOT NULL
    CHECK (endpoint IN ('list', 'detail', 'attachment', 'comment')),
  window_started_at INTEGER NOT NULL,
  request_count INTEGER NOT NULL DEFAULT 0 CHECK (request_count >= 0),
  last_audited_at INTEGER,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (
    app_id,
    reporter_integration_id,
    reporter_hash,
    audit_key_version,
    endpoint,
    window_started_at
  )
);

CREATE INDEX idx_feedback_reporter_rate_windows_updated
  ON feedback_reporter_rate_windows(updated_at);

CREATE TABLE feedback_reporter_access_audits (
  id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  reporter_integration_id TEXT NOT NULL REFERENCES app_reporter_integrations(id) ON DELETE CASCADE,
  reporter_hash TEXT NOT NULL,
  audit_key_version TEXT NOT NULL,
  endpoint TEXT NOT NULL
    CHECK (endpoint IN ('list', 'detail', 'attachment', 'comment')),
  ticket_id TEXT,
  attachment_id TEXT,
  throttle_window_started_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE INDEX idx_feedback_reporter_access_audits_lookup
  ON feedback_reporter_access_audits(
    app_id, reporter_integration_id, reporter_hash, endpoint, created_at DESC
  );

CREATE INDEX idx_feedback_reporter_access_audits_retention
  ON feedback_reporter_access_audits(created_at);

CREATE UNIQUE INDEX idx_feedback_reporter_access_audits_throttle
  ON feedback_reporter_access_audits(
    app_id, reporter_integration_id, reporter_hash, audit_key_version,
    endpoint, throttle_window_started_at
  ) WHERE throttle_window_started_at IS NOT NULL;

CREATE TRIGGER app_deploy_tokens_reporter_integration_insert BEFORE INSERT ON app_deploy_tokens WHEN NEW.reporter_integration_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM app_reporter_integrations ri WHERE ri.id = NEW.reporter_integration_id AND ri.app_id = NEW.app_id) BEGIN SELECT RAISE(ABORT, 'reporter integration app mismatch'); END;
CREATE TRIGGER app_deploy_tokens_reporter_integration_update BEFORE UPDATE OF app_id, reporter_integration_id ON app_deploy_tokens WHEN NEW.reporter_integration_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM app_reporter_integrations ri WHERE ri.id = NEW.reporter_integration_id AND ri.app_id = NEW.app_id) BEGIN SELECT RAISE(ABORT, 'reporter integration app mismatch'); END;
CREATE TRIGGER feedback_tickets_reporter_integration_insert BEFORE INSERT ON feedback_tickets WHEN NEW.reporter_integration_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM app_reporter_integrations ri WHERE ri.id = NEW.reporter_integration_id AND ri.app_id = NEW.app_id) BEGIN SELECT RAISE(ABORT, 'reporter integration app mismatch'); END;
CREATE TRIGGER feedback_tickets_reporter_integration_update BEFORE UPDATE OF app_id, reporter_integration_id ON feedback_tickets WHEN NEW.reporter_integration_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM app_reporter_integrations ri WHERE ri.id = NEW.reporter_integration_id AND ri.app_id = NEW.app_id) BEGIN SELECT RAISE(ABORT, 'reporter integration app mismatch'); END;
CREATE TRIGGER feedback_comments_reporter_owner_insert BEFORE INSERT ON feedback_comments WHEN NEW.author_type = 'reporter' AND NOT EXISTS (SELECT 1 FROM feedback_tickets t WHERE t.id = NEW.ticket_id AND t.reporter_integration_id = NEW.reporter_integration_id AND t.reporter_id = NEW.reporter_id) BEGIN SELECT RAISE(ABORT, 'reporter comment owner mismatch'); END;
CREATE TRIGGER feedback_events_owner_insert BEFORE INSERT ON feedback_events WHEN NOT EXISTS (SELECT 1 FROM feedback_tickets t JOIN app_reporter_integrations ri ON ri.id = t.reporter_integration_id AND ri.app_id = t.app_id AND ri.archived_at IS NULL WHERE t.id = NEW.ticket_id AND t.app_id = NEW.app_id AND t.reporter_integration_id = NEW.reporter_integration_id AND t.reporter_id = NEW.reporter_id) BEGIN SELECT RAISE(ABORT, 'feedback event owner mismatch'); END;
