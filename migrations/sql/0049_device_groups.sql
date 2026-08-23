CREATE TABLE IF NOT EXISTS device_groups (
  id          TEXT PRIMARY KEY,
  app_id      TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  description TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_device_groups_app_name
  ON device_groups(app_id, name COLLATE NOCASE);

CREATE TABLE IF NOT EXISTS device_group_members (
  group_id   TEXT NOT NULL REFERENCES device_groups(id) ON DELETE CASCADE,
  device_id  TEXT NOT NULL,
  label      TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (group_id, device_id)
);

CREATE INDEX IF NOT EXISTS idx_device_group_members_device
  ON device_group_members(device_id, group_id);

-- release_scopes cannot use a normal foreign key because scope_value is
-- polymorphic. Enforce the device-group branch in the database so concurrent
-- create/update/delete requests cannot leave a dangling or cross-app scope.
-- Cloudflare's remote D1 migration parser currently requires trigger bodies
-- on one physical line (workers-sdk#4998 / CFSQL-1402). Keep these compact
-- even though multiline triggers work in SQLite and local Miniflare.
CREATE TRIGGER IF NOT EXISTS trg_release_scopes_device_group_insert BEFORE INSERT ON release_scopes WHEN NEW.scope_type = 'device_group' AND NOT EXISTS (SELECT 1 FROM releases r JOIN device_groups g ON g.id = NEW.scope_value WHERE r.id = NEW.release_id AND r.app_id = g.app_id) BEGIN SELECT RAISE(ABORT, 'device_group scope must reference a group in the release app'); END;

CREATE TRIGGER IF NOT EXISTS trg_release_scopes_device_group_update BEFORE UPDATE OF release_id, scope_type, scope_value ON release_scopes WHEN NEW.scope_type = 'device_group' AND NOT EXISTS (SELECT 1 FROM releases r JOIN device_groups g ON g.id = NEW.scope_value WHERE r.id = NEW.release_id AND r.app_id = g.app_id) BEGIN SELECT RAISE(ABORT, 'device_group scope must reference a group in the release app'); END;

CREATE TRIGGER IF NOT EXISTS trg_device_groups_live_release_delete BEFORE DELETE ON device_groups WHEN EXISTS (SELECT 1 FROM apps WHERE id = OLD.app_id) AND EXISTS (SELECT 1 FROM release_scopes s JOIN releases r ON r.id = s.release_id WHERE s.scope_type = 'device_group' AND s.scope_value = OLD.id AND r.status IN ('draft', 'active')) BEGIN SELECT RAISE(ABORT, 'device group is used by a draft or active release'); END;
