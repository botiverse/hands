-- Google Play open testing (Play track `beta`) becomes a fourth distribution track.
-- Rebuild play_distribution_state to widen its track CHECK; every row is kept.
CREATE TABLE play_distribution_state_new (
  app_id              TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  release_id          TEXT NOT NULL REFERENCES releases(id) ON DELETE CASCADE,
  package_name        TEXT NOT NULL,
  track               TEXT NOT NULL CHECK (track IN ('internal', 'closed', 'open', 'production')),
  version_code        INTEGER NOT NULL,
  rollout_percent     INTEGER CHECK (rollout_percent BETWEEN 0 AND 100),
  state               TEXT NOT NULL CHECK (state IN ('active', 'halted', 'failed-closed')),
  last_edit_id        TEXT,
  last_receipt_id     TEXT NOT NULL REFERENCES release_receipts(id) ON DELETE RESTRICT,
  revision            INTEGER NOT NULL DEFAULT 1,
  updated_at          INTEGER NOT NULL,
  PRIMARY KEY (app_id, release_id)
);
INSERT INTO play_distribution_state_new
  (app_id, release_id, package_name, track, version_code, rollout_percent, state,
   last_edit_id, last_receipt_id, revision, updated_at)
SELECT app_id, release_id, package_name, track, version_code, rollout_percent, state,
       last_edit_id, last_receipt_id, revision, updated_at
FROM play_distribution_state;
DROP TABLE play_distribution_state;
ALTER TABLE play_distribution_state_new RENAME TO play_distribution_state;
