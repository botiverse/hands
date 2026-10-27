-- Google Play store listing text (edits.listings) through Hands.
--
-- A store listing push is app-scoped, not release-scoped, so it cannot reuse
-- release_receipts (release_id NOT NULL) or play_edit_locks (release_id NOT NULL
-- REFERENCES releases). Both tables below are additive; nothing existing changes.
--
-- Apply BEFORE deploying the worker that ships with it: promote's lock query reads
-- play_store_listing_locks. Deploy order: docs/google-play-operations.md.

-- Immutable evidence for every push that reached Google: dry runs (validated, then
-- the edit deleted), commits, no-op pushes, and failures after the adapter was
-- called. Text is recorded as per-field sha256 + code-point length, not verbatim.
CREATE TABLE play_store_listing_receipts (
  id              TEXT PRIMARY KEY,
  app_id          TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  package_name    TEXT NOT NULL,
  operation_id    TEXT NOT NULL,
  mode            TEXT NOT NULL CHECK (mode IN ('dry_run', 'commit')),
  verdict         TEXT NOT NULL CHECK (verdict IN ('validated', 'committed', 'no_changes', 'failed-closed')),
  play_edit_id    TEXT,
  languages_json  TEXT NOT NULL CHECK (json_valid(languages_json)),
  payload_json    TEXT NOT NULL CHECK (json_valid(payload_json)),
  created_by      TEXT NOT NULL,
  created_at      INTEGER NOT NULL
);

CREATE INDEX idx_play_store_listing_receipts_app
  ON play_store_listing_receipts(app_id, created_at DESC, id);

CREATE TRIGGER trg_play_store_listing_receipts_no_update
BEFORE UPDATE ON play_store_listing_receipts
BEGIN
  SELECT RAISE(ABORT, 'play store listing receipts are immutable');
END;

CREATE TRIGGER trg_play_store_listing_receipts_no_delete
BEFORE DELETE ON play_store_listing_receipts
BEGIN
  SELECT RAISE(ABORT, 'play store listing receipts are immutable');
END;

-- One Hands-held Play edit per package. A primary-key row is the lock; the
-- promote path and the store listing path each refuse to acquire while the
-- other's row exists (INSERT ... WHERE NOT EXISTS on the other table).
CREATE TABLE play_store_listing_locks (
  app_id          TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  package_name    TEXT NOT NULL,
  operation_id    TEXT NOT NULL UNIQUE,
  acquired_by     TEXT NOT NULL,
  acquired_at     INTEGER NOT NULL,
  PRIMARY KEY (app_id, package_name)
);
