import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

const migrationPath = fileURLToPath(
  new URL("../../migrations/sql/0049_device_groups.sql", import.meta.url),
);

describe("device-group migration invariants", () => {
  it("keeps trigger definitions on one physical line for remote D1 migrations", () => {
    const triggerLines = readFileSync(migrationPath, "utf8")
      .split("\n")
      .filter((line) => line.startsWith("CREATE TRIGGER"));

    expect(triggerLines).toHaveLength(3);
    for (const line of triggerLines) {
      expect(line).toContain(" BEGIN ");
      expect(line).toMatch(/ END;$/);
      expect(line).not.toMatch(/\bCASE\b/);
      expect(line.match(/\bEND;/g)).toHaveLength(1);
    }
  });

  it("enforces same-app scopes and blocks deletion while a live release references the group", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    db.exec(`
      CREATE TABLE apps (id TEXT PRIMARY KEY);
      CREATE TABLE releases (
        id TEXT PRIMARY KEY,
        app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
        status TEXT NOT NULL
      );
      CREATE TABLE release_scopes (
        id TEXT PRIMARY KEY,
        release_id TEXT NOT NULL REFERENCES releases(id) ON DELETE CASCADE,
        scope_type TEXT NOT NULL,
        scope_value TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      INSERT INTO apps (id) VALUES ('app-a'), ('app-b');
      INSERT INTO releases (id, app_id, status)
      VALUES ('release-a', 'app-a', 'draft'), ('release-b', 'app-b', 'active');
    `);
    db.exec(readFileSync(migrationPath, "utf8"));
    db.exec(`
      INSERT INTO device_groups (id, app_id, name, created_at, updated_at)
      VALUES ('group-a', 'app-a', 'A devices', 1, 1),
             ('group-b', 'app-b', 'B devices', 1, 1);
    `);

    expect(() => db.prepare(`
      INSERT INTO release_scopes (id, release_id, scope_type, scope_value, created_at)
      VALUES ('scope-valid', 'release-a', 'device_group', 'group-a', 1)
    `).run()).not.toThrow();
    expect(() => db.prepare(`
      INSERT INTO release_scopes (id, release_id, scope_type, scope_value, created_at)
      VALUES ('scope-cross-app', 'release-a', 'device_group', 'group-b', 1)
    `).run()).toThrow("device_group scope must reference a group in the release app");
    expect(() => db.prepare(`
      UPDATE release_scopes SET scope_value = 'group-b' WHERE id = 'scope-valid'
    `).run()).toThrow("device_group scope must reference a group in the release app");
    expect(() => db.prepare("DELETE FROM device_groups WHERE id = 'group-a'").run())
      .toThrow("device group is used by a draft or active release");

    db.prepare("UPDATE releases SET status = 'superseded' WHERE id = 'release-a'").run();
    expect(() => db.prepare("DELETE FROM device_groups WHERE id = 'group-a'").run()).not.toThrow();
  });

  it("does not block app cascade deletion", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    db.exec(`
      CREATE TABLE apps (id TEXT PRIMARY KEY);
      CREATE TABLE releases (
        id TEXT PRIMARY KEY,
        app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
        status TEXT NOT NULL
      );
      CREATE TABLE release_scopes (
        id TEXT PRIMARY KEY,
        release_id TEXT NOT NULL REFERENCES releases(id) ON DELETE CASCADE,
        scope_type TEXT NOT NULL,
        scope_value TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      INSERT INTO apps (id) VALUES ('app-delete');
      INSERT INTO releases (id, app_id, status) VALUES ('release-delete', 'app-delete', 'active');
    `);
    db.exec(readFileSync(migrationPath, "utf8"));
    db.exec(`
      INSERT INTO device_groups (id, app_id, name, created_at, updated_at)
      VALUES ('group-delete', 'app-delete', 'Delete devices', 1, 1);
      INSERT INTO release_scopes (id, release_id, scope_type, scope_value, created_at)
      VALUES ('scope-delete', 'release-delete', 'device_group', 'group-delete', 1);
    `);

    expect(() => db.prepare("DELETE FROM apps WHERE id = 'app-delete'").run()).not.toThrow();
    expect(db.prepare("SELECT COUNT(*) AS count FROM device_groups").get()).toEqual({ count: 0 });
  });
});
