import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { scopeFromSchema, tablesWritten } from "../../scripts/migration-fk-scope.mjs";

const migrationDir = fileURLToPath(new URL("../../migrations/sql/", import.meta.url));
const files = readdirSync(migrationDir).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();

function liveDb() {
  const db = new Database(":memory:");
  for (const f of files) db.exec(readFileSync(`${migrationDir}${f}`, "utf8"));
  return db;
}

function schema(db: Database.Database) {
  // Exactly the query the deploy readback runs against D1.
  return db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND sql IS NOT NULL").all();
}

function referencing(db: Database.Database, tables: string[]): string[] {
  return scopeFromSchema(tables, schema(db)) as string[];
}

function scope(db: Database.Database, migrations: string[]): string[] {
  const tables = [...new Set(migrations.flatMap((f) => tablesWritten(readFileSync(`${migrationDir}${f}`, "utf8")) as string[]))];
  return referencing(db, tables);
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
    const children = referencing(db, ["apps"]);
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
    expect(referencing(db, ["no_such_scratch_table"])).toEqual([]);
  });

  it("every live table a migration writes is reachable, so the scoped check is never weaker than the full one per table", () => {
    const db = liveDb();
    const live = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name").all() as Array<{ name: string }>).map((r) => r.name);
    expect(scope(db, files)).toEqual(expect.arrayContaining(live));
    for (const t of scope(db, files)) expect(() => db.prepare(`PRAGMA foreign_key_check("${t}")`).all()).not.toThrow();
  });

  it("rejects identifiers it cannot quote safely", () => {
    expect(() => scopeFromSchema(["apps'; DROP TABLE apps; --"], [])).toThrow(/plain identifier/);
  });
  it("fails closed when a run applied migrations but no file names were parsed", () => {
    const script = fileURLToPath(new URL("../../scripts/migration-fk-scope.mjs", import.meta.url));
    const run = spawnSync(process.execPath, [script, "tables", migrationDir], { encoding: "utf8" });
    expect(run.status).not.toBe(0);
    expect(run.stdout).toBe("");
    const ok = spawnSync(process.execPath, [script, "tables", migrationDir, "0088_asc_analytics_ingest.sql"], { encoding: "utf8" });
    expect(ok.status).toBe(0);
    expect(ok.stdout).toContain("asc_analytics_daily");
  });
  it("reads foreign keys from the schema exactly as SQLite resolves them, for every table", () => {
    const db = liveDb();
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND sql IS NOT NULL").all() as Array<{ name: string }>).map((r) => r.name);
    for (const parent of tables) {
      const viaPragma = (db.prepare(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?
         UNION SELECT m.name FROM sqlite_master m, pragma_foreign_key_list(m.name) f
         WHERE m.type = 'table' AND lower(f."table") = lower(?) ORDER BY name`,
      ).all(parent, parent) as Array<{ name: string }>).map((r) => r.name);
      expect(referencing(db, [parent]), parent).toEqual(viaPragma);
    }
  });

  it("refuses schema rows it cannot read rather than checking nothing", () => {
    expect(() => scopeFromSchema(["apps"], { error: "refused" })).toThrow(/array/);
    expect(() => scopeFromSchema(["apps"], [{ name: "apps" }])).toThrow(/name and sql/);
  });
});
