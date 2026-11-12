import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { referencingSql, tablesWritten } from "../../scripts/migration-fk-scope.mjs";

const migrationDir = fileURLToPath(new URL("../../migrations/sql/", import.meta.url));
const files = readdirSync(migrationDir).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();

function liveDb() {
  const db = new Database(":memory:");
  for (const f of files) db.exec(readFileSync(`${migrationDir}${f}`, "utf8"));
  return db;
}

function scope(db: Database.Database, migrations: string[]): string[] {
  const tables = [...new Set(migrations.flatMap((f) => tablesWritten(readFileSync(`${migrationDir}${f}`, "utf8")) as string[]))];
  return (db.prepare(referencingSql(tables)).all() as Array<{ name: string }>).map((r) => r.name);
}

describe("deploy readback foreign-key scope", () => {
  it("scopes the check to the tables the applied migrations write", () => {
    const db = liveDb();
    expect(scope(db, ["0088_asc_analytics_ingest.sql"])).toEqual([
      "asc_analytics_daily", "asc_analytics_daily_totals", "asc_analytics_ingest_schedule", "asc_analytics_instances",
    ]);
  });

  it("includes child tables whose foreign keys point at a written parent", () => {
    const db = liveDb();
    const children = (db.prepare(referencingSql(["apps"])).all() as Array<{ name: string }>).map((r) => r.name);
    expect(children).toContain("apps");
    expect(children).toContain("channels");
    expect(children.length).toBeGreaterThan(5);
  });

  it("does not mistake trigger keywords for tables and drops tables that no longer exist", () => {
    expect(tablesWritten("CREATE TRIGGER t AFTER UPDATE OF status ON builds BEGIN UPDATE apps SET x = 1; END;"))
      .toEqual(["apps"]);
    expect(tablesWritten("-- DELETE FROM commented\nCREATE TABLE IF NOT EXISTS \"a_b\" (x); ALTER TABLE a_b RENAME TO c_d; DROP TABLE IF EXISTS tmp;"))
      .toEqual(["a_b", "c_d", "tmp"]);
    const db = liveDb();
    expect((db.prepare(referencingSql(["no_such_scratch_table"])).all())).toEqual([]);
  });

  it("every live table a migration writes is reachable, so the scoped check is never weaker than the full one per table", () => {
    const db = liveDb();
    const live = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name").all() as Array<{ name: string }>).map((r) => r.name);
    expect(scope(db, files)).toEqual(expect.arrayContaining(live));
    for (const t of scope(db, files)) expect(() => db.prepare(`PRAGMA foreign_key_check("${t}")`).all()).not.toThrow();
  });

  it("rejects identifiers it cannot quote safely", () => {
    expect(() => referencingSql(["apps'; DROP TABLE apps; --"])).toThrow(/plain identifier/);
  });
});
