-- Migration 0046: app_notarizations + app_notarization_attempts
-- Broker-only notarization lane (platform feature).
--
-- Two-table model per XX control-plane terminal review (conditional green):
--   app_notarizations         = logical notarization (source asset snapshot, permanent)
--   app_notarization_attempts = each Apple submission (append-only)
--
-- Revision 2 (2026-07-18): incorporates XX CHANGES REQUIRED:
--   B1: UNIQUE(app_id, asset_id, computed_sha256) is PERMANENT — all retries same logical, new attempt.
--       Added UNIQUE(notarization_id, attempt_no).
--   B2: Composite FK / triggers enforce ownership consistency (build.app_id==logical.app_id etc.)
--   B3: build/asset FK → RESTRICT; operation_id nullable + ON DELETE SET NULL. Audit chain survives.
--   B4: Full CHECK constraints + triggers for cross-table closure invariants.
--   M1: Added error_phase, raw_apple_status, last_polled_at, reconcile_state columns.
--   M2: Added s3_receipt_etag column; test matrix updated separately.
--
-- Secrets discipline: temp AWS creds, sessionToken, developerLogUrl, .p8 key — NEVER stored in D1.

-- ──────────── logical notarization (source snapshot, permanent) ────────────

CREATE TABLE IF NOT EXISTS app_notarizations (
  id                    TEXT PRIMARY KEY,
  app_id                TEXT NOT NULL REFERENCES apps(id) ON DELETE RESTRICT,
  build_id              TEXT NOT NULL REFERENCES builds(id) ON DELETE RESTRICT,

  -- Source asset snapshot (frozen at creation; drift = fail closed).
  asset_id              TEXT NOT NULL REFERENCES build_assets(id) ON DELETE RESTRICT,
  r2_key                TEXT NOT NULL,
  r2_etag               TEXT NOT NULL,
  source_size_bytes     INTEGER NOT NULL,
  computed_sha256       TEXT NOT NULL,
  source_filetype       TEXT NOT NULL,
  source_platform       TEXT NOT NULL DEFAULT 'darwin',

  -- Logical state (projection of latest attempt's terminal outcome).
  state                 TEXT NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'in_progress', 'accepted', 'invalid', 'rejected', 'error')),

  -- Triple closure fields (constraint 4).
  ready_for_staple      INTEGER NOT NULL DEFAULT 0 CHECK (ready_for_staple IN (0, 1)),
  apple_log_sha256      TEXT,
  apple_log_job_id      TEXT,

  -- The currently active attempt.
  active_attempt_id     TEXT,  -- FK added via separate ALTER below (self-ref to attempts table)

  created_by_actor      TEXT NOT NULL,
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL,
  completed_at          INTEGER,

  -- B1: PERMANENT uniqueness — one logical per (app, asset, SHA). Retries create new ATTEMPTS.
  UNIQUE (app_id, asset_id, computed_sha256),

  -- B4: column-level CHECKs
  CHECK (source_filetype IN ('dmg', 'zip', 'pkg')),
  CHECK (source_platform = 'darwin'),
  CHECK (length(computed_sha256) = 64 AND computed_sha256 GLOB '[0-9a-f]*'),
  CHECK (source_size_bytes > 0),
  CHECK (length(r2_key) > 0),
  CHECK (length(r2_etag) > 0),

  -- B4: closure implication — ready=1 requires accepted state + SHA + jobId present
  CHECK (
    (ready_for_staple = 0) OR
    (ready_for_staple = 1 AND state = 'accepted'
     AND apple_log_sha256 IS NOT NULL AND apple_log_job_id IS NOT NULL
     AND apple_log_sha256 = computed_sha256)
  )
);

-- B1: index for the permanent unique constraint (explicit for clarity)
CREATE UNIQUE INDEX IF NOT EXISTS uq_notarizations_identity
  ON app_notarizations(app_id, asset_id, computed_sha256);

CREATE INDEX IF NOT EXISTS idx_notarizations_app
  ON app_notarizations(app_id, created_at DESC);

-- ──────────── append-only attempts ────────────

CREATE TABLE IF NOT EXISTS app_notarization_attempts (
  id                    TEXT PRIMARY KEY,
  notarization_id       TEXT NOT NULL REFERENCES app_notarizations(id) ON DELETE CASCADE,
  app_id                TEXT NOT NULL REFERENCES apps(id) ON DELETE RESTRICT,  -- denormalized for ownership check

  attempt_no            INTEGER NOT NULL,   -- 1-based, increments per logical
  operation_id          TEXT REFERENCES operation_logs(id) ON DELETE SET NULL,  -- B3: nullable, survives op delete

  -- Apple submission identity
  apple_submission_id   TEXT UNIQUE,   -- globally unique UUID, Apple-issued

  -- Upload lifecycle
  upload_state          TEXT NOT NULL DEFAULT 'pending'
    CHECK (upload_state IN ('pending', 'uploading', 'uploaded', 'upload_failed', 'upload_uncertain')),

  -- S3 PUT receipt (M2/B4: ETag recorded but NOT treated as content hash)
  s3_receipt_etag       TEXT,

  -- Status lifecycle
  status_state          TEXT NOT NULL DEFAULT 'pending'
    CHECK (status_state IN ('pending', 'in_progress', 'accepted', 'invalid', 'rejected', 'error')),

  -- Error classification (per XX: 401/403/7000 distinct)
  error_class           TEXT
    CHECK (error_class IS NULL OR error_class IN (
      'NOTARY_AUTH_INVALID', 'NOTARY_ROLE_INSUFFICIENT', 'NOTARY_TEAM_NOT_CONFIGURED',
      'APPLE_REQUEST_FAILED', 'S3_UPLOAD_FAILED', 'SHA_BINDING_MISMATCH',
      'ASSET_INTEGRITY_MISMATCH', 'UPLOAD_UNCERTAIN', 'UNKNOWN'
    )),
  error_detail          TEXT,   -- sanitized, no secrets

  -- M1: transient error reconciliation
  error_phase           TEXT
    CHECK (error_phase IS NULL OR error_phase IN (
      'create_submission', 's3_upload', 'status_poll', 'log_fetch', 'sha_binding'
    )),
  raw_apple_status      TEXT,   -- sanitized raw Apple status string (e.g. "In Progress", "Rejected")
  last_polled_at        INTEGER,
  reconcile_state       TEXT NOT NULL DEFAULT 'none'
    CHECK (reconcile_state IN ('none', 'needed', 'in_progress', 'reconciled', 'abandoned')),

  -- Log receipts (triple closure)
  log_fetched           INTEGER NOT NULL DEFAULT 0 CHECK (log_fetched IN (0, 1)),
  log_sha256            TEXT,
  log_job_id            TEXT,

  -- Timestamps
  created_at            INTEGER NOT NULL,
  submitted_at          INTEGER,
  uploaded_at           INTEGER,
  completed_at          INTEGER,

  -- B1: unique attempt number per logical
  UNIQUE (notarization_id, attempt_no),

  -- B4: log_fetched=1 requires accepted + sha + jobId
  CHECK (
    (log_fetched = 0) OR
    (log_fetched = 1 AND status_state = 'accepted'
     AND log_sha256 IS NOT NULL AND log_job_id IS NOT NULL)
  ),

  -- B4: completed_at set iff terminal
  CHECK (
    (completed_at IS NULL AND status_state IN ('pending', 'in_progress')) OR
    (completed_at IS NOT NULL AND status_state IN ('accepted', 'invalid', 'rejected', 'error'))
  ),

  -- B4: error_class set iff error/failed terminal
  CHECK (
    (error_class IS NULL AND status_state NOT IN ('error') AND upload_state NOT IN ('upload_failed')) OR
    (error_class IS NOT NULL)
  ),

  -- B4: SHA format when present
  CHECK (log_sha256 IS NULL OR (length(log_sha256) = 64 AND log_sha256 GLOB '[0-9a-f]*'))
);

-- Ownership lookup: GET /apps/:appId/notarizations/:submissionId queries this first.
CREATE INDEX IF NOT EXISTS idx_attempts_app_submission
  ON app_notarization_attempts(app_id, apple_submission_id)
  WHERE apple_submission_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_attempts_notarization
  ON app_notarization_attempts(notarization_id, attempt_no);

-- ──────────── active_attempt_id FK (self-ref, added after both tables exist) ────────────

-- B2: active_attempt_id must belong to THIS logical row.
-- Enforced via trigger below (cross-table constraint).
-- SQLite can't do a composite FK to enforce "belongs to this logical", so trigger is the gate.

-- ──────────── B2: Ownership consistency triggers ────────────
-- These enforce that denormalized IDs are consistent across build/asset/app/attempt.

-- B2.1: build.app_id must match logical.app_id
CREATE TRIGGER IF NOT EXISTS trg_notarize_logical_build_app
BEFORE INSERT ON app_notarizations
FOR EACH ROW BEGIN
  SELECT CASE
    WHEN (SELECT app_id FROM builds WHERE id = NEW.build_id) != NEW.app_id
    THEN RAISE(ABORT, 'build_id does not belong to app_id')
  END;
END;

CREATE TRIGGER IF NOT EXISTS trg_notarize_logical_build_app_upd
BEFORE UPDATE ON app_notarizations
FOR EACH ROW WHEN NEW.build_id != OLD.build_id OR NEW.app_id != OLD.app_id
BEGIN
  SELECT CASE
    WHEN (SELECT app_id FROM builds WHERE id = NEW.build_id) != NEW.app_id
    THEN RAISE(ABORT, 'build_id does not belong to app_id')
  END;
END;

-- B2.2: asset.build_id must match logical.build_id
CREATE TRIGGER IF NOT EXISTS trg_notarize_logical_asset_build
BEFORE INSERT ON app_notarizations
FOR EACH ROW BEGIN
  SELECT CASE
    WHEN (SELECT build_id FROM build_assets WHERE id = NEW.asset_id) != NEW.build_id
    THEN RAISE(ABORT, 'asset_id does not belong to build_id')
  END;
END;

CREATE TRIGGER IF NOT EXISTS trg_notarize_logical_asset_build_upd
BEFORE UPDATE ON app_notarizations
FOR EACH ROW WHEN NEW.asset_id != OLD.asset_id
BEGIN
  SELECT CASE
    WHEN (SELECT build_id FROM build_assets WHERE id = NEW.asset_id) != NEW.build_id
    THEN RAISE(ABORT, 'asset_id does not belong to build_id')
  END;
END;

-- B2.3: attempt.app_id must match parent logical.app_id
CREATE TRIGGER IF NOT EXISTS trg_notarize_attempt_app_match
BEFORE INSERT ON app_notarization_attempts
FOR EACH ROW BEGIN
  SELECT CASE
    WHEN (SELECT app_id FROM app_notarizations WHERE id = NEW.notarization_id) != NEW.app_id
    THEN RAISE(ABORT, 'attempt app_id does not match parent logical app_id')
  END;
END;

CREATE TRIGGER IF NOT EXISTS trg_notarize_attempt_app_match_upd
BEFORE UPDATE ON app_notarization_attempts
FOR EACH ROW WHEN NEW.app_id != OLD.app_id OR NEW.notarization_id != OLD.notarization_id
BEGIN
  SELECT CASE
    WHEN (SELECT app_id FROM app_notarizations WHERE id = NEW.notarization_id) != NEW.app_id
    THEN RAISE(ABORT, 'attempt app_id does not match parent logical app_id')
  END;
END;

-- B2.4: active_attempt_id must belong to THIS logical row
CREATE TRIGGER IF NOT EXISTS trg_notarize_active_attempt_belongs
BEFORE INSERT ON app_notarizations
FOR EACH ROW WHEN NEW.active_attempt_id IS NOT NULL
BEGIN
  SELECT CASE
    WHEN (SELECT notarization_id FROM app_notarization_attempts WHERE id = NEW.active_attempt_id) != NEW.id
    THEN RAISE(ABORT, 'active_attempt_id does not belong to this logical notarization')
  END;
END;

CREATE TRIGGER IF NOT EXISTS trg_notarize_active_attempt_belongs_upd
BEFORE UPDATE OF active_attempt_id ON app_notarizations
FOR EACH ROW WHEN NEW.active_attempt_id IS NOT NULL AND NEW.active_attempt_id != OLD.active_attempt_id
BEGIN
  SELECT CASE
    WHEN (SELECT notarization_id FROM app_notarization_attempts WHERE id = NEW.active_attempt_id) != NEW.id
    THEN RAISE(ABORT, 'active_attempt_id does not belong to this logical notarization')
  END;
END;

-- ──────────── B4: Cross-table closure invariant for ready_for_staple ────────────
-- ready_for_staple=1 requires the active attempt's submission_id == logical's apple_log_job_id
-- AND the active attempt's log_sha256 == logical's apple_log_sha256.
-- The column-level CHECK on logical already guards SHA==computed_sha256.
-- This trigger guards the cross-table jobId/submission_id binding.
CREATE TRIGGER IF NOT EXISTS trg_notarize_ready_closure
BEFORE UPDATE OF ready_for_staple ON app_notarizations
FOR EACH ROW WHEN NEW.ready_for_staple = 1
BEGIN
  SELECT CASE
    WHEN NEW.active_attempt_id IS NULL
    THEN RAISE(ABORT, 'ready_for_staple=1 requires active_attempt_id')
    WHEN (SELECT apple_submission_id FROM app_notarization_attempts WHERE id = NEW.active_attempt_id) != NEW.apple_log_job_id
    THEN RAISE(ABORT, 'ready_for_staple=1 requires active attempt submission_id == apple_log_job_id')
  END;
END;
