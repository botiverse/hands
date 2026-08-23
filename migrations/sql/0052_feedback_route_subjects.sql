CREATE TABLE app_reporter_routes (
  app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  reporter_integration_id TEXT NOT NULL REFERENCES app_reporter_integrations(id) ON DELETE CASCADE,
  reporter_id TEXT NOT NULL,
  route_subject TEXT NOT NULL,
  subject_version TEXT NOT NULL CHECK (subject_version = 'v1'),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (app_id, reporter_integration_id, reporter_id),
  CHECK (length(route_subject) BETWEEN 8 AND 160),
  CHECK (substr(route_subject, 1, 7) = 'rfr_v1_'),
  CHECK (route_subject NOT GLOB '*[^A-Za-z0-9_-]*')
);

CREATE INDEX idx_app_reporter_routes_integration
  ON app_reporter_routes(app_id, reporter_integration_id, created_at);

CREATE TRIGGER app_reporter_routes_owner_insert
BEFORE INSERT ON app_reporter_routes
WHEN NOT EXISTS (
  SELECT 1 FROM app_reporter_integrations ri
  JOIN apps a ON a.id = ri.app_id
  WHERE ri.id = NEW.reporter_integration_id
    AND ri.app_id = NEW.app_id
    AND ri.archived_at IS NULL
    AND a.archived = 0
)
BEGIN SELECT RAISE(ABORT, 'reporter route integration mismatch'); END;

CREATE TRIGGER app_reporter_routes_no_update
BEFORE UPDATE ON app_reporter_routes
BEGIN SELECT RAISE(ABORT, 'v1 reporter routes are immutable'); END;

CREATE TRIGGER app_reporter_routes_no_delete
BEFORE DELETE ON app_reporter_routes
WHEN EXISTS (SELECT 1 FROM apps WHERE id = OLD.app_id)
BEGIN SELECT RAISE(ABORT, 'v1 reporter routes are immutable'); END;

CREATE TABLE app_reporter_webhook_subscriptions (
  app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  reporter_integration_id TEXT NOT NULL REFERENCES app_reporter_integrations(id) ON DELETE CASCADE,
  webhook_id TEXT NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (app_id, reporter_integration_id, webhook_id)
);

CREATE INDEX idx_app_reporter_webhook_subscriptions_webhook
  ON app_reporter_webhook_subscriptions(webhook_id, app_id, reporter_integration_id);

CREATE TRIGGER app_reporter_webhook_subscriptions_owner_insert
BEFORE INSERT ON app_reporter_webhook_subscriptions
WHEN NOT EXISTS (
  SELECT 1
  FROM app_reporter_integrations ri
  JOIN apps a ON a.id = ri.app_id
  JOIN webhooks w ON w.id = NEW.webhook_id
  WHERE ri.id = NEW.reporter_integration_id
    AND ri.app_id = NEW.app_id
    AND ri.archived_at IS NULL
    AND a.archived = 0
    AND w.app_id = NEW.app_id
    AND w.org_id = a.org_id
    AND w.enabled = 1
    AND w.archived_at IS NULL
)
BEGIN SELECT RAISE(ABORT, 'reporter webhook subscription mismatch'); END;

ALTER TABLE feedback_events
  ADD COLUMN route_outcome TEXT NOT NULL DEFAULT 'route_unbound'
    CHECK (route_outcome IN ('route_bound', 'route_unbound'));

ALTER TABLE feedback_events
  ADD COLUMN route_subject TEXT;

CREATE TRIGGER feedback_events_route_snapshot_insert
BEFORE INSERT ON feedback_events
WHEN (NEW.route_outcome = 'route_bound') != (NEW.route_subject IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'feedback event route snapshot mismatch'); END;

-- Initial trusted submissions use a separate immutable ledger because the
-- already-deployed feedback_events CHECK cannot be widened in place safely.
CREATE TABLE feedback_submission_events (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL CHECK (event_type = 'feedback:new'),
  app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  ticket_id TEXT NOT NULL REFERENCES feedback_tickets(id) ON DELETE CASCADE,
  reporter_integration_id TEXT NOT NULL REFERENCES app_reporter_integrations(id) ON DELETE CASCADE,
  reporter_id TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  route_outcome TEXT NOT NULL CHECK (route_outcome = 'route_bound'),
  route_subject TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX idx_feedback_submission_events_ticket
  ON feedback_submission_events(ticket_id);

CREATE TRIGGER feedback_submission_events_no_update
BEFORE UPDATE ON feedback_submission_events
BEGIN SELECT RAISE(ABORT, 'feedback submission events are immutable'); END;

CREATE TRIGGER feedback_submission_events_owner_insert
BEFORE INSERT ON feedback_submission_events
WHEN NOT EXISTS (
  SELECT 1
  FROM feedback_tickets t
  JOIN apps a ON a.id = t.app_id AND a.archived = 0
  JOIN app_reporter_integrations ri
    ON ri.id = t.reporter_integration_id
   AND ri.app_id = t.app_id
   AND ri.archived_at IS NULL
  JOIN app_reporter_routes r
    ON r.app_id = t.app_id
   AND r.reporter_integration_id = t.reporter_integration_id
   AND r.reporter_id = t.reporter_id
   AND r.route_subject = NEW.route_subject
  WHERE t.id = NEW.ticket_id
    AND t.app_id = NEW.app_id
    AND t.reporter_integration_id = NEW.reporter_integration_id
    AND t.reporter_id = NEW.reporter_id
)
BEGIN SELECT RAISE(ABORT, 'feedback submission event owner mismatch'); END;

ALTER TABLE webhooks
  ADD COLUMN signature_key_version TEXT NOT NULL DEFAULT 'v1';

ALTER TABLE webhook_deliveries
  ADD COLUMN feedback_submission_event_id TEXT
    REFERENCES feedback_submission_events(id) ON DELETE SET NULL;

ALTER TABLE webhook_deliveries
  ADD COLUMN signing_secret TEXT;

ALTER TABLE webhook_deliveries
  ADD COLUMN signature_key_version TEXT NOT NULL DEFAULT 'legacy-v1';

ALTER TABLE webhook_deliveries
  ADD COLUMN reporter_delivery INTEGER NOT NULL DEFAULT 0
    CHECK (reporter_delivery IN (0, 1));

CREATE UNIQUE INDEX idx_webhook_deliveries_submission_event
  ON webhook_deliveries(webhook_id, feedback_submission_event_id)
  WHERE feedback_submission_event_id IS NOT NULL;
