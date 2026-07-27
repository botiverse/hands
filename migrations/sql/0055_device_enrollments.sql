-- Stable, operator-managed aliases for physical QA/test devices.
--
-- The Android SDK device id remains a random per-install identifier and still
-- resets on uninstall/clear-data.  An enrollment is an authenticated control-
-- plane object that lets a publisher rebind the replacement installation id
-- to the same device-group / feature-flag targeting slots without inventing a
-- permanent hardware identifier.
CREATE TABLE IF NOT EXISTS device_enrollments (
  id                TEXT PRIMARY KEY,
  app_id            TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  alias             TEXT NOT NULL,
  label             TEXT,
  current_device_id TEXT,
  status            TEXT NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active', 'revoked')),
  revision          INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_by        TEXT NOT NULL,
  updated_by        TEXT NOT NULL,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  last_rebound_at   INTEGER,
  revoked_at        INTEGER
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_device_enrollments_app_alias
  ON device_enrollments(app_id, alias COLLATE NOCASE);

-- One live installation can occupy only one stable enrollment slot per app.
CREATE UNIQUE INDEX IF NOT EXISTS idx_device_enrollments_app_current_device
  ON device_enrollments(app_id, current_device_id)
  WHERE status = 'active' AND current_device_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS device_enrollment_operations (
  id                         TEXT PRIMARY KEY,
  app_id                     TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  enrollment_id              TEXT NOT NULL REFERENCES device_enrollments(id) ON DELETE CASCADE,
  operation_id               TEXT NOT NULL,
  kind                       TEXT NOT NULL CHECK (kind IN ('create', 'rebind', 'revoke')),
  from_device_id             TEXT,
  to_device_id               TEXT,
  expected_revision          INTEGER,
  resulting_revision         INTEGER NOT NULL,
  migrated_group_memberships INTEGER NOT NULL DEFAULT 0,
  migrated_feature_flags     INTEGER NOT NULL DEFAULT 0,
  actor                      TEXT NOT NULL,
  created_at                 INTEGER NOT NULL,
  UNIQUE (app_id, operation_id)
);

CREATE INDEX IF NOT EXISTS idx_device_enrollment_operations_enrollment
  ON device_enrollment_operations(enrollment_id, created_at DESC);

-- D1 batch() is transactional but does not expose an interactive transaction.
-- These operation guards make a stale/revoked rebind abort the entire batch
-- before any group or feature-flag target is changed.
-- Cloudflare's remote D1 migration parser requires compact one-line trigger
-- bodies (workers-sdk#4998 / CFSQL-1402).
CREATE TRIGGER IF NOT EXISTS trg_device_enrollment_rebind_guard BEFORE INSERT ON device_enrollment_operations WHEN NEW.kind = 'rebind' AND NOT EXISTS (SELECT 1 FROM device_enrollments e WHERE e.id = NEW.enrollment_id AND e.app_id = NEW.app_id AND e.status = 'active' AND e.current_device_id = NEW.from_device_id AND e.revision = NEW.expected_revision AND NEW.resulting_revision = e.revision + 1) BEGIN SELECT RAISE(ABORT, 'device enrollment rebind precondition failed'); END;

CREATE TRIGGER IF NOT EXISTS trg_device_enrollment_revoke_guard BEFORE INSERT ON device_enrollment_operations WHEN NEW.kind = 'revoke' AND NOT EXISTS (SELECT 1 FROM device_enrollments e WHERE e.id = NEW.enrollment_id AND e.app_id = NEW.app_id AND e.status = 'active' AND e.current_device_id = NEW.from_device_id AND e.revision = NEW.expected_revision AND NEW.resulting_revision = e.revision + 1) BEGIN SELECT RAISE(ABORT, 'device enrollment revoke precondition failed'); END;
