import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const migration = fileURLToPath(
  new URL("../../migrations/sql/0065_feedback_closure_reason.sql", import.meta.url),
);
const databases: string[] = [];

function sql(db: string, statement: string): string {
  return execFileSync("/usr/bin/sqlite3", [db, `PRAGMA foreign_keys=ON; ${statement}`], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function database(): string {
  const db = `/tmp/hands-feedback-closure-${crypto.randomUUID()}.sqlite`;
  databases.push(db);
  sql(db, `
    PRAGMA foreign_keys=ON;
    CREATE TABLE apps (id TEXT PRIMARY KEY);
    CREATE TABLE feedback_tickets (
      id TEXT PRIMARY KEY,
      app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
      status TEXT NOT NULL
    );
    INSERT INTO apps VALUES ('app-a'), ('app-b');
    INSERT INTO feedback_tickets (id, app_id, status)
    VALUES ('legacy-closed', 'app-a', 'closed');
  `);
  execFileSync("/usr/bin/sqlite3", [db], {
    input: readFileSync(migration),
    stdio: ["pipe", "pipe", "pipe"],
  });
  sql(db, `
    INSERT INTO feedback_tickets (id, app_id, status) VALUES
      ('ticket-a', 'app-a', 'open'),
      ('ticket-b', 'app-a', 'open'),
      ('ticket-other-app', 'app-b', 'open');
  `);
  return db;
}

afterEach(() => {
  for (const db of databases.splice(0)) {
    try {
      execFileSync("/bin/rm", [db]);
    } catch {
      // Best-effort test cleanup only.
    }
  }
});

describe("migration 0063 — feedback closure reason", () => {
  it("requires a reason and keeps duplicate links app-scoped", () => {
    const db = database();
    expect(() => sql(db,
      "UPDATE feedback_tickets SET status='closed' WHERE id='ticket-a';",
    )).toThrow(/invalid feedback closure reason/);
    sql(db,
      "UPDATE feedback_tickets SET status='closed', closure_reason='completed' WHERE id='ticket-a';",
    );
    expect(sql(db,
      "SELECT status || '|' || closure_reason FROM feedback_tickets WHERE id='ticket-a';",
    )).toBe("closed|completed");

    // Legacy closed rows existed before 0063. The migration preserves them;
    // new transitions into closed must carry a reason.
    sql(db,
      "UPDATE feedback_tickets SET status='closed' WHERE id='legacy-closed';",
    );

    expect(() => sql(db, `
      UPDATE feedback_tickets
      SET status='closed', closure_reason='duplicate',
          duplicate_of_ticket_id='ticket-other-app'
      WHERE id='ticket-b';
    `)).toThrow(/invalid feedback closure reason/);
    sql(db, `
      UPDATE feedback_tickets
      SET status='closed', closure_reason='duplicate', duplicate_of_ticket_id='ticket-a'
      WHERE id='ticket-b';
    `);
    expect(sql(db, `
      SELECT closure_reason || '|' || duplicate_of_ticket_id
      FROM feedback_tickets WHERE id='ticket-b';
    `)).toBe("duplicate|ticket-a");
    expect(() => sql(db,
      "DELETE FROM feedback_tickets WHERE id='ticket-a';",
    )).toThrow(/FOREIGN KEY constraint failed/);

    sql(db, `
      UPDATE feedback_tickets
      SET status='in_progress', closure_reason=NULL, duplicate_of_ticket_id=NULL
      WHERE id='ticket-b';
    `);
    expect(sql(db, `
      SELECT status || '|' || COALESCE(closure_reason, 'null') || '|'
        || COALESCE(duplicate_of_ticket_id, 'null')
      FROM feedback_tickets WHERE id='ticket-b';
    `)).toBe("in_progress|null|null");
  });
});
