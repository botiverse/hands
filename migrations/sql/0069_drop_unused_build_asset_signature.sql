-- Migration 0069: remove the unused generic build-asset signature field.
--
-- This is not an APK/code-signing field. APK signer lineage remains in the
-- inspector tables and signing_credentials remains unchanged. The abandoned
-- Tauri updater surface that reused this generic field is removed in the same
-- source change.
--
-- The deploy workflow performs an immediate pre-apply remote census and stops
-- unless every live signature is NULL or blank.

ALTER TABLE build_assets DROP COLUMN signature;
