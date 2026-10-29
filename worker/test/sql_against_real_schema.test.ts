import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

/**
 * Every literal SQL statement in worker/src must prepare against the real schema.
 *
 * `ascAppIdFor` shipped `SELECT bundle_id, asc_app_id FROM apps` -- columns that never
 * existed on `apps`. It failed in production on every App Store release route while the
 * unit tests stayed green, because their fake DB answered with whatever shape the code
 * asked for. Unit tests can confirm behaviour; only the schema can confirm a statement
 * is runnable at all.
 *
 * This suite loads the migration chain once and prepares each literal statement found in
 * the source. Statements built by interpolation are skipped -- they cannot be checked
 * without knowing the interpolated identifiers, and claiming otherwise would be the same
 * false confidence this test exists to remove.
 */

const srcDir = fileURLToPath(new URL("../src/", import.meta.url));
const migrationsDir = fileURLToPath(new URL("../../migrations/sql/", import.meta.url));

function tsFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) tsFiles(p, out);
    else if (entry.endsWith(".ts")) out.push(p);
  }
  return out;
}

const VERB = /^\s*(SELECT|INSERT|UPDATE|DELETE|WITH)\b/i;

function literalStatements(src: string): string[] {
  const found: string[] = [];
  const re = /`([^`]+)`|"([^"\n]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const text = m[1] ?? m[2];
    if (text === undefined || !VERB.test(text)) continue;
    // Skip interpolated statements: the identifiers are runtime values.
    if (/\$\{/.test(text)) continue;
    // Skip cases where a verb-looking string is actually a message fragment.
    if (!/\b(FROM|INTO|SET|VALUES)\b/i.test(text)) continue;
    found.push(text);
  }
  return found;
}

describe("SQL in worker/src prepares against the migrated schema", () => {
  it("no literal statement references a table or column that does not exist", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    for (const f of readdirSync(migrationsDir).filter((x) => x.endsWith(".sql")).sort()) {
      db.exec(readFileSync(join(migrationsDir, f), "utf8"));
    }

    const failures: string[] = [];
    let checked = 0;
    for (const file of tsFiles(srcDir)) {
      const src = readFileSync(file, "utf8");
      for (const sql of literalStatements(src)) {
        // Numbered placeholders are D1 style; better-sqlite3 only wants anonymous ones.
        const normalised = sql.replace(/\?\d+/g, "?");
        checked++;
        try {
          db.prepare(normalised);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (/no such (column|table)/i.test(msg)) {
            failures.push(`${file.replace(srcDir, "")}: ${msg} :: ${sql.slice(0, 90)}`);
          }
        }
      }
    }

    // Guard against the extractor silently matching nothing.
    expect(checked).toBeGreaterThan(500);
    expect(failures, failures.join("\n")).toEqual([]);
    db.close();
  });
});
