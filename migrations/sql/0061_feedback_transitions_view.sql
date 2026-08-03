-- Replayable, minimized feedback transitions for app-scoped agent patrols.
--
-- audit_logs remains the single append-only source of truth. This view strips
-- actor and arbitrary payload data, expands a combined status+assignee audit
-- into a fixed status-then-assignee order, and exposes no reporter identity,
-- comment body, contact, device, webhook data, or secret-bearing field.

CREATE TRIGGER audit_logs_no_update BEFORE UPDATE ON audit_logs BEGIN SELECT RAISE(ABORT, 'audit logs are immutable'); END;

CREATE TRIGGER audit_logs_no_delete BEFORE DELETE ON audit_logs WHEN EXISTS (SELECT 1 FROM apps WHERE id = OLD.app_id) BEGIN SELECT RAISE(ABORT, 'audit logs are durable while app exists'); END;

CREATE INDEX idx_audit_app_action ON audit_logs(app_id, action);
CREATE INDEX idx_audit_action_created ON audit_logs(action, created_at);

CREATE VIEW feedback_transitions AS
WITH safe_logs AS (
  SELECT rowid AS audit_rowid, app_id, action, created_at,
         CASE WHEN json_valid(payload) THEN payload ELSE '{}' END AS payload
  FROM audit_logs
), expanded AS (
  SELECT l.audit_rowid,
         1 AS event_order,
         l.app_id,
         json_extract(l.payload, '$.ticket_id') AS ticket_id,
         'status_changed' AS transition_type,
         json_extract(l.payload, '$.previous_status') AS previous_value,
         json_extract(l.payload, '$.status') AS value,
         l.created_at AS occurred_at
  FROM safe_logs l
  WHERE l.action = 'feedback.update'
    AND json_type(l.payload, '$.ticket_id') = 'text'
    AND json_type(l.payload, '$.previous_status') = 'text'
    AND json_type(l.payload, '$.status') = 'text'
    AND json_extract(l.payload, '$.previous_status') IS NOT json_extract(l.payload, '$.status')

  UNION ALL

  SELECT l.audit_rowid,
         2,
         l.app_id,
         json_extract(l.payload, '$.ticket_id'),
         'assignee_changed',
         json_extract(l.payload, '$.previous_assignee'),
         json_extract(l.payload, '$.assignee'),
         l.created_at
  FROM safe_logs l
  WHERE l.action = 'feedback.update'
    AND json_type(l.payload, '$.ticket_id') = 'text'
    AND json_type(l.payload, '$.previous_assignee') IN ('text', 'null')
    AND json_type(l.payload, '$.assignee') IN ('text', 'null')
    AND json_extract(l.payload, '$.previous_assignee') IS NOT json_extract(l.payload, '$.assignee')

  UNION ALL

  SELECT l.audit_rowid,
         1,
         l.app_id,
         json_extract(l.payload, '$.ticket_id'),
         'comment_visibility',
         NULL,
         CASE WHEN json_extract(l.payload, '$.internal') = 1 THEN 'internal' ELSE 'reporter' END,
         l.created_at
  FROM safe_logs l
  WHERE l.action = 'feedback.comment'
    AND json_type(l.payload, '$.ticket_id') = 'text'
    AND json_type(l.payload, '$.internal') IN ('true', 'false')

  UNION ALL

  SELECT l.audit_rowid,
         1,
         l.app_id,
         json_extract(l.payload, '$.ticket_id'),
         'comment_visibility',
         NULL,
         'reporter',
         l.created_at
  FROM safe_logs l
  WHERE l.action = 'feedback.reporter_comment'
    AND json_type(l.payload, '$.ticket_id') = 'text'
), numbered AS (
  SELECT app_id,
         ROW_NUMBER() OVER (
           PARTITION BY app_id ORDER BY audit_rowid, event_order
         ) AS sequence,
         ticket_id,
         transition_type,
         previous_value,
         value,
         occurred_at
  FROM expanded
)
SELECT app_id, sequence, ticket_id, transition_type,
       previous_value, value, occurred_at
FROM numbered;
