import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

const migrationPath = fileURLToPath(
  new URL("../../migrations/sql/0048_app_token_permissions.sql", import.meta.url),
);

describe("app-token permission migration", () => {
  it("preserves legacy role tokens and allows additive role and explicit grants", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    db.exec(`
      CREATE TABLE apps (id TEXT PRIMARY KEY);
      CREATE TABLE raft_accounts (id TEXT PRIMARY KEY);
      CREATE TABLE app_deploy_tokens (
        id TEXT PRIMARY KEY,
        app_id TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        token_prefix TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        app_role TEXT NOT NULL CHECK (app_role IN ('publisher', 'viewer')),
        created_by TEXT REFERENCES raft_accounts(id) ON DELETE SET NULL,
        created_by_actor TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER,
        last_used_at INTEGER,
        revoked_at INTEGER
      );
      CREATE INDEX idx_app_deploy_tokens_app
        ON app_deploy_tokens(app_id, revoked_at, expires_at);
      CREATE INDEX idx_app_deploy_tokens_hash
        ON app_deploy_tokens(token_hash);
      INSERT INTO apps (id) VALUES ('app-1');
      INSERT INTO app_deploy_tokens
        (id, app_id, name, token_prefix, token_hash, app_role, created_by_actor, created_at)
      VALUES ('legacy', 'app-1', 'legacy CI', 'qvdt_legacy', 'hash-legacy', 'publisher', 'test', 1);
    `);

    db.exec(readFileSync(migrationPath, "utf8"));

    expect(db.prepare(
      "SELECT app_role, scopes_json FROM app_deploy_tokens WHERE id = 'legacy'",
    ).get()).toEqual({ app_role: "publisher", scopes_json: null });

    expect(() => db.prepare(`
      INSERT INTO app_deploy_tokens
        (id, app_id, name, token_prefix, token_hash, app_role, scopes_json, created_by_actor, created_at)
      VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?)
    `).run(
      "scoped",
      "app-1",
      "feedback writer",
      "qvdt_scoped",
      "hash-scoped",
      JSON.stringify(["feedback:write"]),
      "test",
      2,
    )).not.toThrow();

    const additive = db.prepare(`
      INSERT INTO app_deploy_tokens
        (id, app_id, name, token_prefix, token_hash, app_role, scopes_json, created_by_actor, created_at)
      VALUES (?, 'app-1', ?, ?, ?, ?, ?, 'test', 3)
    `);
    expect(() => additive.run(
      "both",
      "both",
      "qvdt_both",
      "hash-both",
      "viewer",
      "[\"feedback:write\"]",
    )).not.toThrow();
    expect(() => additive.run(
      "neither",
      "neither",
      "qvdt_neither",
      "hash-neither",
      null,
      null,
    ))
      .toThrow();
  });
});
