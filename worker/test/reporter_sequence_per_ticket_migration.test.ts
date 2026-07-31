/**
 * Migration 0059 scopes the reporter comment sequence to a single ticket.
 *
 * The property under test is not "numbers are smaller" — it is that a reporter
 * cannot infer anything from the numbers they receive. A reporter sees the
 * non-internal comments of their own ticket, so any number consumed by anything
 * else (an internal note, another reporter's ticket, another app) shows up as a
 * gap and tells them an invisible event happened.
 *
 * Existing values are deliberately left alone; renumbering would invalidate
 * in-flight cursors, since the deploy applies migrations before the new Worker
 * is live.
 */

import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

const MIGRATION_DIR = fileURLToPath(new URL("../../migrations/sql/", import.meta.url));
const MIGRATION = "0059_reporter_sequence_per_ticket.sql";

function applyMigrations(db: Database.Database, includeMigration: boolean) {
  for (const name of readdirSync(MIGRATION_DIR).sort()) {
    if (!name.endsWith(".sql")) continue;
    if (name === MIGRATION && !includeMigration) continue;
    db.exec(readFileSync(`${MIGRATION_DIR}${name}`, "utf8"));
  }
}

const migrate = (db: Database.Database) =>
  db.exec(readFileSync(`${MIGRATION_DIR}${MIGRATION}`, "utf8"));

const comment = (db: Database.Database, id: string, ticket: string, internal: 0 | 1 = 0) =>
  db.prepare(
    `INSERT INTO feedback_comments (id, ticket_id, author_actor, author_type, body, internal, created_at)
     VALUES (?,?,'staff:t','staff','body',?,1)`,
  ).run(id, ticket, internal);

const seq = (db: Database.Database, id: string) =>
  (db.prepare("SELECT reporter_sequence AS s FROM feedback_comments WHERE id = ?")
    .get(id) as { s: number | null }).s;

/**
 * One app, two reporters with a ticket each, plus a second app — the shapes
 * that the earlier global and per-app scopes leaked across.
 */
function base(includeMigration: boolean) {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  applyMigrations(db, includeMigration);

  for (const app of ["app-a", "app-b"]) {
    db.prepare("INSERT INTO apps (id, slug, name, platform, created_at) VALUES (?,?,?,'android',1)")
      .run(app, app, app);
    db.prepare(
      "INSERT INTO app_reporter_integrations (id, app_id, name, created_at, updated_at) VALUES (?,?,'inbox',1,1)",
    ).run(`intg-${app}`, app);
  }
  const ticket = (id: string, app: string, reporter: string) =>
    db.prepare(
      `INSERT INTO feedback_tickets (id, app_id, kind, status, message, metadata_json,
         reporter_id, reporter_integration_id, created_at, updated_at)
       VALUES (?,?,'feedback','open','m','{}',?,?,1,1)`,
    ).run(id, app, reporter, `intg-${app}`);

  ticket("alice", "app-a", "alice");
  ticket("bob", "app-a", "bob");     // same app, different reporter
  ticket("carol", "app-b", "carol"); // different app
  return db;
}

describe("migration 0059 — per-ticket reporter comment sequence", () => {
  it("leaves a reporter no gap to interpret, whatever else happens", () => {
    const db = base(true);
    comment(db, "a1", "alice");
    comment(db, "b1", "bob");     // another reporter, same app — invisible to Alice
    comment(db, "c1", "carol");   // another app entirely
    comment(db, "a-int", "alice", 1); // internal note on Alice's own ticket
    comment(db, "a2", "alice");

    // Alice's two visible comments are consecutive. Every kind of event she
    // cannot see happened in between, and none of them consumed a number.
    expect(seq(db, "a1")).toBe(1);
    expect(seq(db, "a2")).toBe(2);
    expect(seq(db, "a-int")).toBeNull();
  });

  it("does not leak another reporter in the same app (the per-app scope did)", () => {
    const db = base(true);
    comment(db, "a1", "alice");
    comment(db, "b1", "bob");
    comment(db, "a2", "alice");
    // Under per-app numbering Alice saw 1 then 3 and could infer Bob's comment.
    expect(seq(db, "a2") - seq(db, "a1")).toBe(1);
  });

  it("numbers each ticket independently", () => {
    const db = base(true);
    comment(db, "a1", "alice");
    comment(db, "b1", "bob");
    comment(db, "c1", "carol");
    // The same value in three tickets: impossible under a global counter.
    expect([seq(db, "a1"), seq(db, "b1"), seq(db, "c1")]).toEqual([1, 1, 1]);
  });

  it("leaves existing numbers untouched and continues above each ticket's own maximum", () => {
    const db = base(false);
    comment(db, "a1", "alice");
    comment(db, "b1", "bob");
    comment(db, "a2", "alice");
    const before = [seq(db, "a1"), seq(db, "b1"), seq(db, "a2")];
    expect(before).toEqual([1, 2, 3]); // old global numbering

    migrate(db);
    expect([seq(db, "a1"), seq(db, "b1"), seq(db, "a2")]).toEqual(before);

    // Alice's ticket continues above its own max (3), not from 1.
    comment(db, "a3", "alice");
    expect(seq(db, "a3")).toBe(4);
    // Bob's ticket continues above ITS own max (2).
    comment(db, "b2", "bob");
    expect(seq(db, "b2")).toBe(3);
  });

  it("keeps a pagination cursor issued before the migration valid", () => {
    const db = base(false);
    comment(db, "a1", "alice");
    comment(db, "a2", "alice");
    const cursor = seq(db, "a1") as number;
    const page = () =>
      db.prepare(
        `SELECT id FROM feedback_comments
         WHERE ticket_id='alice' AND internal=0 AND reporter_sequence > ?
         ORDER BY reporter_sequence`,
      ).all(cursor).map((r) => (r as { id: string }).id);

    const before = page();
    migrate(db);
    expect(page()).toEqual(before);
    expect(page()).toEqual(["a2"]);
  });

  it("keeps an existing read receipt selecting the same unread set", () => {
    const db = base(false);
    comment(db, "a1", "alice");
    comment(db, "a2", "alice");
    db.prepare(
      `INSERT INTO feedback_reporter_ticket_reads
         (app_id, reporter_integration_id, reporter_id, ticket_id,
          read_through_sequence, read_through_comment_id, updated_at)
       VALUES ('app-a','intg-app-a','alice','alice',?, 'a1', 1)`,
    ).run(seq(db, "a1"));
    const unread = () =>
      db.prepare(
        `SELECT fc.id FROM feedback_comments fc
         JOIN feedback_reporter_ticket_reads r ON r.ticket_id = fc.ticket_id
         WHERE fc.ticket_id='alice' AND fc.internal=0
           AND fc.reporter_sequence > r.read_through_sequence`,
      ).all().map((r) => (r as { id: string }).id);

    const before = unread();
    migrate(db);
    expect(unread()).toEqual(before);
    expect(unread()).toEqual(["a2"]);
  });

  it("rejects a duplicate within one ticket but allows it across tickets", () => {
    const db = base(true);
    comment(db, "a1", "alice");
    comment(db, "b1", "bob");
    expect(seq(db, "a1")).toBe(seq(db, "b1"));
    expect(() =>
      db.prepare("UPDATE feedback_comments SET reporter_sequence = 1 WHERE id = 'a1'").run(),
    ).toThrow();
  });
});
