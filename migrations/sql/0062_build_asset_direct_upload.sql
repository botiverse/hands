-- Direct upload for release build assets: declare -> R2 staging PUT -> complete.
--
-- build_assets is rebuilt rather than altered. The UNIQUE from 0010 is a table
-- constraint, and SQLite cannot drop one in place; leaving it would keep rejecting a
-- QA artifact and a release installable that share a shape, which is exactly what
-- artifact_kind scoping is meant to allow.

-- ---------------------------------------------------------------------------
-- Preflight. Runs before anything destructive, on purpose.
--
-- Two properties of the existing data can make the rebuild below fail: a row whose
-- arch or variant is already the literal '-', which the new CHECK forbids, and two
-- rows that collide once the slot is normalised, which the new UNIQUE index forbids.
-- Both are legal under today's schema, so neither can be assumed absent.
--
-- Placement is the whole point. `wrangler d1 migrations apply --remote` posts this
-- file to D1 as one `/query` string, and wrangler documents rollback only for the
-- separate `--file` import path -- so whether a failure half way down leaves a
-- renamed old table beside an empty new one is not something this file should have
-- to know. Asserting first makes the question moot: a violation aborts before the
-- RENAME, and the database is untouched either way.
--
-- A bare RAISE() is trigger-only in SQLite, so the abort is a named CHECK; SQLite
-- puts the constraint name in the error, which is what the operator will read.
--
-- Each guard drops its own scratch table first. When a guard fires, its CREATE has
-- already committed while the INSERT has not, so the table survives the abort; a
-- second attempt would then die on "table already exists" and report the wrong
-- problem entirely. A guard that breaks the retry is worse than no guard.
DROP TABLE IF EXISTS _preflight_0062_sentinel;
CREATE TABLE _preflight_0062_sentinel (
  offending_rows INTEGER NOT NULL CONSTRAINT
    "0062 preflight failed: build_assets has rows whose arch or variant is the literal '-'. The rebuilt table reserves '-' as the NULL sentinel and rejects it as a value. Resolve those rows, then re-apply: this aborts before the rebuild starts, so build_assets and builds are untouched."
    CHECK (offending_rows = 0)
);
INSERT INTO _preflight_0062_sentinel
SELECT COUNT(*) FROM build_assets WHERE arch = '-' OR variant = '-';
DROP TABLE _preflight_0062_sentinel;

-- Ordering matters between the two guards, not just before the DDL. This one
-- normalises with COALESCE because the index it protects normalises the same way,
-- so a literal '-' and a NULL genuinely would collide there. That also means this
-- query cannot distinguish them -- which is safe only because the guard above has
-- already established there are no literal '-' rows left to confuse it.
DROP TABLE IF EXISTS _preflight_0062_slot;
CREATE TABLE _preflight_0062_slot (
  colliding_slots INTEGER NOT NULL CONSTRAINT
    "0062 preflight failed: build_assets already has two or more rows sharing a canonical slot (build_id, artifact_kind, platform, arch, variant, filetype) once NULL is normalised. The rebuilt table makes that slot unique. Resolve the duplicates, then re-apply: this aborts before the rebuild starts, so build_assets and builds are untouched."
    CHECK (colliding_slots = 0)
);
INSERT INTO _preflight_0062_slot
SELECT COUNT(*) FROM (
  SELECT 1
    FROM build_assets
   GROUP BY build_id, artifact_kind, platform,
            COALESCE(arch, '-'), COALESCE(variant, '-'), filetype
  HAVING COUNT(*) > 1
);
DROP TABLE _preflight_0062_slot;
-- ---------------------------------------------------------------------------

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

-- Dropping the foreign key kept the ledger alive past its asset, but it also removed
-- the check that a seal names a real attempt when it is written. A trigger restores
-- that at INSERT only: a seal for an attempt that never existed is refused, while a
-- legitimate one still outlives the asset it belonged to.
CREATE TRIGGER build_asset_ingest_seal_requires_attempt
BEFORE INSERT ON build_asset_ingest_seal
WHEN NOT EXISTS (
  SELECT 1 FROM build_asset_ingest_attempt
   WHERE asset_id = NEW.asset_id AND attempt = NEW.attempt
)
BEGIN
  SELECT RAISE(ABORT, 'seal ledger row must name an existing attempt');
END;

-- "Identity columns are immutable" was a statement about intent, not a rule SQLite
-- enforces: it permits UPDATE of a primary key, so a legitimate seal could be
-- retargeted to a fictitious attempt and its exact tombstone key lost. Identity is
-- frozen here; the lifecycle columns still move by CAS.
CREATE TRIGGER build_asset_ingest_seal_identity_immutable
BEFORE UPDATE OF asset_id, attempt, lease_generation, final_key, intent_at
  ON build_asset_ingest_seal
-- Fires on a changed value, not on the column appearing in a SET list, so an
-- idempotent or full-row write that leaves identity alone is not refused.
WHEN NEW.asset_id         IS NOT OLD.asset_id
  OR NEW.attempt          IS NOT OLD.attempt
  OR NEW.lease_generation IS NOT OLD.lease_generation
  OR NEW.final_key        IS NOT OLD.final_key
  OR NEW.intent_at        IS NOT OLD.intent_at
BEGIN
  SELECT RAISE(ABORT, 'seal ledger identity is immutable');
END;

-- Guarding DELETE alone left a two-step route out: move `outcome` off 'cleaned',
-- then delete. `cleaned` is therefore terminal. Entering it stays allowed, and so
-- does writing a cleanup_receipt afterwards — only leaving it is refused.
CREATE TRIGGER build_asset_ingest_seal_cleaned_is_terminal
BEFORE UPDATE OF outcome ON build_asset_ingest_seal
WHEN OLD.outcome = 'cleaned' AND NEW.outcome IS NOT OLD.outcome
BEGIN
  SELECT RAISE(ABORT, 'a tombstoned seal ledger row cannot leave the cleaned state');
END;

-- A tombstoned generation's row records the exact key of an object that still
-- exists and is never removed. Retention may reap rows that were never tombstoned;
-- it may not reap the ones that make a permanent object discoverable.
CREATE TRIGGER build_asset_ingest_seal_cleaned_is_permanent
BEFORE DELETE ON build_asset_ingest_seal
WHEN OLD.outcome = 'cleaned'
BEGIN
  SELECT RAISE(ABORT, 'a tombstoned seal ledger row is permanent');
END;

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
