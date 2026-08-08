-- Direct upload for release build assets: declare -> R2 staging PUT -> complete.
-- Additive only. Existing rows keep NULL ingest state and stay on the legacy gate;
-- nothing is backfilled to 'ready', because "this row existed" and "this row passed
-- the new verifier" are different claims and only the first one is true of them.

-- Per-build protocol selection. Explicit at creation, immutable after; NULL = legacy.
-- Deliberately not inferred from created_at: a timestamp is not a declaration.
ALTER TABLE builds ADD COLUMN asset_ingest_protocol_version INTEGER;

-- The required slot set the draft gate evaluates, frozen with the protocol version.
-- Kept separate from required_targets_json: external targets and asset slots are two
-- contracts, and sharing a column makes a mismatch in either look like the other.
ALTER TABLE builds ADD COLUMN required_asset_slots_json TEXT;

-- Canonical slot identity. The 0010 index cannot serve: arch/variant are NULLable and
-- SQLite treats NULLs as distinct, so it never enforced one-row-per-slot for assets
-- without them; and it predates artifact_kind (0020), so a QA artifact and a release
-- installable in the same shape collide. Sentinels are outside the input domain.
-- The CHECK is what makes '-' a sentinel rather than a guess: it may only appear
-- when the underlying column is NULL, so a literal '-' input cannot masquerade as
-- "no arch" and merge two distinct slots into one.
ALTER TABLE build_assets ADD COLUMN slot_arch TEXT NOT NULL DEFAULT '-'
  CHECK (slot_arch <> '-' OR arch IS NULL);
ALTER TABLE build_assets ADD COLUMN slot_variant TEXT NOT NULL DEFAULT '-'
  CHECK (slot_variant <> '-' OR variant IS NULL);

UPDATE build_assets
   SET slot_arch = COALESCE(arch, '-'),
       slot_variant = COALESCE(variant, '-');

-- Fails closed if duplicate slots already exist. That failure is the census: the old
-- index permitted duplicate NULL-slot rows for its entire life, so they may be real.
CREATE UNIQUE INDEX idx_build_assets_canonical_slot
  ON build_assets(build_id, artifact_kind, platform, slot_arch, slot_variant, filetype);

-- One row per upload attempt. Cleanup finds staging objects here by exact key; it is
-- never inferred and never prefix-scanned.
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

-- One row per (attempt, lease generation). Written BEFORE the R2 create-once write is
-- issued, so an object that exists is always discoverable by exact key even if the
-- process dies between the write and any later update. Identity columns are immutable;
-- lifecycle columns move only by named CAS.
CREATE TABLE build_asset_ingest_seal (
  asset_id         TEXT    NOT NULL,
  attempt          INTEGER NOT NULL,
  lease_generation INTEGER NOT NULL,
  final_key        TEXT    NOT NULL,
  intent_at        INTEGER NOT NULL,
  sealed_at        INTEGER,
  outcome          TEXT CHECK (outcome IN ('committed', 'superseded', 'cleaned')),
  cleanup_receipt  TEXT,
  PRIMARY KEY (asset_id, attempt, lease_generation),
  FOREIGN KEY (asset_id, attempt)
    REFERENCES build_asset_ingest_attempt(asset_id, attempt) ON DELETE CASCADE
);

CREATE INDEX idx_build_asset_ingest_seal_open
  ON build_asset_ingest_seal(outcome, intent_at);

-- Replay keys are request-scoped, not identity. One asset accumulates several keys
-- when CI reruns, so a single column on build_assets cannot hold them.
CREATE TABLE build_asset_ingest_replay (
  app_id          TEXT    NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  build_id        TEXT    NOT NULL REFERENCES builds(id) ON DELETE CASCADE,
  idempotency_key TEXT    NOT NULL,
  asset_id        TEXT    NOT NULL REFERENCES build_assets(id) ON DELETE CASCADE,
  request_digest  TEXT    NOT NULL,
  created_at      INTEGER NOT NULL,
  PRIMARY KEY (app_id, build_id, idempotency_key)
);

CREATE INDEX idx_build_asset_ingest_replay_asset
  ON build_asset_ingest_replay(asset_id);
