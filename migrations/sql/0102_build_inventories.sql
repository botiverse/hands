-- Build content inventories: what an APK or IPA contains (size by category,
-- libraries, SDKs, permissions, components, entitlements), extracted by the
-- parser container when the installable is uploaded or on request.
--
-- The inventory JSON (up to a few hundred KB) lives in R2 at r2_key
-- (apps/<app>/builds/<build>/inventory.json) so the builds row stays small
-- and list queries never carry it. This row says that an inventory exists,
-- which bytes it describes (source asset and file hash) and when it was
-- computed, so the diff endpoint can find the previous build's inventory
-- without listing R2. One row per build: recomputing replaces it.
CREATE TABLE IF NOT EXISTS build_inventories (
  build_id TEXT PRIMARY KEY REFERENCES builds(id) ON DELETE CASCADE,
  app_id TEXT NOT NULL,
  platform TEXT NOT NULL CHECK (platform IN ('android', 'ios')),
  schema_version INTEGER NOT NULL,
  r2_key TEXT NOT NULL,
  source_asset_id TEXT,
  source_file_hash TEXT,
  total_bytes INTEGER NOT NULL,
  generator TEXT,
  computed_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_build_inventories_app
  ON build_inventories(app_id, computed_at);
