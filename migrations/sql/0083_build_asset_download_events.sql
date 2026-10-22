-- Public download accounting for build_assets (task #48).
--
-- WHY: build_assets.download_count has exactly two writers, both on the admin
-- surface (builds.ts incrementBuildAssetDownloadCount via handleDownloadBuildAsset,
-- and qa_artifacts.ts). Real clients use the public route
-- /apps/:slug/latest/download -> handlePublicLatestReleaseDownload, which only
-- 302-redirects to R2 and never touches the counter. During the 1.12 retention
-- analysis we nearly used download_count as an update conversion rate; it does
-- not count user downloads at all.
--
-- WHY A SEPARATE TABLE RATHER THAN JUST INCREMENTING download_count:
-- downloading again must not increment again for the same visitor (task #48
-- acceptance criterion 2). Incrementing a counter cannot dedupe, and the
-- existing counter is already a mixed population (admin + QA). Keeping public
-- events separate means the old column keeps its old meaning and the new signal
-- is unambiguous -- nobody has to re-derive what a given number counted.
--
-- Mirrors release_share_events (0022): same visitor_hash dedupe, same
-- COUNT(DISTINCT visitor_hash) reporting shape.
CREATE TABLE IF NOT EXISTS build_asset_download_events (
  id TEXT PRIMARY KEY,
  asset_id TEXT NOT NULL REFERENCES build_assets(id) ON DELETE CASCADE,
  build_id TEXT NOT NULL,
  visitor_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- Dedupe is a hard invariant: one row per (asset, visitor), forever.
-- The UNIQUE keyword is what actually enforces it. The INSERT uses
-- `WHERE NOT EXISTS` to avoid a pointless write, but that alone is only safe if
-- the check and the insert cannot interleave; the unique index makes the
-- invariant structural instead of dependent on that assumption, and it doubles
-- as the covering index for the dedupe probe.
-- DROP then CREATE, not CREATE IF NOT EXISTS: SQLite matches IF NOT EXISTS on the
-- NAME, not the definition, so an environment that already applied an earlier
-- non-unique version of this index would silently keep the non-unique one and
-- the guarantee would quietly not hold. Dropping first makes the statement
-- idempotent AND self-correcting regardless of what is already there.
DROP INDEX IF EXISTS idx_build_asset_download_events_asset_visitor;
CREATE UNIQUE INDEX idx_build_asset_download_events_asset_visitor
  ON build_asset_download_events(asset_id, visitor_hash);

-- Reporting by build (per-version download totals).
CREATE INDEX IF NOT EXISTS idx_build_asset_download_events_build
  ON build_asset_download_events(build_id, created_at);
