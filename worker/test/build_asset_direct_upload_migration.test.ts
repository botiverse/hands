/**
 * Migration 0062 — direct upload for release build assets.
 *
 * Applied over the real prior migrations, and — importantly — over rows that already
 * exist. An earlier revision of this suite created the database empty and only then
 * inserted, so a CHECK that fails on pre-existing non-NULL data passed here and would
 * have failed on every real deployment. `seedBeforeMigration` exists so that fixture
 * cannot be convenient again.
 *
 * The kind-scoping case likewise uses a NON-NULL arch. With NULLs it passed for the
 * wrong reason: SQLite treats NULLs as distinct, so the old table constraint could
 * never fire and the test proved nothing about artifact_kind.
 */

import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

const MIGRATION_DIR = fileURLToPath(new URL("../../migrations/sql/", import.meta.url));
const MIGRATION = "0062_build_asset_direct_upload.sql";

type Seed = (db: Database.Database) => void;

/** Apply every migration; optionally insert rows *before* 0062 runs. */
function database(opts: { seedBeforeMigration?: Seed; includeMigration?: boolean } = {}) {
  const include = opts.includeMigration ?? true;
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  for (const name of readdirSync(MIGRATION_DIR).sort()) {
    if (!name.endsWith(".sql")) continue;
    if (name === MIGRATION) {
      if (!include) continue;
      opts.seedBeforeMigration?.(db);
    }
    db.exec(readFileSync(`${MIGRATION_DIR}${name}`, "utf8"));
  }
  if (!include) opts.seedBeforeMigration?.(db);
  return db;
}

function seedApps(db: Database.Database) {
  db.exec(`
    INSERT INTO apps (id, slug, name, platform, created_at) VALUES
      ('app-a', 'app-a', 'A', 'android', 1), ('app-b', 'app-b', 'B', 'android', 1);
    INSERT INTO builds (id, app_id, version_name, version_code, created_at, updated_at) VALUES
      ('build-a', 'app-a', '1.0.0', 1, 1, 1), ('build-b', 'app-b', '1.0.0', 1, 1, 1);
  `);
}

/** A legacy-shaped INSERT: no slot columns, exactly as existing writers issue it. */
function insertAsset(
  db: Database.Database,
  id: string,
  o: { build?: string; arch?: string | null; variant?: string | null; kind?: string } = {},
) {
  db.prepare(
    `INSERT INTO build_assets
       (id, build_id, platform, arch, variant, filetype, r2_key, file_hash, size_bytes,
        artifact_kind, created_at)
     VALUES (?, ?, 'android', ?, ?, 'apk', 'k', 'h', 1, ?, 1)`,
  ).run(id, o.build ?? "build-a", o.arch ?? null, o.variant ?? null, o.kind ?? "installable");
}

describe("migration 0062 — build asset direct upload", () => {
  it("applies over rows that already exist, and carries every one of them across", () => {
    // Every real database has rows with a non-NULL arch. A revision of this migration
    // added a defaulted column with a CHECK, which fails on exactly them.
    //
    // Asserting "did not throw" is not enough: build_assets is rebuilt here, and a
    // rebuild that dropped every row would satisfy that and nothing else.
    const db = database({
      seedBeforeMigration: (db) => {
        seedApps(db);
        insertAsset(db, "pre-a", { arch: "arm64", variant: "release" });
        insertAsset(db, "pre-b", { arch: "x86" });
        insertAsset(db, "pre-c");
        db.prepare("UPDATE build_assets SET metadata_json = '{\"kept\":1}', download_count = 7").run();
      },
    });
    const rows = db.prepare(
      `SELECT id, r2_key, file_hash, size_bytes, metadata_json, download_count,
              slot_arch, slot_variant
         FROM build_assets ORDER BY id`,
    ).all();
    expect(rows).toEqual([
      { id: "pre-a", r2_key: "k", file_hash: "h", size_bytes: 1, metadata_json: '{"kept":1}', download_count: 7, slot_arch: "arm64", slot_variant: "release" },
      { id: "pre-b", r2_key: "k", file_hash: "h", size_bytes: 1, metadata_json: '{"kept":1}', download_count: 7, slot_arch: "x86", slot_variant: "-" },
      { id: "pre-c", r2_key: "k", file_hash: "h", size_bytes: 1, metadata_json: '{"kept":1}', download_count: 7, slot_arch: "-", slot_variant: "-" },
    ]);
  });

  it("leaves existing writers alone: a legacy INSERT with no slot columns still works", () => {
    const db = database({ seedBeforeMigration: seedApps });
    expect(() => insertAsset(db, "legacy", { arch: "x86", variant: "release" })).not.toThrow();
  });

  it("scopes the slot by artifact_kind at a NON-NULL arch", () => {
    const db = database({ seedBeforeMigration: seedApps });
    insertAsset(db, "rel", { arch: "arm64", variant: "release" });
    // Rejected before 0062: the 0010 table constraint omitted artifact_kind.
    expect(() =>
      insertAsset(db, "qa", { arch: "arm64", variant: "release", kind: "ios-simulator-qa" }),
    ).not.toThrow();
  });

  it("rejects a duplicate canonical slot, including when arch and variant are NULL", () => {
    const db = database({ seedBeforeMigration: seedApps });
    insertAsset(db, "n1");
    expect(() => insertAsset(db, "n2")).toThrow(/UNIQUE constraint failed/);
    insertAsset(db, "a1", { arch: "arm64" });
    expect(() => insertAsset(db, "a2", { arch: "arm64" })).toThrow(/UNIQUE constraint failed/);
  });

  it("keeps the sentinel out of the input domain", () => {
    const db = database({ seedBeforeMigration: seedApps });
    expect(() => insertAsset(db, "sent", { arch: "-" })).toThrow(/CHECK constraint failed/);
  });

  it("derives the slot columns so a writer cannot disagree with them", () => {
    const db = database({ seedBeforeMigration: seedApps });
    // Generated columns: a caller supplying its own slot value — which would let two
    // rows share a raw slot while appearing distinct — is refused by SQLite itself.
    expect(() =>
      db.prepare(
        `INSERT INTO build_assets
           (id, build_id, platform, arch, variant, filetype, r2_key, file_hash,
            size_bytes, artifact_kind, created_at, slot_arch)
         VALUES ('forced', 'build-a', 'android', 'arm64', NULL, 'apk', 'k', 'h', 1,
                 'installable', 1, 'x86')`,
      ).run(),
    ).toThrow(/generated column/i);
  });

  it("does not backfill existing builds onto the new gate", () => {
    const db = database({ seedBeforeMigration: seedApps });
    const row = db.prepare(
      "SELECT asset_ingest_protocol_version AS v, required_asset_slots_json AS s FROM builds WHERE id = 'build-a'",
    ).get() as { v: number | null; s: string | null };
    expect(row.v).toBeNull();
    expect(row.s).toBeNull();
  });

  it("keeps the seal ledger when its asset is deleted", () => {
    const db = database({ seedBeforeMigration: seedApps });
    insertAsset(db, "as1", { arch: "arm64" });
    db.exec(`
      INSERT INTO build_asset_ingest_attempt
        (asset_id, attempt, declared_sha256, declared_size, staging_key,
         upload_expires_at, state, cleanup_state, created_at)
      VALUES ('as1', 1, 'sha', 10, 'staging-1', 99, 'ready', 'tombstoned', 1);
      INSERT INTO build_asset_ingest_seal
        (asset_id, attempt, lease_generation, final_key, intent_at, outcome)
      VALUES ('as1', 1, 1, 'final-as1-g1', 1, 'cleaned');
    `);
    db.prepare("DELETE FROM build_assets WHERE id = 'as1'").run();
    // A tombstone is permanent, so the row recording its exact key must outlive the
    // asset. A cascade here would delete the only record of an object that exists.
    expect(db.prepare("SELECT COUNT(*) AS n FROM build_asset_ingest_seal").get()).toEqual({ n: 1 });
  });

  it("gives each attempt and each lease generation its own row", () => {
    const db = database({ seedBeforeMigration: seedApps });
    insertAsset(db, "as1", { arch: "arm64" });
    const attempt = db.prepare(
      `INSERT INTO build_asset_ingest_attempt
         (asset_id, attempt, declared_sha256, declared_size, staging_key,
          upload_expires_at, state, cleanup_state, created_at)
       VALUES ('as1', ?, 'sha', 10, ?, 99, 'pending', 'live', 1)`,
    );
    attempt.run(1, "staging-1");
    attempt.run(2, "staging-2");
    const seal = db.prepare(
      `INSERT INTO build_asset_ingest_seal
         (asset_id, attempt, lease_generation, final_key, intent_at)
       VALUES ('as1', 1, ?, ?, 1)`,
    );
    seal.run(1, "final-g1");
    seal.run(2, "final-g2");
    expect(() => seal.run(1, "final-g1-again")).toThrow(/UNIQUE constraint failed/);
  });

  it("refuses a replay key that names a build or asset outside its own scope", () => {
    const db = database({ seedBeforeMigration: seedApps });
    insertAsset(db, "as-a", { build: "build-a", arch: "arm64" });
    const replay = db.prepare(
      `INSERT INTO build_asset_ingest_replay
         (app_id, build_id, idempotency_key, asset_id, request_digest, created_at)
       VALUES (?, ?, ?, ?, 'digest', 1)`,
    );
    replay.run("app-a", "build-a", "key-1", "as-a");
    // One asset may hold several keys — a CI rerun with a new key reuses it.
    expect(() => replay.run("app-a", "build-a", "key-2", "as-a")).not.toThrow();
    expect(() => replay.run("app-a", "build-a", "key-1", "as-a")).toThrow(/UNIQUE constraint/);
    // Another app's build must not be able to name this app's asset.
    expect(() => replay.run("app-b", "build-b", "key-x", "as-a")).toThrow(/FOREIGN KEY/);
    // Nor may a build be claimed under the wrong app.
    expect(() => replay.run("app-b", "build-a", "key-y", "as-a")).toThrow(/FOREIGN KEY/);
  });

  it("refuses states outside the frozen set", () => {
    const db = database({ seedBeforeMigration: seedApps });
    insertAsset(db, "as1", { arch: "arm64" });
    expect(() =>
      db.prepare(
        `INSERT INTO build_asset_ingest_attempt
           (asset_id, attempt, declared_sha256, declared_size, staging_key,
            upload_expires_at, state, cleanup_state, created_at)
         VALUES ('as1', 9, 'sha', 10, 'k', 99, 'done', 'live', 1)`,
      ).run(),
    ).toThrow(/CHECK constraint failed/);
  });
});
