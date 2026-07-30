/**
 * Migration 0059 stops the reporter comment sequence from leaking activity:
 * internal comments no longer consume a number, and numbering restarts per app.
 *
 * The migration also renumbers existing rows, so the assertions that matter are
 * the ones about what survives it — read receipts must keep meaning exactly what
 * they meant, or every reporter's unread count silently changes.
 */

import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

const MIGRATION_DIR = fileURLToPath(new URL("../../migrations/sql/", import.meta.url));
const MIGRATION = "0059_reporter_sequence_per_app.sql";

function applyMigrations(db: Database.Database, includeMigration: boolean) {
  for (const name of readdirSync(MIGRATION_DIR).sort()) {
    if (!name.endsWith(".sql")) continue;
    if (name === MIGRATION && !includeMigration) continue;
    db.exec(readFileSync(`${MIGRATION_DIR}${name}`, "utf8"));
  }
}

/** Two apps, one ticket each, comments interleaved so global numbering shows. */
function seeded(includeMigration: boolean) {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  applyMigrations(db, false);

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

  const insert = db.prepare(
    `INSERT INTO feedback_comments (id, ticket_id, author_actor, author_type, body, internal, created_at)
     VALUES (?,?,'staff:t','staff','body',?,?)`,
  );
  insert.run("c1", "ticket-app-a", 0, 10);
  insert.run("c2", "ticket-app-b", 0, 11);
  insert.run("c3", "ticket-app-a", 1, 12); // internal
  insert.run("c4", "ticket-app-a", 0, 13);
  insert.run("c5", "ticket-app-b", 1, 14); // internal
  insert.run("c6", "ticket-app-b", 0, 15);

  if (includeMigration) db.exec(readFileSync(`${MIGRATION_DIR}${MIGRATION}`, "utf8"));
  return db;
}

const sequences = (db: Database.Database) =>
  Object.fromEntries(
    db.prepare("SELECT id, reporter_sequence FROM feedback_comments ORDER BY id")
      .all()
      .map((r) => [(r as { id: string }).id, (r as { reporter_sequence: number | null }).reporter_sequence]),
  );

describe("migration 0059 — per-app reporter comment sequence", () => {
  it("numbered globally and counted internal comments before the migration", () => {
    // The defect, stated as a fact: one counter, advanced by every comment.
    expect(sequences(seeded(false))).toEqual({ c1: 1, c2: 2, c3: 3, c4: 4, c5: 5, c6: 6 });
  });

  it("numbers per app and leaves internal comments unnumbered after it", () => {
    expect(sequences(seeded(true))).toEqual({
      c1: 1, c4: 2, // app-a, internal c3 consumed nothing
      c2: 1, c6: 2, // app-b, numbering independent of app-a
      c3: null, c5: null,
    });
  });

  it("keeps a read receipt pointing at the same comment", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    applyMigrations(db, false);
    const seed = seeded(false);
    // rebuild with a receipt written in the OLD numbering
    const before = seed.prepare("SELECT reporter_sequence AS s FROM feedback_comments WHERE id='c4'")
      .get() as { s: number };
    expect(before.s).toBe(4);

    seed.prepare(
      `INSERT INTO feedback_reporter_ticket_reads
         (app_id, reporter_integration_id, reporter_id, ticket_id,
          read_through_sequence, read_through_comment_id, updated_at)
       VALUES ('app-a','intg-app-a','rep','ticket-app-a',?,'c4',1)`,
    ).run(before.s);
    seed.exec(readFileSync(`${MIGRATION_DIR}${MIGRATION}`, "utf8"));

    const after = seed.prepare(
      "SELECT read_through_sequence AS s, read_through_comment_id AS id FROM feedback_reporter_ticket_reads",
    ).get() as { s: number; id: string };
    // The number changed (4 -> 2) but the meaning did not: still "read through c4".
    expect(after.id).toBe("c4");
    expect(after.s).toBe(2);
    expect(after.s).toBe(
      (seed.prepare("SELECT reporter_sequence AS s FROM feedback_comments WHERE id='c4'").get() as { s: number }).s,
    );
  });

  it("aborts rather than corrupt unread counts when a receipt cannot be resolved", () => {
    const db = seeded(false);
    // c3 is internal, so it loses its number: this receipt cannot be recomputed.
    db.prepare(
      `INSERT INTO feedback_reporter_ticket_reads
         (app_id, reporter_integration_id, reporter_id, ticket_id,
          read_through_sequence, read_through_comment_id, updated_at)
       VALUES ('app-a','intg-app-a','rep','ticket-app-a',3,'c3',1)`,
    ).run();
    expect(() => db.exec(readFileSync(`${MIGRATION_DIR}${MIGRATION}`, "utf8"))).toThrow(/CHECK constraint failed/);
  });

  it("does not advance the app high-water for an internal comment", () => {
    const db = seeded(true);
    const highWater = () =>
      (db.prepare("SELECT high_water AS h FROM feedback_comment_app_sequence_state WHERE app_id='app-a'")
        .get() as { h: number }).h;
    const before = highWater();

    db.prepare(
      `INSERT INTO feedback_comments (id, ticket_id, author_actor, author_type, body, internal, created_at)
       VALUES ('c7','ticket-app-a','staff:t','staff','body',1,20)`,
    ).run();
    expect(highWater()).toBe(before);
    expect(sequences(db).c7).toBeNull();

    db.prepare(
      `INSERT INTO feedback_comments (id, ticket_id, author_actor, author_type, body, internal, created_at)
       VALUES ('c8','ticket-app-a','staff:t','staff','body',0,21)`,
    ).run();
    expect(highWater()).toBe(before + 1);
    expect(sequences(db).c8).toBe(before + 1);
  });

  it("numbers each app independently for new comments", () => {
    const db = seeded(true);
    db.prepare(
      `INSERT INTO feedback_comments (id, ticket_id, author_actor, author_type, body, internal, created_at)
       VALUES ('a3','ticket-app-a','staff:t','staff','body',0,30)`,
    ).run();
    db.prepare(
      `INSERT INTO feedback_comments (id, ticket_id, author_actor, author_type, body, internal, created_at)
       VALUES ('b3','ticket-app-b','staff:t','staff','body',0,31)`,
    ).run();
    const seq = sequences(db);
    // Same number in both apps — impossible under the old global counter.
    expect(seq.a3).toBe(3);
    expect(seq.b3).toBe(3);
  });

  it("still allows an app to be deleted", () => {
    const db = seeded(true);
    expect(() => db.prepare("DELETE FROM apps WHERE id='app-b'").run()).not.toThrow();
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM feedback_comment_app_sequence_state WHERE app_id='app-b'").get(),
    ).toEqual({ n: 0 });
  });

  it("rejects a duplicate sequence within one app but allows it across apps", () => {
    const db = seeded(true);
    // Cross-app duplicates already exist (c1 and c2 are both 1) and are fine.
    expect(sequences(db).c1).toBe(sequences(db).c2);
    // Within one app the unique index must still bite.
    expect(() =>
      db.prepare("UPDATE feedback_comments SET reporter_sequence = 1 WHERE id = 'c4'").run(),
    ).toThrow();
  });
});
