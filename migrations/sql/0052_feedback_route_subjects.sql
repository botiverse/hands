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
  WHERE ri.id = NEW.reporter_integration_id
    AND ri.app_id = NEW.app_id
    AND ri.archived_at IS NULL
)
BEGIN SELECT RAISE(ABORT, 'reporter route integration mismatch'); END;

CREATE TRIGGER app_reporter_routes_no_update
BEFORE UPDATE ON app_reporter_routes
BEGIN SELECT RAISE(ABORT, 'v1 reporter routes are immutable'); END;

CREATE TRIGGER app_reporter_routes_no_delete
BEFORE DELETE ON app_reporter_routes
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
