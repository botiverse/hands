import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

const migrationPath = fileURLToPath(
  new URL("../../migrations/sql/0053_release_identity_and_activation.sql", import.meta.url),
);

describe("release identity migration", () => {
  it("keeps remote-D1 trigger bodies on one physical line", () => {
    const triggerLines = readFileSync(migrationPath, "utf8")
      .split("\n")
      .filter((line) => line.startsWith("CREATE TRIGGER"));

    expect(triggerLines).toHaveLength(3);
    for (const line of triggerLines) {
      expect(line).toContain(" BEGIN ");
      expect(line).toMatch(/ END;$/);
      expect(line.match(/\bEND;/g)).toHaveLength(1);
    }
  });

  it("preserves legacy duplicates while rejecting every new duplicate lifecycle", () => {
    const db = new Database(":memory:");
    db.exec(`
      CREATE TABLE builds (
        id TEXT PRIMARY KEY,
        app_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        product_type TEXT NOT NULL,
        release_type TEXT NOT NULL,
        version_name TEXT NOT NULL,
        version_code INTEGER NOT NULL
      );
      CREATE TABLE releases (
        id TEXT PRIMARY KEY,
        app_id TEXT NOT NULL,
        build_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        product_type TEXT NOT NULL,
        release_type TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE release_scopes (
        id TEXT PRIMARY KEY,
        release_id TEXT NOT NULL,
        scope_type TEXT NOT NULL,
        scope_value TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      INSERT INTO builds
        (id, app_id, channel_id, product_type, release_type, version_name, version_code)
      VALUES
        ('build-legacy-a', 'app-a', 'main', 'android-apk', 'stable', '1.0.0', 100),
        ('build-legacy-b', 'app-a', 'main', 'android-apk', 'stable', '1.0.0', 100),
        ('build-cancelled', 'app-a', 'main', 'android-apk', 'stable', '1.0.1', 101),
        ('build-draft', 'app-a', 'main', 'android-apk', 'stable', '1.0.2', 102),
        ('build-conflict', 'app-a', 'main', 'android-apk', 'stable', '1.0.0', 100),
        ('build-cancel-conflict', 'app-a', 'main', 'android-apk', 'stable', '1.0.1', 101),
        ('build-new', 'app-a', 'main', 'android-apk', 'stable', '1.0.3', 103),
        ('build-other-channel', 'app-a', 'beta', 'android-apk', 'stable', '1.0.0', 100),
        ('build-unreleased', 'app-a', 'main', 'android-apk', 'stable', '9.0.0', 900);

      INSERT INTO releases
        (id, app_id, build_id, channel_id, product_type, release_type, status, created_at, updated_at)
      VALUES
        ('release-legacy-a', 'app-a', 'build-legacy-a', 'main', 'android-apk', 'stable', 'active', 10, 20),
        ('release-legacy-b', 'app-a', 'build-legacy-b', 'main', 'android-apk', 'stable', 'cancelled', 11, 21),
        ('release-cancelled', 'app-a', 'build-cancelled', 'main', 'android-apk', 'stable', 'cancelled', 12, 22),
        ('release-draft', 'app-a', 'build-draft', 'main', 'android-apk', 'stable', 'draft', 13, 23);

      INSERT INTO release_scopes (id, release_id, scope_type, scope_value, created_at)
      VALUES
        ('scope-a', 'release-legacy-a', 'full', 'all', 10),
        ('scope-b', 'release-legacy-b', 'device_group', 'legacy-group', 11),
        ('scope-cancelled', 'release-cancelled', 'full', 'all', 12),
        ('scope-draft', 'release-draft', 'full', 'all', 13);
    `);

    expect(() => db.exec(readFileSync(migrationPath, "utf8"))).not.toThrow();

    expect(db.prepare(`
      SELECT id, status, activated_at FROM releases ORDER BY id
    `).all()).toEqual([
      { id: "release-cancelled", status: "cancelled", activated_at: 22 },
      { id: "release-draft", status: "draft", activated_at: null },
      { id: "release-legacy-a", status: "active", activated_at: 20 },
      { id: "release-legacy-b", status: "cancelled", activated_at: 21 },
    ]);
    expect(db.prepare(`
      SELECT release_id, scope_type, scope_value FROM release_scopes ORDER BY id
    `).all()).toEqual([
      { release_id: "release-legacy-a", scope_type: "full", scope_value: "all" },
      { release_id: "release-legacy-b", scope_type: "device_group", scope_value: "legacy-group" },
      { release_id: "release-cancelled", scope_type: "full", scope_value: "all" },
      { release_id: "release-draft", scope_type: "full", scope_value: "all" },
    ]);

    const insertRelease = db.prepare(`
      INSERT INTO releases
        (id, app_id, build_id, channel_id, product_type, release_type, status,
         created_at, updated_at, activated_at)
      VALUES (?, 'app-a', ?, ?, 'android-apk', 'stable', ?, 30, 30, NULL)
    `);
    expect(() => insertRelease.run(
      "release-conflict",
      "build-conflict",
      "main",
      "draft",
    )).toThrow("release version already exists");
    expect(() => insertRelease.run(
      "release-cancel-conflict",
      "build-cancel-conflict",
      "main",
      "draft",
    )).toThrow("release version already exists");
    expect(() => insertRelease.run(
      "release-new",
      "build-new",
      "main",
      "draft",
    )).not.toThrow();
    expect(() => insertRelease.run(
      "release-other-channel",
      "build-other-channel",
      "beta",
      "draft",
    )).not.toThrow();

    expect(() => db.prepare(`
      UPDATE releases SET channel_id = 'beta' WHERE id = 'release-new'
    `).run()).toThrow("release identity is immutable");
    expect(() => db.prepare(`
      UPDATE builds SET version_code = 104 WHERE id = 'build-new'
    `).run()).toThrow("released build identity is immutable");
    expect(() => db.prepare(`
      UPDATE builds SET version_code = 901 WHERE id = 'build-unreleased'
    `).run()).not.toThrow();
    expect(() => db.prepare(`
      UPDATE releases SET status = 'active' WHERE id = 'release-new'
    `).run()).not.toThrow();
  });
});
