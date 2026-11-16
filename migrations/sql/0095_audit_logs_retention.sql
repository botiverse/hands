-- Audit history outlives the app it describes, and is append-only.
--
-- `audit_logs.app_id` cascades from `apps` (0001), so purging an app deleted its
-- whole audit history. 0074 added `app_purge_records` to say who purged an app
-- and when, but the app's own history was still lost. Rebuilding audit_logs
-- without the cascade would copy every row in one migration; instead a trigger
-- copies each row into `audit_logs_archive` as it is deleted, by the cascade or
-- by anything else. The archive has no foreign keys, so nothing removes it.
--
-- Audit rows are also made immutable: nothing in the Worker updates them, and a
-- trigger now refuses any UPDATE.
CREATE TABLE IF NOT EXISTS audit_logs_archive (
  id          TEXT PRIMARY KEY,
  app_id      TEXT NOT NULL,
  action      TEXT NOT NULL,
  actor       TEXT NOT NULL,
  actor_id    TEXT,
  actor_type  TEXT,
  payload     TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  archived_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_archive_app ON audit_logs_archive(app_id, created_at DESC);

CREATE TRIGGER IF NOT EXISTS trg_audit_logs_archive_on_delete
BEFORE DELETE ON audit_logs
BEGIN
  INSERT OR IGNORE INTO audit_logs_archive
    (id, app_id, action, actor, actor_id, actor_type, payload, created_at, archived_at)
  VALUES
    (OLD.id, OLD.app_id, OLD.action, OLD.actor, OLD.actor_id, OLD.actor_type, OLD.payload, OLD.created_at,
     CAST(strftime('%s', 'now') AS INTEGER) * 1000);
END;

CREATE TRIGGER IF NOT EXISTS trg_audit_logs_no_update
BEFORE UPDATE ON audit_logs
BEGIN
  SELECT RAISE(ABORT, 'audit_logs rows are append-only');
END;
