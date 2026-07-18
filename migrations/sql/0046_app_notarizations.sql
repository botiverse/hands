-- Migration 0046: app_notarizations + app_notarization_attempts
-- Broker-only notarization lane (platform feature).
--
-- Revision 3 (2026-07-18): addresses XX r2 CHANGES REQUIRED:
--   B2-fix: trigger change-detection uses IS NOT (not !=); fire on all relevant columns;
--           ownership uses NOT EXISTS not scalar subquery !=
--   B4-fix: ready_for_staple enforced on INSERT + all relevant UPDATEs (logical + attempt);
--           full triple closure checked; SHA CHECK uses NOT GLOB '*[^0-9a-f]*'
--   B4-fix: error_class CHECK encodes proper state↔error relationship
--   M2-fix: test matrix corrected to 43 cases + new negative SQL tests

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

  active_attempt_id     TEXT,  -- FK + ownership enforced via triggers

  created_by_actor      TEXT NOT NULL,
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL,
  completed_at          INTEGER,

  UNIQUE (app_id, asset_id, computed_sha256),

  CHECK (source_filetype IN ('dmg', 'zip', 'pkg')),
  CHECK (source_platform = 'darwin'),
  -- B4-fix: proper hex check (NOT GLOB '*[^0-9a-f]*' rejects any non-hex char)
  CHECK (length(computed_sha256) = 64 AND computed_sha256 NOT GLOB '*[^0-9a-f]*'),
  CHECK (source_size_bytes > 0),
  CHECK (length(r2_key) > 0),
  CHECK (length(r2_etag) > 0),

  -- B4-fix: ready=1 full closure (column-level; trigger adds cross-table)
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

  created_at            INTEGER NOT NULL,
  submitted_at          INTEGER,
  uploaded_at           INTEGER,
  completed_at          INTEGER,

  UNIQUE (notarization_id, attempt_no),

  -- B4-fix: proper hex check
  CHECK (log_sha256 IS NULL OR (length(log_sha256) = 64 AND log_sha256 NOT GLOB '*[^0-9a-f]*')),

  -- B4-fix: log_fetched=1 requires accepted + sha + jobId
  CHECK (
    (log_fetched = 0) OR
    (log_fetched = 1 AND status_state = 'accepted'
     AND log_sha256 IS NOT NULL AND log_job_id IS NOT NULL)
  ),

  -- B4-fix: completed_at set iff terminal
  CHECK (
    (completed_at IS NULL AND status_state IN ('pending', 'in_progress')) OR
    (completed_at IS NOT NULL AND status_state IN ('accepted', 'invalid', 'rejected', 'error'))
  ),

  -- B4-fix: proper error_class ↔ state relationship
  -- error_class IS NULL only when status/upload are in a non-error state
  -- Rejected is a terminal Apple state, NOT an infra error — error_class may be NULL for Rejected
  -- error_class IS NOT NULL required when: status_state=error OR upload_state=upload_failed
  CHECK (
    (error_class IS NOT NULL AND status_state IN ('accepted','invalid','rejected','error','in_progress','pending'))
    OR
    (error_class IS NULL AND status_state IN ('pending','in_progress','accepted','invalid','rejected')
     AND upload_state NOT IN ('upload_failed'))
  )
);

CREATE INDEX IF NOT EXISTS idx_attempts_app_submission
  ON app_notarization_attempts(app_id, apple_submission_id)
  WHERE apple_submission_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_attempts_notarization
  ON app_notarization_attempts(notarization_id, attempt_no);

-- ═══════════════════════════════════════════════════════════════════════
-- TRIGGERS — ownership consistency + closure invariants
-- B2-fix: use IS NOT for change detection (NULL-safe), NOT EXISTS for ownership
-- ═══════════════════════════════════════════════════════════════════════

-- B2.1: build.app_id must match logical.app_id (INSERT)
CREATE TRIGGER IF NOT EXISTS trg_notarize_logical_build_app_ins
BEFORE INSERT ON app_notarizations
FOR EACH ROW BEGIN
  SELECT CASE
    WHEN NOT EXISTS (SELECT 1 FROM builds WHERE id = NEW.build_id AND app_id = NEW.app_id)
    THEN RAISE(ABORT, 'build_id does not belong to app_id')
  END;
END;

-- B2.1: same check on UPDATE of build_id OR app_id (IS NOT for NULL-safety)
CREATE TRIGGER IF NOT EXISTS trg_notarize_logical_build_app_upd
BEFORE UPDATE OF build_id, app_id ON app_notarizations
FOR EACH ROW BEGIN
  SELECT CASE
    WHEN NOT EXISTS (SELECT 1 FROM builds WHERE id = NEW.build_id AND app_id = NEW.app_id)
    THEN RAISE(ABORT, 'build_id does not belong to app_id')
  END;
END;

-- B2.2: asset.build_id must match logical.build_id (INSERT)
CREATE TRIGGER IF NOT EXISTS trg_notarize_logical_asset_build_ins
BEFORE INSERT ON app_notarizations
FOR EACH ROW BEGIN
  SELECT CASE
    WHEN NOT EXISTS (SELECT 1 FROM build_assets WHERE id = NEW.asset_id AND build_id = NEW.build_id)
    THEN RAISE(ABORT, 'asset_id does not belong to build_id')
  END;
END;

-- B2.2-fix: fire on BOTH asset_id AND build_id change (was only asset_id)
CREATE TRIGGER IF NOT EXISTS trg_notarize_logical_asset_build_upd
BEFORE UPDATE OF asset_id, build_id ON app_notarizations
FOR EACH ROW BEGIN
  SELECT CASE
    WHEN NOT EXISTS (SELECT 1 FROM build_assets WHERE id = NEW.asset_id AND build_id = NEW.build_id)
    THEN RAISE(ABORT, 'asset_id does not belong to build_id')
  END;
END;

-- B2.3: attempt.app_id must match parent logical.app_id (INSERT)
CREATE TRIGGER IF NOT EXISTS trg_notarize_attempt_app_ins
BEFORE INSERT ON app_notarization_attempts
FOR EACH ROW BEGIN
  SELECT CASE
    WHEN NOT EXISTS (SELECT 1 FROM app_notarizations WHERE id = NEW.notarization_id AND app_id = NEW.app_id)
    THEN RAISE(ABORT, 'attempt app_id does not match parent logical app_id')
  END;
END;

-- B2.3: same on UPDATE
CREATE TRIGGER IF NOT EXISTS trg_notarize_attempt_app_upd
BEFORE UPDATE OF notarization_id, app_id ON app_notarization_attempts
FOR EACH ROW BEGIN
  SELECT CASE
    WHEN NOT EXISTS (SELECT 1 FROM app_notarizations WHERE id = NEW.notarization_id AND app_id = NEW.app_id)
    THEN RAISE(ABORT, 'attempt app_id does not match parent logical app_id')
  END;
END;

-- B2.4-fix: active_attempt_id ownership — fire on INSERT + UPDATE, IS NOT for NULL-safe detection
-- NULL→foreign was bypassing because != evaluates to NULL when OLD is NULL.
CREATE TRIGGER IF NOT EXISTS trg_notarize_active_attempt_ins
BEFORE INSERT ON app_notarizations
FOR EACH ROW WHEN NEW.active_attempt_id IS NOT NULL
BEGIN
  SELECT CASE
    WHEN NOT EXISTS (
      SELECT 1 FROM app_notarization_attempts
      WHERE id = NEW.active_attempt_id AND notarization_id = NEW.id
    )
    THEN RAISE(ABORT, 'active_attempt_id does not belong to this logical notarization')
  END;
END;

CREATE TRIGGER IF NOT EXISTS trg_notarize_active_attempt_upd
BEFORE UPDATE OF active_attempt_id ON app_notarizations
FOR EACH ROW WHEN NEW.active_attempt_id IS NOT NULL AND NEW.active_attempt_id IS NOT OLD.active_attempt_id
BEGIN
  SELECT CASE
    WHEN NOT EXISTS (
      SELECT 1 FROM app_notarization_attempts
      WHERE id = NEW.active_attempt_id AND notarization_id = NEW.id
    )
    THEN RAISE(ABORT, 'active_attempt_id does not belong to this logical notarization')
  END;
END;

-- ═══════════════════════════════════════════════════════════════════════
-- B4-fix: FULL triple closure enforcement
-- ready_for_staple=1 requires (all simultaneously true):
--   logical.state = 'accepted'
--   logical.active_attempt_id IS NOT NULL
--   active attempt EXISTS, belongs to this logical, status_state='accepted', log_fetched=1
--   active attempt.apple_submission_id == logical.apple_log_job_id
--   active attempt.log_job_id == logical.apple_log_job_id
--   logical.apple_log_sha256 == logical.computed_sha256
--   attempt.log_sha256 == logical.apple_log_sha256
--
-- Enforced on: logical INSERT + UPDATE of any closure-relevant column,
-- AND on attempt UPDATE/DELETE while parent logical is ready.
-- ═══════════════════════════════════════════════════════════════════════

-- Helper: the full closure check as a reusable expression.
-- (SQLite triggers can't share functions; we inline the check in each trigger.)

-- B4: ready closure on logical INSERT
CREATE TRIGGER IF NOT EXISTS trg_notarize_ready_ins
BEFORE INSERT ON app_notarizations
FOR EACH ROW WHEN NEW.ready_for_staple = 1
BEGIN
  SELECT CASE
    WHEN NOT (
      NEW.state = 'accepted'
      AND NEW.active_attempt_id IS NOT NULL
      AND NEW.apple_log_sha256 = NEW.computed_sha256
      AND NEW.apple_log_sha256 IS NOT NULL
      AND NEW.apple_log_job_id IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM app_notarization_attempts a
        WHERE a.id = NEW.active_attempt_id
          AND a.notarization_id = NEW.id
          AND a.status_state = 'accepted'
          AND a.log_fetched = 1
          AND a.apple_submission_id = NEW.apple_log_job_id
          AND a.log_job_id = NEW.apple_log_job_id
          AND a.log_sha256 = NEW.apple_log_sha256
      )
    )
    THEN RAISE(ABORT, 'ready_for_staple=1 requires full triple closure: accepted state + active accepted attempt with log_fetched=1 + jobId==submission_id==log_job_id + SHA match')
  END;
END;

-- B4: ready closure on logical UPDATE of ANY closure-relevant column
CREATE TRIGGER IF NOT EXISTS trg_notarize_ready_upd
BEFORE UPDATE OF ready_for_staple, state, active_attempt_id, apple_log_sha256, apple_log_job_id, computed_sha256
ON app_notarizations
FOR EACH ROW WHEN NEW.ready_for_staple = 1
BEGIN
  SELECT CASE
    WHEN NOT (
      NEW.state = 'accepted'
      AND NEW.active_attempt_id IS NOT NULL
      AND NEW.apple_log_sha256 = NEW.computed_sha256
      AND NEW.apple_log_sha256 IS NOT NULL
      AND NEW.apple_log_job_id IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM app_notarization_attempts a
        WHERE a.id = NEW.active_attempt_id
          AND a.notarization_id = NEW.id
          AND a.status_state = 'accepted'
          AND a.log_fetched = 1
          AND a.apple_submission_id = NEW.apple_log_job_id
          AND a.log_job_id = NEW.apple_log_job_id
          AND a.log_sha256 = NEW.apple_log_sha256
      )
    )
    THEN RAISE(ABORT, 'ready_for_staple=1 requires full triple closure')
  END;
END;

-- B4: attempt UPDATE that breaks parent's closure while parent is ready
-- If the active attempt's fields change, the parent logical's ready_for_staple
-- must be re-evaluated. We prevent mutations that would break closure silently
-- by checking if this attempt IS the active attempt of a ready logical.
CREATE TRIGGER IF NOT EXISTS trg_notarize_attempt_break_closure_upd
BEFORE UPDATE OF status_state, log_fetched, log_sha256, log_job_id, apple_submission_id
ON app_notarization_attempts
FOR EACH ROW
BEGIN
  SELECT CASE
    WHEN EXISTS (
      SELECT 1 FROM app_notarizations n
      WHERE n.active_attempt_id = NEW.id AND n.ready_for_staple = 1
    )
    AND NOT (
      -- After this update, does the closure still hold?
      EXISTS (
        SELECT 1 FROM app_notarizations n
        WHERE n.active_attempt_id = NEW.id AND n.ready_for_staple = 1
        AND n.state = 'accepted'
        AND NEW.status_state = 'accepted'
        AND NEW.log_fetched = 1
        AND NEW.apple_submission_id = n.apple_log_job_id
        AND NEW.log_job_id = n.apple_log_job_id
        AND NEW.log_sha256 = n.apple_log_sha256
        AND n.apple_log_sha256 = n.computed_sha256
      )
    )
    THEN RAISE(ABORT, 'update breaks ready_for_staple closure of parent logical')
  END;
END;

-- B4: attempt DELETE that breaks parent's closure while parent is ready
-- (CASCADE from logical delete is fine; this catches direct attempt deletes)
CREATE TRIGGER IF NOT EXISTS trg_notarize_attempt_break_closure_del
BEFORE DELETE ON app_notarization_attempts
FOR EACH ROW
BEGIN
  SELECT CASE
    WHEN EXISTS (
      SELECT 1 FROM app_notarizations n
      WHERE n.active_attempt_id = OLD.id AND n.ready_for_staple = 1
    )
    THEN RAISE(ABORT, 'cannot delete active attempt of a ready logical notarization')
  END;
END;
