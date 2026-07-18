import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

function database() {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(`
    CREATE TABLE apps (id TEXT PRIMARY KEY);
    CREATE TABLE builds (id TEXT PRIMARY KEY, app_id TEXT NOT NULL REFERENCES apps(id));
    CREATE TABLE build_assets (
      id TEXT PRIMARY KEY,
      build_id TEXT NOT NULL REFERENCES builds(id),
      platform TEXT NOT NULL,
      filetype TEXT NOT NULL
    );
    CREATE TABLE operation_logs (id TEXT PRIMARY KEY);
  `);
  const migration = readFileSync(
    fileURLToPath(new URL("../../migrations/sql/0046_app_notarizations.sql", import.meta.url)),
    "utf8",
  );
  db.exec(migration);
  db.exec(`
    INSERT INTO apps(id) VALUES ('app');
    INSERT INTO builds(id, app_id) VALUES ('build', 'app');
    INSERT INTO build_assets(id, build_id, platform, filetype)
      VALUES ('asset', 'build', 'darwin', 'dmg');
    INSERT INTO app_notarizations(
      id, app_id, build_id, asset_id, r2_key, r2_etag, source_size_bytes,
      computed_sha256, source_filetype, source_platform, state,
      ready_for_staple, created_by_actor, created_at, updated_at
    ) VALUES (
      'logical', 'app', 'build', 'asset', 'asset.dmg', 'etag', 10,
      '${"a".repeat(64)}', 'dmg', 'darwin', 'pending', 0, 'tester', 1, 1
    );
    INSERT INTO app_notarization_attempts(
      id, notarization_id, app_id, attempt_no, submission_name,
      upload_state, status_state, reconcile_state, created_at
    ) VALUES (
      'attempt', 'logical', 'app', 1, 'build-dmg-intent.dmg',
      'uploaded', 'in_progress', 'none', 1
    );
    UPDATE app_notarizations SET active_attempt_id = 'attempt' WHERE id = 'logical';
  `);
  return db;
}

describe("notarization migration state-machine counterexamples", () => {
  it("rejects normalized accepted with a transient log-fetch error", () => {
    const db = database();
    expect(() => db.exec(`
      UPDATE app_notarization_attempts
      SET status_state = 'accepted', error_class = 'APPLE_REQUEST_FAILED',
          error_phase = 'log_fetch', reconcile_state = 'needed', completed_at = 2
      WHERE id = 'attempt'
    `)).toThrow();
  });

  it("allows raw Apple Accepted while normalized state remains in_progress", () => {
    const db = database();
    expect(() => db.exec(`
      UPDATE app_notarization_attempts
      SET status_state = 'in_progress', raw_apple_status = 'Accepted',
          error_class = 'APPLE_REQUEST_FAILED', error_phase = 'log_fetch',
          reconcile_state = 'needed', completed_at = NULL
      WHERE id = 'attempt'
    `)).not.toThrow();
  });

  it("requires a non-empty durable submission intent", () => {
    const db = database();
    expect(() => db.exec(`
      INSERT INTO app_notarization_attempts(
        id, notarization_id, app_id, attempt_no, submission_name,
        upload_state, status_state, reconcile_state, created_at
      ) VALUES ('bad-intent', 'logical', 'app', 2, '', 'pending', 'pending', 'none', 2)
    `)).toThrow();
  });

  it("enforces full Accepted job-id and SHA closure", () => {
    const db = database();
    db.exec(`
      UPDATE app_notarization_attempts
      SET apple_submission_id = '11111111-1111-1111-1111-111111111111',
          status_state = 'accepted', log_fetched = 1,
          log_sha256 = '${"a".repeat(64)}',
          log_job_id = '11111111-1111-1111-1111-111111111111',
          reconcile_state = 'reconciled', completed_at = 2
      WHERE id = 'attempt'
    `);
    expect(() => db.exec(`
      UPDATE app_notarizations
      SET state = 'accepted', ready_for_staple = 1,
          apple_log_sha256 = '${"a".repeat(64)}',
          apple_log_job_id = '22222222-2222-2222-2222-222222222222',
          completed_at = 2
      WHERE id = 'logical'
    `)).toThrow();
    expect(() => db.exec(`
      UPDATE app_notarizations
      SET state = 'accepted', ready_for_staple = 1,
          apple_log_sha256 = '${"a".repeat(64)}',
          apple_log_job_id = '11111111-1111-1111-1111-111111111111',
          completed_at = 2
      WHERE id = 'logical'
    `)).not.toThrow();
  });
});
