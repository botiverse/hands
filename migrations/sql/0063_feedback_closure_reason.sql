-- Closing a feedback ticket carries a durable reason. Status remains the
-- four-state workflow; the reason explains why the terminal `closed` state
-- was chosen without inventing more statuses.

ALTER TABLE feedback_tickets
  ADD COLUMN closure_reason TEXT
    CHECK (
      closure_reason IS NULL OR closure_reason IN (
        'completed',
        'no_longer_needed',
        'not_planned',
        'cannot_reproduce',
        'duplicate'
      )
    );

ALTER TABLE feedback_tickets
  ADD COLUMN duplicate_of_ticket_id TEXT
    REFERENCES feedback_tickets(id) ON DELETE RESTRICT;

CREATE INDEX idx_feedback_tickets_duplicate_of
  ON feedback_tickets(app_id, duplicate_of_ticket_id)
  WHERE duplicate_of_ticket_id IS NOT NULL;

CREATE TRIGGER feedback_ticket_closure_insert
BEFORE INSERT ON feedback_tickets
WHEN
  (NEW.status = 'closed' AND NEW.closure_reason IS NULL)
  OR (NEW.status <> 'closed' AND (
    NEW.closure_reason IS NOT NULL OR NEW.duplicate_of_ticket_id IS NOT NULL
  ))
  OR (NEW.closure_reason = 'duplicate' AND (
    NEW.duplicate_of_ticket_id IS NULL
    OR NEW.duplicate_of_ticket_id = NEW.id
    OR NOT EXISTS (
      SELECT 1 FROM feedback_tickets original
      WHERE original.id = NEW.duplicate_of_ticket_id
        AND original.app_id = NEW.app_id
    )
  ))
  OR (NEW.closure_reason IS NOT NULL
      AND NEW.closure_reason <> 'duplicate'
      AND NEW.duplicate_of_ticket_id IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'invalid feedback closure reason');
END;

CREATE TRIGGER feedback_ticket_closure_update
BEFORE UPDATE OF status, closure_reason, duplicate_of_ticket_id, app_id
ON feedback_tickets
WHEN
  (OLD.status <> 'closed' AND NEW.status = 'closed' AND NEW.closure_reason IS NULL)
  OR (NEW.status <> 'closed' AND (
    NEW.closure_reason IS NOT NULL OR NEW.duplicate_of_ticket_id IS NOT NULL
  ))
  OR (NEW.closure_reason = 'duplicate' AND (
    NEW.duplicate_of_ticket_id IS NULL
    OR NEW.duplicate_of_ticket_id = NEW.id
    OR NOT EXISTS (
      SELECT 1 FROM feedback_tickets original
      WHERE original.id = NEW.duplicate_of_ticket_id
        AND original.app_id = NEW.app_id
    )
  ))
  OR (NEW.closure_reason IS NOT NULL
      AND NEW.closure_reason <> 'duplicate'
      AND NEW.duplicate_of_ticket_id IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'invalid feedback closure reason');
END;
