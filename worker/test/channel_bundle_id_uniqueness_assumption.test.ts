import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

/**
 * `channels.bundle_id` has no uniqueness constraint, so two channels of the same app
 * may legitimately share one -- an app's `debug` channel carries the same bundle id as
 * `main`, because both are the same App Store app.
 *
 * Every read of a channel bundle id is therefore only unambiguous because it also pins
 * `slug = 'main'`. Nothing encodes that today except the queries themselves; a future
 * "find the channel for this bundle id" lookup would silently match two rows and pick
 * whichever the database returned first.
 *
 * This pins the assumption at the level that matters: the shape of the queries.
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

describe("channel bundle ids are only read from the main channel", () => {
  it("the schema does not make bundle_id unique, which is why the slug filter matters", () => {
    const db = new Database(":memory:");
    for (const f of readdirSync(migrationsDir).filter((x) => x.endsWith(".sql")).sort()) {
      db.exec(readFileSync(join(migrationsDir, f), "utf8"));
    }
    const indexes = db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'channels' AND sql IS NOT NULL")
      .all() as Array<{ sql: string }>;
    const uniqueOnBundleId = indexes.filter((i) => /unique/i.test(i.sql) && /bundle_id/i.test(i.sql));
    expect(uniqueOnBundleId).toEqual([]);
    db.close();
  });

  it("every query that selects a channel's bundle_id also pins slug = 'main'", () => {
    const offenders: string[] = [];
    for (const file of tsFiles(srcDir)) {
      const src = readFileSync(file, "utf8");
      // Take the whole statement up to the end of the string literal. Stopping at a
      // quote would truncate exactly where `slug = 'main'` lives and report every
      // correctly-scoped query as an offender.
      for (const match of src.matchAll(/SELECT\s+bundle_id\s+FROM\s+channels[^`"]*/gi)) {
        const statement = match[0];
        if (!/slug\s*=\s*'main'/i.test(statement)) {
          offenders.push(`${file.replace(srcDir, "")}: ${statement.slice(0, 90)}`);
        }
      }
    }
    expect(offenders, offenders.join("\n")).toEqual([]);
  });
});
