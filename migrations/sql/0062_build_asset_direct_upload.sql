-- Direct upload for release build assets: declare -> R2 staging PUT -> complete.
--
-- build_assets is rebuilt rather than altered. The UNIQUE from 0010 is a table
-- constraint, and SQLite cannot drop one in place; leaving it would keep rejecting a
-- QA artifact and a release installable that share a shape, which is exactly what
-- artifact_kind scoping is meant to allow.

-- Per-build protocol selection: explicit at creation, immutable after, NULL = legacy.
-- Not inferred from created_at, because a timestamp is not a declaration.
ALTER TABLE builds ADD COLUMN asset_ingest_protocol_version INTEGER;

-- The set the draft gate evaluates. Separate from required_targets_json: external
-- targets and asset slots are two contracts, and one column would make a mismatch in
-- either look like a mismatch in the other.
ALTER TABLE builds ADD COLUMN required_asset_slots_json TEXT;

-- Lets the replay ledger reference (app_id, build_id) as a pair, so a key cannot be
-- presented against a build belonging to another app.
CREATE UNIQUE INDEX idx_builds_app_scope ON builds(app_id, id);

ALTER TABLE build_assets RENAME TO build_assets_legacy;

CREATE TABLE build_assets (
  id                      TEXT PRIMARY KEY,
  build_id                TEXT NOT NULL REFERENCES builds(id) ON DELETE CASCADE,
  platform                TEXT NOT NULL,
  -- The sentinel is kept out of the input domain at the source, so a literal '-'
  -- can never occupy the slot that means "no arch" and merge two distinct slots.
  arch                    TEXT CHECK (arch IS NULL OR arch <> '-'),
  variant                 TEXT CHECK (variant IS NULL OR variant <> '-'),
  filetype                TEXT NOT NULL,
  r2_key                  TEXT NOT NULL,
  file_hash               TEXT NOT NULL,
  size_bytes              INTEGER NOT NULL,
  signature               TEXT,
  signing_credential_id   TEXT REFERENCES signing_credentials(id) ON DELETE SET NULL,
  metadata_json           TEXT NOT NULL DEFAULT '{}',
  download_count          INTEGER NOT NULL DEFAULT 0,
  created_at              INTEGER NOT NULL,
  artifact_kind           TEXT NOT NULL DEFAULT 'installable',
  -- Generated, not caller-supplied: a writer cannot set a slot value that disagrees
  -- with the column it normalizes, and existing INSERTs need no change.
  slot_arch    TEXT GENERATED ALWAYS AS (COALESCE(arch, '-')) VIRTUAL,
  slot_variant TEXT GENERATED ALWAYS AS (COALESCE(variant, '-')) VIRTUAL
);

INSERT INTO build_assets (
  id, build_id, platform, arch, variant, filetype, r2_key, file_hash, size_bytes,
  signature, signing_credential_id, metadata_json, download_count, created_at,
  artifact_kind
)
SELECT
  id, build_id, platform, arch, variant, filetype, r2_key, file_hash, size_bytes,
  signature, signing_credential_id, metadata_json, download_count, created_at,
  artifact_kind
FROM build_assets_legacy;

DROP TABLE build_assets_legacy;

CREATE INDEX idx_build_assets_build ON build_assets(build_id);
CREATE INDEX idx_build_assets_signing
  ON build_assets(signing_credential_id) WHERE signing_credential_id IS NOT NULL;

-- Canonical slot: closed (no NULLs) and kind-scoped. Fails closed if duplicates
-- already exist; the old index permitted them for its whole life.
CREATE UNIQUE INDEX idx_build_assets_canonical_slot
  ON build_assets(build_id, artifact_kind, platform, slot_arch, slot_variant, filetype);

-- Lets the replay ledger reference (build_id, asset_id) as a pair.
CREATE UNIQUE INDEX idx_build_assets_build_scope ON build_assets(build_id, id);

-- One row per upload attempt; cleanup finds staging objects here by exact key.
CREATE TABLE build_asset_ingest_attempt (
  asset_id             TEXT    NOT NULL REFERENCES build_assets(id) ON DELETE CASCADE,
  attempt              INTEGER NOT NULL,
  declared_sha256      TEXT    NOT NULL,
  declared_size        INTEGER NOT NULL CHECK (declared_size > 0),
  staging_key          TEXT    NOT NULL,
  -- NULL until a lease generation wins: the final key embeds the generation, and no
  -- generation exists until the cron claims the work.
  committed_final_key  TEXT,
  upload_expires_at    INTEGER NOT NULL,
  state                TEXT    NOT NULL
    CHECK (state IN ('pending', 'verifying', 'ready', 'failed', 'expired')),
  verifier_lease_id         TEXT,
  verifier_lease_expires_at INTEGER,
  cleanup_state        TEXT    NOT NULL DEFAULT 'live'
    CHECK (cleanup_state IN ('live', 'tombstoned', 'expired')),
  cleanup_receipt      TEXT,
  created_at           INTEGER NOT NULL,
  PRIMARY KEY (asset_id, attempt)
);

CREATE INDEX idx_build_asset_ingest_attempt_sweep
  ON build_asset_ingest_attempt(state, upload_expires_at);

-- One row per (attempt, lease generation), written BEFORE the R2 create-once write is
-- issued, so an object that exists is discoverable by exact key even if the process
-- dies immediately after writing it.
--
-- Deliberately no foreign key: a tombstone is permanent, and the row that records its
-- exact key must outlive the asset. A cascade here would delete the only record of an
-- object that still exists.
CREATE TABLE build_asset_ingest_seal (
  asset_id         TEXT    NOT NULL,
  attempt          INTEGER NOT NULL,
  lease_generation INTEGER NOT NULL,
  final_key        TEXT    NOT NULL,
  intent_at        INTEGER NOT NULL,
  sealed_at        INTEGER,
  outcome          TEXT CHECK (outcome IN ('committed', 'superseded', 'cleaned')),
  cleanup_receipt  TEXT,
  PRIMARY KEY (asset_id, attempt, lease_generation)
);

CREATE INDEX idx_build_asset_ingest_seal_open
  ON build_asset_ingest_seal(outcome, intent_at);

-- Replay keys are request-scoped, not identity. Composite references keep a key from
-- naming a build in another app, or an asset in another build.
CREATE TABLE build_asset_ingest_replay (
  app_id          TEXT    NOT NULL,
  build_id        TEXT    NOT NULL,
  idempotency_key TEXT    NOT NULL,
  asset_id        TEXT    NOT NULL,
  request_digest  TEXT    NOT NULL,
  created_at      INTEGER NOT NULL,
  PRIMARY KEY (app_id, build_id, idempotency_key),
  FOREIGN KEY (app_id, build_id) REFERENCES builds(app_id, id) ON DELETE CASCADE,
  FOREIGN KEY (build_id, asset_id) REFERENCES build_assets(build_id, id) ON DELETE CASCADE
);

CREATE INDEX idx_build_asset_ingest_replay_asset
  ON build_asset_ingest_replay(asset_id);
