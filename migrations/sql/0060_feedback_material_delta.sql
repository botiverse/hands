-- Internal agent material-delta cursor for feedback tickets.
--
-- This is a separate numbering domain from reporter_sequence. The reporter
-- domain is ticket-local and visible-comment-only; material delta is app-local
-- and advances for ticket creation, real status/assignee changes, and every
-- current production comment insert (reporter or staff, external or internal).
-- Values are generated only from feedback_tickets and are never seeded from a
-- comment sequence, rowid, or timestamp.

ALTER TABLE feedback_tickets ADD COLUMN material_sequence INTEGER;

CREATE TABLE feedback_material_sequence_state (
  app_id TEXT PRIMARY KEY REFERENCES apps(id) ON DELETE CASCADE,
  high_water INTEGER NOT NULL
    CHECK (high_water BETWEEN 0 AND 9007199254740991)
);

-- Deterministic per-app bootstrap. ROW_NUMBER is dense inside each app and
-- does not import values from any prior numbering domain.
WITH ranked AS (
  SELECT id,
         ROW_NUMBER() OVER (PARTITION BY app_id ORDER BY created_at, id) AS seq
  FROM feedback_tickets
)
UPDATE feedback_tickets
SET material_sequence = (SELECT seq FROM ranked WHERE ranked.id = feedback_tickets.id);

INSERT INTO feedback_material_sequence_state (app_id, high_water)
SELECT app_id, MAX(material_sequence)
FROM feedback_tickets
GROUP BY app_id;

CREATE UNIQUE INDEX idx_feedback_tickets_app_material_sequence
  ON feedback_tickets(app_id, material_sequence);

-- Cloudflare's remote D1 migration parser requires trigger bodies on one
-- physical line (workers-sdk#4998 / CFSQL-1402). Keep these compact.

CREATE TRIGGER feedback_material_state_insert_guard BEFORE INSERT ON feedback_material_sequence_state WHEN NEW.high_water != 0 BEGIN SELECT RAISE(ABORT, 'feedback material state must start at zero'); END;

CREATE TRIGGER feedback_material_state_monotonic BEFORE UPDATE ON feedback_material_sequence_state WHEN NEW.app_id != OLD.app_id OR NEW.high_water != OLD.high_water + 1 BEGIN SELECT RAISE(ABORT, 'feedback material high-water must advance by one'); END;

CREATE TRIGGER feedback_material_state_no_delete BEFORE DELETE ON feedback_material_sequence_state WHEN EXISTS (SELECT 1 FROM apps WHERE id = OLD.app_id) BEGIN SELECT RAISE(ABORT, 'feedback material state is durable while app exists'); END;

CREATE TRIGGER feedback_tickets_material_managed_insert BEFORE INSERT ON feedback_tickets WHEN NEW.material_sequence IS NOT NULL BEGIN SELECT RAISE(ABORT, 'feedback material sequence is managed'); END;

CREATE TRIGGER feedback_tickets_app_immutable BEFORE UPDATE OF app_id ON feedback_tickets WHEN NEW.app_id != OLD.app_id BEGIN SELECT RAISE(ABORT, 'feedback ticket app is immutable'); END;

CREATE TRIGGER feedback_tickets_material_managed_update BEFORE UPDATE OF material_sequence ON feedback_tickets WHEN NEW.material_sequence IS NULL OR NEW.app_id != OLD.app_id OR NEW.material_sequence <= COALESCE(OLD.material_sequence, 0) OR NEW.material_sequence != (SELECT high_water FROM feedback_material_sequence_state WHERE app_id = NEW.app_id) BEGIN SELECT RAISE(ABORT, 'feedback material sequence is managed'); END;

CREATE TRIGGER feedback_tickets_material_no_delete BEFORE DELETE ON feedback_tickets WHEN EXISTS (SELECT 1 FROM apps WHERE id = OLD.app_id) BEGIN SELECT RAISE(ABORT, 'feedback ticket deletion requires app purge or tombstone'); END;

CREATE TRIGGER feedback_tickets_material_insert AFTER INSERT ON feedback_tickets BEGIN INSERT OR IGNORE INTO feedback_material_sequence_state (app_id, high_water) VALUES (NEW.app_id, 0); UPDATE feedback_material_sequence_state SET high_water = high_water + 1 WHERE app_id = NEW.app_id; UPDATE feedback_tickets SET material_sequence = (SELECT high_water FROM feedback_material_sequence_state WHERE app_id = NEW.app_id) WHERE rowid = NEW.rowid; END;

CREATE TRIGGER feedback_tickets_material_status_assignee AFTER UPDATE OF status, assignee ON feedback_tickets WHEN NEW.status IS NOT OLD.status OR NEW.assignee IS NOT OLD.assignee BEGIN UPDATE feedback_material_sequence_state SET high_water = high_water + 1 WHERE app_id = NEW.app_id; UPDATE feedback_tickets SET material_sequence = (SELECT high_water FROM feedback_material_sequence_state WHERE app_id = NEW.app_id) WHERE rowid = NEW.rowid; END;

CREATE TRIGGER feedback_comments_material_insert AFTER INSERT ON feedback_comments BEGIN UPDATE feedback_material_sequence_state SET high_water = high_water + 1 WHERE app_id = (SELECT app_id FROM feedback_tickets WHERE id = NEW.ticket_id); UPDATE feedback_tickets SET material_sequence = (SELECT high_water FROM feedback_material_sequence_state WHERE app_id = feedback_tickets.app_id) WHERE id = NEW.ticket_id; END;
