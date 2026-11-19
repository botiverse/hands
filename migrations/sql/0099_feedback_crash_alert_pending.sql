-- A crash alert (new group / spike) owed for a ticket. Set when the ticket is
-- created; cleared once the alert has been decided, which happens only after
-- symbolication has settled the ticket's group. A row still set a few minutes
-- later lost its background run and is finished by the cron sweep.
ALTER TABLE feedback_tickets ADD COLUMN crash_alert_pending_since INTEGER;
CREATE INDEX IF NOT EXISTS idx_feedback_tickets_crash_alert_pending
  ON feedback_tickets(crash_alert_pending_since)
  WHERE crash_alert_pending_since IS NOT NULL;
