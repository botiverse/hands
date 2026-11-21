-- Fill the empty build of crash tickets that a merge left without one.
--
-- When an SDK native crash record (no crash-time version) created a ticket and
-- the app's exit report for the same process merged in later, the merge kept
-- the report's version_name / version_code in metadata but left the ticket's
-- columns empty. Merges now fill an empty build; this applies the same rule to
-- tickets merged before that change.
--
-- Same reading as ingest (metadataVersion in routes/feedback.ts): version_name,
-- then fallback_version_name, first 200 characters, empty counts as missing;
-- version_code from an integer or an all-digit string, then
-- fallback_version_code. Only merged tickets (metadata carries a crash_merge
-- array) and only empty columns change; a build already on a ticket is never
-- replaced. Re-running this changes nothing.

UPDATE feedback_tickets
SET version_name = (
  SELECT substr(v, 1, 200) FROM (
    SELECT CASE
      WHEN json_extract(metadata_json, '$.version_name') IS NOT NULL
        AND CAST(json_extract(metadata_json, '$.version_name') AS TEXT) <> ''
        THEN CAST(json_extract(metadata_json, '$.version_name') AS TEXT)
      WHEN json_extract(metadata_json, '$.fallback_version_name') IS NOT NULL
        AND CAST(json_extract(metadata_json, '$.fallback_version_name') AS TEXT) <> ''
        THEN CAST(json_extract(metadata_json, '$.fallback_version_name') AS TEXT)
    END AS v
  )
)
WHERE version_name IS NULL
  AND kind = 'crash'
  AND json_valid(metadata_json)
  AND json_type(metadata_json, '$.crash_merge') = 'array';

UPDATE feedback_tickets
SET version_code = (
  SELECT CASE
    WHEN json_type(metadata_json, '$.version_code') = 'integer'
      THEN json_extract(metadata_json, '$.version_code')
    WHEN json_type(metadata_json, '$.version_code') = 'text'
      AND trim(json_extract(metadata_json, '$.version_code')) <> ''
      AND trim(json_extract(metadata_json, '$.version_code')) NOT GLOB '*[^0-9]*'
      THEN CAST(trim(json_extract(metadata_json, '$.version_code')) AS INTEGER)
    WHEN json_type(metadata_json, '$.fallback_version_code') = 'integer'
      THEN json_extract(metadata_json, '$.fallback_version_code')
    WHEN json_type(metadata_json, '$.fallback_version_code') = 'text'
      AND trim(json_extract(metadata_json, '$.fallback_version_code')) <> ''
      AND trim(json_extract(metadata_json, '$.fallback_version_code')) NOT GLOB '*[^0-9]*'
      THEN CAST(trim(json_extract(metadata_json, '$.fallback_version_code')) AS INTEGER)
  END
)
WHERE version_code IS NULL
  AND kind = 'crash'
  AND json_valid(metadata_json)
  AND json_type(metadata_json, '$.crash_merge') = 'array';
