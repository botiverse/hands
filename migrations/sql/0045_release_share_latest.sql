-- Rolling release shares: the token stays stable while its target follows the
-- active release in the seed release's (app, channel, product_type,
-- release_type) track. Existing shares remain pinned to their release.

ALTER TABLE release_shares ADD COLUMN target_mode TEXT NOT NULL DEFAULT 'release';
ALTER TABLE release_shares ADD COLUMN channel_id TEXT REFERENCES channels(id) ON DELETE CASCADE;
ALTER TABLE release_shares ADD COLUMN product_type TEXT;
ALTER TABLE release_shares ADD COLUMN release_type TEXT;

CREATE INDEX IF NOT EXISTS idx_release_shares_latest_track
  ON release_shares(target_mode, channel_id, product_type, release_type)
  WHERE target_mode = 'latest';
