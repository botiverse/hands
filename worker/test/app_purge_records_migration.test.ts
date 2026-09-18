/**
 * Migration 0075 — the app purge audit record.
 *
 * Loads the REAL migration files in order rather than a hand-written schema. The earlier
 * verification of this migration was manual (run by hand, read the output); nothing in CI would
 * have gone red if a constraint regressed, so a state that was rejected during review could
 * silently become legal later. Each row of the table below was verified by hand once; this file
 * is that verification made permanent.
 *
 * The point of the table is coverage, not examples: an earlier revision guarded only the two
 * illegal states that had been demonstrated, leaving three others reachable. So the invariants
 * are stated as "exactly these three states are legal" and every other combination is asserted
 * to fail.
 */

import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

const MIGRATION_DIR = fileURLToPath(new URL("../../migrations/sql/", import.meta.url));
const MIGRATION = "0075_app_purge_records.sql";

function database(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  for (const name of readdirSync(MIGRATION_DIR).sort()) {
    if (!name.endsWith(".sql")) continue;
    db.exec(readFileSync(`${MIGRATION_DIR}${name}`, "utf8"));
  }
  return db;
}

type State = { id: string; status: string; completedAt: number | null; failureClass: string | null };

function insert(db: Database.Database, s: State): boolean {
  try {
    db.prepare(
      `INSERT INTO app_purge_records
         (id, app_id, app_slug, org_id, actor, actor_id, actor_type, status, completed_at, failure_class, started_at)
       VALUES (?, 'a', 's', 'o', 'tester', 'acct', 'human', ?, ?, ?, 1)`,
    ).run(s.id, s.status, s.completedAt, s.failureClass);
    return true;
  } catch {
    return false;
  }
}

describe("migration 0075: app_purge_records state machine", () => {
  it("accepts exactly the three legal states", () => {
    const db = database();
    expect(insert(db, { id: "s1", status: "started", completedAt: null, failureClass: null })).toBe(true);
    expect(insert(db, { id: "s2", status: "completed", completedAt: 5, failureClass: null })).toBe(true);
    expect(insert(db, { id: "s3", status: "failed", completedAt: null, failureClass: "r2_delete_failed" })).toBe(true);
  });

  it("rejects every other combination on INSERT", () => {
    const db = database();
    const illegal: State[] = [
      { id: "b1", status: "started", completedAt: 5, failureClass: null },
      { id: "b2", status: "started", completedAt: null, failureClass: "r2_delete_failed" },
      { id: "b3", status: "completed", completedAt: 5, failureClass: "r2_delete_failed" },
      { id: "b4", status: "completed", completedAt: null, failureClass: null },
      // A zero timestamp is not a completion: it would read as "completed at the epoch".
      { id: "b5", status: "completed", completedAt: 0, failureClass: null },
      { id: "b6", status: "failed", completedAt: 7, failureClass: "r2_delete_failed" },
      { id: "b7", status: "failed", completedAt: null, failureClass: null },
      { id: "b8", status: "weird", completedAt: null, failureClass: null },
    ];
    for (const s of illegal) {
      expect(insert(db, s), `${s.status}/${s.completedAt}/${s.failureClass} should be rejected`).toBe(false);
    }
  });

  it("rejects illegal transitions on UPDATE, and settled rows are final", () => {
    const db = database();
    insert(db, { id: "c1", status: "completed", completedAt: 5, failureClass: null });
    insert(db, { id: "d1", status: "started", completedAt: null, failureClass: null });
    const rejects = (sql: string) => {
      try { db.exec(sql); return false; } catch { return true; }
    };
    expect(rejects("UPDATE app_purge_records SET failure_class='r2_delete_failed' WHERE id='c1'")).toBe(true);
    expect(rejects("UPDATE app_purge_records SET completed_at=NULL WHERE id='c1'")).toBe(true);
    expect(rejects("UPDATE app_purge_records SET completed_at=0 WHERE id='c1'")).toBe(true);
    expect(rejects("UPDATE app_purge_records SET status='failed', failure_class='x' WHERE id='c1'")).toBe(true);
    expect(rejects("UPDATE app_purge_records SET status='started' WHERE id='c1'")).toBe(true);
    // A started row cannot acquire an outcome either.
    expect(rejects("UPDATE app_purge_records SET failure_class='r2_delete_failed' WHERE id='d1'")).toBe(true);
    expect(rejects("UPDATE app_purge_records SET completed_at=5 WHERE id='d1'")).toBe(true);
    // ...while the legal transition still works.
    expect(rejects("UPDATE app_purge_records SET status='completed', completed_at=5 WHERE id='d1'")).toBe(false);
  });

  it("constrains failure_class to the values the code can produce", () => {
    const db = database();
    expect(insert(db, { id: "f1", status: "failed", completedAt: null, failureClass: "r2_delete_failed" })).toBe(true);
    expect(insert(db, { id: "f2", status: "failed", completedAt: null, failureClass: "db_finalize_failed" })).toBe(true);
    expect(insert(db, { id: "f3", status: "failed", completedAt: null, failureClass: "app_delete_unverified" })).toBe(true);
    // Unreachable by construction: the intent write happens before any destructive step, so this
    // case is a request-level outcome, not a state of this row.
    expect(insert(db, { id: "f4", status: "failed", completedAt: null, failureClass: "intent_write_failed" })).toBe(false);
    expect(insert(db, { id: "f5", status: "failed", completedAt: null, failureClass: "anything-else" })).toBe(false);
  });

  it("survives an app delete while the audit rows that cascade do not", () => {
    const db = database();
    db.exec(`
      INSERT INTO apps (id, slug, name, platform, created_at) VALUES ('app-x','app-x','X','android',1);
      INSERT INTO audit_logs (id, app_id, action, actor, payload, created_at)
        VALUES ('l1','app-x','app.archive','tester','{}',1);
    `);
    db.prepare(
      `INSERT INTO app_purge_records
         (id, app_id, app_slug, actor, actor_type, status, started_at)
       VALUES ('p1','app-x','app-x','tester','human','started',1)`,
    ).run();
    db.exec("DELETE FROM apps WHERE id='app-x'");
    expect((db.prepare("SELECT COUNT(*) n FROM audit_logs").get() as { n: number }).n).toBe(0);
    expect((db.prepare("SELECT COUNT(*) n FROM app_purge_records").get() as { n: number }).n).toBe(1);
  });

  it("carries no foreign keys, so a snapshot survives its subject", () => {
    const db = database();
    const ddl = (db.prepare("SELECT sql FROM sqlite_master WHERE name='app_purge_records'").get() as { sql: string }).sql;
    expect(ddl).not.toMatch(/FOREIGN KEY/);
    // And re-applying is safe (deploy retries).
    db.exec(readFileSync(`${MIGRATION_DIR}${MIGRATION}`, "utf8"));
  });
});
