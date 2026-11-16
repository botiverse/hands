/**
 * Signing service through the real handlers on the real migration chain. The
 * container is replaced by a recorder (its signing tools are exercised by the
 * container's own tests and by a local image run); everything else is
 * production code, including encryption at rest.
 */

import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  handleCreateSigningJob,
  handleExportSigningIdentityBackup,
  handleGenerateAndroidSigningIdentity,
  handleGetSigningJob,
  handleGrantSigningIdentity,
  handleListSigningIdentities,
  handleRevokeSigningIdentity,
  handleRunSigningJob,
  handleUngrantSigningIdentity,
  handleUploadSigningIdentity,
} from "../src/routes/signing";
import { setSigningContainerForTests } from "../src/lib/signing";

const MIGRATION_DIR = fileURLToPath(new URL("../../migrations/sql/", import.meta.url));
const ORG = "org";
const APP = "app-deck";
const SHA = "a".repeat(64);

function d1(db: Database.Database) {
  const prepare = (sql: string) => {
    const indexes: number[] = [];
    const normalized = sql.replace(/\?(\d+)/g, (_m, i) => { indexes.push(Number(i)); return "?"; });
    const statement = db.prepare(normalized);
    const bind = (...input: unknown[]) => {
      const params = (indexes.length ? indexes.map((i) => input[i - 1]) : input).map((v) => v === undefined ? null : v);
      const execute = () => statement.reader
        ? { results: statement.all(...params), success: true as const, meta: { changes: 0 } }
        : { results: [], success: true as const, meta: { changes: statement.run(...params).changes } };
      return { _execute: execute, run: async () => execute(), all: async () => execute(), first: async <T>() => (statement.get(...params) as T | undefined) ?? null };
    };
    return { bind, run: () => bind().run(), all: () => bind().all(), first: <T>() => bind().first<T>() };
  };
  return { prepare, batch: async (sts: { _execute: () => unknown }[]) => db.transaction(() => sts.map((s) => s._execute()))() };
}

function environment() {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  for (const name of readdirSync(MIGRATION_DIR).sort()) {
    if (name.endsWith(".sql")) sqlite.exec(readFileSync(`${MIGRATION_DIR}${name}`, "utf8"));
  }
  sqlite.prepare(`INSERT INTO organizations (id, slug, name, external_provider, external_id, created_at) VALUES (?, ?, ?, 'raft', ?, 1)`).run(ORG, ORG, "Org", "s1");
  sqlite.prepare(`INSERT INTO organizations (id, slug, name, external_provider, external_id, created_at) VALUES ('org2','org2','Org2','raft','s2',1)`).run();
  sqlite.prepare(`INSERT INTO apps (id, org_id, slug, name, platform, client_key, created_at) VALUES (?, ?, 'raft-deck-android', 'Deck', 'android', 'ck', 1)`).run(APP, ORG);
  sqlite.prepare(`INSERT INTO apps (id, org_id, slug, name, platform, client_key, created_at) VALUES ('app-mac', ?, 'raft-deck', 'Deck Mac', 'electron', 'ck2', 2)`).run(ORG);
  sqlite.prepare(`INSERT INTO apps (id, org_id, slug, name, platform, client_key, created_at) VALUES ('app-foreign', 'org2', 'other', 'Other', 'android', 'ck3', 1)`).run();
  const objects = new Map<string, number>();
  const env = {
    DB: d1(sqlite),
    ASC_CRED_ENC_KEY: "test-master-key",
    R2_ACCOUNT_ID: "acct",
    R2_BUCKET_NAME: "bucket",
    R2_S3_ACCESS_KEY_ID: "AKID",
    R2_S3_SECRET_ACCESS_KEY: "secret",
    APK_BUCKET: {
      head: async (key: string) => (objects.has(key) ? { size: objects.get(key) } : null),
      delete: async (key: string) => { objects.delete(key); },
    },
  } as unknown as Env;
  return { sqlite, env, objects };
}

async function call(handler: (c: any) => Promise<Response>, env: Env, params: Record<string, string>, body: unknown = {}) {
  const c = {
    env,
    req: { param: (n: string) => params[n] ?? "", json: async () => body, query: () => undefined },
    json: (data: unknown, s = 200) => new Response(JSON.stringify(data), { status: s }),
    get: (key: string) => (key === "admin_actor" ? "tester" : undefined),
  } as any;
  const response = await handler(c);
  return { status: response.status, body: await response.json() as any };
}

type Call = { path: string; body: any };
function recorder(reply: (path: string, body: any) => { status?: number; body: unknown }) {
  const calls: Call[] = [];
  setSigningContainerForTests(async (path, body) => {
    calls.push({ path, body });
    const r = reply(path, body);
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200 });
  });
  return calls;
}

const ANDROID_META = { subject: "CN=Deck", sha256_fingerprint: "ff".repeat(32), not_after: "2056", key_alias: "release" };

afterEach(() => {
  setSigningContainerForTests(null);
  vi.unstubAllGlobals();
});

async function uploadAndroid(env: Env, extra: Record<string, unknown> = {}) {
  return call(handleUploadSigningIdentity, env, { orgId: ORG }, {
    kind: "android_keystore", name: "Deck release", keystore_b64: "QUJD", store_password: "storepw-secret", key_alias: "release", ...extra,
  });
}

describe("signing identities", () => {
  it("stores an uploaded key encrypted, verified by the container, and never returns key material", async () => {
    const { env, sqlite } = environment();
    const calls = recorder(() => ({ body: { metadata: ANDROID_META } }));
    const created = await uploadAndroid(env);
    expect(created.status).toBe(201);
    expect(calls[0]).toMatchObject({ path: "/signing/inspect", body: { secret: { kind: "android_keystore", store_password: "storepw-secret", key_password: "storepw-secret" } } });
    const row = sqlite.prepare("SELECT * FROM signing_identities").get() as any;
    expect(row.secret_ciphertext_b64).not.toContain("storepw");
    expect(Buffer.from(row.secret_ciphertext_b64, "base64").toString("latin1")).not.toContain("storepw-secret");
    expect(JSON.stringify(created.body)).not.toContain("storepw");
    expect(JSON.stringify(created.body)).not.toContain("QUJD");
    const listed = await call(handleListSigningIdentities, env, { orgId: ORG });
    expect(listed.body.signing_identities).toHaveLength(1);
    expect(listed.body.signing_identities[0]).toMatchObject({ kind: "android_keystore", origin: "uploaded", metadata: ANDROID_META, apps: [] });
    expect(JSON.stringify(listed.body)).not.toContain("storepw");
    // Other orgs see nothing.
    expect((await call(handleListSigningIdentities, env, { orgId: "org2" })).body.signing_identities).toHaveLength(0);
  });

  it("rejects bad input and a key the container cannot open", async () => {
    const { env } = environment();
    recorder(() => ({ status: 400, body: { error: "keystore, password or alias is wrong", code: "signing_identity_invalid" } }));
    expect((await uploadAndroid(env)).body.code).toBe("signing_identity_invalid");
    expect((await uploadAndroid(env, { keystore_b64: "not base64!" })).status).toBe(400);
    expect((await uploadAndroid(env, { key_alias: "-J-Dx=1" })).status).toBe(400);
    expect((await uploadAndroid(env, { key_alias: "a b" })).status).toBe(400);
    expect((await uploadAndroid(env, { key_alias: "-Jfoo" })).status).toBe(400);
    expect((await call(handleUploadSigningIdentity, env, { orgId: ORG }, { kind: "windows", name: "x" })).status).toBe(400);
    expect((await call(handleUploadSigningIdentity, env, { orgId: ORG }, {
      kind: "apple_developer_id", name: "Dev ID", p12_b64: "QUJD", p12_password: "x", notary: { key_id: "K", issuer_id: "I", p8: "nope" },
    })).status).toBe(400);
  });

  it("generates an Android key in Hands and gives out its backup once", async () => {
    const { env, sqlite } = environment();
    recorder((path) => path === "/signing/generate-android"
      ? { body: { secret: { kind: "android_keystore", keystore_b64: "R0VO", store_password: "gen-pw", key_alias: "release", key_password: "gen-pw" }, metadata: ANDROID_META } }
      : { body: { metadata: ANDROID_META } });
    const generated = await call(handleGenerateAndroidSigningIdentity, env, { orgId: ORG }, { name: "Deck Android" });
    expect(generated.status).toBe(201);
    expect(generated.body.signing_identity).toMatchObject({ origin: "generated", backup_exported_at: null });
    const id = generated.body.signing_identity.id;
    const backup = await call(handleExportSigningIdentityBackup, env, { orgId: ORG, identityId: id });
    expect(backup.body).toMatchObject({ keystore_b64: "R0VO", store_password: "gen-pw", key_alias: "release", format: "PKCS12" });
    // A lost response can be retried for a short while, then the backup is gone.
    expect((await call(handleExportSigningIdentityBackup, env, { orgId: ORG, identityId: id })).status).toBe(200);
    sqlite.prepare("UPDATE signing_identities SET backup_exported_at = ? WHERE id = ?").run(Date.now() - 11 * 60 * 1000, id);
    const again = await call(handleExportSigningIdentityBackup, env, { orgId: ORG, identityId: id });
    expect([again.status, again.body.code]).toEqual([409, "backup_already_exported"]);
    const uploaded = await uploadAndroid(env);
    expect((await call(handleExportSigningIdentityBackup, env, { orgId: ORG, identityId: uploaded.body.signing_identity.id })).body.code).toBe("backup_not_available");
    expect((await call(handleExportSigningIdentityBackup, env, { orgId: "org2", identityId: id })).status).toBe(404);
  });

  it("grants only to apps of the same org", async () => {
    const { env } = environment();
    recorder(() => ({ body: { metadata: ANDROID_META } }));
    const id = (await uploadAndroid(env)).body.signing_identity.id;
    expect((await call(handleGrantSigningIdentity, env, { orgId: ORG, identityId: id, appId: "app-foreign" })).body.code).toBe("app_not_in_org");
    expect((await call(handleGrantSigningIdentity, env, { orgId: "org2", identityId: id, appId: "app-foreign" })).status).toBe(404);
    const granted = await call(handleGrantSigningIdentity, env, { orgId: ORG, identityId: id, appId: APP });
    expect(granted.body.signing_identity.apps).toEqual([{ app_id: APP, slug: "raft-deck-android" }]);
    expect((await call(handleUngrantSigningIdentity, env, { orgId: ORG, identityId: id, appId: APP })).body.signing_identity.apps).toEqual([]);
  });
});

describe("signing jobs", () => {
  async function grantedAndroid() {
    const ctx = environment();
    recorder(() => ({ body: { metadata: ANDROID_META } }));
    const id = (await uploadAndroid(ctx.env)).body.signing_identity.id;
    await call(handleGrantSigningIdentity, ctx.env, { orgId: ORG, identityId: id, appId: APP });
    return { ...ctx, identityId: id };
  }
  const jobBody = (extra: Record<string, unknown> = {}) => ({ artifact_type: "apk", filename: "app-release.apk", size: 1234, sha256: SHA, ...extra });

  it("signs an uploaded APK with the granted key and returns a verified download", async () => {
    const { env, sqlite, objects, identityId } = await grantedAndroid();
    const created = await call(handleCreateSigningJob, env, { appId: APP }, jobBody());
    expect(created.status).toBe(201);
    expect(created.body.upload_url).toContain("X-Amz-Signature");
    expect(created.body.job).toMatchObject({ status: "awaiting_upload", identity_id: identityId });
    const jobId = created.body.job.id;

    // Not uploaded yet: the job fails and says so.
    const early = await call(handleRunSigningJob, env, { appId: APP, jobId });
    expect(early.body.job).toMatchObject({ status: "failed", error_code: "signing_input_missing" });

    const second = (await call(handleCreateSigningJob, env, { appId: APP }, jobBody())).body.job.id;
    objects.set(`signing/${APP}/${second}/input`, 1234);
    const calls = recorder(() => ({ body: { output_size: 1300, output_sha256: "b".repeat(64), notary_submission_id: null } }));
    const run = await call(handleRunSigningJob, env, { appId: APP, jobId: second });
    expect(run.body.job).toMatchObject({ status: "succeeded", output_sha256: "b".repeat(64) });
    expect(run.body.job.download_url).toContain("X-Amz-Signature");
    expect(calls[0]!.path).toBe("/signing/sign");
    expect(calls[0]!.body).toMatchObject({ artifact_type: "apk", expected_input_sha256: SHA, secret: { kind: "android_keystore", store_password: "storepw-secret" } });
    // Running again is a no-op on a finished job.
    await call(handleRunSigningJob, env, { appId: APP, jobId: second });
    expect(calls).toHaveLength(1);
    const audit = sqlite.prepare("SELECT action, payload FROM audit_logs WHERE app_id = ? AND action LIKE 'signing_job.%' ORDER BY created_at").all(APP) as any[];
    expect(audit.map((a) => a.action)).toEqual(expect.arrayContaining(["signing_job.create", "signing_job.sign", "signing_job.fail"]));
    expect(audit.map((a) => a.payload).join("")).not.toContain("storepw");
  });

  it("refuses ungranted, mismatched, revoked and unsupported requests", async () => {
    const { env, sqlite, objects, identityId } = await grantedAndroid();
    expect((await call(handleCreateSigningJob, env, { appId: "app-mac" }, jobBody())).body.code).toBe("signing_identity_not_granted");
    expect((await call(handleCreateSigningJob, env, { appId: APP }, jobBody({ artifact_type: "macos", filename: "x.app.zip" }))).body.code).toBe("signing_identity_not_granted");
    expect((await call(handleCreateSigningJob, env, { appId: APP }, jobBody({ artifact_type: "ipa" }))).body.code).toBe("signing_unsupported");
    expect((await call(handleCreateSigningJob, env, { appId: APP }, jobBody({ notarize: true }))).status).toBe(400);
    expect((await call(handleCreateSigningJob, env, { appId: APP }, jobBody({ sha256: "x" }))).status).toBe(400);
    expect((await call(handleCreateSigningJob, env, { appId: APP }, jobBody({ size: 0 }))).status).toBe(400);
    expect((await call(handleCreateSigningJob, env, { appId: APP }, jobBody({ filename: "../x" }))).status).toBe(400);

    // Two granted keys: the caller must choose.
    const other = (await uploadAndroid(env)).body.signing_identity.id;
    await call(handleGrantSigningIdentity, env, { orgId: ORG, identityId: other, appId: APP });
    expect((await call(handleCreateSigningJob, env, { appId: APP }, jobBody())).body.code).toBe("signing_identity_ambiguous");
    const chosen = await call(handleCreateSigningJob, env, { appId: APP }, jobBody({ identity_id: identityId }));
    expect(chosen.status).toBe(201);

    // Size mismatch with the declared size.
    objects.set(`signing/${APP}/${chosen.body.job.id}/input`, 99);
    expect((await call(handleRunSigningJob, env, { appId: APP, jobId: chosen.body.job.id })).body.job.error_code).toBe("signing_input_mismatch");

    // Revoked after the job was created: signing refuses.
    const late = (await call(handleCreateSigningJob, env, { appId: APP }, jobBody({ identity_id: identityId }))).body.job.id;
    objects.set(`signing/${APP}/${late}/input`, 1234);
    await call(handleRevokeSigningIdentity, env, { orgId: ORG, identityId });
    const calls = recorder(() => ({ body: {} }));
    expect((await call(handleRunSigningJob, env, { appId: APP, jobId: late })).body.job.error_code).toBe("signing_identity_revoked");
    expect(calls).toHaveLength(0);
    // An app moved to another org keeps none of the old org's keys, even if a grant row lingers.
    recorder(() => ({ body: { metadata: ANDROID_META } }));
    const fresh = (await uploadAndroid(env)).body.signing_identity.id;
    await call(handleGrantSigningIdentity, env, { orgId: ORG, identityId: fresh, appId: APP });
    sqlite.prepare("UPDATE apps SET org_id = 'org2' WHERE id = ?").run(APP);
    expect((await call(handleCreateSigningJob, env, { appId: APP }, jobBody({ identity_id: fresh }))).body.code).toBe("signing_identity_not_granted");
    expect((await call(handleListSigningIdentities, env, { orgId: ORG })).body.signing_identities.find((i: any) => i.id === fresh).apps).toEqual([]);
    sqlite.prepare("UPDATE apps SET org_id = ? WHERE id = ?").run(ORG, APP);
    // Jobs are app-scoped.
    expect((await call(handleGetSigningJob, env, { appId: "app-mac", jobId: late })).status).toBe(404);
  });

  it("fails a job whose signing request was lost", async () => {
    const { env, sqlite, objects } = await grantedAndroid();
    const jobId = (await call(handleCreateSigningJob, env, { appId: APP }, jobBody())).body.job.id;
    objects.set(`signing/${APP}/${jobId}/input`, 1234);
    sqlite.prepare("UPDATE signing_jobs SET status = 'signing', updated_at = ? WHERE id = ?").run(Date.now() - 10 * 60 * 1000, jobId);
    expect((await call(handleGetSigningJob, env, { appId: APP, jobId })).body.job.status).toBe("signing");
    sqlite.prepare("UPDATE signing_jobs SET updated_at = ? WHERE id = ?").run(Date.now() - 31 * 60 * 1000, jobId);
    expect((await call(handleGetSigningJob, env, { appId: APP, jobId })).body.job).toMatchObject({ status: "failed", error_code: "signing_interrupted" });
  });

  it("notarizes a macOS app: polls Apple, staples when accepted, fails when rejected", async () => {
    const { env, objects } = environment();
    const { privateKey } = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]) as CryptoKeyPair;
    const pkcs8 = Buffer.from(await crypto.subtle.exportKey("pkcs8", privateKey) as ArrayBuffer).toString("base64");
    const p8 = `-----BEGIN PRIVATE KEY-----\n${pkcs8}\n-----END PRIVATE KEY-----`;
    recorder(() => ({ body: { metadata: { subject: "CN=Developer ID Application: X (TEAM123456)", team_id: "TEAM123456", notary_key_id: "KEY1" } } }));
    const id = (await call(handleUploadSigningIdentity, env, { orgId: ORG }, {
      kind: "apple_developer_id", name: "Dev ID", p12_b64: "QUJD", p12_password: "pw", notary: { key_id: "KEY1", issuer_id: "ISS", p8 },
    })).body.signing_identity.id;
    await call(handleGrantSigningIdentity, env, { orgId: ORG, identityId: id, appId: "app-mac" });

    const created = await call(handleCreateSigningJob, env, { appId: "app-mac" }, { artifact_type: "macos", filename: "Deck.app.zip", size: 10, sha256: SHA, notarize: true });
    const jobId = created.body.job.id;
    objects.set(`signing/app-mac/${jobId}/input`, 10);
    const calls = recorder((path) => path === "/signing/sign"
      ? { body: { output_size: 11, output_sha256: "c".repeat(64), notary_submission_id: "11111111-2222-3333-4444-555555555555" } }
      : { body: { output_size: 12, output_sha256: "d".repeat(64) } });
    const signed = await call(handleRunSigningJob, env, { appId: "app-mac", jobId }, { entitlements_b64: "PHBsaXN0Lz4=" });
    expect(signed.body.job).toMatchObject({ status: "notarizing", notary_status: "In Progress" });
    expect(signed.body.job.download_url).toBeUndefined();
    expect(calls[0]!.body).toMatchObject({ notarize: true, entitlements_b64: "PHBsaXN0Lz4=" });

    let appleStatus = "In Progress";
    const appleCalls: string[] = [];
    let appleDown = false;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      appleCalls.push(String(url));
      if (appleDown) throw new TypeError("network down");
      expect(String((init.headers as Record<string, string>).authorization)).toMatch(/^Bearer ey/);
      return new Response(JSON.stringify({ data: { attributes: { status: appleStatus } } }));
    }));
    expect((await call(handleGetSigningJob, env, { appId: "app-mac", jobId })).body.job.status).toBe("notarizing");
    // A network failure talking to Apple is not a verdict.
    appleDown = true;
    expect((await call(handleGetSigningJob, env, { appId: "app-mac", jobId })).body.job.status).toBe("notarizing");
    appleDown = false;
    appleStatus = "Accepted";
    const done = await call(handleGetSigningJob, env, { appId: "app-mac", jobId });
    expect(done.body.job).toMatchObject({ status: "succeeded", output_sha256: "d".repeat(64), notary_status: "Accepted" });
    expect(calls.map((c) => c.path)).toEqual(["/signing/sign", "/signing/staple"]);
    expect(appleCalls[0]).toBe("https://appstoreconnect.apple.com/notary/v2/submissions/11111111-2222-3333-4444-555555555555");

    // A rejected submission fails the job.
    const second = await call(handleCreateSigningJob, env, { appId: "app-mac" }, { artifact_type: "macos", filename: "Deck.app.zip", size: 10, sha256: SHA, notarize: true });
    objects.set(`signing/app-mac/${second.body.job.id}/input`, 10);
    await call(handleRunSigningJob, env, { appId: "app-mac", jobId: second.body.job.id });
    appleStatus = "Invalid";
    const failed = await call(handleGetSigningJob, env, { appId: "app-mac", jobId: second.body.job.id });
    expect(failed.body.job).toMatchObject({ status: "failed", error_code: "signing_notary_rejected" });
    // A finished job is never turned into a failure later.
    expect((await call(handleGetSigningJob, env, { appId: "app-mac", jobId })).body.job.status).toBe("succeeded");
    // The unstapled output was removed after stapling.
    expect(objects.has(`signing/app-mac/${jobId}/input`)).toBe(false);
  });
});
