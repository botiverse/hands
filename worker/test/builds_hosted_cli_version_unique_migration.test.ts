/**
 * Migration 0072 — one build per (app, version) for hosted CLI binaries.
 *
 * The point of this migration is a DATABASE constraint. Application-side checks
 * cannot serialize concurrent publishers, and a test that inserts sequentially
 * would pass whether or not the index exists — so every case here asserts the
 * index's own behaviour, from the database's point of view, and is written so
 * that removing the index fails it.
 *
 * The predicate is deliberately narrow: `source = 'cli' AND product_type =
 * 'cli-binary'`. Two neighbouring behaviours matter as much as the constraint
 * itself, because a broader predicate would have caused them:
 *   - a `source = 'cli'` build of ANOTHER product type must stay unconstrained
 *     (the Android/iOS CLI publishers also write source = 'cli'); and
 *   - the 0044 external index must keep governing external builds unchanged.
 */

import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

const MIGRATION_DIR = fileURLToPath(new URL("../../migrations/sql/", import.meta.url));
const MIGRATION = "0072_builds_hosted_cli_version_unique.sql";

/** Apply migrations in order, optionally seeding rows before 0072 runs. */
function database(opts: { seedBeforeMigration?: (db: Database.Database) => void } = {}) {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  for (const name of readdirSync(MIGRATION_DIR).sort()) {
    if (!name.endsWith(".sql")) continue;
    if (name === MIGRATION) opts.seedBeforeMigration?.(db);
    db.exec(readFileSync(`${MIGRATION_DIR}${name}`, "utf8"));
  }
  return db;
}

function seedApp(db: Database.Database, id = "app-a") {
  db.prepare(
    "INSERT INTO apps (id, slug, name, platform, created_at) VALUES (?, ?, ?, 'node', 1)",
  ).run(id, id, id);
  db.prepare(
    `INSERT INTO channels (id, app_id, slug, name, created_at) VALUES (?, ?, 'main', 'Main', 1)`,
  ).run(`ch-${id}`, id);
}

function insertBuild(
  db: Database.Database,
  id: string,
  o: { app?: string; version?: string; source?: string; productType?: string } = {},
) {
  const app = o.app ?? "app-a";
  db.prepare(
    `INSERT INTO builds (id, app_id, channel_id, product_type, release_type, version_name,
                         version_code, source, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'stable', ?, 1, ?, 'succeeded', 1, 1)`,
  ).run(id, app, `ch-${app}`, o.productType ?? "cli-binary", o.version ?? "1.0.0", o.source ?? "cli");
}

describe("migration 0072 — hosted cli-binary (app, version) uniqueness", () => {
  it("rejects a second hosted cli-binary build for the same app and version", () => {
    const db = database();
    seedApp(db);
    insertBuild(db, "b1");
    // The constraint is the migration's whole purpose: without it this insert
    // succeeds and a version would resolve to an ambiguous build.
    expect(() => insertBuild(db, "b2")).toThrow(/UNIQUE/i);
    expect(db.prepare("SELECT COUNT(*) AS n FROM builds").get()).toEqual({ n: 1 });
  });

  it("allows the same version on a different app, and a different version on the same app", () => {
    const db = database();
    seedApp(db, "app-a");
    seedApp(db, "app-b");
    insertBuild(db, "b1", { app: "app-a", version: "1.0.0" });
    insertBuild(db, "b2", { app: "app-b", version: "1.0.0" });
    insertBuild(db, "b3", { app: "app-a", version: "1.0.1" });
    expect(db.prepare("SELECT COUNT(*) AS n FROM builds").get()).toEqual({ n: 3 });
  });

  it("leaves a source='cli' build of another product type unconstrained", () => {
    const db = database();
    seedApp(db);
    // The Android/iOS CLI publishers also write source = 'cli'. A broader
    // predicate (`source IN ('external','cli')`) would have forbade this pair
    // and could have collided with existing data; naming the product type is
    // what keeps this migration scoped to hosted CLI binaries.
    insertBuild(db, "android-1", { productType: "android-apk" });
    insertBuild(db, "android-2", { productType: "android-apk" });
    expect(db.prepare("SELECT COUNT(*) AS n FROM builds").get()).toEqual({ n: 2 });
  });

  it("leaves the 0044 external constraint and its existing rows governed as before", () => {
    const db = database();
    seedApp(db);
    insertBuild(db, "ext-1", { source: "external" });
    // 0044 still owns this pair for external builds.
    expect(() => insertBuild(db, "ext-2", { source: "external" })).toThrow(/UNIQUE/i);
    // And an external build may coexist with a hosted one at the same version,
    // because the two indexes are disjoint (they must not cover each other).
    insertBuild(db, "hosted-1", { source: "cli" });
    expect(db.prepare("SELECT COUNT(*) AS n FROM builds").get()).toEqual({ n: 2 });
  });

  it("constrains rows that already existed before the migration ran", () => {
    // Symmetry with 0044's rule: an index created over existing data must still
    // refuse the second row afterwards. Seeding here proves the constraint is
    // not merely a forward-looking guard on newly inserted rows.
    const db = database({
      seedBeforeMigration: (db) => {
        seedApp(db);
        insertBuild(db, "pre-1");
      },
    });
    expect(db.prepare("SELECT COUNT(*) AS n FROM builds").get()).toEqual({ n: 1 });
    expect(() => insertBuild(db, "post-1")).toThrow(/UNIQUE/i);
  });
});
