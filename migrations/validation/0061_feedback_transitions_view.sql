-- Post-migration / restore validator for the feedback transition projection.
-- A valid database returns zero rows.
WITH malformed_source AS (
  SELECT l.app_id,
         'malformed_' || l.action AS violation
  FROM audit_logs l
  WHERE (
      l.action = 'feedback.update'
      AND (
        NOT json_valid(l.payload)
        OR json_type(CASE WHEN json_valid(l.payload) THEN l.payload ELSE '{}' END, '$.ticket_id') IS NOT 'text'
        OR NOT (
          (
            json_type(CASE WHEN json_valid(l.payload) THEN l.payload ELSE '{}' END, '$.previous_status') = 'text'
            AND json_type(CASE WHEN json_valid(l.payload) THEN l.payload ELSE '{}' END, '$.status') = 'text'
          )
          OR
          (
            json_type(CASE WHEN json_valid(l.payload) THEN l.payload ELSE '{}' END, '$.previous_assignee') IN ('text', 'null')
            AND json_type(CASE WHEN json_valid(l.payload) THEN l.payload ELSE '{}' END, '$.assignee') IN ('text', 'null')
          )
        )
      )
    )
    OR (
      l.action = 'feedback.comment'
      AND (
        NOT json_valid(l.payload)
        OR json_type(CASE WHEN json_valid(l.payload) THEN l.payload ELSE '{}' END, '$.ticket_id') IS NOT 'text'
        OR COALESCE(json_type(CASE WHEN json_valid(l.payload) THEN l.payload ELSE '{}' END, '$.internal'), 'missing') NOT IN ('true', 'false')
      )
    )
    OR (
      l.action = 'feedback.reporter_comment'
      AND (
        NOT json_valid(l.payload)
        OR json_type(CASE WHEN json_valid(l.payload) THEN l.payload ELSE '{}' END, '$.ticket_id') IS NOT 'text'
      )
    )
), projection_stats AS (
  SELECT app_id,
         COUNT(*) AS event_count,
         MIN(sequence) AS min_sequence,
         MAX(sequence) AS max_sequence,
         COUNT(*) - COUNT(DISTINCT sequence) AS duplicate_count
  FROM feedback_transitions
  GROUP BY app_id
), projection_violations AS (
  SELECT app_id,
         CASE
           WHEN min_sequence != 1 THEN 'transition_sequence_not_one_based'
           WHEN event_count != max_sequence THEN 'transition_sequence_gap'
           WHEN duplicate_count != 0 THEN 'duplicate_transition_sequence'
           ELSE NULL
         END AS violation
  FROM projection_stats
)
SELECT app_id, violation FROM malformed_source
UNION ALL
SELECT app_id, violation FROM projection_violations WHERE violation IS NOT NULL
ORDER BY app_id, violation;
