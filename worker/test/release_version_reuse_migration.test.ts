import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

const identityMigrationPath = fileURLToPath(
  new URL("../../migrations/sql/0053_release_identity_and_activation.sql", import.meta.url),
);
const reuseMigrationPath = fileURLToPath(
  new URL("../../migrations/sql/0056_cancelled_release_version_reuse.sql", import.meta.url),
);

describe("cancelled release version reuse migration", () => {
  it("keeps every remote-D1 trigger body on one physical line", () => {
    const triggerLines = readFileSync(reuseMigrationPath, "utf8")
      .split("\n")
      .filter((line) => line.startsWith("CREATE TRIGGER"));

    expect(triggerLines).toHaveLength(2);
    for (const line of triggerLines) {
      expect(line).toContain(" BEGIN ");
      expect(line).toMatch(/ END;$/);
      expect(line.match(/\bEND;/g)).toHaveLength(1);
    }
  });

  it("releases only cancelled identities and prevents conflicting reactivation", () => {
    const db = new Database(":memory:");
    db.exec(`
      CREATE TABLE builds (
        id TEXT PRIMARY KEY,
        app_id TEXT NOT NULL,
        channel_id TEXT,
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
        ('build-old', 'app-a', 'main', 'android-apk', 'stable', '1.8.0', 1080000),
        ('build-new', 'app-a', 'main', 'android-apk', 'stable', '1.8.0', 1080000),
        ('build-third', 'app-a', 'main', 'android-apk', 'stable', '1.8.0', 1080000),
        ('build-other', 'app-a', 'beta', 'android-apk', 'stable', '1.8.0', 1080000);

      INSERT INTO releases
        (id, app_id, build_id, channel_id, product_type, release_type, status, created_at, updated_at)
      VALUES
        ('release-old', 'app-a', 'build-old', 'main', 'android-apk', 'stable', 'draft', 1, 1);
    `);

    db.exec(readFileSync(identityMigrationPath, "utf8"));
    db.exec(readFileSync(reuseMigrationPath, "utf8"));

    const insertRelease = db.prepare(`
      INSERT INTO releases
        (id, app_id, build_id, channel_id, product_type, release_type, status,
         created_at, updated_at, activated_at)
      VALUES (?, 'app-a', ?, ?, 'android-apk', 'stable', 'draft', 2, 2, NULL)
    `);

    expect(() => insertRelease.run(
      "release-new",
      "build-new",
      "main",
    )).toThrow("release version already exists");

    for (const reservedStatus of ["active", "superseded"]) {
      db.prepare("UPDATE releases SET status = ? WHERE id = 'release-old'")
        .run(reservedStatus);
      expect(() => insertRelease.run(
        `release-new-${reservedStatus}`,
        "build-new",
        "main",
      )).toThrow("release version already exists");
    }

    db.prepare("UPDATE releases SET status = 'cancelled' WHERE id = 'release-old'").run();
    expect(() => insertRelease.run(
      "release-new",
      "build-new",
      "main",
    )).not.toThrow();
    expect(() => insertRelease.run(
      "release-third",
      "build-third",
      "main",
    )).toThrow("release version already exists");
    expect(() => insertRelease.run(
      "release-other",
      "build-other",
      "beta",
    )).not.toThrow();

    expect(() => db.prepare(
      "UPDATE releases SET status = 'draft' WHERE id = 'release-old'",
    ).run()).toThrow("release version already exists");
    db.prepare("UPDATE releases SET status = 'cancelled' WHERE id = 'release-new'").run();
    expect(() => db.prepare(
      "UPDATE releases SET status = 'draft' WHERE id = 'release-old'",
    ).run()).not.toThrow();

    expect(db.prepare(
      `SELECT id, status FROM releases
       WHERE channel_id = 'main' ORDER BY id`,
    ).all()).toEqual([
      { id: "release-new", status: "cancelled" },
      { id: "release-old", status: "draft" },
    ]);
  });
});
