import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

const migrationDir = fileURLToPath(new URL("../../migrations/sql/", import.meta.url));

function migratedDatabase() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  for (const name of readdirSync(migrationDir).sort()) {
    if (!name.endsWith(".sql")) continue;
    db.exec(readFileSync(`${migrationDir}${name}`, "utf8"));
  }
  return db;
}

function seedIdentity(db: Database.Database) {
  db.exec(`
    INSERT INTO raft_accounts
      (id, provider_subject, server_id, principal_type, display_name, raw_profile,
       created_at, updated_at, last_login_at)
    VALUES ('account-1', 'human-1', 'server-1', 'human', 'Human', '{}', 1, 1, 1);

    INSERT INTO apps
      (id, slug, name, platform, created_at, public_history,
       installer_catalog_public, installer_package_id, installer_publisher_name)
    VALUES ('app-1', 'app-1', 'App 1', 'android', 1, 1, 1,
            'dev.hands.app', 'Hands');
    INSERT INTO channels (id, app_id, slug, name, created_at)
    VALUES ('channel-1', 'app-1', 'main', 'Main', 1);
  `);
}

describe("migration 0067 — installer consumer", () => {
  it("only admits explicitly public Android/OHOS apps with package identity", () => {
    const db = migratedDatabase();

    expect(() => db.exec(`
      INSERT INTO apps
        (id, slug, name, platform, created_at, installer_catalog_public)
      VALUES ('private-app', 'private-app', 'Private', 'android', 1, 1);
    `)).toThrow(/installer catalog requires public history/);

    db.exec(`
      INSERT INTO apps (id, slug, name, platform, created_at)
      VALUES ('app-1', 'app-1', 'App 1', 'android', 1);
    `);
    expect(() => db.exec(`
      UPDATE apps SET installer_catalog_public=1, public_history=1,
        installer_package_id='dev.hands.app', installer_publisher_name='Hands'
      WHERE id='app-1';
    `)).not.toThrow();
    expect(() => db.exec("UPDATE apps SET public_history=0 WHERE id='app-1'"))
      .toThrow(/installer catalog requires public history/);
  });

  it("keeps login and refresh secrets unique and refresh families independently revocable", () => {
    const db = migratedDatabase();
    seedIdentity(db);

    db.exec(`
      INSERT INTO installer_login_codes
        (id, code_hash, account_id, client_id, redirect_uri, state, code_challenge,
         code_challenge_method, created_at, expires_at)
      VALUES ('code-1', 'hash-1', 'account-1', 'client-1', 'hands://callback',
              'state-1', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'S256', 1, 2);
      INSERT INTO installer_refresh_tokens
        (id, family_id, account_id, client_id, token_hash, created_at, expires_at)
      VALUES ('refresh-1', 'family-1', 'account-1', 'client-1', 'refresh-hash-1', 1, 10);
    `);

    expect(() => db.exec(`
      INSERT INTO installer_login_codes
        (id, code_hash, account_id, client_id, redirect_uri, state, code_challenge,
         code_challenge_method, created_at, expires_at)
      VALUES ('code-2', 'hash-1', 'account-1', 'client-1', 'hands://callback',
              'state-2', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'S256', 1, 2);
    `)).toThrow(/UNIQUE/);
    expect(() => db.exec(`
      INSERT INTO installer_refresh_tokens
        (id, family_id, account_id, client_id, token_hash, created_at, expires_at)
      VALUES ('refresh-2', 'family-2', 'account-1', 'client-1', 'refresh-hash-1', 1, 10);
    `)).toThrow(/UNIQUE/);

    db.exec("UPDATE installer_refresh_tokens SET revoked_at=5 WHERE family_id='family-1'");
    expect(db.prepare(
      "SELECT revoked_at FROM installer_refresh_tokens WHERE id='refresh-1'",
    ).pluck().get()).toBe(5);
  });

  it("allows one revisioned subscription row per account/app/channel", () => {
    const db = migratedDatabase();
    seedIdentity(db);
    db.exec(`
      INSERT INTO installer_subscriptions
        (id, account_id, app_id, channel_id, revision, created_at, updated_at)
      VALUES ('sub-1', 'account-1', 'app-1', 'channel-1', 1, 1, 1);
    `);
    expect(() => db.exec(`
      INSERT INTO installer_subscriptions
        (id, account_id, app_id, channel_id, revision, created_at, updated_at)
      VALUES ('sub-2', 'account-1', 'app-1', 'channel-1', 1, 1, 1);
    `)).toThrow(/UNIQUE/);
    expect(() => db.exec("UPDATE installer_subscriptions SET revision=0 WHERE id='sub-1'"))
      .toThrow(/CHECK/);
  });

  it("binds inspected metadata to the exact installable asset bytes and build identity", () => {
    const db = migratedDatabase();
    seedIdentity(db);
    db.exec(`
      INSERT INTO builds
        (id, app_id, channel_id, product_type, release_type, version_name,
         version_code, source, status, created_at, updated_at)
      VALUES ('build-1', 'app-1', 'channel-1', 'android-apk', 'stable', '1.0.0',
              100, 'ci', 'succeeded', 1, 1);
      INSERT INTO build_assets
        (id, build_id, platform, filetype, r2_key, file_hash, size_bytes,
         created_at, artifact_kind)
      VALUES ('asset-1', 'build-1', 'android', 'apk', 'artifact.apk',
              'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
              10, 1, 'installable');
      INSERT INTO installer_asset_metadata
        (asset_id, platform, filetype, package_id, version_code,
         signer_fingerprint, inspected_file_hash, inspector_version, inspected_at)
      VALUES ('asset-1', 'android', 'apk', 'dev.hands.app', 100,
              'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
              'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
              'inspector-v1', 2);
    `);

    expect(() => db.exec(`
      UPDATE installer_asset_metadata
      SET inspected_file_hash='cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc'
      WHERE asset_id='asset-1';
    `)).toThrow(/must match exact installable asset/);
    expect(() => db.exec(`
      UPDATE installer_asset_metadata SET version_code=101 WHERE asset_id='asset-1';
    `)).toThrow(/must match exact installable asset/);
    expect(() => db.exec(`
      UPDATE installer_asset_metadata SET package_id='dev.other' WHERE asset_id='asset-1';
    `)).toThrow(/must match exact installable asset/);
  });
});
