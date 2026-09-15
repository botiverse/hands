-- Migration 0073: give `builds` a column for WHERE THE BYTES LIVE.
--
-- Why: `builds.source` answers two orthogonal questions at once. It records the
-- creation path ('web' console, 'cli', 'qa-artifact', 'mobile-ci') and, for the
-- single value 'external', it ALSO asserts where the bytes live (declared URLs in
-- `external_build_targets`, no R2 object). Three readers therefore test
-- `source = 'external'` to ask a placement question:
--   worker/src/routes/external_dl.ts
--   worker/src/routes/builds.ts (getExternalBuild)
--   worker/src/routes/releases.ts (required_external_targets gate)
-- A census on 2026-09-15 found the label consistent with the bytes (all 31
-- 'external' rows declare targets; none has R2 assets), but that is coincidence,
-- not a guarantee: a future writer that stores bytes externally under a different
-- `source` value would not be recognised.
--
-- What this does: adds the placement fact as its own column, so placement is read
-- directly rather than inferred from a creation-path label.
--
-- Deliberately NOT done here:
--   * `source` is not modified, and no source value is added or removed. The 31
--     'external' rows keep `source = 'external'`.
--   * The 0044 partial unique index (idx_builds_external_app_version) stays on
--     `source = 'external'`. Its predicate still matches exactly the same 31 rows
--     because `source` is unchanged. Moving that index onto the new column is a
--     separate, independently reviewable step.
--
-- Naming: the value is 'hands_r2', not 'r2'. The external side already reads
-- `r2_key`, so a bare 'r2' in this column would read as a reference to that key
-- rather than as "the bytes are in our own bucket". (Chosen by @artin.)
--
-- Default: 'hands_r2' is the overwhelming majority of history (190 of 221 rows at
-- census time) and keeps the column total, so readers never handle NULL. The
-- remaining rows are backfilled to 'external' separately: supplying a value for a
-- brand-new column is not a rewrite of an existing one, and the backfill set is
-- derivable from evidence rather than guessed:
--     UPDATE builds SET artifact_mode = 'external'
--     WHERE id IN (SELECT build_id FROM external_build_targets);
-- That production write needs its own explicit authorization and readback.

ALTER TABLE builds ADD COLUMN artifact_mode TEXT NOT NULL DEFAULT 'hands_r2';

-- Constrain the domain so an unknown placement cannot be written silently. Both
-- values are meaningful: 'hands_r2' = bytes are objects under build_assets.r2_key;
-- 'external' = bytes are declared URLs in external_build_targets.
--
-- NOTE: SQLite cannot add a CHECK constraint to an existing table via ALTER TABLE,
-- so the domain is enforced by a trigger instead. This mirrors the existing
-- migration style of using the database to make a bad state unrepresentable.
CREATE TRIGGER IF NOT EXISTS trg_builds_artifact_mode_domain_insert
BEFORE INSERT ON builds
FOR EACH ROW
WHEN NEW.artifact_mode NOT IN ('hands_r2', 'external')
BEGIN
  SELECT RAISE(ABORT, 'builds.artifact_mode must be hands_r2 or external');
END;

CREATE TRIGGER IF NOT EXISTS trg_builds_artifact_mode_domain_update
BEFORE UPDATE OF artifact_mode ON builds
FOR EACH ROW
WHEN NEW.artifact_mode NOT IN ('hands_r2', 'external')
BEGIN
  SELECT RAISE(ABORT, 'builds.artifact_mode must be hands_r2 or external');
END;

-- Readers look builds up by placement, so support that lookup.
CREATE INDEX IF NOT EXISTS idx_builds_artifact_mode
  ON builds(artifact_mode);
