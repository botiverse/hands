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
  it("carries every column, index and foreign key across the rebuild", () => {
    // build_assets is rebuilt, so "did not throw" proves nothing: a copy that dropped
    // rows, or mapped a column to the wrong position, would satisfy it. Every one of
    // the 15 pre-existing columns is seeded with a distinct non-default value so a
    // mis-mapping cannot hide behind a default.
    const db = database({
      seedBeforeMigration: (db) => {
        seedApps(db);
        db.prepare(
          `INSERT INTO signing_credentials
             (id, owner_type, owner_id, platform, kind, label, encrypted_blob,
              created_at, updated_at)
           VALUES ('cred-1', 'app', 'app-a', 'android', 'keystore', 'c', 'x', 1, 1)`,
        ).run();
        db.prepare(
          `INSERT INTO build_assets
             (id, build_id, platform, arch, variant, filetype, r2_key, file_hash,
              size_bytes, signature, signing_credential_id, metadata_json,
              download_count, created_at, artifact_kind)
           VALUES ('pre-a', 'build-a', 'harmony', 'arm64', 'release', 'hap',
                   'r2/key/a', 'sha-a', 4242, 'sig-a', 'cred-1', '{"kept":true}',
                   77, 1700000001, 'installable')`,
        ).run();
        insertAsset(db, "pre-b", { arch: "x86" });
      },
    });

    expect(
      db.prepare("SELECT * FROM build_assets WHERE id = 'pre-a'").get(),
    ).toEqual({
      id: "pre-a", build_id: "build-a", platform: "harmony", arch: "arm64",
      variant: "release", filetype: "hap", r2_key: "r2/key/a", file_hash: "sha-a",
      size_bytes: 4242, signature: "sig-a", signing_credential_id: "cred-1",
      metadata_json: '{"kept":true}', download_count: 77, created_at: 1700000001,
      artifact_kind: "installable", slot_arch: "arm64", slot_variant: "release",
    });
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM build_assets").get(),
    ).toEqual({ n: 2 });

    // The indexes and foreign keys the old table carried must still be there.
    const indexes = db.prepare(
      `SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'build_assets'
         AND name NOT LIKE 'sqlite_%' ORDER BY name`,
    ).all().map((r) => (r as { name: string }).name);
    expect(indexes).toContain("idx_build_assets_build");
    expect(indexes).toContain("idx_build_assets_signing");
    expect(
      db.prepare("SELECT \"table\", \"from\" FROM pragma_foreign_key_list('build_assets') ORDER BY \"from\"").all(),
    ).toEqual([
      { table: "builds", from: "build_id" },
      { table: "signing_credentials", from: "signing_credential_id" },
    ]);
    expect(db.pragma("foreign_key_check")).toEqual([]);
  });

  it("refuses a seal row that names an attempt which never existed", () => {
    const db = database({ seedBeforeMigration: seedApps });
    insertAsset(db, "as1", { arch: "arm64" });
    // Dropping the FK let the ledger outlive its asset; it also removed the check
    // that a seal names something real when written. The trigger restores that at
    // INSERT only.
    expect(() =>
      db.prepare(
        `INSERT INTO build_asset_ingest_seal
           (asset_id, attempt, lease_generation, final_key, intent_at)
         VALUES ('no-such-asset', 99, 1, 'final-x', 1)`,
      ).run(),
    ).toThrow(/must name an existing attempt/);
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

  it("freezes seal identity against UPDATE while lifecycle columns still move", () => {
    const db = database({ seedBeforeMigration: seedApps });
    insertAsset(db, "as1", { arch: "arm64" });
    db.exec(`
      INSERT INTO build_asset_ingest_attempt
        (asset_id, attempt, declared_sha256, declared_size, staging_key,
         upload_expires_at, state, cleanup_state, created_at)
      VALUES ('as1', 1, 'sha', 10, 'staging-1', 99, 'verifying', 'live', 1);
      INSERT INTO build_asset_ingest_seal
        (asset_id, attempt, lease_generation, final_key, intent_at)
      VALUES ('as1', 1, 1, 'final-real', 1);
    `);
    // "Identity is immutable" was intent, not a rule: SQLite permits UPDATE of a
    // primary key, so a legitimate seal could be retargeted at a fictitious attempt
    // and the exact key of a real object lost.
    for (const set of [
      "asset_id = 'missing'",
      "attempt = 99",
      "lease_generation = 7",
      "final_key = 'arbitrary'",
      "intent_at = 2",
    ]) {
      expect(() => db.prepare(`UPDATE build_asset_ingest_seal SET ${set}`).run())
        .toThrow(/identity is immutable/);
    }
    // The lifecycle columns must still advance, or the ledger cannot record outcomes.
    expect(() =>
      db.prepare(
        "UPDATE build_asset_ingest_seal SET sealed_at = 5, outcome = 'committed', cleanup_receipt = 'r'",
      ).run(),
    ).not.toThrow();
    // The rule is "identity may not change", not "identity may not be named". A
    // full-row or retried write that restates the same identity is not a rewrite,
    // and refusing it would push callers into hand-built column lists.
    expect(() =>
      db.prepare(`
        UPDATE build_asset_ingest_seal
           SET asset_id = asset_id, attempt = attempt, lease_generation = lease_generation,
               final_key = final_key, intent_at = intent_at, sealed_at = 6
      `).run(),
    ).not.toThrow();
    expect(
      db.prepare("SELECT final_key, sealed_at FROM build_asset_ingest_seal").get(),
    ).toEqual({ final_key: "final-real", sealed_at: 6 });
  });

  it("cannot escape permanence by moving `outcome` off cleaned and then deleting", () => {
    const db = database({ seedBeforeMigration: seedApps });
    insertAsset(db, "as1", { arch: "arm64" });
    db.exec(`
      INSERT INTO build_asset_ingest_attempt
        (asset_id, attempt, declared_sha256, declared_size, staging_key,
         upload_expires_at, state, cleanup_state, created_at)
      VALUES ('as1', 1, 'sha', 10, 's1', 99, 'failed', 'tombstoned', 1);
      INSERT INTO build_asset_ingest_seal
        (asset_id, attempt, lease_generation, final_key, intent_at, outcome)
      VALUES ('as1', 1, 1, 'final-cleaned', 1, 'cleaned');
    `);
    // Guarding DELETE alone is not permanence: the delete guard reads `outcome`, so
    // whoever can write `outcome` can unlock the delete in two statements.
    for (const next of ["'superseded'", "'committed'", "NULL"]) {
      expect(() =>
        db.prepare(`UPDATE build_asset_ingest_seal SET outcome = ${next}`).run(),
      ).toThrow(/cannot leave the cleaned state/);
    }
    expect(
      db.prepare("SELECT outcome FROM build_asset_ingest_seal").pluck().get(),
    ).toBe("cleaned");
    // Terminal means no exit, not frozen: a cleanup receipt still lands afterwards,
    // and restating the same outcome is not a transition.
    expect(() =>
      db.prepare(
        "UPDATE build_asset_ingest_seal SET outcome = 'cleaned', cleanup_receipt = 'r2-tombstone-etag'",
      ).run(),
    ).not.toThrow();
    // And entering cleaned from any other state stays open.
    db.exec(`
      INSERT INTO build_asset_ingest_attempt
        (asset_id, attempt, declared_sha256, declared_size, staging_key,
         upload_expires_at, state, cleanup_state, created_at)
      VALUES ('as1', 2, 'sha', 10, 's2', 99, 'failed', 'live', 1);
      INSERT INTO build_asset_ingest_seal
        (asset_id, attempt, lease_generation, final_key, intent_at, outcome)
      VALUES ('as1', 2, 1, 'final-2', 1, 'superseded');
    `);
    expect(() =>
      db.prepare(
        "UPDATE build_asset_ingest_seal SET outcome = 'cleaned' WHERE attempt = 2",
      ).run(),
    ).not.toThrow();
    // The consequence: after the whole sequence the exact key of every tombstone is
    // still discoverable, which is the only reason the ledger exists.
    expect(() => db.prepare("DELETE FROM build_asset_ingest_seal").run())
      .toThrow(/permanent/);
    expect(
      db.prepare("SELECT COUNT(*) FROM build_asset_ingest_seal").pluck().get(),
    ).toBe(2);
  });

  it("keeps a tombstoned seal row permanently, while others stay reapable", () => {
    const db = database({ seedBeforeMigration: seedApps });
    insertAsset(db, "as1", { arch: "arm64" });
    db.exec(`
      INSERT INTO build_asset_ingest_attempt
        (asset_id, attempt, declared_sha256, declared_size, staging_key,
         upload_expires_at, state, cleanup_state, created_at)
      VALUES ('as1', 1, 'sha', 10, 's1', 99, 'failed', 'tombstoned', 1),
             ('as1', 2, 'sha', 10, 's2', 99, 'failed', 'live', 1);
      INSERT INTO build_asset_ingest_seal
        (asset_id, attempt, lease_generation, final_key, intent_at, outcome)
      VALUES ('as1', 1, 1, 'final-cleaned', 1, 'cleaned'),
             ('as1', 2, 1, 'final-superseded', 1, 'superseded');
    `);
    // A cleaned row records the exact key of a tombstone that is never removed;
    // deleting it would make a permanent object undiscoverable.
    expect(() =>
      db.prepare("DELETE FROM build_asset_ingest_seal WHERE outcome = 'cleaned'").run(),
    ).toThrow(/permanent/);
    // Retention may still reap rows that were never tombstoned.
    expect(() =>
      db.prepare("DELETE FROM build_asset_ingest_seal WHERE outcome = 'superseded'").run(),
    ).not.toThrow();
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


/**
 * The preflight guards.
 *
 * `wrangler d1 migrations apply --remote` posts this file to D1 as a single `/query`
 * string, and wrangler documents rollback only for the separate `--file` import path.
 * Rather than depend on an atomicity guarantee nobody here can read back, 0062 asserts
 * its preconditions before the first destructive statement.
 *
 * `db.exec` matches the pessimistic reading — it stops at the first error and does not
 * wrap the batch in a transaction — so whatever ran before the abort really is left
 * behind here. That is the point: these tests assert what survives, not what threw.
 */
describe("migration 0062 — preflight", () => {
  /** Prior migrations, then a seed, then 0062 — returning the database either way. */
  function attempt(seed: Seed) {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    for (const name of readdirSync(MIGRATION_DIR).sort()) {
      if (!name.endsWith(".sql")) continue;
      if (name === MIGRATION) break;
      db.exec(readFileSync(`${MIGRATION_DIR}${name}`, "utf8"));
    }
    seed(db);
    let error: Error | null = null;
    try {
      db.exec(readFileSync(`${MIGRATION_DIR}${MIGRATION}`, "utf8"));
    } catch (e) {
      error = e as Error;
    }
    return { db, error };
  }

  const tables = (db: Database.Database) =>
    db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .pluck()
      .all() as string[];

  const hasColumn = (db: Database.Database, table: string, column: string) =>
    (db.pragma(`table_info(${table})`) as { name: string }[]).some((c) => c.name === column);

  /** The consequence both guards exist for: the rebuild never started. */
  function expectUntouched(db: Database.Database, rows: number) {
    const names = tables(db);
    expect(names).toContain("build_assets");
    expect(names).not.toContain("build_assets_legacy");
    expect(names.filter((n) => n.includes("ingest"))).toEqual([]);
    expect(db.prepare("SELECT COUNT(*) FROM build_assets").pluck().get()).toBe(rows);
    // The first statements of 0062 proper are `ALTER TABLE builds`; if the guards sit
    // where they belong, even those have not run.
    expect(hasColumn(db, "builds", "asset_ingest_protocol_version")).toBe(false);
  }

  it("refuses to start when a row already holds the literal '-' sentinel", () => {
    const { db, error } = attempt((d) => {
      seedApps(d);
      insertAsset(d, "as1", { arch: "-" });
    });
    expect(error?.message).toMatch(/0062 preflight failed: .*literal '-'/);
    expectUntouched(db, 1);
  });

  it("refuses to start when two rows already share a normalised slot", () => {
    const { db, error } = attempt((d) => {
      seedApps(d);
      insertAsset(d, "as1", { arch: null });
      insertAsset(d, "as2", { arch: null });
    });
    expect(error?.message).toMatch(/0062 preflight failed: .*canonical slot/);
    expectUntouched(db, 2);
  });

  it("still applies once the offending data is resolved", () => {
    const { db, error } = attempt((d) => {
      seedApps(d);
      insertAsset(d, "as1", { arch: "-" });
    });
    expect(error).not.toBeNull();
    // A guard that fires leaves its scratch table behind — its CREATE committed, its
    // INSERT did not. If the retry did not drop it first, the second attempt would die
    // on "table already exists" and report a problem the operator does not have.
    expect(tables(db).some((n) => n.startsWith("_preflight_0062"))).toBe(true);
    db.prepare("UPDATE build_assets SET arch = NULL").run();
    expect(() => db.exec(readFileSync(`${MIGRATION_DIR}${MIGRATION}`, "utf8"))).not.toThrow();
    expect(tables(db)).toContain("build_asset_ingest_seal");
  });

  it("keeps the original rows recoverable after a successful rebuild", () => {
    const db = database({
      seedBeforeMigration: (d) => {
        seedApps(d);
        insertAsset(d, "as1", { arch: "arm64" });
        insertAsset(d, "as2", { arch: "x86_64" });
      },
    });
    // The preflight lowers the chance of the copy failing; this lowers the cost when
    // it fails anyway. If D1 runs the rest of a batch after a statement fails, the
    // assertion stops nothing — and dropping the source table in the same breath
    // would turn a recoverable outage into a permanent loss.
    expect(tables(db)).toContain("build_assets_legacy");
    // "Recoverable" is a claim about content, not about a table still being listed:
    // every column of every row must still be readable from the retained copy.
    const columns = (t: string) =>
      (db.pragma(`table_info(${t})`) as { name: string }[]).map((c) => c.name);
    const carried = columns("build_assets_legacy");
    expect(carried).toHaveLength(15);
    expect(columns("build_assets")).toEqual(expect.arrayContaining(carried));
    const list = carried.join(", ");
    expect(db.prepare(`SELECT ${list} FROM build_assets_legacy ORDER BY id`).all()).toEqual(
      db.prepare(`SELECT ${list} FROM build_assets ORDER BY id`).all(),
    );
    // The index names the rebuild reuses must have ended up on the new table; they
    // travelled with the old one through the RENAME and were dropped by name.
    const owner = (i: string) =>
      db
        .prepare("SELECT tbl_name FROM sqlite_master WHERE type = 'index' AND name = ?")
        .pluck()
        .get(i);
    expect(owner("idx_build_assets_build")).toBe("build_assets");
    expect(owner("idx_build_assets_signing")).toBe("build_assets");
  });

  it("leaves no scratch table behind on a clean apply", () => {
    const { db, error } = attempt((d) => {
      seedApps(d);
      insertAsset(d, "as1", { arch: "arm64" });
    });
    expect(error).toBeNull();
    expect(tables(db).filter((n) => n.startsWith("_preflight"))).toEqual([]);
  });
});
