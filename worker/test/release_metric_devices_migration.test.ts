import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const migrationPath = fileURLToPath(
  new URL("../../migrations/sql/0052_release_metric_devices.sql", import.meta.url),
);

describe("release metric device migration", () => {
  it("deduplicates one device per release and metric kind and cascades with release", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    db.exec("CREATE TABLE releases(id TEXT PRIMARY KEY)");
    db.exec("INSERT INTO releases(id) VALUES ('release-1')");
    db.exec(readFileSync(migrationPath, "utf8"));

    const insert = db.prepare(
      `INSERT INTO release_metric_devices
       (release_id, metric_kind, device_id, first_checked_at, last_checked_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(release_id, metric_kind, device_id) DO UPDATE SET
         last_checked_at = excluded.last_checked_at`,
    );
    insert.run("release-1", "offered", "device-1", 10, 10);
    insert.run("release-1", "offered", "device-1", 20, 20);
    insert.run("release-1", "current", "device-1", 30, 30);
    expect(db.prepare(
      "SELECT metric_kind, first_checked_at, last_checked_at FROM release_metric_devices ORDER BY metric_kind",
    ).all()).toEqual([
      { metric_kind: "current", first_checked_at: 30, last_checked_at: 30 },
      { metric_kind: "offered", first_checked_at: 10, last_checked_at: 20 },
    ]);
    expect(() => insert.run("release-1", "invalid", "device-2", 40, 40)).toThrow();

    db.exec("DELETE FROM releases WHERE id = 'release-1'");
    expect(db.prepare("SELECT COUNT(*) AS n FROM release_metric_devices").get()).toEqual({ n: 0 });
  });
});
