/**
 * Describe the structure the migration files produce, so a real database can be
 * compared against it after `wrangler d1 migrations apply`.
 *
 * A row in `d1_migrations` records that a file ran. It does not say the database now
 * looks the way that file describes, and the two can disagree — an apply can exit
 * zero having done less than it claimed. Comparing structure is what closes that gap.
 *
 * Counting columns is not enough: `table_info` omits generated columns, so a table can
 * gain two and report the same count before and after. This uses `table_xinfo`, which
 * shows them. A database still sitting on the previous migration passes a column count
 * and fails this.
 *
 * The same SQL runs locally and remotely — `--sql` prints it for the remote side —
 * because two queries that merely intend to measure the same thing are a comparison
 * between two possibly different things.
 *
 * Objects belonging to the substrate rather than to our migrations are excluded:
 * SQLite internals, D1 internals, wrangler's bookkeeping table, and the scratch tables
 * a failed preflight leaves behind. Those legitimately differ between a database built
 * from files and one that has lived in production, so including them would produce a
 * difference that means nothing and hide the ones that mean something.
 */

import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const MIGRATION_DIR = fileURLToPath(new URL("../../migrations/sql/", import.meta.url));

/** Substring tests rather than LIKE, so no escape survives a trip through the shell. */
const OURS = `substr(name, 1, 7) <> 'sqlite_'
          AND substr(name, 1, 3) <> '_cf'
          AND substr(name, 1, 10) <> '_preflight'
          AND name <> 'd1_migrations'`;

export const FINGERPRINT_SQL = [
  // tbl_name is what makes this an ownership check rather than an existence check.
  // Without it, an index attached to build_assets_legacy and the same index attached
  // to build_assets produce the identical line and the diff passes — which is exactly
  // the false green the criterion was written to catch. For a table, tbl_name equals
  // its own name, so including it costs nothing there.
  `SELECT type || ' ' || name || ' ' || coalesce(tbl_name, '') AS line FROM sqlite_master WHERE ${OURS}`,
  `UNION ALL`,
  `SELECT 'columns ' || m.name || ' ' ||`,
  `       coalesce((SELECT group_concat(x.name, ',') FROM pragma_table_xinfo(m.name) x), '')`,
  `  FROM sqlite_master m WHERE m.type = 'table' AND ${OURS.replace(/name/g, "m.name")}`,
]
  .join(" ")
  .replace(/\s+/g, " ");

export function buildExpected() {
  const db = new Database(":memory:");
  for (const name of readdirSync(MIGRATION_DIR).sort()) {
    if (name.endsWith(".sql")) db.exec(readFileSync(MIGRATION_DIR + name, "utf8"));
  }
  return db;
}

export const fingerprint = (db) => db.prepare(FINGERPRINT_SQL).pluck().all().sort();

if (import.meta.url === `file://${process.argv[1]}`) {
  const out = process.argv.includes("--sql")
    ? FINGERPRINT_SQL
    : fingerprint(buildExpected()).join("\n");
  process.stdout.write(out + "\n");
}
