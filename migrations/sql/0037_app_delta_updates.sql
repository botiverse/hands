-- Per-app toggle for automatic Android delta/differential update generation
-- (task #246). When enabled, publishing a release generates archive-patcher
-- patches from the last N published versions to the new one. Default off; this
-- flag is also the gate for making delta updates a paid feature.
ALTER TABLE apps ADD COLUMN delta_updates_enabled INTEGER NOT NULL DEFAULT 0;
