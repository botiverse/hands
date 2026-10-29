import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

/**
 * `ascAppIdFor` used to read `bundle_id, asc_app_id FROM apps`. Neither column has
 * ever existed on `apps`, so every App Store release route failed in production with
 * `D1_ERROR: no such column: bundle_id` -- while the unit tests stayed green, because
 * their fake DB returned `{ bundle_id, asc_app_id }` for any query at all. The stub
 * answered the question instead of the database.
 *
 * So this test does not stub: it builds the schema from the real migration chain and
 * runs the exact statement the route builds. If someone reintroduces a column that
 * does not exist, this fails at prepare() rather than in production.
 */

const migrationsDir = fileURLToPath(new URL("../../migrations/sql/", import.meta.url));
const routePath = fileURLToPath(new URL("../src/routes/app_store_release.ts", import.meta.url));

function migratedDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  for (const file of readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort()) {
    db.exec(readFileSync(migrationsDir + file, "utf8"));
  }
  return db;
}

describe("App Store release: bundle id comes from a column that exists", () => {
  it("builds the schema from the real migration chain", () => {
    const db = migratedDb();
    const cols = (t: string) =>
      (db.prepare(`PRAGMA table_info(${t})`).all() as Array<{ name: string }>).map((c) => c.name);

    // The premise of the bug: bundle ids are on channels, never on apps.
    expect(cols("channels")).toContain("bundle_id");
    expect(cols("apps")).not.toContain("bundle_id");
    expect(cols("apps")).not.toContain("asc_app_id");
    db.close();
  });

  it("the bundle-id query the route issues prepares and runs against that schema", () => {
    const db = migratedDb();
    db.prepare(
      "INSERT INTO apps (id, slug, name, platform, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run("app-1", "raft-ios", "Raft iOS", "ios", 0);
    db.prepare(
      "INSERT INTO channels (id, app_id, slug, name, bundle_id, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run("ch-1", "app-1", "main", "Main", "build.raft.app", 0);

    // Extract the real statements from the route rather than restating them here:
    // a copy would drift from the code and stop testing anything.
    const src = readFileSync(routePath, "utf8");
    const sqls: string[] = [];
    const re = /prepare\(\s*\n?\s*"([^"]+)"/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) {
      const q = m[1];
      if (/^\s*(SELECT|INSERT|UPDATE|DELETE)/i.test(q)) sqls.push(q);
    }
    expect(sqls.length).toBeGreaterThan(0);
    const bundleSql = sqls.filter((q) => q.includes("bundle_id"));
    expect(bundleSql.length).toBeGreaterThan(0);

    // The route uses D1-style numbered placeholders (?1); better-sqlite3 wants an
    // anonymous ?, so normalise for the prepare check only. The point of the check is
    // whether the named COLUMNS and TABLES exist, which is unaffected by binding style.
    const normalise = (sql: string) => sql.replace(/\?\d+/g, "?");
    for (const sql of sqls) {
      const args = Array((normalise(sql).match(/\?/g) ?? []).length).fill("app-1");
      expect(
        () => db.prepare(normalise(sql)).get(...args),
        "route SQL must prepare: " + sql,
      ).not.toThrow();
    }

    const row = db.prepare(normalise(bundleSql[0])).get("app-1") as { bundle_id: string | null };
    expect(row.bundle_id).toBe("build.raft.app");
    db.close();
  });

  it("the old query is what fails -- this is the regression being pinned", () => {
    const db = migratedDb();
    expect(() => db.prepare("SELECT bundle_id, asc_app_id FROM apps WHERE id = ?")).toThrow(
      /no such column/i,
    );
    db.close();
  });

  it("the route file contains no reference to the columns that do not exist", () => {
    const src = readFileSync(routePath, "utf8");
    expect(src).not.toMatch(/FROM\s+apps\s+WHERE[^;]*bundle_id/i);
    expect(src).not.toMatch(/asc_app_id\s+FROM\s+apps/i);
  });
});
