import { readFileSync } from "node:fs";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

const migrationPath = new URL(
  "../../migrations/sql/0054_app_update_cleanup_terminal.sql",
  import.meta.url,
);

function baseDb() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE operation_logs (
      id TEXT PRIMARY KEY,
      app_id TEXT,
      kind TEXT NOT NULL,
      status TEXT NOT NULL,
      parent_op_id TEXT,
      step_number INTEGER,
      actor TEXT NOT NULL DEFAULT 'admin',
      input TEXT NOT NULL DEFAULT '{}',
      output TEXT NOT NULL DEFAULT '{}',
      error TEXT,
      progress REAL NOT NULL DEFAULT 0,
      retry_count INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      completed_at INTEGER
    );
    CREATE TABLE webhooks (id TEXT PRIMARY KEY);
    CREATE TABLE webhook_deliveries (
      id TEXT PRIMARY KEY,
      webhook_id TEXT NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
      event_type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 3,
      last_attempt_at INTEGER,
      next_attempt_at INTEGER,
      last_response_status INTEGER,
      last_response_body TEXT,
      last_error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      completed_at INTEGER
    );
  `);
  return db;
}

function seedOperationAndReceipt(db: Database.Database) {
  const hex = "a".repeat(64);
  db.prepare(`
    INSERT INTO operation_logs
      (id, app_id, kind, status, actor, input, output, progress,
       retry_count, created_at, updated_at, completed_at)
    VALUES ('operation-1', 'app-1', 'app-update-cleanup-terminal', 'success',
            'tester', '{}', '{}', 1, 0, 1, 1, 1)
  `).run();
  db.prepare(`
    INSERT INTO app_update_cleanup_terminal_receipts
      (operation_id, receipt_digest, run_case_id, attempt,
       artifact_bundle_digest, app_id, release_id, release_revision,
       build_id, app_slug, channel_slug, target_artifact_sha256,
       target_version_code, target_installation_digest, cancel_readback,
       scope_deactivated, scope_readback_json, delivery_bindings_json,
       canonical_request_json, event_payload_json, canonical_receipt_json,
       created_at)
    VALUES (?, ?, 'run-1', 1, ?, 'app-1', 'release-1', 2, 'build-1',
            'app-one', 'main', ?, 10, ?, 'inactive', 1,
            '{}', '[]', '{}', '{}', '{}', 1)
  `).run("operation-1", `sha256:${hex}`, hex, hex, `sha256:${hex}`);
}

describe("0054 App Update cleanup terminal migration", () => {
  it("applies cleanly and adds the delivery receipt reference", () => {
    const sql = readFileSync(migrationPath, "utf8");
    const db = baseDb();
    expect(() => db.exec(sql)).not.toThrow();
    expect(db.prepare(
      "SELECT name FROM pragma_table_info('webhook_deliveries') WHERE name='app_update_terminal_receipt_id'",
    ).get()).toEqual({ name: "app_update_terminal_receipt_id" });
    db.close();
  });

  it("enforces immutable operation/receipt identity and one delivery per subscriber", () => {
    const db = baseDb();
    db.exec(readFileSync(migrationPath, "utf8"));
    seedOperationAndReceipt(db);
    db.prepare("INSERT INTO webhooks (id) VALUES ('hook-1')").run();
    db.prepare(`
      INSERT INTO webhook_deliveries
        (id, webhook_id, event_type, payload_json,
         app_update_terminal_receipt_id, created_at, updated_at)
      VALUES ('delivery-1', 'hook-1', 'app_update:cleanup_terminal', '{}',
              'operation-1', 1, 1)
    `).run();

    expect(() => db.prepare(
      "UPDATE operation_logs SET status='failed' WHERE id='operation-1'",
    ).run()).toThrow(/immutable/i);
    expect(() => db.prepare(
      "DELETE FROM operation_logs WHERE id='operation-1'",
    ).run()).toThrow(/immutable/i);
    expect(() => db.prepare(
      "UPDATE app_update_cleanup_terminal_receipts SET attempt=2 WHERE operation_id='operation-1'",
    ).run()).toThrow(/immutable/i);
    expect(() => db.prepare(`
      INSERT INTO webhook_deliveries
        (id, webhook_id, event_type, payload_json,
         app_update_terminal_receipt_id, created_at, updated_at)
      VALUES ('delivery-2', 'hook-1', 'app_update:cleanup_terminal', '{}',
              'operation-1', 1, 1)
    `).run()).toThrow(/UNIQUE/i);
    db.close();
  });

  it("rejects malformed digests at the storage boundary", () => {
    const db = baseDb();
    db.exec(readFileSync(migrationPath, "utf8"));
    db.prepare(`
      INSERT INTO operation_logs
        (id, kind, status, actor, input, output, created_at, updated_at)
      VALUES ('operation-bad', 'app-update-cleanup-terminal', 'success',
              'tester', '{}', '{}', 1, 1)
    `).run();
    expect(() => db.prepare(`
      INSERT INTO app_update_cleanup_terminal_receipts
        (operation_id, receipt_digest, run_case_id, attempt,
         artifact_bundle_digest, app_id, release_id, release_revision,
         build_id, app_slug, channel_slug, target_artifact_sha256,
         target_version_code, target_installation_digest, cancel_readback,
         scope_deactivated, scope_readback_json, delivery_bindings_json,
         canonical_request_json, event_payload_json, canonical_receipt_json,
         created_at)
      VALUES ('operation-bad', ?, 'run-bad', 1, ?, 'app', 'release', 1,
              'build', 'app', 'main', ?, 1, ?, 'inactive', 1,
              '{}', '[]', '{}', '{}', '{}', 1)
    `).run(
      `sha256:${"g".repeat(64)}`,
      "b".repeat(64),
      "c".repeat(64),
      `sha256:${"d".repeat(64)}`,
    )).toThrow(/CHECK/i);
    db.close();
  });
});
