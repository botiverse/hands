-- Migration 0073: give `builds` a column for WHERE THE BYTES LIVE, and populate it.
--
-- ┌─ IF THIS MIGRATION FAILS ON `CHECK constraint failed: ok = 1` ─────────────────┐
-- │ This is NOT a bug. It means the backfill disagrees with the placement facts:    │
-- │ either an externally-declared build is still at the default, or a build was     │
-- │ marked 'external' that is not externally placed. Do NOT delete the assertion to │
-- │ make the deploy pass - that turns a guarded backfill into an unguarded one.     │
-- │ Correct handling = list the offending rows and escalate; decide per-row whether │
-- │ the row is genuinely external or genuinely R2-backed.                           │
-- │                                                                                 │
-- │   SELECT b.id, b.app_id, b.version_name, b.source, b.artifact_mode,            │
-- │          EXISTS (SELECT 1 FROM external_build_targets t                        │
-- │                   WHERE t.build_id = b.id) AS has_targets,                     │
-- │          EXISTS (SELECT 1 FROM build_assets a                                   │
-- │                   WHERE a.build_id = b.id) AS has_assets                       │
-- │   FROM builds b                                                                 │
-- │   WHERE (b.artifact_mode <> 'external'                                          │
-- │            AND EXISTS (SELECT 1 FROM external_build_targets t                   │
-- │                         WHERE t.build_id = b.id)                                │
-- │            AND NOT EXISTS (SELECT 1 FROM build_assets a                         │
-- │                             WHERE a.build_id = b.id))                           │
-- │      OR (b.artifact_mode = 'external'                                           │
-- │            AND NOT (EXISTS (SELECT 1 FROM external_build_targets t              │
-- │                              WHERE t.build_id = b.id)                           │
-- │                    AND NOT EXISTS (SELECT 1 FROM build_assets a                 │
-- │                                    WHERE a.build_id = b.id)));                   │
-- └─────────────────────────────────────────────────────────────────────────────────┘
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
-- What this does: adds the placement fact as its own column, populates it for
-- existing rows, and proves the result - so placement is read directly rather than
-- inferred from a creation-path label, with no intermediate state in which a
-- reader could see a half-populated column.
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
-- census time) and keeps the column total, so readers never handle NULL.
--
-- THE BACKFILL RUNS HERE, IN THIS MIGRATION, NOT AS A FOLLOW-UP WRITE.
--
-- Why it is not a separate step: `deploy-hands-server.yml` applies every pending
-- migration on ANY deploy. If the column were added here and backfilled later,
-- there would be a window - opened by any unrelated deploy, not only one of ours -
-- in which the 31 externally-declared builds still read the default. In that window
-- `external_dl.ts` selects on `artifact_mode = 'external'`, finds nothing, and the
-- live public download path `/dl/...` answers 404. Making the backfill part of the
-- migration removes the window entirely: apply and backfill are one atomic step
-- under the existing migration handshake. (@Sentinel identified the window;
-- @artin chose this shape.)
--
-- The backfill predicate is the FACT, not the label: a build whose bytes are
-- declared in external_build_targets and which has no R2 object is externally
-- placed, regardless of which creation path produced it and regardless of what
-- `source` says. A census on 2026-09-15 (read-only) found 31 such rows, 0 rows
-- labelled 'external' without declared targets, and 0 with both.

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

-- ---------------------------------------------------------------------------
-- Backfill: mark the externally-declared builds, then PROVE the result.
--
-- Predicate = declared bytes and no R2 object. This is deliberately not
-- `source = 'external'`: a build could carry that label while actually having R2
-- assets (the label and the bytes are separate facts, which is the whole reason
-- this column exists). The EXISTS/NOT EXISTS pair encodes the placement itself.
-- ---------------------------------------------------------------------------

UPDATE builds
SET artifact_mode = 'external'
WHERE EXISTS (SELECT 1 FROM external_build_targets t WHERE t.build_id = builds.id)
  AND NOT EXISTS (SELECT 1 FROM build_assets a WHERE a.build_id = builds.id);

-- Zero-residual assertion, in the style of 0068: a CHECK-constraint violation
-- aborts the whole migration (SQLite has no RAISE outside triggers and D1 has no
-- TEMP tables), so a wrong backfill stops the deploy BEFORE the Worker goes out
-- rather than leaving production half-migrated.
--
-- Both directions are asserted, not just the obvious one:
--   * no externally-declared, R2-less build left at the default (under-application)
--   * no build marked 'external' that is not externally placed (over-application)
-- The second is the one that would otherwise go unnoticed, and it is the direction
-- that would make an R2-backed build unreachable through /dl.
CREATE TABLE IF NOT EXISTS _guard_artifact_mode_backfill (ok INTEGER NOT NULL CHECK (ok = 1));
DELETE FROM _guard_artifact_mode_backfill;

INSERT INTO _guard_artifact_mode_backfill (ok)
SELECT CASE WHEN (
  SELECT count(*) FROM (
    -- under-application: external placement still at the default
    SELECT b.id FROM builds b
    WHERE b.artifact_mode <> 'external'
      AND EXISTS (SELECT 1 FROM external_build_targets t WHERE t.build_id = b.id)
      AND NOT EXISTS (SELECT 1 FROM build_assets a WHERE a.build_id = b.id)
    UNION ALL
    -- over-application: marked external without external placement
    SELECT b.id FROM builds b
    WHERE b.artifact_mode = 'external'
      AND NOT (
        EXISTS (SELECT 1 FROM external_build_targets t WHERE t.build_id = b.id)
        AND NOT EXISTS (SELECT 1 FROM build_assets a WHERE a.build_id = b.id)
      )
  )
) = 0 THEN 1 ELSE 0 END;

DROP TABLE _guard_artifact_mode_backfill;
