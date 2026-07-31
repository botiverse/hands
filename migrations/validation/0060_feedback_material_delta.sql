-- Post-migration / restore validator for feedback material-delta state.
--
-- A valid database returns zero rows. Any returned row is a hard rollout or
-- restore blocker; repair ticket carrier and allocator state together before
-- allowing material-delta readers or writers to resume.
WITH app_stats AS (
  SELECT a.id AS app_id,
         COUNT(t.id) AS ticket_count,
         SUM(CASE WHEN t.id IS NOT NULL AND t.material_sequence IS NULL THEN 1 ELSE 0 END) AS null_count,
         SUM(CASE WHEN t.id IS NOT NULL AND typeof(t.material_sequence) != 'integer' THEN 1 ELSE 0 END) AS noninteger_count,
         SUM(CASE WHEN t.id IS NOT NULL AND t.material_sequence <= 0 THEN 1 ELSE 0 END) AS nonpositive_count,
         SUM(CASE WHEN t.id IS NOT NULL AND t.material_sequence > 9007199254740991 THEN 1 ELSE 0 END) AS unsafe_count,
         COUNT(t.material_sequence) - COUNT(DISTINCT t.material_sequence) AS duplicate_count,
         MAX(t.material_sequence) AS max_sequence,
         s.high_water AS high_water,
         typeof(s.high_water) AS high_water_type
  FROM apps a
  LEFT JOIN feedback_tickets t ON t.app_id = a.id
  LEFT JOIN feedback_material_sequence_state s ON s.app_id = a.id
  GROUP BY a.id, s.high_water
), violations AS (
  SELECT app_id,
         CASE
           WHEN ticket_count > 0 AND high_water IS NULL THEN 'missing_state'
           WHEN null_count > 0 THEN 'null_ticket_sequence'
           WHEN noninteger_count > 0 THEN 'noninteger_ticket_sequence'
           WHEN nonpositive_count > 0 THEN 'nonpositive_ticket_sequence'
           WHEN unsafe_count > 0 THEN 'unsafe_ticket_sequence'
           WHEN duplicate_count > 0 THEN 'duplicate_ticket_sequence'
           WHEN high_water IS NOT NULL AND high_water_type != 'integer' THEN 'noninteger_high_water'
           WHEN high_water IS NOT NULL AND (high_water < 0 OR high_water > 9007199254740991) THEN 'unsafe_high_water'
           WHEN ticket_count = 0 AND high_water NOT IN (0) THEN 'empty_app_nonzero_state'
           WHEN ticket_count > 0 AND max_sequence > high_water THEN 'ticket_ahead_of_high_water'
           WHEN ticket_count > 0 AND max_sequence != high_water THEN 'max_high_water_mismatch'
           ELSE NULL
         END AS violation,
         ticket_count,
         max_sequence,
         high_water
  FROM app_stats
)
SELECT app_id, violation, ticket_count, max_sequence, high_water
FROM violations
WHERE violation IS NOT NULL
ORDER BY app_id;
