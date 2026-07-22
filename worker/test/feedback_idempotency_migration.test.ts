import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

const migrationPath = fileURLToPath(
  new URL("../../migrations/sql/0050_feedback_idempotency.sql", import.meta.url),
);

describe("feedback idempotency migration", () => {
  it("adds nullable submission fields and enforces one id per app", () => {
    const db = new Database(":memory:");
    db.exec(`
      CREATE TABLE feedback_tickets (
        id TEXT PRIMARY KEY,
        app_id TEXT NOT NULL,
        message TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      INSERT INTO feedback_tickets (id, app_id, message, created_at)
      VALUES ('legacy', 'app-1', 'legacy ticket', 1);
    `);

    db.exec(readFileSync(migrationPath, "utf8"));

    expect(db.prepare(
      "SELECT submission_id, submission_fingerprint, reporter_id FROM feedback_tickets WHERE id = 'legacy'",
    ).get()).toEqual({
      submission_id: null,
      submission_fingerprint: null,
      reporter_id: null,
    });

    const insert = db.prepare(`
      INSERT INTO feedback_tickets
        (id, app_id, message, created_at, submission_id, submission_fingerprint, reporter_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    insert.run("first", "app-1", "first", 2, "submission-1", "fingerprint-1", "reporter-1");
    expect(() => insert.run(
      "duplicate",
      "app-1",
      "duplicate",
      3,
      "submission-1",
      "fingerprint-2",
      "reporter-1",
    )).toThrow();
    expect(() => insert.run(
      "other-app",
      "app-2",
      "other app",
      4,
      "submission-1",
      "fingerprint-3",
      "reporter-2",
    )).not.toThrow();
    expect(() => insert.run("legacy-2", "app-1", "no id", 5, null, null, null)).not.toThrow();

    const indexes = db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'feedback_tickets'",
    ).all() as Array<{ name: string }>;
    expect(indexes.map((index) => index.name)).toContain("idx_feedback_tickets_reporter");
  });
});
