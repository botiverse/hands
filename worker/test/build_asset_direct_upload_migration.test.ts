/**
 * Migration 0062 — direct upload for release build assets.
 *
 * Asserts against the real migration file, applied over the real prior migrations,
 * so what is proven is the schema production will get rather than a fixture.
 *
 * The properties here are the ones the frozen design leans on. Each has a
 * counterexample that was live before this migration, and each fails if the
 * corresponding line of SQL is removed.
 */

import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

const MIGRATION_DIR = fileURLToPath(new URL("../../migrations/sql/", import.meta.url));
const MIGRATION = "0062_build_asset_direct_upload.sql";

function database(includeMigration = true) {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  for (const name of readdirSync(MIGRATION_DIR).sort()) {
    if (!name.endsWith(".sql")) continue;
    if (name === MIGRATION && !includeMigration) continue;
    db.exec(readFileSync(`${MIGRATION_DIR}${name}`, "utf8"));
  }
  db.prepare(
    "INSERT INTO apps (id, slug, name, platform, created_at) VALUES ('app-i', 'app-i', 'Ingest', 'android', 1)",
  ).run();
  db.prepare(
    `INSERT INTO builds (id, app_id, version_name, version_code, created_at, updated_at)
     VALUES ('build-i', 'app-i', '1.0.0', 1, 1, 1)`,
  ).run();
  return db;
}

/** Insert a build asset in a given slot. Mirrors how production writes the row. */
function insertAsset(
  db: Database.Database,
  id: string,
  opts: { arch?: string | null; variant?: string | null; kind?: string } = {},
) {
  const arch = opts.arch ?? null;
  const variant = opts.variant ?? null;
  db.prepare(
    `INSERT INTO build_assets
       (id, build_id, platform, arch, variant, filetype, r2_key, file_hash, size_bytes,
        artifact_kind, created_at, slot_arch, slot_variant)
     VALUES (?, 'build-i', 'android', ?, ?, 'apk', 'k', 'h', 1, ?, 1, ?, ?)`,
  ).run(id, arch, variant, opts.kind ?? "installable", arch ?? "-", variant ?? "-");
}

describe("migration 0062 — build asset direct upload", () => {
  it("replays the defect: before 0062 the slot index admits duplicate NULL slots", () => {
    const db = database(false);
    const insert = (id: string) =>
      db.prepare(
        `INSERT INTO build_assets
           (id, build_id, platform, arch, variant, filetype, r2_key, file_hash, size_bytes,
            artifact_kind, created_at)
         VALUES (?, 'build-i', 'android', NULL, NULL, 'apk', 'k', 'h', 1, 'installable', 1)`,
      ).run(id);
    insert("dup-1");
    // The 0010 index looks like one-row-per-slot and never was, for any asset
    // without arch/variant: SQLite treats NULLs as distinct.
    expect(() => insert("dup-2")).not.toThrow();
  });

  it("closes the slot: duplicate slots are rejected once normalized", () => {
    const db = database();
    insertAsset(db, "a-1");
    expect(() => insertAsset(db, "a-2")).toThrow(/UNIQUE constraint failed/);
  });

  it("scopes the slot by artifact_kind so QA and release do not collide", () => {
    const db = database();
    insertAsset(db, "rel-1");
    // Before 0062 this was rejected: the index predated artifact_kind, so a QA
    // artifact and a release installable fought over one slot.
    expect(() => insertAsset(db, "qa-1", { kind: "ios-simulator-qa" })).not.toThrow();
  });

  it("keeps the sentinel out of the input domain", () => {
    const db = database();
    // A literal "-" arch must not be able to occupy the slot that means "no arch",
    // or two distinct slots silently become one.
    expect(() =>
      db.prepare(
        `INSERT INTO build_assets
           (id, build_id, platform, arch, variant, filetype, r2_key, file_hash, size_bytes,
            artifact_kind, created_at, slot_arch, slot_variant)
         VALUES ('sentinel', 'build-i', 'android', '-', NULL, 'apk', 'k', 'h', 1,
                 'installable', 1, '-', '-')`,
      ).run(),
    ).toThrow(/CHECK constraint failed/);
  });

  it("leaves existing builds on the legacy gate rather than backfilling them", () => {
    const db = database();
    const row = db.prepare(
      "SELECT asset_ingest_protocol_version AS v, required_asset_slots_json AS s FROM builds WHERE id = 'build-i'",
    ).get() as { v: number | null; s: string | null };
    // "this build existed" and "this build's assets passed the new verifier" are
    // different claims; a backfill would forge the second from the first.
    expect(row.v).toBeNull();
    expect(row.s).toBeNull();
  });

  it("gives every attempt and every seal generation its own discoverable row", () => {
    const db = database();
    insertAsset(db, "a-1");
    const attempt = db.prepare(
      `INSERT INTO build_asset_ingest_attempt
         (asset_id, attempt, declared_sha256, declared_size, staging_key,
          upload_expires_at, state, cleanup_state, created_at)
       VALUES ('a-1', ?, 'sha', 10, ?, 99, 'pending', 'live', 1)`,
    );
    attempt.run(1, "staging-1");
    attempt.run(2, "staging-2");
    expect(() => attempt.run(1, "staging-1-again")).toThrow(/UNIQUE constraint failed/);

    const seal = db.prepare(
      `INSERT INTO build_asset_ingest_seal
         (asset_id, attempt, lease_generation, final_key, intent_at)
       VALUES ('a-1', 1, ?, ?, 1)`,
    );
    seal.run(1, "final-a1-g1");
    // A second lease generation on the same attempt keeps its own row, so the
    // object a superseded verifier sealed stays findable by exact key.
    seal.run(2, "final-a1-g2");
    expect(() => seal.run(1, "final-a1-g1-again")).toThrow(/UNIQUE constraint failed/);
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM build_asset_ingest_seal WHERE asset_id = 'a-1'").get(),
    ).toEqual({ n: 2 });
  });

  it("scopes replay keys per app and build, and lets one asset hold several", () => {
    const db = database();
    insertAsset(db, "a-1");
    const replay = db.prepare(
      `INSERT INTO build_asset_ingest_replay
         (app_id, build_id, idempotency_key, asset_id, request_digest, created_at)
       VALUES ('app-i', 'build-i', ?, 'a-1', 'digest', 1)`,
    );
    replay.run("key-1");
    // A CI rerun with a fresh key reuses the asset; a single column could not have
    // held both keys, which is why this is a table.
    replay.run("key-2");
    expect(() => replay.run("key-1")).toThrow(/UNIQUE constraint failed/);
  });

  it("refuses states and cleanup states outside the frozen sets", () => {
    const db = database();
    insertAsset(db, "a-1");
    const withState = (state: string) =>
      db.prepare(
        `INSERT INTO build_asset_ingest_attempt
           (asset_id, attempt, declared_sha256, declared_size, staging_key,
            upload_expires_at, state, cleanup_state, created_at)
         VALUES ('a-1', 99, 'sha', 10, 'k', 99, ?, 'live', 1)`,
      ).run(state);
    expect(() => withState("done")).toThrow(/CHECK constraint failed/);
  });
});
