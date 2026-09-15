import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  fileURLToPath(new URL("../../migrations/sql/0073_builds_artifact_mode.sql", import.meta.url)),
  "utf8",
);

/** Minimal `builds` + `external_build_targets` shape, enough for this migration. */
function freshDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE builds (
      id TEXT PRIMARY KEY,
      app_id TEXT NOT NULL,
      version_name TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'web'
    );
    CREATE TABLE external_build_targets (
      build_id TEXT NOT NULL,
      target TEXT NOT NULL
    );
  `);
  return db;
}

describe("0073 builds.artifact_mode", () => {
  it("adds the column as NOT NULL DEFAULT hands_r2 so existing rows stay total", () => {
    const db = freshDb();
    db.exec("INSERT INTO builds (id, app_id, version_name, source) VALUES ('b1','a','1.0.0','cli')");
    db.exec(migration);

    const row = db
      .prepare("SELECT artifact_mode FROM builds WHERE id = 'b1'")
      .get() as { artifact_mode: string };
    expect(row.artifact_mode).toBe("hands_r2");

    const cols = db.prepare("PRAGMA table_info(builds)").all() as Array<{
      name: string;
      notnull: number;
      dflt_value: string | null;
    }>;
    const added = cols.find((c) => c.name === "artifact_mode");
    expect(added?.notnull).toBe(1);
    expect(added?.dflt_value).toBe("'hands_r2'");
  });

  it("does not touch source and does not add or remove a source value", () => {
    const db = freshDb();
    db.exec("INSERT INTO builds (id, app_id, version_name, source) VALUES ('ext','a','1.0.0','external')");
    db.exec(migration);

    const row = db
      .prepare("SELECT source, artifact_mode FROM builds WHERE id = 'ext'")
      .get() as { source: string; artifact_mode: string };
    // source keeps its creation-path meaning; placement simply defaults until backfilled.
    expect(row.source).toBe("external");
    expect(row.artifact_mode).toBe("hands_r2");
  });

  it("keeps the 0044 predicate matching exactly the external rows (index not moved)", () => {
    const db = freshDb();
    db.exec(migration);
    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index'")
      .all() as Array<{ name: string }>;
    // This migration must not create or move a unique index keyed on artifact_mode.
    expect(indexes.map((i) => i.name)).not.toContain("idx_builds_external_app_version");
  });

  it("accepts both documented placement values", () => {
    const db = freshDb();
    db.exec(migration);
    db.exec("INSERT INTO builds (id, app_id, version_name, source, artifact_mode) VALUES ('r','a','1','cli','hands_r2')");
    db.exec("INSERT INTO builds (id, app_id, version_name, source, artifact_mode) VALUES ('e','a','2','external','external')");
    const rows = db
      .prepare("SELECT artifact_mode FROM builds ORDER BY id")
      .all() as Array<{ artifact_mode: string }>;
    expect(rows.map((r) => r.artifact_mode)).toEqual(["external", "hands_r2"]);
  });

  it("rejects an unknown placement on insert and on update", () => {
    const db = freshDb();
    db.exec(migration);
    db.exec("INSERT INTO builds (id, app_id, version_name, source) VALUES ('x','a','1','cli')");

    expect(() =>
      db.exec("INSERT INTO builds (id, app_id, version_name, source, artifact_mode) VALUES ('y','a','2','cli','gcs')"),
    ).toThrow(/artifact_mode must be hands_r2 or external/);

    expect(() => db.exec("UPDATE builds SET artifact_mode = 'elsewhere' WHERE id = 'x'")).toThrow(
      /artifact_mode must be hands_r2 or external/,
    );
  });

  it("backs external-declared builds to 'external' from evidence, not from a guess", () => {
    // Proves the backfill set is derivable: rows with declared targets are exactly the
    // rows that must become 'external'. (The production write itself is separately gated.)
    const db = freshDb();
    db.exec("INSERT INTO builds (id, app_id, version_name, source) VALUES ('with_t','a','1','external')");
    db.exec("INSERT INTO builds (id, app_id, version_name, source) VALUES ('no_t','a','2','cli')");
    db.exec("INSERT INTO external_build_targets (build_id, target) VALUES ('with_t','linux-x64')");
    db.exec(migration);

    db.exec(`UPDATE builds SET artifact_mode = 'external'
             WHERE id IN (SELECT build_id FROM external_build_targets)`);

    const rows = db
      .prepare("SELECT id, artifact_mode FROM builds ORDER BY id")
      .all() as Array<{ id: string; artifact_mode: string }>;
    expect(rows).toEqual([
      { id: "no_t", artifact_mode: "hands_r2" },
      { id: "with_t", artifact_mode: "external" },
    ]);
  });
});
