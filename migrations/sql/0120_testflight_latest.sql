-- Public "latest external TestFlight build" for iOS apps that distribute through
-- TestFlight instead of a published Hands release. An app opts in with
-- public_testflight_latest (default off, so nothing is exposed until an admin
-- turns it on); GET /public/v2/apps/:slug/testflight/latest then reads the one
-- row below.
--
-- testflight_latest_builds holds at most one row per app: the highest build
-- number currently known to be IN_BETA_TESTING externally. It is written
-- best-effort by the Apple external-build-state webhook and the
-- testflight-publish / status readbacks, and deleted when that same ASC build
-- leaves IN_BETA_TESTING (a later readback or webhook repopulates it).
ALTER TABLE apps ADD COLUMN public_testflight_latest INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS testflight_latest_builds (
  app_id TEXT PRIMARY KEY REFERENCES apps(id) ON DELETE CASCADE,
  version_name TEXT NOT NULL,
  version_code INTEGER NOT NULL,
  asc_build_id TEXT NOT NULL,
  external_build_state TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
