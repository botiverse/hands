-- A published Electron release's update metadata (latest*.yml) can be replaced
-- without re-publishing, to switch delta patches off or stage a rollout. The
-- installer entries never change; only the metadata served for the release does.
-- Each replacement is a row; the newest row not reverted is served, and
-- reverting it falls back to the previous one, then to the build's own file.
CREATE TABLE electron_metadata_overrides (
  id TEXT PRIMARY KEY,
  release_id TEXT NOT NULL REFERENCES releases(id) ON DELETE CASCADE,
  asset_id TEXT NOT NULL REFERENCES build_assets(id) ON DELETE CASCADE,
  r2_key TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  reverted_at INTEGER,
  reverted_by TEXT
);

CREATE INDEX idx_electron_metadata_overrides_current
  ON electron_metadata_overrides(release_id, asset_id, created_at);
