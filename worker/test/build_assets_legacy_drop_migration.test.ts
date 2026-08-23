import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

// node:sqlite is a Node builtin that Vite's resolver does not yet recognise, so load it at
// runtime via createRequire rather than a static import (which Vite rewrites to a bare
// "sqlite" specifier and fails to resolve).
type SqliteRow = Record<string, unknown>;
interface Db {
  exec(sql: string): void;
  prepare(sql: string): { get(...params: unknown[]): SqliteRow };
  close(): void;
}
const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync } = nodeRequire("node:sqlite") as {
  DatabaseSync: new (path: string) => Db;
};

// 0068 guards a DROP behind an in-migration ⊇ assert that fails via a CHECK(ok=1)
// violation ordered BEFORE the DROP. Its correctness depends on the runner STOPPING at
// the first erroring statement (proven against wrangler d1 --local: the RED file aborts
// with "CHECK constraint failed: ok = 1" and build_assets_legacy survives). node:sqlite's
// exec() uses sqlite3_exec semantics — stop at first error — matching D1. The repo's other
// migration tests shell out to /usr/bin/sqlite3, but the CLI without -bail CONTINUES past
// errors, which would (wrongly) run the DROP even on a RED dataset; node:sqlite is the
// faithful and portable engine for the property under test.
const migration = readFileSync(
  fileURLToPath(
    new URL("../../migrations/sql/0068_drop_build_assets_legacy.sql", import.meta.url),
  ),
  "utf8",
);

// Column order matches the INSERTs below: id, build_id, r2_key, file_hash, signature,
// signing_credential_id, metadata_json, artifact_kind.
function seedSchema(db: Db): void {
  db.exec(`
    CREATE TABLE build_assets (
      id TEXT PRIMARY KEY, build_id TEXT, r2_key TEXT NOT NULL, file_hash TEXT NOT NULL,
      signature TEXT, signing_credential_id TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}', artifact_kind TEXT NOT NULL DEFAULT 'installable'
    );
    CREATE TABLE build_assets_legacy (
      id TEXT PRIMARY KEY, build_id TEXT, r2_key TEXT NOT NULL, file_hash TEXT NOT NULL,
      signature TEXT, signing_credential_id TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}', artifact_kind TEXT NOT NULL DEFAULT 'installable'
    );
  `);
}

function tableExists(db: Db, name: string): boolean {
  const row = db
    .prepare("SELECT count(*) AS c FROM sqlite_master WHERE type='table' AND name=?")
    .get(name) as { c: number };
  return row.c === 1;
}

describe("migration 0068 — guarded drop of build_assets_legacy", () => {
  it("RED: aborts and preserves the table when a legacy row is not in live (missing / never-migrated)", () => {
    const db = new DatabaseSync(":memory:");
    seedSchema(db);
    db.exec(
      `INSERT INTO build_assets VALUES ('a1','b1','k1','h1','sig1','cred1','{}','installable');
       INSERT INTO build_assets_legacy VALUES ('a1','b1','k1','h1','sig1','cred1','{}','installable');
       -- credential-bearing row that exists ONLY in legacy: the ⓶ danger case 0068 exists to catch.
       INSERT INTO build_assets_legacy VALUES ('orphan','b9','k9','h9','SECRETSIG','cred9','{}','installable');`,
    );
    expect(() => db.exec(migration)).toThrow(/CHECK constraint failed/);
    expect(tableExists(db, "build_assets_legacy")).toBe(true); // DROP after the abort did not run
    db.close();
  });

  it("RED: aborts when a legacy row's credential columns were mutated in live (id matches, values differ)", () => {
    const db = new DatabaseSync(":memory:");
    seedSchema(db);
    db.exec(
      `INSERT INTO build_assets VALUES ('a1','b1','k1','h1','sigLIVE','cred1','{}','installable');
       INSERT INTO build_assets_legacy VALUES ('a1','b1','k1','h1','sigOLD','cred1','{}','installable');`,
    );
    expect(() => db.exec(migration)).toThrow(/CHECK constraint failed/);
    expect(tableExists(db, "build_assets_legacy")).toBe(true);
    db.close();
  });

  it("GREEN: drops build_assets_legacy when live ⊇ legacy on the compared columns (NULL creds included)", () => {
    const db = new DatabaseSync(":memory:");
    seedSchema(db);
    db.exec(
      `INSERT INTO build_assets VALUES ('a1','b1','k1','h1','sig1','cred1','{}','installable');
       INSERT INTO build_assets VALUES ('a2','b1','k2','h2',NULL,NULL,'{}','app-icon');
       INSERT INTO build_assets_legacy VALUES ('a1','b1','k1','h1','sig1','cred1','{}','installable');
       INSERT INTO build_assets_legacy VALUES ('a2','b1','k2','h2',NULL,NULL,'{}','app-icon');`,
    );
    expect(() => db.exec(migration)).not.toThrow();
    expect(tableExists(db, "build_assets_legacy")).toBe(false);
    expect(tableExists(db, "build_assets")).toBe(true);
    db.close();
  });

  it("GREEN: metadata_json is excluded — a legacy row differing ONLY in metadata_json still drops (no false abort)", () => {
    const db = new DatabaseSync(":memory:");
    seedSchema(db);
    db.exec(
      `INSERT INTO build_assets VALUES ('a1','b1','k1','h1','sig1','cred1','{"downloads":9,"from_version_code":42}','delta-patch');
       INSERT INTO build_assets_legacy VALUES ('a1','b1','k1','h1','sig1','cred1','{}','delta-patch');`,
    );
    expect(() => db.exec(migration)).not.toThrow();
    expect(tableExists(db, "build_assets_legacy")).toBe(false);
    db.close();
  });

  it("GREEN: an empty legacy table is vacuously ⊇-satisfied and drops cleanly", () => {
    const db = new DatabaseSync(":memory:");
    seedSchema(db);
    db.exec(`INSERT INTO build_assets VALUES ('a1','b1','k1','h1','sig1','cred1','{}','installable');`);
    expect(() => db.exec(migration)).not.toThrow();
    expect(tableExists(db, "build_assets_legacy")).toBe(false);
    db.close();
  });
});
