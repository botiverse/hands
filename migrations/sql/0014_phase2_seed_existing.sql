-- Migration 0014: seed product_types / release_types / channels for any apps that
-- didn't get seeded (e.g., apps created after migration 0013 ran on an empty db).
--
-- Idempotent: NOT EXISTS guards against duplicate seeding.

-- ---------- Seed default product_types for every app that doesn't have them ----------

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

-- ---------- Ensure default channels for every app ----------

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