ALTER TABLE feedback_tickets ADD COLUMN submission_id TEXT;
ALTER TABLE feedback_tickets ADD COLUMN submission_fingerprint TEXT;
ALTER TABLE feedback_tickets ADD COLUMN reporter_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_feedback_tickets_submission
  ON feedback_tickets(app_id, submission_id)
  WHERE submission_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_feedback_tickets_reporter
  ON feedback_tickets(app_id, reporter_id, created_at)
  WHERE reporter_id IS NOT NULL;
