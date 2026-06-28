-- Migration 0019: simplify release model defaults.
--
-- Product decision: channel is the single user-facing release lane axis.
-- Keep the internal release_type column at its stable default for now, but
-- stop exposing/seeding release_types in new apps.

-- Rename default seed channels where they still use the old overlapping names.
UPDATE channels
SET slug = 'main',
    name = 'Main',
    bundle_id = NULL
WHERE slug = 'production';

UPDATE channels
SET slug = 'preview',
    name = 'Preview',
    bundle_id = (
      SELECT apps.slug || '.preview'
      FROM apps
      WHERE apps.id = channels.app_id
    )
WHERE slug = 'beta';

UPDATE channels
SET slug = 'nightly',
    name = 'Nightly',
    bundle_id = (
      SELECT apps.slug || '.nightly'
      FROM apps
      WHERE apps.id = channels.app_id
    )
WHERE slug = 'internal';

-- Remove seeded release type rows that are no longer user-facing. Historical
-- releases/builds keep their denormalized release_type='stable' column value.
DELETE FROM release_types
WHERE name IN ('stable', 'rc', 'beta', 'internal')
  AND NOT EXISTS (
    SELECT 1
    FROM releases
    WHERE releases.app_id = release_types.app_id
      AND releases.release_type = release_types.name
  );
