/**
 * Migration 0098 — sequenced release checks cannot be rewritten in place.
 *
 * Loads the real migration files. The "old Worker" statement below is the
 * release-check upsert as it was before sequence ordering existed: it never
 * sets sequence or decision_id, so on a sequenced row it would change the
 * verdict while keeping the row's sequence. The trigger must abort it.
 */

import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

const MIGRATION_DIR = fileURLToPath(new URL("../../migrations/sql/", import.meta.url));

function database(): Database.Database {
  const db = new Database(":memory:");
  for (const name of readdirSync(MIGRATION_DIR).sort()) {
    if (!name.endsWith(".sql")) continue;
    db.exec(readFileSync(`${MIGRATION_DIR}${name}`, "utf8"));
  }
  // release_checks has a foreign key to releases; this test is about the row itself.
  db.pragma("foreign_keys = OFF");
  return db;
}

const OLD_WORKER_UPSERT = `
  INSERT INTO release_checks
    (id, release_id, app_id, source, run_id, run_url, verdict,
     cases_total, cases_passed, summary, reviewer, reviewed_at, created_at, updated_at)
  VALUES (?, 'rel', 'app', 'tb', ?, NULL, ?, NULL, NULL, NULL, NULL, ?, 2, 2)
  ON CONFLICT (release_id, source) DO UPDATE SET
    run_id = excluded.run_id, verdict = excluded.verdict,
    reviewed_at = excluded.reviewed_at, updated_at = excluded.updated_at
  WHERE (excluded.reviewed_at IS NOT NULL
         AND (release_checks.reviewed_at IS NULL OR excluded.reviewed_at > release_checks.reviewed_at))`;

function seed(db: Database.Database, sequence: number | null, decisionId: string | null) {
  db.prepare(
    `INSERT INTO release_checks (id, release_id, app_id, source, run_id, verdict, reviewed_at,
       created_at, updated_at, sequence, decision_id)
     VALUES ('row', 'rel', 'app', 'tb', 'r1', 'passed', 100, 1, 1, ?, ?)`,
  ).run(sequence, decisionId);
}

const row = (db: Database.Database) =>
  db.prepare("SELECT run_id, verdict, sequence, decision_id FROM release_checks WHERE id = 'row'").get();

describe("0098 release check sequence guard", () => {
  it("aborts an old Worker's in-place update of a sequenced row", () => {
    const db = database();
    seed(db, 3, "dec-3");
    expect(() => db.prepare(OLD_WORKER_UPSERT).run("new", "late", "failed", 99999)).toThrow(/sequenced check/);
    expect(row(db)).toEqual({ run_id: "r1", verdict: "passed", sequence: 3, decision_id: "dec-3" });
  });

  it("allows only a larger sequence with another, non-NULL decision_id", () => {
    const db = database();
    seed(db, 3, "dec-3");
    const update = db.prepare("UPDATE release_checks SET verdict = 'failed', sequence = ?, decision_id = ? WHERE id = 'row'");
    for (const [sequence, decisionId] of [[3, "dec-x"], [2, "dec-x"], [4, "dec-3"], [4, null], [null, "dec-x"], [null, null]] as const) {
      expect(() => update.run(sequence, decisionId)).toThrow(/sequenced check/);
    }
    expect(() => db.prepare("UPDATE release_checks SET verdict = 'failed' WHERE id = 'row'").run()).toThrow(/sequenced check/);
    expect(row(db)).toEqual({ run_id: "r1", verdict: "passed", sequence: 3, decision_id: "dec-3" });
    update.run(4, "dec-4");
    expect(row(db)).toEqual({ run_id: "r1", verdict: "failed", sequence: 4, decision_id: "dec-4" });
  });

  it("leaves unsequenced rows to the existing rules", () => {
    const db = database();
    seed(db, null, null);
    db.prepare(OLD_WORKER_UPSERT).run("new", "r2", "failed", 200);
    expect(row(db)).toEqual({ run_id: "r2", verdict: "failed", sequence: null, decision_id: null });
    db.prepare("UPDATE release_checks SET sequence = 1, decision_id = 'dec-1' WHERE id = 'row'").run();
    expect(row(db)).toMatchObject({ sequence: 1, decision_id: "dec-1" });
  });
});
