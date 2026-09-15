-- Migration 0072: keep one build per (app, version) for hosted CLI binaries.
--
-- Context. Migration 0044 added the only (app_id, version_name) uniqueness on
-- `builds`, as a PARTIAL index scoped to externally-hosted artifacts:
--
--   CREATE UNIQUE INDEX idx_builds_external_app_version
--     ON builds(app_id, version_name) WHERE source = 'external';
--
-- Nothing constrains that pair for any other kind of build (0005 says as much:
-- "no UNIQUE constraint yet"). Hosted Node/CLI builds are published with
-- source = 'cli', so without this migration a second build could share an
-- (app, version_name) with the first, and the publish/download lookups that
-- resolve a version to exactly one build would have no row to prefer.
--
-- Scope. The predicate names both `source = 'cli'` AND
-- `product_type = 'cli-binary'` on purpose. `source = 'cli'` alone is used by
-- other publishers (the Android/iOS CLI flows also write source = 'cli'), so a
-- broad predicate would pull unrelated builds into the constraint. Naming the
-- product type keeps this index adjacent to — and independent of — the 0044
-- external index, which is left exactly as it was.
--
-- Note this is a database constraint, not an application check: concurrent
-- publishers cannot be serialized by CLI-side code, and a passing test proves
-- only that no race was attempted.

CREATE UNIQUE INDEX IF NOT EXISTS idx_builds_hosted_cli_app_version
  ON builds(app_id, version_name)
  WHERE source = 'cli' AND product_type = 'cli-binary';
