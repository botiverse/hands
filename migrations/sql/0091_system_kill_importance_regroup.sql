-- Regroup system kills that were filed as background although the system
-- reported them foreground or visible at the moment of exit.
--
-- The background rule now lets `crash_exit_importance` decide alone whenever
-- the exit record carries it (>= 400 is background). Earlier ingest also
-- treated a stale memory-trim or app-recorded state as background, so a few
-- tickets with importance < 400 were stored under `SystemKill@background`.
-- Give them back the signature ingest computes for any other crash:
-- `<crash_exception_class>@<crash_top_frame>`.
--
-- Only the signature changes. Status and closure reason are left as they are:
-- a person may have already reopened or re-closed a ticket.
-- Rows whose class or frame is missing, or whose frame has parentheses (which
-- ingest normalises), are left alone rather than guessed.

UPDATE feedback_tickets
SET signature = substr(
      trim(json_extract(metadata_json, '$.crash_exception_class'))
        || '@' || trim(json_extract(metadata_json, '$.crash_top_frame')),
      1, 300)
WHERE signature = 'SystemKill@background'
  AND kind IN ('crash', 'error')
  AND json_valid(metadata_json)
  AND json_extract(metadata_json, '$.crash_type') = 'system_kill'
  AND json_type(metadata_json, '$.crash_exit_importance') IN ('integer', 'real')
  AND CAST(json_extract(metadata_json, '$.crash_exit_importance') AS INTEGER) < 400
  AND json_type(metadata_json, '$.crash_exception_class') = 'text'
  AND trim(json_extract(metadata_json, '$.crash_exception_class')) <> ''
  AND json_type(metadata_json, '$.crash_top_frame') = 'text'
  AND trim(json_extract(metadata_json, '$.crash_top_frame')) <> ''
  AND instr(json_extract(metadata_json, '$.crash_top_frame'), '(') = 0;
