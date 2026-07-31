/**
 * Migration 0059 stops the reporter comment sequence from leaking activity:
 * from here on only reporter-visible comments consume a number, and each app
 * numbers independently.
 *
 * It deliberately does NOT renumber existing rows. The tests below pin that
 * choice, because rewriting history breaks two things that are easy to miss:
 * in-flight pagination cursors — the deploy applies migrations before the new
 * Worker is live, so an old Worker would compare a large pre-renumber cursor
 * against small new values and silently return nothing — and read receipts,
 * whose `read_through_comment_id` is not constrained to their own ticket.
 */

import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

const MIGRATION_DIR = fileURLToPath(new URL("../../migrations/sql/", import.meta.url));
const MIGRATION = "0059_reporter_sequence_per_app.sql";

function applyMigrations(db: Database.Database) {
  for (const name of readdirSync(MIGRATION_DIR).sort()) {
    if (!name.endsWith(".sql")) continue;
    if (name === MIGRATION) continue;
    db.exec(readFileSync(`${MIGRATION_DIR}${name}`, "utf8"));
  }
}

const migrate = (db: Database.Database) =>
  db.exec(readFileSync(`${MIGRATION_DIR}${MIGRATION}`, "utf8"));

const insertComment = (db: Database.Database, id: string, ticket: string, internal: 0 | 1, at: number) =>
  db.prepare(
    `INSERT INTO feedback_comments (id, ticket_id, author_actor, author_type, body, internal, created_at)
     VALUES (?,?,'staff:t','staff','body',?,?)`,
  ).run(id, ticket, internal, at);

/** Two apps with interleaved comments, so the old global numbering is visible. */
function seeded(includeMigration: boolean) {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  applyMigrations(db);

  for (const app of ["app-a", "app-b"]) {
    db.prepare("INSERT INTO apps (id, slug, name, platform, created_at) VALUES (?,?,?,'android',1)")
      .run(app, app, app);
    db.prepare(
      "INSERT INTO app_reporter_integrations (id, app_id, name, created_at, updated_at) VALUES (?,?,'inbox',1,1)",
    ).run(`intg-${app}`, app);
    db.prepare(
      `INSERT INTO feedback_tickets (id, app_id, kind, status, message, metadata_json,
         reporter_id, reporter_integration_id, created_at, updated_at)
       VALUES (?,?,'feedback','open','m','{}','rep',?,1,1)`,
    ).run(`ticket-${app}`, app, `intg-${app}`);
  }

  insertComment(db, "c1", "ticket-app-a", 0, 10);
  insertComment(db, "c2", "ticket-app-b", 0, 11);
  insertComment(db, "c3", "ticket-app-a", 1, 12); // internal
  insertComment(db, "c4", "ticket-app-a", 0, 13);

  if (includeMigration) migrate(db);
  return db;
}

const sequences = (db: Database.Database) =>
  Object.fromEntries(
    db.prepare("SELECT id, reporter_sequence FROM feedback_comments ORDER BY id")
      .all()
      .map((r) => [(r as { id: string }).id, (r as { reporter_sequence: number | null }).reporter_sequence]),
  );

const highWater = (db: Database.Database, app: string) =>
  (db.prepare("SELECT high_water AS h FROM feedback_comment_app_sequence_state WHERE app_id = ?")
    .get(app) as { h: number } | undefined)?.h;

describe("migration 0059 — per-app reporter comment sequence", () => {
  it("leaves every existing number exactly as it was", () => {
    // Renumbering would invalidate cursors clients already hold and would force
    // read receipts to be rewritten. Neither is necessary: nothing compares
    // this column across tickets.
    const before = sequences(seeded(false));
    expect(before).toEqual({ c1: 1, c2: 2, c3: 3, c4: 4 });
    expect(sequences(seeded(true))).toEqual(before);
  });

  it("does not advance the app high-water for an internal comment", () => {
    const db = seeded(true);
    const before = highWater(db, "app-a");
    insertComment(db, "c5", "ticket-app-a", 1, 20);
    expect(highWater(db, "app-a")).toBe(before);
    expect(sequences(db).c5).toBeNull();
  });

  it("numbers a new reporter-visible comment above that app's own maximum", () => {
    const db = seeded(true);
    // app-a's highest existing value is 4, inherited from the old global
    // counter, so the next number must clear it rather than collide.
    insertComment(db, "c5", "ticket-app-a", 0, 20);
    expect(sequences(db).c5).toBe(5);
  });

  it("numbers each app independently from then on", () => {
    const db = seeded(true);
    // app-b's own maximum is 2, so its next value is 3 — unrelated to app-a.
    // That independence is what stops one app's counter reporting another's
    // activity.
    insertComment(db, "b2", "ticket-app-b", 0, 21);
    expect(sequences(db).b2).toBe(3);
    insertComment(db, "a5", "ticket-app-a", 0, 22);
    expect(sequences(db).a5).toBe(5);
  });

  it("keeps an existing read receipt meaningful without touching it", () => {
    const db = seeded(false);
    db.prepare(
      `INSERT INTO feedback_reporter_ticket_reads
         (app_id, reporter_integration_id, reporter_id, ticket_id,
          read_through_sequence, read_through_comment_id, updated_at)
       VALUES ('app-a','intg-app-a','rep','ticket-app-a',1,'c1',1)`,
    ).run();
    const unread = () =>
      db.prepare(
        `SELECT fc.id FROM feedback_comments fc
         JOIN feedback_reporter_ticket_reads r ON r.ticket_id = fc.ticket_id
         WHERE fc.ticket_id = 'ticket-app-a' AND fc.internal = 0
           AND fc.reporter_sequence > r.read_through_sequence
         ORDER BY fc.reporter_sequence`,
      ).all().map((r) => (r as { id: string }).id);

    const before = unread();
    migrate(db);
    expect(unread()).toEqual(before);
    expect(unread()).toEqual(["c4"]);
    // The receipt row itself is never rewritten.
    expect(db.prepare("SELECT read_through_sequence AS s FROM feedback_reporter_ticket_reads").get())
      .toEqual({ s: 1 });
  });

  it("keeps a pagination cursor issued before the migration valid", () => {
    const db = seeded(false);
    const cursor = (db.prepare("SELECT reporter_sequence AS s FROM feedback_comments WHERE id='c1'")
      .get() as { s: number }).s;
    const page = () =>
      db.prepare(
        `SELECT id FROM feedback_comments
         WHERE ticket_id='ticket-app-a' AND internal=0 AND reporter_sequence > ?
         ORDER BY reporter_sequence`,
      ).all(cursor).map((r) => (r as { id: string }).id);

    const before = page();
    migrate(db);
    // Renumbering would have left this cursor above every new value, so the
    // reporter would have seen no further comments at all.
    expect(page()).toEqual(before);
    expect(page()).toEqual(["c4"]);
  });

  it("still allows an app to be deleted", () => {
    const db = seeded(true);
    expect(() => db.prepare("DELETE FROM apps WHERE id='app-b'").run()).not.toThrow();
    expect(highWater(db, "app-b")).toBeUndefined();
  });
});
