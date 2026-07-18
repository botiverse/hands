-- Migration 0046: app_notarizations + app_notarization_attempts
-- Broker-only notarization lane (platform feature).
--
-- Revision 4 (2026-07-18): tightens state and ownership constraints:
--   B4-fix: error_class CHECK no longer tautological — non-NULL requires concrete error condition
--   B4-fix: attempt identity fields (id/notarization_id/app_id/attempt_no) immutable after INSERT
--   B3-fix: direct DELETE of non-ready attempt rejected while parent exists
--   B3-fix: logical source-snapshot columns frozen (immutable after INSERT)
--   M2-fix: added cases 8.9/8.10 + direct-delete + frozen-snapshot negatives

CREATE TABLE IF NOT EXISTS app_notarizations (
  id                    TEXT PRIMARY KEY,
  app_id                TEXT NOT NULL REFERENCES apps(id) ON DELETE RESTRICT,
  build_id              TEXT NOT NULL REFERENCES builds(id) ON DELETE RESTRICT,

  asset_id              TEXT NOT NULL REFERENCES build_assets(id) ON DELETE RESTRICT,
  r2_key                TEXT NOT NULL,
  r2_etag               TEXT NOT NULL,
  source_size_bytes     INTEGER NOT NULL,
  computed_sha256       TEXT NOT NULL,
  source_filetype       TEXT NOT NULL,
  source_platform       TEXT NOT NULL DEFAULT 'darwin',

  state                 TEXT NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'in_progress', 'accepted', 'invalid', 'rejected', 'error')),

  ready_for_staple      INTEGER NOT NULL DEFAULT 0 CHECK (ready_for_staple IN (0, 1)),
  apple_log_sha256      TEXT,
  apple_log_job_id      TEXT,

  active_attempt_id     TEXT,

  created_by_actor      TEXT NOT NULL,
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL,
  completed_at          INTEGER,

  UNIQUE (app_id, asset_id, computed_sha256),

  CHECK (source_filetype IN ('dmg', 'zip', 'pkg')),
  CHECK (source_platform = 'darwin'),
  CHECK (length(computed_sha256) = 64 AND computed_sha256 NOT GLOB '*[^0-9a-f]*'),
  CHECK (source_size_bytes > 0),
  CHECK (length(r2_key) > 0),
  CHECK (length(r2_etag) > 0),

  CHECK (
    (ready_for_staple = 0) OR
    (ready_for_staple = 1 AND state = 'accepted'
     AND apple_log_sha256 IS NOT NULL AND apple_log_job_id IS NOT NULL
     AND apple_log_sha256 = computed_sha256
     AND active_attempt_id IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_notarizations_identity
  ON app_notarizations(app_id, asset_id, computed_sha256);

CREATE INDEX IF NOT EXISTS idx_notarizations_app
  ON app_notarizations(app_id, created_at DESC);

-- ──────────── append-only attempts ────────────

CREATE TABLE IF NOT EXISTS app_notarization_attempts (
  id                    TEXT PRIMARY KEY,
  notarization_id       TEXT NOT NULL REFERENCES app_notarizations(id) ON DELETE CASCADE,
  app_id                TEXT NOT NULL REFERENCES apps(id) ON DELETE RESTRICT,

  attempt_no            INTEGER NOT NULL,
  operation_id          TEXT REFERENCES operation_logs(id) ON DELETE SET NULL,

  submission_name       TEXT NOT NULL,
  apple_submission_id   TEXT UNIQUE,

  upload_state          TEXT NOT NULL DEFAULT 'pending'
    CHECK (upload_state IN ('pending', 'uploading', 'uploaded', 'upload_failed', 'upload_uncertain')),

  s3_receipt_etag       TEXT,

  status_state          TEXT NOT NULL DEFAULT 'pending'
    CHECK (status_state IN ('pending', 'in_progress', 'accepted', 'invalid', 'rejected', 'error')),

  error_class           TEXT
    CHECK (error_class IS NULL OR error_class IN (
      'NOTARY_AUTH_INVALID', 'NOTARY_ROLE_INSUFFICIENT', 'NOTARY_TEAM_NOT_CONFIGURED',
      'APPLE_REQUEST_FAILED', 'S3_UPLOAD_FAILED', 'SHA_BINDING_MISMATCH',
      'ASSET_INTEGRITY_MISMATCH', 'UPLOAD_UNCERTAIN', 'UNKNOWN'
    )),
  error_detail          TEXT,

  error_phase           TEXT
    CHECK (error_phase IS NULL OR error_phase IN (
      'create_submission', 's3_upload', 'status_poll', 'log_fetch', 'sha_binding'
    )),
  raw_apple_status      TEXT,
  last_polled_at        INTEGER,
  reconcile_state       TEXT NOT NULL DEFAULT 'none'
    CHECK (reconcile_state IN ('none', 'needed', 'in_progress', 'reconciled', 'abandoned')),

  log_fetched           INTEGER NOT NULL DEFAULT 0 CHECK (log_fetched in (0,1)),
  log_sha256            TEXT,
  log_job_id            TEXT,
  log_r2_key            TEXT,
  log_size_bytes        INTEGER,
  log_retained_at       INTEGER,

  created_at            INTEGER NOT NULL,
  submitted_at          INTEGER,
  uploaded_at           INTEGER,
  completed_at          INTEGER,

  UNIQUE (notarization_id, attempt_no),

  CHECK (log_sha256 IS NULL OR (length(log_sha256) = 64 AND log_sha256 NOT GLOB '*[^0-9a-f]*')),
  CHECK (length(submission_name) > 0),
  CHECK ((log_r2_key IS NULL AND log_size_bytes IS NULL AND log_retained_at IS NULL) OR
         (log_r2_key IS NOT NULL AND length(log_r2_key) > 0 AND log_size_bytes > 0 AND log_retained_at IS NOT NULL)),

  CHECK (
    (log_fetched = 0) OR
    (log_fetched = 1 AND status_state = 'accepted'
     AND log_sha256 IS NOT NULL AND log_job_id IS NOT NULL)
  ),

  CHECK (
    (completed_at IS NULL AND status_state IN ('pending', 'in_progress')) OR
    (completed_at IS NOT NULL AND status_state IN ('accepted', 'invalid', 'rejected', 'error'))
  ),

  -- B4-fix (r5): bidirectional error_class ↔ state relationship.
  -- NULL branch: requires NO error condition (status != error AND upload != failed).
  --   accepted/pending/in_progress/invalid/rejected with NULL error_class all pass
  --   UNLESS status=error or upload=upload_failed (those REQUIRE a non-NULL class).
  -- Non-NULL branch: requires a concrete error condition:
  --   status IN (error, invalid, rejected)  -- terminal infra error or classified Apple terminal
  --   OR upload IN (upload_failed, upload_uncertain)
  --   OR (pending/in_progress with reconcile_state != none OR error_phase IS NOT NULL)  -- transient
  CHECK (
    -- NULL is valid only when there is no error/upload-failed state
    (error_class IS NULL AND status_state != 'error' AND upload_state != 'upload_failed')
    OR
    -- non-NULL is valid only when there is a concrete error condition
    (error_class IS NOT NULL AND (
      status_state IN ('error', 'invalid', 'rejected')
      OR upload_state IN ('upload_failed', 'upload_uncertain')
      OR (status_state IN ('pending', 'in_progress') AND (reconcile_state != 'none' OR error_phase IS NOT NULL))
    ))
  )
);

CREATE INDEX IF NOT EXISTS idx_attempts_app_submission
  ON app_notarization_attempts(app_id, apple_submission_id)
  WHERE apple_submission_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_attempts_notarization
  ON app_notarization_attempts(notarization_id, attempt_no);

-- ═══════════════════════════════════════════════════════════════════════
-- B2: Ownership consistency triggers (carried from r3, verified fixed)
-- ═══════════════════════════════════════════════════════════════════════

CREATE TRIGGER IF NOT EXISTS trg_notarize_logical_build_app_ins
BEFORE INSERT ON app_notarizations FOR EACH ROW BEGIN
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM builds WHERE id = NEW.build_id AND app_id = NEW.app_id)
    THEN RAISE(ABORT, 'build_id does not belong to app_id') END;
END;

CREATE TRIGGER IF NOT EXISTS trg_notarize_logical_build_app_upd
BEFORE UPDATE OF build_id, app_id ON app_notarizations FOR EACH ROW BEGIN
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM builds WHERE id = NEW.build_id AND app_id = NEW.app_id)
    THEN RAISE(ABORT, 'build_id does not belong to app_id') END;
END;

CREATE TRIGGER IF NOT EXISTS trg_notarize_logical_asset_build_ins
BEFORE INSERT ON app_notarizations FOR EACH ROW BEGIN
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM build_assets WHERE id = NEW.asset_id AND build_id = NEW.build_id)
    THEN RAISE(ABORT, 'asset_id does not belong to build_id') END;
END;

CREATE TRIGGER IF NOT EXISTS trg_notarize_logical_asset_build_upd
BEFORE UPDATE OF asset_id, build_id ON app_notarizations FOR EACH ROW BEGIN
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM build_assets WHERE id = NEW.asset_id AND build_id = NEW.build_id)
    THEN RAISE(ABORT, 'asset_id does not belong to build_id') END;
END;

CREATE TRIGGER IF NOT EXISTS trg_notarize_attempt_app_ins
BEFORE INSERT ON app_notarization_attempts FOR EACH ROW BEGIN
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM app_notarizations WHERE id = NEW.notarization_id AND app_id = NEW.app_id)
    THEN RAISE(ABORT, 'attempt app_id does not match parent logical app_id') END;
END;

CREATE TRIGGER IF NOT EXISTS trg_notarize_attempt_app_upd
BEFORE UPDATE OF notarization_id, app_id ON app_notarization_attempts FOR EACH ROW BEGIN
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM app_notarizations WHERE id = NEW.notarization_id AND app_id = NEW.app_id)
    THEN RAISE(ABORT, 'attempt app_id does not match parent logical app_id') END;
END;

-- B2.4: active_attempt_id ownership (IS NOT for NULL-safety)
CREATE TRIGGER IF NOT EXISTS trg_notarize_active_attempt_ins
BEFORE INSERT ON app_notarizations FOR EACH ROW WHEN NEW.active_attempt_id IS NOT NULL
BEGIN
  SELECT CASE WHEN NOT EXISTS (
      SELECT 1 FROM app_notarization_attempts WHERE id = NEW.active_attempt_id AND notarization_id = NEW.id
    ) THEN RAISE(ABORT, 'active_attempt_id does not belong to this logical notarization') END;
END;

CREATE TRIGGER IF NOT EXISTS trg_notarize_active_attempt_upd
BEFORE UPDATE OF active_attempt_id ON app_notarizations
FOR EACH ROW WHEN NEW.active_attempt_id IS NOT NULL AND NEW.active_attempt_id IS NOT OLD.active_attempt_id
BEGIN
  SELECT CASE WHEN NOT EXISTS (
      SELECT 1 FROM app_notarization_attempts WHERE id = NEW.active_attempt_id AND notarization_id = NEW.id
    ) THEN RAISE(ABORT, 'active_attempt_id does not belong to this logical notarization') END;
END;

-- ═══════════════════════════════════════════════════════════════════════
-- B3-fix (r4): Frozen source snapshot — immutable identity columns after INSERT
-- ═══════════════════════════════════════════════════════════════════════

-- Source snapshot columns that must never change after creation.
-- Any UPDATE that changes a frozen column is rejected.
CREATE TRIGGER IF NOT EXISTS trg_notarize_freeze_snapshot
BEFORE UPDATE OF app_id, build_id, asset_id, r2_key, r2_etag, source_size_bytes,
                       computed_sha256, source_filetype, source_platform,
                       created_by_actor, created_at
ON app_notarizations
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'source snapshot columns are immutable after creation');
END;

-- ═══════════════════════════════════════════════════════════════════════
-- B3-fix (r4): Append-only attempts — reject direct DELETE while parent exists
-- Parent CASCADE delete still works (parent row is gone when this trigger fires).
-- ═══════════════════════════════════════════════════════════════════════

CREATE TRIGGER IF NOT EXISTS trg_notarize_attempt_no_direct_delete
BEFORE DELETE ON app_notarization_attempts
FOR EACH ROW WHEN EXISTS (SELECT 1 FROM app_notarizations WHERE id = OLD.notarization_id)
BEGIN
  SELECT RAISE(ABORT, 'cannot directly delete an attempt while its logical notarization exists; delete via parent CASCADE only');
END;

-- ═══════════════════════════════════════════════════════════════════════
-- B4-fix (r4): Immutable attempt identity — id/notarization_id/app_id/attempt_no
-- These can never change after INSERT. Prevents rename/reparent closure bypass.
-- ═══════════════════════════════════════════════════════════════════════

CREATE TRIGGER IF NOT EXISTS trg_notarize_attempt_freeze_identity
BEFORE UPDATE OF id, notarization_id, app_id, attempt_no, created_at
ON app_notarization_attempts
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'attempt identity columns (id, notarization_id, app_id, attempt_no) are immutable after creation');
END;

-- ═══════════════════════════════════════════════════════════════════════
-- B4: FULL triple closure enforcement (carried from r3, verified fixed)
-- ═══════════════════════════════════════════════════════════════════════

CREATE TRIGGER IF NOT EXISTS trg_notarize_ready_ins
BEFORE INSERT ON app_notarizations FOR EACH ROW WHEN NEW.ready_for_staple = 1
BEGIN
  SELECT CASE WHEN NOT (
      NEW.state = 'accepted' AND NEW.active_attempt_id IS NOT NULL
      AND NEW.apple_log_sha256 = NEW.computed_sha256
      AND NEW.apple_log_sha256 IS NOT NULL AND NEW.apple_log_job_id IS NOT NULL
      AND EXISTS (SELECT 1 FROM app_notarization_attempts a
        WHERE a.id = NEW.active_attempt_id AND a.notarization_id = NEW.id
          AND a.status_state = 'accepted' AND a.log_fetched = 1
          AND a.apple_submission_id = NEW.apple_log_job_id
          AND a.log_job_id = NEW.apple_log_job_id
          AND a.log_sha256 = NEW.apple_log_sha256)
    ) THEN RAISE(ABORT, 'ready_for_staple=1 requires full triple closure') END;
END;

CREATE TRIGGER IF NOT EXISTS trg_notarize_ready_upd
BEFORE UPDATE OF ready_for_staple, state, active_attempt_id, apple_log_sha256, apple_log_job_id, computed_sha256
ON app_notarizations FOR EACH ROW WHEN NEW.ready_for_staple = 1
BEGIN
  SELECT CASE WHEN NOT (
      NEW.state = 'accepted' AND NEW.active_attempt_id IS NOT NULL
      AND NEW.apple_log_sha256 = NEW.computed_sha256
      AND NEW.apple_log_sha256 IS NOT NULL AND NEW.apple_log_job_id IS NOT NULL
      AND EXISTS (SELECT 1 FROM app_notarization_attempts a
        WHERE a.id = NEW.active_attempt_id AND a.notarization_id = NEW.id
          AND a.status_state = 'accepted' AND a.log_fetched = 1
          AND a.apple_submission_id = NEW.apple_log_job_id
          AND a.log_job_id = NEW.apple_log_job_id
          AND a.log_sha256 = NEW.apple_log_sha256)
    ) THEN RAISE(ABORT, 'ready_for_staple=1 requires full triple closure') END;
END;

-- B4: attempt UPDATE that breaks parent closure while parent is ready
CREATE TRIGGER IF NOT EXISTS trg_notarize_attempt_break_closure_upd
BEFORE UPDATE OF status_state, log_fetched, log_sha256, log_job_id, apple_submission_id
ON app_notarization_attempts FOR EACH ROW
BEGIN
  SELECT CASE
    WHEN EXISTS (SELECT 1 FROM app_notarizations n WHERE n.active_attempt_id = NEW.id AND n.ready_for_staple = 1)
    AND NOT EXISTS (
        SELECT 1 FROM app_notarizations n WHERE n.active_attempt_id = NEW.id AND n.ready_for_staple = 1
        AND n.state = 'accepted'
        AND NEW.status_state = 'accepted' AND NEW.log_fetched = 1
        AND NEW.apple_submission_id = n.apple_log_job_id
        AND NEW.log_job_id = n.apple_log_job_id
        AND NEW.log_sha256 = n.apple_log_sha256
        AND n.apple_log_sha256 = n.computed_sha256
      )
    THEN RAISE(ABORT, 'update breaks ready_for_staple closure of parent logical') END;
END;

-- B4: attempt DELETE while parent is ready (additional guard beyond append-only)
CREATE TRIGGER IF NOT EXISTS trg_notarize_attempt_break_closure_del
BEFORE DELETE ON app_notarization_attempts FOR EACH ROW
BEGIN
  SELECT CASE WHEN EXISTS (
      SELECT 1 FROM app_notarizations n WHERE n.active_attempt_id = OLD.id AND n.ready_for_staple = 1
    ) THEN RAISE(ABORT, 'cannot delete active attempt of a ready logical notarization') END;
END;
