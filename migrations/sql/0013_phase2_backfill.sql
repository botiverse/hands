-- Migration 0013: Phase 2 backfill + seed defaults
--
-- For every existing app, seed:
--   product_types  (android-apk, electron-installer, rn-bundle)
--   channels       (ensure main/preview/nightly exist; fill in bundle_id defaults)
--
-- For every existing versions row, backfill into builds + build_assets
-- + releases + release_scopes.
--
-- Idempotent: uses NOT EXISTS pattern to skip rows that would violate UNIQUE.
-- D1 SQLite supports unixepoch() for current epoch.

-- ---------- 1. Seed default product_types for every app ----------

INSERT INTO product_types (id, app_id, name, display_name, description,
                           supported_platforms_json, default_assets_json,
                           parser_kind, schema_json, created_at, updated_at)
SELECT
  lower(hex(randomblob(16))),
  a.id,
  'android-apk',
  'Android APK',
  'Android application package — direct install',
  '[]',
  '[{"platform":"android","filetype":"apk"}]',
  'apk-aapt',
  '{"requires_native_codes":true,"requires_signing":true}',
  unixepoch() * 1000,
  unixepoch() * 1000
FROM apps a
WHERE NOT EXISTS (
  SELECT 1 FROM product_types pt
  WHERE pt.app_id = a.id AND pt.name = 'android-apk'
);

INSERT INTO product_types (id, app_id, name, display_name, description,
                           supported_platforms_json, default_assets_json,
                           parser_kind, schema_json, created_at, updated_at)
SELECT
  lower(hex(randomblob(16))),
  a.id,
  'electron-installer',
  'Electron desktop app',
  'Cross-platform desktop application (darwin + linux + win32)',
  '["darwin-arm64","darwin-x64","linux-x64","linux-arm64","win32-x64","win32-arm64"]',
  '[{"platform":"darwin-arm64","filetype":"dmg"},{"platform":"darwin-x64","filetype":"dmg"},{"platform":"linux-x64","filetype":"appimage"},{"platform":"linux-x64","filetype":"deb"},{"platform":"win32-x64","filetype":"exe"},{"platform":"win32-arm64","filetype":"msi"}]',
  'electron-asar',
  '{"requires_electron_version":true,"requires_signing":true}',
  unixepoch() * 1000,
  unixepoch() * 1000
FROM apps a
WHERE NOT EXISTS (
  SELECT 1 FROM product_types pt
  WHERE pt.app_id = a.id AND pt.name = 'electron-installer'
);

INSERT INTO product_types (id, app_id, name, display_name, description,
                           supported_platforms_json, default_assets_json,
                           parser_kind, schema_json, created_at, updated_at)
SELECT
  lower(hex(randomblob(16))),
  a.id,
  'rn-bundle',
  'React Native / Expo OTA bundle',
  'JavaScript bundle hot-update (replaces JS layer, native shell stays)',
  '[]',
  '[{"platform":"rn","filetype":"bundle"}]',
  'rn-bundle',
  '{"requires_target_app_version":true}',
  unixepoch() * 1000,
  unixepoch() * 1000
FROM apps a
WHERE NOT EXISTS (
  SELECT 1 FROM product_types pt
  WHERE pt.app_id = a.id AND pt.name = 'rn-bundle'
);

-- ---------- 3. Ensure default channels (main/preview/nightly) for every app ----------

INSERT INTO channels (id, app_id, slug, name, bundle_id, password, git_url,
                     enabled_product_types_json, metadata_json, created_at)
SELECT
  lower(hex(randomblob(16))), a.id, 'main', 'Main',
  NULL, NULL, NULL,
  '["android-apk","electron-installer","rn-bundle"]',
  '{}',
  unixepoch() * 1000
FROM apps a
WHERE NOT EXISTS (
  SELECT 1 FROM channels c WHERE c.app_id = a.id AND c.slug = 'main'
);

INSERT INTO channels (id, app_id, slug, name, bundle_id, password, git_url,
                     enabled_product_types_json, metadata_json, created_at)
SELECT
  lower(hex(randomblob(16))), a.id, 'preview', 'Preview',
  a.slug || '.preview', NULL, NULL,
  '["android-apk","rn-bundle"]',
  '{}',
  unixepoch() * 1000
FROM apps a
WHERE NOT EXISTS (
  SELECT 1 FROM channels c WHERE c.app_id = a.id AND c.slug = 'preview'
);

INSERT INTO channels (id, app_id, slug, name, bundle_id, password, git_url,
                     enabled_product_types_json, metadata_json, created_at)
SELECT
  lower(hex(randomblob(16))), a.id, 'nightly', 'Nightly',
  a.slug || '.nightly', NULL, NULL,
  '["android-apk"]',
  '{}',
  unixepoch() * 1000
FROM apps a
WHERE NOT EXISTS (
  SELECT 1 FROM channels c WHERE c.app_id = a.id AND c.slug = 'nightly'
);

-- ---------- 4. Backfill existing versions into builds + build_assets + releases + release_scopes ----------

-- 4a. Create a builds row for each versions row (if not already present)
INSERT INTO builds (id, app_id, channel_id, product_type, release_type,
                    version_name, version_code, changelog, source, status,
                    build_metadata_json, parsed_metadata_json,
                    created_at, updated_at, completed_at)
SELECT
  v.id, v.app_id,
  (SELECT id FROM channels WHERE app_id = v.app_id AND slug = v.channel LIMIT 1),
  'android-apk', 'stable',
  v.version_name, v.version_code, v.changelog, 'web', 'succeeded',
  '{}',
  json_object('package_name', v.package_name, 'signature_sha256', v.signature_sha256,
              'min_sdk', v.min_sdk, 'target_sdk', v.target_sdk,
              'app_label', NULL, 'size_bytes', v.size_bytes,
              'native_codes', '[]'),
  v.created_at, v.created_at, v.created_at
FROM versions v
WHERE NOT EXISTS (SELECT 1 FROM builds b WHERE b.id = v.id);

-- 4b. Create a build_assets row for each build (single APK asset)
INSERT INTO build_assets (id, build_id, platform, arch, variant, filetype,
                          r2_key, file_hash, size_bytes, signature,
                          metadata_json, download_count, created_at)
SELECT
  lower(hex(randomblob(16))),
  v.id,
  'android', NULL, NULL, 'apk',
  v.r2_key, v.file_hash, v.size_bytes, v.signature_sha256,
  '{}', 0, v.created_at
FROM versions v
WHERE NOT EXISTS (
  SELECT 1 FROM build_assets ba
  WHERE ba.build_id = v.id AND ba.platform = 'android' AND ba.arch IS NULL
    AND ba.variant IS NULL AND ba.filetype = 'apk'
);

-- 4c. Create a releases row for each build (status='active', is_full=1)
-- (Avoid JOIN to versions here — the JOIN made the FK constraint check
--  more complex than necessary; reads from builds only.)
INSERT INTO releases (id, app_id, build_id, channel_id, product_type, release_type,
                      status, is_full, should_force_update,
                      rollout_target_cohorts_json, changelog,
                      provenance_json, created_by, created_at, updated_at)
SELECT
  lower(hex(randomblob(16))),
  b.app_id, b.id, b.channel_id, b.product_type, b.release_type,
  'active', 1, 0,
  '[]', b.changelog,
  '{}',
  'legacy-backfill', b.created_at, b.created_at
FROM builds b
WHERE NOT EXISTS (
  SELECT 1 FROM releases r WHERE r.build_id = b.id
);

-- 4d. Create a release_scopes row (full / all) for each backfilled release
INSERT INTO release_scopes (id, release_id, scope_type, scope_value, created_at)
SELECT
  lower(hex(randomblob(16))),
  r.id, 'full', 'all', r.created_at
FROM releases r
WHERE r.created_by = 'legacy-backfill'
  AND NOT EXISTS (
    SELECT 1 FROM release_scopes rs WHERE rs.release_id = r.id
  );
