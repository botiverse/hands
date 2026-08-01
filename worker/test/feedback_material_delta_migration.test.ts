import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

const MIGRATION_DIR = fileURLToPath(new URL("../../migrations/sql/", import.meta.url));
const MIGRATION = "0060_feedback_material_delta.sql";
const MIGRATION_SQL = readFileSync(`${MIGRATION_DIR}${MIGRATION}`, "utf8");
const VALIDATION_SQL = readFileSync(
  new URL("../../migrations/validation/0060_feedback_material_delta.sql", import.meta.url),
  "utf8",
);

function applyMigrations(db: Database.Database, includeMaterial = true) {
  for (const name of readdirSync(MIGRATION_DIR).sort()) {
    if (!name.endsWith(".sql")) continue;
    if (name === MIGRATION && !includeMaterial) continue;
    db.exec(readFileSync(`${MIGRATION_DIR}${name}`, "utf8"));
  }
}

const migrate = (db: Database.Database) =>
  db.exec(MIGRATION_SQL);

function database(includeMaterial = true) {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  applyMigrations(db, includeMaterial);
  return db;
}

function app(db: Database.Database, id: string) {
  db.prepare(
    "INSERT INTO apps (id, slug, name, platform, created_at) VALUES (?,?,?,'android',1)",
  ).run(id, id, id);
}

function integration(db: Database.Database, appId: string) {
  const id = `intg-${appId}`;
  db.prepare(
    "INSERT INTO app_reporter_integrations (id, app_id, name, created_at, updated_at) VALUES (?,?,'inbox',1,1)",
  ).run(id, appId);
  return id;
}

function ticket(
  db: Database.Database,
  id: string,
  appId: string,
  createdAt: number,
  reporterIntegrationId: string | null = null,
) {
  db.prepare(
    `INSERT INTO feedback_tickets
       (id, app_id, kind, status, message, metadata_json, reporter_id,
        reporter_integration_id, created_at, updated_at)
     VALUES (?,?,'feedback','open','message','{}',?,?,?,?)`,
  ).run(
    id,
    appId,
    reporterIntegrationId ? `reporter-${appId}` : null,
    reporterIntegrationId,
    createdAt,
    createdAt,
  );
}

function staffComment(
  db: Database.Database,
  id: string,
  ticketId: string,
  internal: 0 | 1,
) {
  db.prepare(
    `INSERT INTO feedback_comments
       (id, ticket_id, author_actor, author_type, body, internal, created_at)
     VALUES (?,?,'staff:test','staff','body',?,1)`,
  ).run(id, ticketId, internal);
}

function reporterComment(db: Database.Database, id: string, ticketId: string, integrationId: string) {
  db.prepare(
    `INSERT INTO feedback_comments
       (id, ticket_id, author_actor, author_type, body, internal,
        reporter_integration_id, reporter_id, submission_id,
        submission_fingerprint, created_at)
     VALUES (?,?,'reporter:test','reporter','body',0,?,'reporter-app-a',?,'fingerprint',1)`,
  ).run(id, ticketId, integrationId, `submission-${id}`);
}

const material = (db: Database.Database, ticketId: string) =>
  (db.prepare("SELECT material_sequence AS s FROM feedback_tickets WHERE id = ?")
    .get(ticketId) as { s: number }).s;

const reporterSequence = (db: Database.Database, commentId: string) =>
  (db.prepare("SELECT reporter_sequence AS s FROM feedback_comments WHERE id = ?")
    .get(commentId) as { s: number | null }).s;

const highWater = (db: Database.Database, appId: string) =>
  (db.prepare("SELECT high_water AS h FROM feedback_material_sequence_state WHERE app_id = ?")
    .get(appId) as { h: number }).h;

const validationErrors = (db: Database.Database) => db.prepare(VALIDATION_SQL).all() as Array<{
  app_id: string;
  violation: string;
}>;

function writeOpcodeCounts(db: Database.Database, sql: string) {
  const counts = { Insert: 0, Delete: 0, IdxInsert: 0, IdxDelete: 0, Program: 0 };
  for (const row of db.prepare(`EXPLAIN ${sql}`).all() as Array<{ opcode: keyof typeof counts }>) {
    if (row.opcode in counts) counts[row.opcode] += 1;
  }
  return counts;
}

describe("migration 0060 — feedback material delta", () => {
  it("backfills a deterministic per-app domain without changing reporter state", () => {
    const db = database(false);
    app(db, "app-a");
    app(db, "app-b");
    const intg = integration(db, "app-a");
    ticket(db, "a-z", "app-a", 1, intg);
    ticket(db, "a-a", "app-a", 1, intg);
    ticket(db, "b-a", "app-b", 1);
    db.prepare(
      "UPDATE feedback_tickets SET updated_at = CASE id WHEN 'a-a' THEN 999 ELSE 0 END",
    ).run();
    staffComment(db, "visible", "a-a", 0);
    staffComment(db, "internal", "a-a", 1);
    const reporterBefore = [reporterSequence(db, "visible"), reporterSequence(db, "internal")];

    migrate(db);

    expect(material(db, "a-a")).toBe(1);
    expect(material(db, "a-z")).toBe(2);
    expect(material(db, "b-a")).toBe(1);
    expect(highWater(db, "app-a")).toBe(2);
    expect(highWater(db, "app-b")).toBe(1);
    expect([reporterSequence(db, "visible"), reporterSequence(db, "internal")])
      .toEqual(reporterBefore);
    expect(db.prepare("SELECT COUNT(*) AS n FROM feedback_tickets WHERE material_sequence IS NULL")
      .get()).toEqual({ n: 0 });
  });

  it("kills every forbidden backfill source", () => {
    const fixture = () => {
      const db = database(false);
      app(db, "app-a");
      const intg = integration(db, "app-a");
      ticket(db, "a-z", "app-a", 1, intg);
      ticket(db, "a-a", "app-a", 1, intg);
      db.prepare(
        "UPDATE feedback_tickets SET updated_at = CASE id WHEN 'a-a' THEN 999 ELSE 0 END",
      ).run();
      staffComment(db, "comment-z", "a-z", 0);
      for (let index = 0; index < 4; index += 1) {
        staffComment(db, `padding-${index}`, "a-a", 1);
      }
      staffComment(db, "comment-a", "a-a", 0);
      db.exec("DROP TRIGGER feedback_comments_reporter_sequence_immutable");
      db.prepare(
        "UPDATE feedback_comments SET reporter_sequence=900 WHERE id='comment-a'",
      ).run();
      db.exec(
        `CREATE TABLE foreign_material_state (app_id TEXT PRIMARY KEY, high_water INTEGER NOT NULL);
         INSERT INTO foreign_material_state VALUES ('app-a', 777)`,
      );
      return db;
    };
    const expected = [
      { id: "a-a", material_sequence: 1 },
      { id: "a-z", material_sequence: 2 },
    ];
    const killed = (sql: string) => {
      const db = fixture();
      try {
        db.exec(sql);
        return JSON.stringify(db.prepare(
          "SELECT id, material_sequence FROM feedback_tickets ORDER BY id",
        ).all()) !== JSON.stringify(expected);
      } catch {
        return true;
      }
    };

    expect(killed(MIGRATION_SQL.replace(
      "PARTITION BY app_id ORDER BY created_at, id",
      "PARTITION BY app_id ORDER BY updated_at, id",
    ))).toBe(true);
    expect(killed(MIGRATION_SQL.replace(
      "ROW_NUMBER() OVER (PARTITION BY app_id ORDER BY created_at, id) AS seq",
      `(SELECT COALESCE(MAX(c.reporter_sequence), 0) FROM feedback_comments c
        WHERE c.ticket_id = feedback_tickets.id) AS seq`,
    ))).toBe(true);
    expect(killed(MIGRATION_SQL.replace(
      "ROW_NUMBER() OVER (PARTITION BY app_id ORDER BY created_at, id) AS seq",
      `(SELECT COALESCE(MAX(c.rowid), 0) FROM feedback_comments c
        WHERE c.ticket_id = feedback_tickets.id) AS seq`,
    ))).toBe(true);
    expect(killed(MIGRATION_SQL.replace(
      "ROW_NUMBER() OVER (PARTITION BY app_id ORDER BY created_at, id) AS seq",
      `(SELECT high_water FROM foreign_material_state f
        WHERE f.app_id = feedback_tickets.app_id) AS seq`,
    ))).toBe(true);
  });

  it("changes no ticket business field or reporter/audit/event/read state during backfill", () => {
    const db = database(false);
    app(db, "app-a");
    const intg = integration(db, "app-a");
    ticket(db, "ticket", "app-a", 1, intg);
    db.prepare(
      `UPDATE feedback_tickets
       SET kind='bug', status='in_progress', assignee='owner', message='preserve',
           contact='contact', version_name='1.2.3', version_code=123,
           channel='main', device_id='device', updated_at=999
       WHERE id='ticket'`,
    ).run();
    staffComment(db, "visible", "ticket", 0);
    staffComment(db, "internal", "ticket", 1);
    db.prepare(
      `INSERT INTO audit_logs (id, app_id, action, actor, payload, created_at)
       VALUES ('audit', 'app-a', 'before', 'staff:test', '{"preserve":true}', 1)`,
    ).run();
    db.prepare(
      `INSERT INTO feedback_events
       (id, event_type, app_id, ticket_id, reporter_integration_id, reporter_id,
        payload_json, route_outcome, created_at)
       VALUES ('event', 'feedback:comment_created', 'app-a', 'ticket', ?,
               'reporter-app-a', '{"preserve":true}', 'route_unbound', 1)`,
    ).run(intg);
    db.prepare(
      `INSERT INTO feedback_reporter_ticket_reads
       (app_id, reporter_integration_id, reporter_id, ticket_id,
        read_through_sequence, read_through_comment_id, updated_at)
       VALUES ('app-a', ?, 'reporter-app-a', 'ticket', 1, 'visible', 1)`,
    ).run(intg);
    const snapshot = {
      ticket: db.prepare(
        `SELECT id, app_id, kind, status, assignee, message, contact, version_name,
                version_code, channel, device_id, created_at, updated_at
         FROM feedback_tickets WHERE id='ticket'`,
      ).get(),
      comments: db.prepare("SELECT * FROM feedback_comments ORDER BY id").all(),
      audits: db.prepare("SELECT * FROM audit_logs ORDER BY id").all(),
      events: db.prepare("SELECT * FROM feedback_events ORDER BY id").all(),
      reads: db.prepare("SELECT * FROM feedback_reporter_ticket_reads ORDER BY ticket_id").all(),
    };

    migrate(db);

    expect({
      ticket: db.prepare(
        `SELECT id, app_id, kind, status, assignee, message, contact, version_name,
                version_code, channel, device_id, created_at, updated_at
         FROM feedback_tickets WHERE id='ticket'`,
      ).get(),
      comments: db.prepare("SELECT * FROM feedback_comments ORDER BY id").all(),
      audits: db.prepare("SELECT * FROM audit_logs ORDER BY id").all(),
      events: db.prepare("SELECT * FROM feedback_events ORDER BY id").all(),
      reads: db.prepare("SELECT * FROM feedback_reporter_ticket_reads ORDER BY ticket_id").all(),
    }).toEqual(snapshot);
    expect(db.prepare(
      "SELECT COUNT(*) AS count FROM feedback_tickets WHERE material_sequence IS NULL",
    ).get()).toEqual({ count: 0 });

    // Production old writers do not send material_sequence. The new schema's
    // AFTER triggers must normalize and allocate before commit.
    ticket(db, "old-worker-ticket", "app-a", 2, intg);
    staffComment(db, "old-worker-comment", "old-worker-ticket", 0);
    expect(material(db, "old-worker-ticket")).toBe(highWater(db, "app-a"));
  });

  it("advances once for each current material writer and not for no-ops or processing", () => {
    const db = database();
    app(db, "app-a");
    const intg = integration(db, "app-a");
    ticket(db, "ticket", "app-a", 1, intg);
    expect([material(db, "ticket"), highWater(db, "app-a")]).toEqual([1, 1]);

    db.prepare(
      "UPDATE feedback_tickets SET status='in_progress', assignee='owner' WHERE id='ticket'",
    ).run();
    expect([material(db, "ticket"), highWater(db, "app-a")]).toEqual([2, 2]);

    db.prepare(
      "UPDATE feedback_tickets SET status='in_progress', assignee='owner' WHERE id='ticket'",
    ).run();
    db.prepare(
      "UPDATE feedback_tickets SET symbolication_status='pending', updated_at=2 WHERE id='ticket'",
    ).run();
    expect([material(db, "ticket"), highWater(db, "app-a")]).toEqual([2, 2]);

    staffComment(db, "external", "ticket", 0);
    expect([material(db, "ticket"), reporterSequence(db, "external")]).toEqual([3, 1]);
    staffComment(db, "internal", "ticket", 1);
    expect([material(db, "ticket"), reporterSequence(db, "internal")]).toEqual([4, null]);
    reporterComment(db, "reporter", "ticket", intg);
    expect([material(db, "ticket"), reporterSequence(db, "reporter")]).toEqual([5, 2]);
    expect(highWater(db, "app-a")).toBe(5);
  });

  it("rolls back allocation with a failed transaction and sequences two writes in one batch", () => {
    const db = database();
    app(db, "app-a");
    ticket(db, "ticket", "app-a", 1);
    const before = highWater(db, "app-a");

    const fail = db.transaction(() => {
      staffComment(db, "rolled-back", "ticket", 0);
      db.prepare("INSERT INTO feedback_comments (id) VALUES ('invalid')").run();
    });
    expect(fail).toThrow();
    expect(highWater(db, "app-a")).toBe(before);
    expect(db.prepare("SELECT id FROM feedback_comments WHERE id='rolled-back'").get()).toBeUndefined();

    db.transaction(() => {
      staffComment(db, "one", "ticket", 0);
      staffComment(db, "two", "ticket", 0);
    })();
    expect([material(db, "ticket"), highWater(db, "app-a")]).toEqual([before + 2, before + 2]);
  });

  it("rejects allocator drift, direct ticket sequence writes, app moves, and exhaustion", () => {
    const db = database();
    app(db, "app-a");
    ticket(db, "one", "app-a", 1);
    ticket(db, "two", "app-a", 2);

    expect(() => db.prepare(
      "UPDATE feedback_material_sequence_state SET high_water=high_water+2 WHERE app_id='app-a'",
    ).run()).toThrow(/must advance by one/);
    expect(() => db.prepare(
      "UPDATE feedback_tickets SET material_sequence=1 WHERE id='two'",
    ).run()).toThrow(/managed/);
    expect(() => db.prepare(
      "UPDATE feedback_tickets SET app_id='other' WHERE id='one'",
    ).run()).toThrow(/app is immutable/);

    const monotonicSql = (db.prepare(
      "SELECT sql FROM sqlite_master WHERE type='trigger' AND name='feedback_material_state_monotonic'",
    ).get() as { sql: string }).sql;
    db.exec("DROP TRIGGER feedback_material_state_monotonic");
    db.prepare(
      "UPDATE feedback_material_sequence_state SET high_water=9007199254740991 WHERE app_id='app-a'",
    ).run();
    db.exec(monotonicSql);
    expect(() => staffComment(db, "overflow", "one", 0)).toThrow(/CHECK constraint failed/);
    expect(db.prepare("SELECT id FROM feedback_comments WHERE id='overflow'").get()).toBeUndefined();
  });

  it("blocks ticket and integration deletion but preserves full app purge", () => {
    const db = database();
    app(db, "app-a");
    const intg = integration(db, "app-a");
    ticket(db, "ticket", "app-a", 1, intg);
    staffComment(db, "visible", "ticket", 0);
    staffComment(db, "internal", "ticket", 1);
    expect([reporterSequence(db, "visible"), reporterSequence(db, "internal")])
      .toEqual([1, null]);

    expect(() => db.prepare("DELETE FROM feedback_tickets WHERE id='ticket'").run())
      .toThrow(/requires app purge or tombstone/);
    expect(() => db.prepare("DELETE FROM app_reporter_integrations WHERE id=?").run(intg))
      .toThrow(/requires app purge or tombstone/);
    expect(db.prepare("SELECT id FROM app_reporter_integrations WHERE id=?").get(intg)).toBeDefined();
    expect(db.prepare("SELECT id FROM feedback_tickets WHERE id='ticket'").get()).toBeDefined();

    db.prepare("DELETE FROM apps WHERE id='app-a'").run();
    expect(db.prepare("SELECT id FROM feedback_tickets WHERE id='ticket'").get()).toBeUndefined();
    expect(db.prepare("SELECT id FROM feedback_comments WHERE ticket_id='ticket'").all()).toEqual([]);
    expect(db.prepare("SELECT id FROM app_reporter_integrations WHERE id=?").get(intg)).toBeUndefined();
    expect(db.prepare(
      "SELECT app_id FROM feedback_material_sequence_state WHERE app_id='app-a'",
    ).get()).toBeUndefined();
  });

  it("uses the exact app-first index for the delta query", () => {
    const db = database(false);
    app(db, "app-a");
    db.exec(
      `WITH RECURSIVE fixture(n) AS (
         VALUES(1) UNION ALL SELECT n + 1 FROM fixture WHERE n < 100000
       )
       INSERT INTO feedback_tickets
       (id, app_id, kind, status, message, metadata_json, created_at, updated_at)
       SELECT printf('ticket-%06d', n), 'app-a', 'feedback', 'open', 'message', '{}', n, n
       FROM fixture`,
    );
    migrate(db);
    const plan = (withApp = true) => db.prepare(
      withApp
        ? `EXPLAIN QUERY PLAN SELECT id, material_sequence
           FROM feedback_tickets
           WHERE app_id = ? AND material_sequence > ?
           ORDER BY material_sequence ASC LIMIT ?`
        : `EXPLAIN QUERY PLAN SELECT id, material_sequence
           FROM feedback_tickets
           WHERE material_sequence > ?
           ORDER BY material_sequence ASC LIMIT ?`,
    ).all(...(withApp ? ["app-a", 0, 101] : [0, 101]))
      .map((row) => String((row as { detail: string }).detail));
    const usesExactAppFirstPlan = (details: string[]) =>
      details.some((detail) =>
        detail.includes("idx_feedback_tickets_app_material_sequence")
        && /\(app_id=\? AND material_sequence>\?\)/.test(detail)
      )
      && details.every((detail) => !/USE TEMP B-TREE FOR ORDER BY/.test(detail));

    expect(usesExactAppFirstPlan(plan())).toBe(true);

    db.exec("DROP INDEX idx_feedback_tickets_app_material_sequence");
    expect(usesExactAppFirstPlan(plan())).toBe(false);

    db.exec(
      `CREATE UNIQUE INDEX idx_feedback_tickets_app_material_sequence
       ON feedback_tickets(material_sequence, app_id)`,
    );
    expect(usesExactAppFirstPlan(plan())).toBe(false);

    db.exec("DROP INDEX idx_feedback_tickets_app_material_sequence");
    db.exec(
      `CREATE UNIQUE INDEX idx_feedback_tickets_app_material_sequence
       ON feedback_tickets(material_sequence)`,
    );
    expect(usesExactAppFirstPlan(plan())).toBe(false);

    db.exec("DROP INDEX idx_feedback_tickets_app_material_sequence");
    db.exec(
      `CREATE UNIQUE INDEX idx_feedback_tickets_app_material_sequence
       ON feedback_tickets(app_id, material_sequence)`,
    );
    expect(usesExactAppFirstPlan(plan(false))).toBe(false);
    expect(usesExactAppFirstPlan(plan())).toBe(true);
  });

  it("ships a reusable validator that rejects every locally provable restore corruption", () => {
    const valid = database();
    app(valid, "app-a");
    app(valid, "empty");
    ticket(valid, "one", "app-a", 1);
    valid.prepare(
      "INSERT INTO feedback_material_sequence_state (app_id, high_water) VALUES ('empty', 0)",
    ).run();
    expect(validationErrors(valid)).toEqual([]);

    const corrupted = (mutate: (db: Database.Database) => void) => {
      const db = database();
      app(db, "app-a");
      ticket(db, "one", "app-a", 1);
      mutate(db);
      return validationErrors(db).map((row) => row.violation);
    };

    expect(corrupted((db) => {
      db.exec("DROP TRIGGER feedback_material_state_no_delete");
      db.prepare("DELETE FROM feedback_material_sequence_state WHERE app_id='app-a'").run();
    })).toContain("missing_state");
    expect(corrupted((db) => {
      db.exec("DROP TRIGGER feedback_tickets_material_managed_update");
      db.prepare("UPDATE feedback_tickets SET material_sequence=NULL WHERE id='one'").run();
    })).toContain("null_ticket_sequence");
    expect(corrupted((db) => {
      db.exec("DROP TRIGGER feedback_tickets_material_managed_update");
      db.prepare("UPDATE feedback_tickets SET material_sequence=0 WHERE id='one'").run();
    })).toContain("nonpositive_ticket_sequence");
    expect(corrupted((db) => {
      db.exec("DROP TRIGGER feedback_tickets_material_managed_update");
      db.prepare("UPDATE feedback_tickets SET material_sequence=9007199254740992 WHERE id='one'").run();
    })).toContain("unsafe_ticket_sequence");
    expect(corrupted((db) => {
      db.exec("DROP TRIGGER feedback_tickets_material_managed_update");
      db.prepare("UPDATE feedback_tickets SET material_sequence=1.5 WHERE id='one'").run();
    })).toContain("noninteger_ticket_sequence");
    expect(corrupted((db) => {
      ticket(db, "two", "app-a", 2);
      db.exec("DROP TRIGGER feedback_tickets_material_managed_update");
      db.exec("DROP INDEX idx_feedback_tickets_app_material_sequence");
      db.prepare("UPDATE feedback_tickets SET material_sequence=1 WHERE id='two'").run();
    })).toContain("duplicate_ticket_sequence");
    expect(corrupted((db) => {
      db.exec("DROP TRIGGER feedback_tickets_material_managed_update");
      db.prepare("UPDATE feedback_tickets SET material_sequence=2 WHERE id='one'").run();
    })).toContain("ticket_ahead_of_high_water");
    expect(corrupted((db) => {
      db.exec("DROP TRIGGER feedback_material_state_monotonic");
      db.prepare("UPDATE feedback_material_sequence_state SET high_water=2 WHERE app_id='app-a'").run();
    })).toContain("max_high_water_mismatch");
    expect(corrupted((db) => {
      db.pragma("ignore_check_constraints = ON");
      db.exec("DROP TRIGGER feedback_material_state_monotonic");
      db.prepare(
        "UPDATE feedback_material_sequence_state SET high_water=9007199254740992 WHERE app_id='app-a'",
      ).run();
    })).toContain("unsafe_high_water");
    expect(corrupted((db) => {
      db.exec("DROP TRIGGER feedback_material_state_monotonic");
      db.prepare(
        "UPDATE feedback_material_sequence_state SET high_water=1.5 WHERE app_id='app-a'",
      ).run();
    })).toContain("noninteger_high_water");
  });

  it("reports the exact 0059 full-schema write opcode delta and carrier comparison", () => {
    const ticketInsert =
      `INSERT INTO feedback_tickets
       (id, app_id, kind, status, message, metadata_json, created_at, updated_at)
       VALUES ('ticket', 'app-a', 'feedback', 'open', 'message', '{}', 1, 1)`;
    const ticketUpdate =
      `UPDATE feedback_tickets
       SET status='resolved', assignee='owner', updated_at=2 WHERE id='ticket'`;
    const commentInsert =
      `INSERT INTO feedback_comments
       (id, ticket_id, author_actor, author_type, body, internal, created_at)
       VALUES ('comment', 'ticket', 'staff:test', 'staff', 'message', 0, 2)`;
    const baseline = database(false);
    const ticketCarrier = database();
    const appendCarrier = database(false);
    appendCarrier.exec(
      `CREATE TABLE synthetic_material_state (
         app_id TEXT PRIMARY KEY,
         high_water INTEGER NOT NULL
       );
       CREATE TABLE synthetic_material_changes (
         app_id TEXT NOT NULL,
         sequence INTEGER NOT NULL,
         ticket_id TEXT NOT NULL,
         PRIMARY KEY (app_id, sequence)
       );
       CREATE TRIGGER synthetic_feedback_comment_material_insert
       AFTER INSERT ON feedback_comments
       BEGIN
         INSERT OR IGNORE INTO synthetic_material_state
         VALUES ((SELECT app_id FROM feedback_tickets WHERE id=NEW.ticket_id), 0);
         UPDATE synthetic_material_state SET high_water=high_water+1
         WHERE app_id=(SELECT app_id FROM feedback_tickets WHERE id=NEW.ticket_id);
         INSERT INTO synthetic_material_changes
         SELECT t.app_id, s.high_water, t.id
         FROM feedback_tickets t
         JOIN synthetic_material_state s ON s.app_id=t.app_id
         WHERE t.id=NEW.ticket_id;
       END;`,
    );

    expect({
      ticket_insert: writeOpcodeCounts(baseline, ticketInsert),
      status_assignee: writeOpcodeCounts(baseline, ticketUpdate),
      comment_insert: writeOpcodeCounts(baseline, commentInsert),
    }).toEqual({
      ticket_insert: { Insert: 1, Delete: 0, IdxInsert: 14, IdxDelete: 0, Program: 1 },
      status_assignee: { Insert: 1, Delete: 0, IdxInsert: 5, IdxDelete: 1, Program: 0 },
      comment_insert: { Insert: 2, Delete: 0, IdxInsert: 11, IdxDelete: 2, Program: 4 },
    });
    expect({
      ticket_insert: writeOpcodeCounts(ticketCarrier, ticketInsert),
      status_assignee: writeOpcodeCounts(ticketCarrier, ticketUpdate),
      comment_insert: writeOpcodeCounts(ticketCarrier, commentInsert),
    }).toEqual({
      ticket_insert: { Insert: 4, Delete: 0, IdxInsert: 17, IdxDelete: 1, Program: 6 },
      status_assignee: { Insert: 3, Delete: 0, IdxInsert: 6, IdxDelete: 2, Program: 3 },
      comment_insert: { Insert: 4, Delete: 0, IdxInsert: 12, IdxDelete: 3, Program: 7 },
    });
    expect(writeOpcodeCounts(appendCarrier, commentInsert)).toEqual({
      Insert: 5,
      Delete: 0,
      IdxInsert: 13,
      IdxDelete: 2,
      Program: 5,
    });
  });
});
