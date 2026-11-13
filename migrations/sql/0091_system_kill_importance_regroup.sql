-- Regroup system kills stored as background that the corrected rule says are not.
--
-- The background rule now lets `crash_exit_importance` decide alone whenever
-- the exit record carries it (>= 400 is background). Only when it is missing
-- does the app-recorded `crash_foreground` decide, and only when that is also
-- missing the memory-trim state. Earlier ingest let a stale trim or foreground
-- value win, so some tickets were stored under `SystemKill@background` that
-- the corrected rule does not count as background. Because the read-side rule
-- also trusts the stored signature, such rows would stay background forever
-- unless regrouped here.
--
-- Each regrouped row gets the signature ingest's crashSignature() computes:
-- `<class or "UnknownException">@<frame with its first "(...)" removed>`,
-- capped at 300 characters, reading the fallback keys `exception_class` /
-- `top_frame` when the crash_* keys are absent. A row whose class and frame
-- are both missing gets NULL, as ingest would give it.
--
-- Only the signature changes. Status and closure reason are left alone: a
-- person may have already reopened or re-closed a ticket. Re-running this
-- changes nothing, since regrouped rows no longer carry the background signature.
-- Whitespace below is JS String.prototype.trim()'s ASCII set.

WITH candidates AS (
  SELECT
    id,
    -- Same parse as SYSTEM_KILL_IMPORTANCE_SQL in worker/src/routes/feedback.ts.
    CASE
      WHEN json_type(metadata_json, '$.crash_exit_importance') IN ('integer', 'real')
        THEN CAST(json_extract(metadata_json, '$.crash_exit_importance') AS INTEGER)
      WHEN json_type(metadata_json, '$.crash_exit_importance') = 'text'
        AND trim(json_extract(metadata_json, '$.crash_exit_importance'), ' ' || char(9, 10, 11, 12, 13)) <> ''
        AND trim(json_extract(metadata_json, '$.crash_exit_importance'), ' ' || char(9, 10, 11, 12, 13)) NOT GLOB '*[^0-9]*'
        THEN CAST(trim(json_extract(metadata_json, '$.crash_exit_importance'), ' ' || char(9, 10, 11, 12, 13)) AS INTEGER)
    END AS importance,
    json_type(metadata_json, '$.crash_foreground') AS foreground,
    lower(trim(COALESCE(json_extract(metadata_json, '$.crash_trim'), ''), ' ' || char(9, 10, 11, 12, 13))) AS trim_state,
    trim(COALESCE(
      CASE WHEN json_type(metadata_json, '$.crash_exception_class') IS NOT NULL
             AND json_type(metadata_json, '$.crash_exception_class') <> 'null'
           THEN json_extract(metadata_json, '$.crash_exception_class') END,
      CASE WHEN json_type(metadata_json, '$.exception_class') <> 'null'
           THEN json_extract(metadata_json, '$.exception_class') END,
      ''), ' ' || char(9, 10, 11, 12, 13)) AS exc,
    trim(COALESCE(
      CASE WHEN json_type(metadata_json, '$.crash_top_frame') IS NOT NULL
             AND json_type(metadata_json, '$.crash_top_frame') <> 'null'
           THEN json_extract(metadata_json, '$.crash_top_frame') END,
      CASE WHEN json_type(metadata_json, '$.top_frame') <> 'null'
           THEN json_extract(metadata_json, '$.top_frame') END,
      ''), ' ' || char(9, 10, 11, 12, 13)) AS frame,
    json_type(metadata_json, '$.crash_exception_class') AS exc_type,
    json_type(metadata_json, '$.exception_class') AS exc_fallback_type,
    json_type(metadata_json, '$.crash_top_frame') AS frame_type,
    json_type(metadata_json, '$.top_frame') AS frame_fallback_type
  FROM feedback_tickets
  WHERE signature = 'SystemKill@background'
    AND kind IN ('crash', 'error')
    AND json_valid(metadata_json)
    AND json_extract(metadata_json, '$.crash_type') = 'system_kill'
),
regroup AS (
  SELECT
    id,
    CASE WHEN exc = '' AND frame = '' THEN NULL ELSE substr(
      (CASE WHEN exc = '' THEN 'UnknownException' ELSE exc END) || '@' ||
      trim(
        CASE
          WHEN instr(frame, '(') > 0 AND instr(substr(frame, instr(frame, '(')), ')') > 0
            THEN substr(frame, 1, instr(frame, '(') - 1)
              || substr(frame, instr(frame, '(') + instr(substr(frame, instr(frame, '(')), ')'))
          ELSE frame
        END,
        ' ' || char(9, 10, 11, 12, 13)),
      1, 300) END AS new_signature
  FROM candidates
  WHERE
    -- The corrected rule says "not background".
    (CASE
      WHEN importance IS NOT NULL THEN importance < 400
      WHEN foreground = 'true' THEN 1
      WHEN foreground = 'false' THEN 0
      ELSE trim_state NOT IN ('ui_hidden', 'background', 'moderate', 'complete')
    END)
    -- Leave rows whose class or frame is not plain text rather than guess
    -- how JavaScript would have stringified them.
    AND COALESCE(exc_type, exc_fallback_type, 'text') IN ('text', 'null')
    AND COALESCE(frame_type, frame_fallback_type, 'text') IN ('text', 'null')
)
UPDATE feedback_tickets
SET signature = (SELECT new_signature FROM regroup WHERE regroup.id = feedback_tickets.id)
WHERE id IN (SELECT id FROM regroup);
