import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

const MIGRATION_DIR = fileURLToPath(new URL("../../migrations/sql/", import.meta.url));
const MIGRATION = "0061_feedback_close_rate_limit.sql";
const MIGRATION_SQL = readFileSync(`${MIGRATION_DIR}${MIGRATION}`, "utf8");

function database(includeCloseMigration = false) {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  for (const name of readdirSync(MIGRATION_DIR).sort()) {
    if (!name.endsWith(".sql")) continue;
    if (name === MIGRATION && !includeCloseMigration) continue;
    db.exec(readFileSync(`${MIGRATION_DIR}${name}`, "utf8"));
  }
  db.prepare(
    "INSERT INTO apps (id, slug, name, platform, created_at) VALUES ('app-close', 'app-close', 'Close', 'web', 1)",
  ).run();
  db.prepare(
    `INSERT INTO app_reporter_integrations (id, app_id, name, created_at, updated_at)
     VALUES ('integration-close', 'app-close', 'Reporter', 1, 1)`,
  ).run();
  return db;
}

function insertWindow(
  db: Database.Database,
  endpoint: string,
  reporterHash = "reporter-hash",
  requestCount = 1,
) {
  return db.prepare(
    `INSERT INTO feedback_reporter_rate_windows
     (app_id, reporter_integration_id, reporter_hash, audit_key_version,
      endpoint, window_started_at, request_count, last_audited_at, updated_at)
     VALUES ('app-close', 'integration-close', ?, 'v1', ?, 3600000, ?, 123, 456)`,
  ).run(reporterHash, endpoint, requestCount);
}

function insertAudit(
  db: Database.Database,
  endpoint: string,
  id = "audit-close",
  throttleWindow: number | null = 3600000,
) {
  return db.prepare(
    `INSERT INTO feedback_reporter_access_audits
     (id, app_id, reporter_integration_id, reporter_hash, audit_key_version,
      endpoint, ticket_id, attachment_id, throttle_window_started_at, created_at)
     VALUES (?, 'app-close', 'integration-close', 'reporter-hash', 'v1', ?, NULL, NULL, ?, 456)`,
  ).run(id, endpoint, throttleWindow);
}

describe("migration 0061 — feedback close rate limit", () => {
  it("replays the deployed failure: the pre-migration schema rejects endpoint=close", () => {
    const db = database();

    expect(() => insertWindow(db, "close")).toThrow(/CHECK constraint failed/);
    expect(() => insertAudit(db, "close")).toThrow(/CHECK constraint failed/);
  });

  it("preserves existing windows byte-for-byte and admits the close endpoint", () => {
    const db = database();
    insertWindow(db, "comment", "preserved", 17);
    insertAudit(db, "detail", "preserved-audit");
    const windowsBefore = db.prepare(
      "SELECT * FROM feedback_reporter_rate_windows ORDER BY reporter_hash",
    ).all();
    const auditsBefore = db.prepare(
      "SELECT * FROM feedback_reporter_access_audits ORDER BY id",
    ).all();

    db.exec(MIGRATION_SQL);

    expect(db.prepare(
      "SELECT * FROM feedback_reporter_rate_windows ORDER BY reporter_hash",
    ).all()).toEqual(windowsBefore);
    expect(db.prepare(
      "SELECT * FROM feedback_reporter_access_audits ORDER BY id",
    ).all()).toEqual(auditsBefore);
    expect(() => insertWindow(db, "close", "close-window")).not.toThrow();
    expect(() => insertAudit(db, "close")).not.toThrow();
    expect(db.prepare(
      "SELECT endpoint, request_count FROM feedback_reporter_rate_windows WHERE reporter_hash='close-window'",
    ).get()).toEqual({ endpoint: "close", request_count: 1 });
    expect(db.prepare(
      `SELECT name FROM sqlite_schema WHERE type='index' AND name IN (
         'idx_feedback_reporter_rate_windows_updated',
         'idx_feedback_reporter_access_audits_lookup',
         'idx_feedback_reporter_access_audits_retention',
         'idx_feedback_reporter_access_audits_throttle'
       ) ORDER BY name`,
    ).all()).toEqual([
      { name: "idx_feedback_reporter_access_audits_lookup" },
      { name: "idx_feedback_reporter_access_audits_retention" },
      { name: "idx_feedback_reporter_access_audits_throttle" },
      { name: "idx_feedback_reporter_rate_windows_updated" },
    ]);
  });

  it("keeps the endpoint, count, ownership, and primary-key guards closed", () => {
    const db = database();
    db.exec(MIGRATION_SQL);
    insertWindow(db, "close");
    insertAudit(db, "close");

    expect(() => insertWindow(db, "delete", "unknown-endpoint")).toThrow(/CHECK constraint failed/);
    expect(() => insertAudit(db, "delete", "unknown-audit")).toThrow(/CHECK constraint failed/);
    expect(() => insertWindow(db, "comment", "negative", -1)).toThrow(/CHECK constraint failed/);
    expect(() => insertWindow(db, "close")).toThrow(/UNIQUE constraint failed/);
    expect(() => insertAudit(db, "close", "duplicate-throttle")).toThrow(/UNIQUE constraint failed/);
    expect(() => db.prepare(
      `INSERT INTO feedback_reporter_rate_windows
       (app_id, reporter_integration_id, reporter_hash, audit_key_version,
        endpoint, window_started_at, request_count, updated_at)
       VALUES ('missing-app', 'integration-close', 'orphan', 'v1', 'close', 1, 1, 1)`,
    ).run()).toThrow(/FOREIGN KEY constraint failed/);
    expect(() => db.prepare(
      `INSERT INTO feedback_reporter_access_audits
       (id, app_id, reporter_integration_id, reporter_hash, audit_key_version,
        endpoint, created_at)
       VALUES ('orphan-audit', 'missing-app', 'integration-close', 'orphan', 'v1', 'close', 1)`,
    ).run()).toThrow(/FOREIGN KEY constraint failed/);
    expect(db.pragma("foreign_key_check")).toEqual([]);
  });
});
