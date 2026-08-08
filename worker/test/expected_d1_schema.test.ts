/**
 * The deploy readback gate compares a real database against the structure the
 * migration files produce. These tests are about the comparison itself: a gate that
 * cannot fail is worse than no gate, because it reads as evidence.
 *
 * The case that motivated it: after 0062, `table_info` reports the same column count
 * for `build_assets` as it did before, because it does not show generated columns. A
 * readback built on column counts is green against a database that never applied the
 * migration at all.
 */

import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import {
  FINGERPRINT_SQL,
  buildExpected,
  fingerprint,
} from "../scripts/expected-d1-schema.mjs";

const MIGRATION_DIR = fileURLToPath(new URL("../../migrations/sql/", import.meta.url));

/** Every migration except those matching `skip` — a database frozen in the past. */
function chainWithout(skip: RegExp) {
  const db = new Database(":memory:");
  for (const name of readdirSync(MIGRATION_DIR).sort()) {
    if (!name.endsWith(".sql") || skip.test(name)) continue;
    db.exec(readFileSync(MIGRATION_DIR + name, "utf8"));
  }
  return db;
}

describe("deploy readback — expected schema", () => {
  it("matches itself, so a correct database is not reported as drifted", () => {
    expect(fingerprint(buildExpected())).toEqual(fingerprint(buildExpected()));
  });

  it("fails a database left on the previous migration", () => {
    const current = fingerprint(buildExpected());
    const stale = fingerprint(chainWithout(/^0062/));
    expect(stale).not.toEqual(current);
    // Specifically the columns `table_info` cannot see, which is why a count is not
    // enough on its own.
    const columnsOf = (lines: string[]) =>
      lines.find((l) => l.startsWith("columns build_assets "));
    expect(columnsOf(current)).toContain("slot_arch,slot_variant");
    expect(columnsOf(stale)).not.toContain("slot_arch");
  });

  it("would have passed the check it replaces — the column count is identical", () => {
    const count = (db: Database.Database) =>
      db.prepare("SELECT COUNT(*) FROM pragma_table_info('build_assets')").pluck().get();
    // Not a property worth keeping; a record of why the weaker check was dropped.
    expect(count(chainWithout(/^0062/))).toBe(count(buildExpected()));
  });

  it("notices a single missing index, not only a whole missing migration", () => {
    const db = buildExpected();
    db.exec("DROP INDEX idx_build_assets_canonical_slot");
    expect(fingerprint(db)).not.toEqual(fingerprint(buildExpected()));
  });

  it("ignores what the substrate owns rather than what our migrations declare", () => {
    const db = buildExpected();
    // These exist on a real D1 database and in no migration file. Treating them as
    // drift would make the gate cry wolf on every deploy, and a gate that always
    // fails gets switched off.
    db.exec(`
      CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY, name TEXT, applied_at TEXT);
      CREATE TABLE _cf_METADATA (key INTEGER PRIMARY KEY, value BLOB);
      CREATE TABLE _preflight_0062_sentinel (n INTEGER);
    `);
    expect(fingerprint(db)).toEqual(fingerprint(buildExpected()));
  });

  it("uses one SQL text for both sides, so the two are the same measurement", () => {
    // The remote side runs this string verbatim through wrangler. If the script
    // computed the local side some other way, the diff would compare two things that
    // merely resemble each other.
    expect(FINGERPRINT_SQL).toContain("pragma_table_xinfo");
    expect(FINGERPRINT_SQL).not.toMatch(/\n/);
    const viaSql = buildExpected().prepare(FINGERPRINT_SQL).pluck().all().sort();
    expect(viaSql).toEqual(fingerprint(buildExpected()));
  });
});
