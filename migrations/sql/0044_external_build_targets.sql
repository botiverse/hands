-- Migration 0044: externally-hosted build declarations for Node/CLI releases.
-- Hands records immutable release evidence while the source URL remains the
-- byte authority. These rows deliberately do not masquerade as R2 assets.

CREATE TABLE IF NOT EXISTS external_build_targets (
  id                 TEXT PRIMARY KEY,
  app_id             TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  build_id           TEXT NOT NULL REFERENCES builds(id) ON DELETE CASCADE,
  version_name       TEXT NOT NULL,
  target             TEXT NOT NULL,
  source_url         TEXT NOT NULL,
  raw_sha256         TEXT NOT NULL,
  raw_size_bytes     INTEGER NOT NULL,
  gzip_sha256        TEXT,
  gzip_size_bytes    INTEGER,
  node_version       TEXT,
  metadata_json      TEXT NOT NULL DEFAULT '{}',
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL,
  UNIQUE (app_id, version_name, target)
);

CREATE INDEX IF NOT EXISTS idx_external_build_targets_build
  ON external_build_targets(build_id, target);

CREATE UNIQUE INDEX IF NOT EXISTS idx_builds_external_app_version
  ON builds(app_id, version_name)
  WHERE source = 'external';

INSERT INTO product_types (id, app_id, name, display_name, description,
                           supported_platforms_json, default_assets_json,
                           parser_kind, schema_json, created_at, updated_at)
SELECT
  lower(hex(randomblob(16))),
  a.id,
  'ohos-app',
  'OHOS app',
  'Signed App Pack and HAP artifacts for AppGallery and sideloading',
  '["ohos"]',
  '[{"platform":"ohos","filetype":"app"},{"platform":"ohos","filetype":"hap"}]',
  'ohos-package',
  '{}',
  unixepoch() * 1000,
  unixepoch() * 1000
FROM apps a
WHERE NOT EXISTS (
  SELECT 1 FROM product_types pt
  WHERE pt.app_id = a.id AND pt.name = 'ohos-app'
);

INSERT INTO product_types (id, app_id, name, display_name, description,
                           supported_platforms_json, default_assets_json,
                           parser_kind, schema_json, created_at, updated_at)
SELECT
  lower(hex(randomblob(16))),
  a.id,
  'cli-binary',
  'Node / CLI binary',
  'Externally hosted Node SEA or CLI binaries',
  '["darwin-arm64","darwin-x64","linux-arm64","linux-x64","win32-arm64","win32-x64"]',
  '[]',
  'external',
  '{"external_source":true}',
  unixepoch() * 1000,
  unixepoch() * 1000
FROM apps a
WHERE NOT EXISTS (
  SELECT 1 FROM product_types pt
  WHERE pt.app_id = a.id AND pt.name = 'cli-binary'
);

UPDATE channels
SET enabled_product_types_json = json_insert(enabled_product_types_json, '$[#]', 'cli-binary')
WHERE slug = 'main'
  AND json_valid(enabled_product_types_json)
  AND NOT EXISTS (
    SELECT 1
    FROM json_each(enabled_product_types_json)
    WHERE value = 'cli-binary'
  );

UPDATE channels
SET enabled_product_types_json = json_insert(enabled_product_types_json, '$[#]', 'ohos-app')
WHERE slug = 'main'
  AND json_valid(enabled_product_types_json)
  AND NOT EXISTS (
    SELECT 1
    FROM json_each(enabled_product_types_json)
    WHERE value = 'ohos-app'
  );
