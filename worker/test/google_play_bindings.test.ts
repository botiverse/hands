import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import {
  assertGooglePlayCredentialKeyring,
  decryptGooglePlayCredential,
  encryptGooglePlayCredential,
  normalizeGooglePlayPackage,
  normalizeGooglePlayTracks,
  parseGoogleServiceAccount,
} from "../src/lib/google_play_bindings";

const credential = {
  type: "service_account" as const,
  project_id: "tenant-project",
  private_key_id: "tenant-key",
  client_email: "tenant@example.iam.gserviceaccount.com",
  private_key: "-----BEGIN PRIVATE KEY-----\nprivate-tenant-material\n-----END PRIVATE KEY-----",
};
const keyring = JSON.stringify({ v1: "first-test-key-material-with-32-bytes", v2: "second-test-key-material-with-32-bytes" });

describe("app-scoped Google Play bindings", () => {
  it("encrypts private material and binds ciphertext to the app identity", async () => {
    const encrypted = await encryptGooglePlayCredential(credential, "app-a", keyring, "v1");
    expect(JSON.stringify(encrypted)).not.toContain("private-tenant-material");
    expect(await decryptGooglePlayCredential(
      encrypted.ciphertext_b64,
      encrypted.iv_b64,
      "app-a",
      encrypted.key_version,
      keyring,
    )).toEqual(credential);
    await expect(decryptGooglePlayCredential(
      encrypted.ciphertext_b64,
      encrypted.iv_b64,
      "app-b",
      encrypted.key_version,
      keyring,
    )).rejects.toThrow();
  });

  it("keeps old ciphertext readable while new credentials rotate to the active key", async () => {
    const old = await encryptGooglePlayCredential(credential, "app-a", keyring, "v1");
    const next = await encryptGooglePlayCredential(credential, "app-a", keyring, "v2");
    expect(old.key_version).toBe("v1");
    expect(next.key_version).toBe("v2");
    await expect(decryptGooglePlayCredential(old.ciphertext_b64, old.iv_b64, "app-a", "v1", keyring))
      .resolves.toEqual(credential);
    await expect(decryptGooglePlayCredential(old.ciphertext_b64, old.iv_b64, "app-a", "v1", JSON.stringify({ v2: "second-test-key-material-with-32-bytes" })))
      .rejects.toThrow(/key version is unavailable/);
  });

  it("rejects invalid credentials, package names, and track mappings before storage", () => {
    expect(() => parseGoogleServiceAccount({ ...credential, type: "authorized_user" })).toThrow(/service_account/);
    expect(() => parseGoogleServiceAccount({ ...credential, private_key: "secret" })).toThrow(/PKCS#8/);
    expect(() => normalizeGooglePlayPackage("../tenant" )).toThrow(/invalid/);
    expect(() => normalizeGooglePlayTracks({ internal: "qa", closed: "bad track", production: "production" })).toThrow(/invalid/);
  });

  it("fails closed unless the active encryption key is present in the keyring", () => {
    expect(() => assertGooglePlayCredentialKeyring(undefined, "v1")).toThrow(/not configured/);
    expect(() => assertGooglePlayCredentialKeyring(keyring, "missing")).toThrow(/ACTIVE_KEY_VERSION/);
    expect(() => assertGooglePlayCredentialKeyring(keyring, "v2")).not.toThrow();
  });

  it("keeps every credential-binding route at the app-admin tier", () => {
    const source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
    const routes = source.split("\n")
      .filter((line) => line.includes('"/api/apps/:appId/google-play-binding'));
    expect(routes).toHaveLength(6);
    expect(routes.every((line) => line.includes('requireAppRole("admin")'))).toBe(true);
    expect(source).toContain('requireAppRole("publisher")');
  });

  it("keeps migration 0071 additive, rerunnable, app-unique, and cascade-scoped", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    db.exec("CREATE TABLE apps (id TEXT PRIMARY KEY)");
    const migration = readFileSync(
      new URL("../../migrations/sql/0071_app_google_play_bindings.sql", import.meta.url),
      "utf8",
    );
    expect(() => db.exec(migration)).not.toThrow();
    expect(() => db.exec(migration)).not.toThrow();
    db.prepare("INSERT INTO apps(id) VALUES ('app-a')").run();
    const insert = db.prepare(`INSERT INTO app_google_play_bindings
      (id, app_id, enabled, package_name, internal_track, closed_track, production_track,
       service_account_email, credential_fingerprint, credential_ciphertext_b64,
       credential_iv_b64, credential_key_version, verification_state, verified_at,
       created_by_actor, updated_by_actor, created_at, updated_at)
      VALUES (?, 'app-a', 1, 'build.raft.app', 'qa', 'closed', 'production',
              'app@example.iam.gserviceaccount.com', 'fingerprint', 'ciphertext',
              'iv', 'v1', 'verified', 1, 'actor', 'actor', 1, 1)`);
    insert.run("binding-a");
    expect(() => insert.run("binding-b")).toThrow(/UNIQUE/);
    db.prepare("DELETE FROM apps WHERE id='app-a'").run();
    expect(db.prepare("SELECT COUNT(*) AS count FROM app_google_play_bindings").get())
      .toEqual({ count: 0 });
  });
});
