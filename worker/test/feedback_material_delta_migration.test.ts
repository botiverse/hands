import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

const MIGRATION_DIR = fileURLToPath(new URL("../../migrations/sql/", import.meta.url));
const MIGRATION = "0060_feedback_material_delta.sql";

function applyMigrations(db: Database.Database, includeMaterial = true) {
  for (const name of readdirSync(MIGRATION_DIR).sort()) {
    if (!name.endsWith(".sql")) continue;
    if (name === MIGRATION && !includeMaterial) continue;
    db.exec(readFileSync(`${MIGRATION_DIR}${name}`, "utf8"));
  }
}

const migrate = (db: Database.Database) =>
  db.exec(readFileSync(`${MIGRATION_DIR}${MIGRATION}`, "utf8"));

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

describe("migration 0060 — feedback material delta", () => {
  it("backfills a deterministic per-app domain without changing reporter state", () => {
    const db = database(false);
    app(db, "app-a");
    app(db, "app-b");
    const intg = integration(db, "app-a");
    ticket(db, "a-z", "app-a", 1, intg);
    ticket(db, "a-a", "app-a", 1, intg);
    ticket(db, "b-a", "app-b", 1);
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

    expect(() => db.prepare("DELETE FROM feedback_tickets WHERE id='ticket'").run())
      .toThrow(/requires app purge or tombstone/);
    expect(() => db.prepare("DELETE FROM app_reporter_integrations WHERE id=?").run(intg))
      .toThrow(/requires app purge or tombstone/);
    expect(db.prepare("SELECT id FROM app_reporter_integrations WHERE id=?").get(intg)).toBeDefined();
    expect(db.prepare("SELECT id FROM feedback_tickets WHERE id='ticket'").get()).toBeDefined();

    db.prepare("DELETE FROM apps WHERE id='app-a'").run();
    expect(db.prepare("SELECT id FROM feedback_tickets WHERE id='ticket'").get()).toBeUndefined();
    expect(db.prepare("SELECT id FROM app_reporter_integrations WHERE id=?").get(intg)).toBeUndefined();
    expect(db.prepare(
      "SELECT app_id FROM feedback_material_sequence_state WHERE app_id='app-a'",
    ).get()).toBeUndefined();
  });

  it("uses the exact app-first index for the delta query", () => {
    const db = database();
    const plan = db.prepare(
      `EXPLAIN QUERY PLAN SELECT id, material_sequence
       FROM feedback_tickets
       WHERE app_id = ? AND material_sequence > ?
       ORDER BY material_sequence ASC LIMIT ?`,
    ).all("app-a", 0, 101).map((row) => String((row as { detail: string }).detail));

    expect(plan.some((detail) => detail.includes("idx_feedback_tickets_app_material_sequence")))
      .toBe(true);
    expect(plan.some((detail) => /SCAN feedback_tickets\b/.test(detail))).toBe(false);
  });
});
