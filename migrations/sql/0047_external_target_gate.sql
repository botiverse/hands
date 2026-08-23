-- External-target publish gate (Computer CLI migration, task #160):
-- 1. builds gains the target-set freeze: once a release of this build is
--    published with a required-target contract, the set is frozen — new
--    target declarations are permanently rejected and the required set is
--    re-asserted on every publish attempt (including replays).
-- 2. external_build_targets gains an explicit gzip transport URL so consumers
--    never have to guess bytes addresses from digests.
ALTER TABLE builds ADD COLUMN targets_frozen_at INTEGER;
ALTER TABLE builds ADD COLUMN freeze_token TEXT;
ALTER TABLE builds ADD COLUMN required_targets_json TEXT;
ALTER TABLE external_build_targets ADD COLUMN gzip_source_url TEXT;
