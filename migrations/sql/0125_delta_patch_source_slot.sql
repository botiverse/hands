-- A delta patch is built against one exact source APK. One version code can ship
-- as more than one APK (a universal and an arm64-v8a build of the same release),
-- so a build may hold two patches with the same from_version_code, arch, variant
-- and filetype that differ only in their source. Patch metadata now records the
-- source as metadata_json.from_sha256, and the update check selects on it
-- (public_v2.ts findDeltaPatch), so it is part of the patch's identity.
--
-- Without this the canonical slot (0062) folds both patches into one slot: the
-- second INSERT fails the unique index, which fails a CLI publish and makes the
-- server generator drop every patch after the first source of a version.
--
-- Same rules as slot_from_version in 0062: scoped to delta patches only (on any
-- other kind an extra metadata field must not escape the constraint), coerced the
-- way the reader compares it (lower-case hex), prefixed so no value can equal the
-- '-' sentinel. A patch without from_sha256 (every row written before this) keeps
-- the sentinel, so existing rows keep their slot and the new index cannot fail on
-- them: it only adds a column to the old key.
ALTER TABLE build_assets ADD COLUMN slot_from_source TEXT GENERATED ALWAYS AS (
  COALESCE(
    CASE WHEN artifact_kind = 'delta-patch'
         THEN 's' || lower(CAST(json_extract(metadata_json, '$.from_sha256') AS TEXT))
    END, '-')
) VIRTUAL;

DROP INDEX idx_build_assets_canonical_slot;

CREATE UNIQUE INDEX idx_build_assets_canonical_slot
  ON build_assets(build_id, artifact_kind, platform, slot_arch, slot_variant,
                  slot_from_version, slot_from_source, filetype);
