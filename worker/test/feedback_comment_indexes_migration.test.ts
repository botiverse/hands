/**
 * The reporter list/detail comment subqueries must resolve through covering
 * indexes instead of scanning every comment on a ticket. D1 bills and times by
 * rows read, and EXPLAIN QUERY PLAN is the documented way to confirm an index
 * is actually used, so the assertions are on the plan itself.
 */

import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

const MIGRATION_DIR = fileURLToPath(new URL("../../migrations/sql/", import.meta.url));
const INDEX_MIGRATION = "0058_feedback_comment_lookup_indexes.sql";

/** Apply the whole ordered migration set so the schema matches production. */
function applyMigrations(db: Database.Database, includeIndexMigration: boolean) {
  for (const name of readdirSync(MIGRATION_DIR).sort()) {
    if (!name.endsWith(".sql")) continue;
    if (name === INDEX_MIGRATION && !includeIndexMigration) continue;
    db.exec(readFileSync(`${MIGRATION_DIR}${name}`, "utf8"));
  }
}

const UNREAD_SUBQUERY = `(SELECT COUNT(*) FROM feedback_comments u
  WHERE u.ticket_id = t.id AND u.internal = 0
    AND u.author_type IN ('staff', 'system')
    AND (rr.ticket_id IS NULL OR u.reporter_sequence > rr.read_through_sequence))`;

const LIST_QUERY = `SELECT t.id,
   (SELECT COUNT(*) FROM feedback_comments fc WHERE fc.ticket_id = t.id AND fc.internal = 0) AS comment_count,
   (SELECT MAX(fc.created_at) FROM feedback_comments fc WHERE fc.ticket_id = t.id AND fc.internal = 0) AS latest_comment_at,
   ${UNREAD_SUBQUERY} AS unread_count
 FROM feedback_tickets t
 LEFT JOIN feedback_reporter_ticket_reads rr
   ON rr.app_id = t.app_id AND rr.reporter_integration_id = t.reporter_integration_id
  AND rr.reporter_id = t.reporter_id AND rr.ticket_id = t.id
 WHERE t.app_id = ? AND t.reporter_integration_id = ? AND t.reporter_id = ?
 ORDER BY t.created_at DESC, t.id DESC LIMIT 20`;

function schema(withIndexes: boolean) {
  const db = new Database(":memory:");
  applyMigrations(db, withIndexes);
  // Ownership triggers are real: a ticket's integration must belong to its app.
  db.prepare("INSERT INTO apps (id, slug, name, platform, created_at) VALUES ('app', 'slug', 'name', 'android', 1)").run();
  db.prepare("INSERT INTO app_reporter_integrations (id, app_id, name, created_at, updated_at) VALUES ('intg', 'app', 'inbox', 1, 1)").run();
  return db;
}

function plan(db: Database.Database) {
  return db
    .prepare(`EXPLAIN QUERY PLAN ${LIST_QUERY}`)
    .all("app", "intg", "rep")
    .map((row) => String((row as { detail: string }).detail));
}

describe("feedback comment lookup indexes", () => {
  it("routes every comment subquery through a covering index", () => {
    const before = plan(schema(false));
    const after = plan(schema(true));

    // Before: the only usable index is (ticket_id, created_at, id), so the
    // internal/author_type/reporter_sequence filters are applied by scanning
    // the ticket's comments.
    expect(before.some((detail) => detail.includes("idx_feedback_comments_ticket ("))).toBe(true);
    expect(before.some((detail) => detail.includes("idx_feedback_comments_unread"))).toBe(false);
    expect(before.some((detail) => detail.includes("idx_feedback_comments_internal_created"))).toBe(false);

    // After: count and MAX(created_at) use the internal+created_at index; the
    // unread predicate uses the author_type+reporter_sequence index.
    expect(
      after.filter((detail) => detail.includes("COVERING INDEX idx_feedback_comments_internal_created")).length,
    ).toBe(2);
    expect(after.some((detail) => detail.includes("COVERING INDEX idx_feedback_comments_unread"))).toBe(true);
    // No comment subquery may fall back to a table scan.
    expect(after.some((detail) => /SCAN (fc|u)\b/.test(detail))).toBe(false);
  });

  it("returns the same counts with the indexes in place", () => {
    const db = schema(true);
    db.prepare(
      `INSERT INTO feedback_tickets
         (id, app_id, kind, status, message, metadata_json, reporter_id,
          reporter_integration_id, created_at, updated_at)
       VALUES ('t1', 'app', 'feedback', 'open', 'm', '{}', 'rep', 'intg', 1, 1)`,
    ).run();
    const insert = db.prepare(
      `INSERT INTO feedback_comments
         (id, ticket_id, author_actor, author_type, body, internal, created_at)
       VALUES (?, 't1', 'staff:test', ?, 'body', ?, ?)`,
    );
    for (let i = 0; i < 12; i += 1) {
      insert.run(`c${i}`, i % 2 === 0 ? "staff" : "system", i % 4 === 0 ? 1 : 0, 2_000 + i);
    }

    const row = db.prepare(LIST_QUERY).get("app", "intg", "rep") as {
      comment_count: number;
      latest_comment_at: number;
      unread_count: number;
    };
    // 12 comments, every 4th internal → 9 reporter-visible; all visible ones are
    // staff/system and there is no read receipt, so all 9 count as unread.
    expect(row.comment_count).toBe(9);
    expect(row.unread_count).toBe(9);
    expect(row.latest_comment_at).toBe(2_011);
  });
});
