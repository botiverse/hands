import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const migration = readFileSync(fileURLToPath(new URL("../../migrations/sql/0069_drop_unused_build_asset_signature.sql", import.meta.url)), "utf8");

describe("0069 generic build asset signature removal", () => {
  it("drops only the unused generic signature column", () => {
    const db = new Database(":memory:");
    db.exec(`CREATE TABLE build_assets (
      id TEXT PRIMARY KEY,
      signature TEXT,
      signing_credential_id TEXT,
      file_hash TEXT
    );`);
    db.exec(migration);
    const columns = db.prepare("PRAGMA table_info(build_assets)").all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toEqual(["id", "signing_credential_id", "file_hash"]);
  });
});
