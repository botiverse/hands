import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

const migrationPath = fileURLToPath(
  new URL("../../migrations/sql/0055_device_enrollments.sql", import.meta.url),
);

describe("device-enrollment migration invariants", () => {
  it("keeps remote-D1 guard trigger bodies on one physical line", () => {
    const triggerLines = readFileSync(migrationPath, "utf8")
      .split("\n")
      .filter((line) => line.startsWith("CREATE TRIGGER"));

    expect(triggerLines).toHaveLength(2);
    for (const line of triggerLines) {
      expect(line).toContain(" BEGIN ");
      expect(line).toMatch(/ END;$/);
      expect(line.match(/\bEND;/g)).toHaveLength(1);
    }
  });

  it("enforces app-scoped aliases, one live installation per app, and stale-operation guards", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    db.exec(`
      CREATE TABLE apps (id TEXT PRIMARY KEY);
      INSERT INTO apps (id) VALUES ('app-a'), ('app-b');
    `);
    db.exec(readFileSync(migrationPath, "utf8"));
    db.exec(`
      INSERT INTO device_enrollments
        (id, app_id, alias, current_device_id, status, revision,
         created_by, updated_by, created_at, updated_at)
      VALUES
        ('enroll-a', 'app-a', 'artin-tablet', 'install-old', 'active', 1,
         'tester', 'tester', 1, 1),
        ('enroll-b', 'app-b', 'artin-tablet', 'install-old', 'active', 1,
         'tester', 'tester', 1, 1);
    `);

    expect(() => db.prepare(`
      INSERT INTO device_enrollments
        (id, app_id, alias, current_device_id, status, revision,
         created_by, updated_by, created_at, updated_at)
      VALUES ('dup-alias', 'app-a', 'ARTIN-TABLET', 'install-other', 'active', 1,
              'tester', 'tester', 1, 1)
    `).run()).toThrow();
    expect(() => db.prepare(`
      INSERT INTO device_enrollments
        (id, app_id, alias, current_device_id, status, revision,
         created_by, updated_by, created_at, updated_at)
      VALUES ('dup-device', 'app-a', 'other-tablet', 'install-old', 'active', 1,
              'tester', 'tester', 1, 1)
    `).run()).toThrow();

    const insertOperation = db.prepare(`
      INSERT INTO device_enrollment_operations
        (id, app_id, enrollment_id, operation_id, kind, from_device_id,
         to_device_id, expected_revision, resulting_revision, actor, created_at)
      VALUES (?, 'app-a', 'enroll-a', ?, ?, ?, ?, ?, ?, 'tester', 2)
    `);
    expect(() => insertOperation.run(
      "op-valid",
      "request-valid",
      "rebind",
      "install-old",
      "install-new",
      1,
      2,
    )).not.toThrow();
    expect(() => insertOperation.run(
      "op-stale",
      "request-stale",
      "rebind",
      "install-old",
      "install-third",
      2,
      3,
    )).toThrow("device enrollment rebind precondition failed");
    expect(() => insertOperation.run(
      "op-wrong-device",
      "request-wrong-device",
      "revoke",
      "install-new",
      null,
      1,
      2,
    )).toThrow("device enrollment revoke precondition failed");
  });

  it("cascades enrollment and immutable receipts with app deletion", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    db.exec("CREATE TABLE apps (id TEXT PRIMARY KEY); INSERT INTO apps (id) VALUES ('app-delete');");
    db.exec(readFileSync(migrationPath, "utf8"));
    db.exec(`
      INSERT INTO device_enrollments
        (id, app_id, alias, current_device_id, status, revision,
         created_by, updated_by, created_at, updated_at)
      VALUES ('enroll-delete', 'app-delete', 'device', 'install', 'active', 1,
              'tester', 'tester', 1, 1);
      INSERT INTO device_enrollment_operations
        (id, app_id, enrollment_id, operation_id, kind, to_device_id,
         resulting_revision, actor, created_at)
      VALUES ('op-delete', 'app-delete', 'enroll-delete', 'create-delete',
              'create', 'install', 1, 'tester', 1);
    `);

    expect(() => db.prepare("DELETE FROM apps WHERE id = 'app-delete'").run()).not.toThrow();
    expect(db.prepare("SELECT COUNT(*) AS count FROM device_enrollments").get()).toEqual({ count: 0 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM device_enrollment_operations").get()).toEqual({ count: 0 });
  });
});
