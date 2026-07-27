import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

const migrationPath = fileURLToPath(
  new URL("../../migrations/sql/0055_feedback_reporter_sessions.sql", import.meta.url),
);

function makeDb() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE apps (id TEXT PRIMARY KEY);
    CREATE TABLE app_reporter_integrations (
      id TEXT PRIMARY KEY,
      app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE
    );
    CREATE TABLE app_deploy_tokens (
      id TEXT PRIMARY KEY,
      app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE
    );
    INSERT INTO apps (id) VALUES ('app-a');
    INSERT INTO app_reporter_integrations (id, app_id) VALUES ('integration-a', 'app-a');
    INSERT INTO app_deploy_tokens (id, app_id) VALUES ('token-a', 'app-a');
  `);
  db.exec(readFileSync(migrationPath, "utf8"));
  return db;
}

describe("feedback reporter sessions migration", () => {
  it("isolates source-token, integration, reporter, key-version, and window buckets", () => {
    const db = makeDb();
    const insert = db.prepare(`
      INSERT INTO feedback_reporter_session_mint_rate_windows
        (app_id, reporter_integration_id, deploy_token_id, reporter_hash,
         audit_key_version, window_started_at, request_count, updated_at)
      VALUES ('app-a', 'integration-a', 'token-a', ?, ?, ?, 1, 1)
    `);
    insert.run("reporter-hash-a", "audit-v1", 0);
    expect(() => insert.run("reporter-hash-a", "audit-v1", 0)).toThrow();
    expect(() => insert.run("reporter-hash-b", "audit-v1", 0)).not.toThrow();
    expect(() => insert.run("reporter-hash-a", "audit-v2", 0)).not.toThrow();
    expect(() => insert.run("reporter-hash-a", "audit-v1", 60_000)).not.toThrow();
    expect(() => db.prepare(`
      INSERT INTO feedback_reporter_session_mint_rate_windows
        (app_id, reporter_integration_id, deploy_token_id, reporter_hash,
         audit_key_version, window_started_at, request_count, updated_at)
      VALUES ('app-a', 'integration-a', 'token-a', 'negative', 'audit-v1', 0, -1, 1)
    `).run()).toThrow();
  });

  it("cascades quota state when its token is deleted", () => {
    const db = makeDb();
    db.prepare(`
      INSERT INTO feedback_reporter_session_mint_rate_windows
        (app_id, reporter_integration_id, deploy_token_id, reporter_hash,
         audit_key_version, window_started_at, request_count, updated_at)
      VALUES ('app-a', 'integration-a', 'token-a', 'reporter-hash', 'audit-v1', 0, 1, 1)
    `).run();
    db.prepare("DELETE FROM app_deploy_tokens WHERE id = 'token-a'").run();
    expect(db.prepare(
      "SELECT COUNT(*) AS count FROM feedback_reporter_session_mint_rate_windows",
    ).get()).toEqual({ count: 0 });
  });
});
