import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

const migrationPath = fileURLToPath(new URL("../../migrations/sql/0069_release_artifact_attestations.sql", import.meta.url));

describe("release artifact attestation migration", () => {
  it("creates the shared trust/attestation ledger with strict enums", () => {
    const db = new Database(":memory:");
    db.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE apps (id TEXT PRIMARY KEY);
      CREATE TABLE releases (id TEXT PRIMARY KEY);
      CREATE TABLE builds (id TEXT PRIMARY KEY);
    `);
    expect(() => db.exec(readFileSync(migrationPath, "utf8"))).not.toThrow();

    const app = db.prepare("PRAGMA table_info(apps)").all() as Array<{ name: string }>;
    expect(app.some((column) => column.name === "update_attestation_required")).toBe(true);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%attestation%'").all()).toHaveLength(3);

    expect(() => db.prepare(`INSERT INTO update_attestation_keys
      (key_id, app_id, algorithm, public_key_spki_b64url, label, created_at)
      VALUES ('k', 'missing', 'RSA', 'key', 'bad', 1)`).run()).toThrow();
    db.prepare(`INSERT INTO apps (id) VALUES ('app')`).run();
    expect(() => db.prepare(`INSERT INTO update_attestation_keys
      (key_id, app_id, algorithm, public_key_spki_b64url, label, created_at)
      VALUES ('k', 'app', 'Ed25519', 'key', 'ok', 1)`).run()).not.toThrow();
    expect(() => db.prepare(`INSERT INTO update_attestation_keys
      (key_id, app_id, algorithm, public_key_spki_b64url, label, created_at, status)
      VALUES ('bad-status', 'app', 'Ed25519', 'key2', 'bad', 1, 'bogus')`).run()).toThrow();
  });
});
