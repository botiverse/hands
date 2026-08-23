import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

const dir = fileURLToPath(new URL("../../migrations/sql/", import.meta.url));

describe("migration 0064 — additional owner servers", () => {
  it("marks existing configurable grants as legacy without changing their role", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    for (const name of readdirSync(dir).sort()) {
      if (!name.endsWith(".sql")) continue;
      if (name === "0064_additional_owner_servers.sql") {
        db.exec(`
          INSERT INTO organizations
            (id, slug, name, external_provider, external_id, created_at, archived)
          VALUES ('raft_extra', 'extra', 'Extra', 'raft', 'extra-server', 1, 0);
          INSERT INTO apps (id, org_id, slug, name, platform, created_at)
          VALUES ('app-1', NULL, 'app-1', 'App 1', 'android', 1);
          INSERT INTO app_server_grants
            (id, app_id, server_id, server_slug, app_role, created_at, updated_at)
          VALUES ('grant-1', 'app-1', 'extra-server', 'extra', 'viewer', 1, 1);
        `);
      }
      db.exec(readFileSync(`${dir}${name}`, "utf8"));
    }

    expect(db.prepare(
      "SELECT app_role, access_model FROM app_server_grants WHERE id = 'grant-1'",
    ).get()).toEqual({ app_role: "viewer", access_model: "legacy_role" });
  });
});
