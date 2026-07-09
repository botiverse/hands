-- Migration 0034: seed iOS IPA product type for existing apps.
--
-- New apps are seeded by the create-app route. This migration backfills
-- existing apps and enables iOS on the two human-facing distribution channels.

INSERT INTO product_types (id, app_id, name, display_name, description,
                           supported_platforms_json, default_assets_json,
                           parser_kind, schema_json, created_at, updated_at)
SELECT
  lower(hex(randomblob(16))),
  a.id,
  'ios-ipa',
  'iOS app',
  'iOS IPA distributed through TestFlight, ad-hoc, or enterprise lanes',
  '["ios"]',
  '[{"platform":"ios","filetype":"ipa"},{"platform":"ios","filetype":"dsym.zip","artifact_kind":"dsym"}]',
  'ipa-info',
  '{"distribution_profile_required":true}',
  unixepoch() * 1000,
  unixepoch() * 1000
FROM apps a
WHERE NOT EXISTS (
  SELECT 1 FROM product_types pt
  WHERE pt.app_id = a.id AND pt.name = 'ios-ipa'
);

UPDATE channels
SET enabled_product_types_json = json_insert(enabled_product_types_json, '$[#]', 'ios-ipa')
WHERE slug IN ('main', 'preview')
  AND json_valid(enabled_product_types_json)
  AND NOT EXISTS (
    SELECT 1
    FROM json_each(enabled_product_types_json)
    WHERE value = 'ios-ipa'
  );
