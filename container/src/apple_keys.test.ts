import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Hono } from "hono";
import { registerSigningRoutes } from "./signing.js";

const app = new Hono();
registerSigningRoutes(app);
const post = async (path: string, body: unknown) => {
  const res = await app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() as any };
};

/** Issue a certificate for a request the way Apple does: its own subject, signed by a CA. */
function issue(csrPem: string, subject: string): string {
  const dir = mkdtempSync(join(tmpdir(), "apple-ca-"));
  try {
    const openssl = (...args: string[]) => execFileSync("openssl", args, { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
    openssl("req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "ca.key", "-out", "ca.pem", "-subj", "/CN=Test WWDR", "-days", "30");
    writeFileSync(join(dir, "req.csr"), csrPem);
    openssl("x509", "-req", "-in", "req.csr", "-CA", "ca.pem", "-CAkey", "ca.key", "-set_serial", "7", "-days", "30", "-subj", subject, "-outform", "DER", "-out", "cert.cer");
    return readFileSync(join(dir, "cert.cer")).toString("base64");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("makes an Apple key and joins it with the issued certificate", async () => {
  const csr = await post("/signing/apple-csr", { common_name: "Botiverse, Inc." });
  assert.equal(csr.status, 200);
  assert.match(csr.body.key_pem, /BEGIN PRIVATE KEY/);
  assert.match(csr.body.csr_pem, /BEGIN CERTIFICATE REQUEST/);

  const cer = issue(csr.body.csr_pem, "/UID=TEAMID1234/CN=Apple Distribution: Test Co (TEAMID1234)/OU=TEAMID1234/O=Test Co/C=US");
  const joined = await post("/signing/apple-p12", { kind: "apple_ios_distribution", key_pem: csr.body.key_pem, certificate_b64: cer });
  assert.equal(joined.status, 200, JSON.stringify(joined.body));
  assert.equal(joined.body.secret.kind, "apple_ios_distribution");
  assert.ok(joined.body.secret.p12_password.length >= 24);
  assert.equal(joined.body.metadata.team_id, "TEAMID1234");
  assert.match(joined.body.metadata.subject, /Apple Distribution: Test Co/);
  // The p12 opens and reports the same certificate.
  const again = await post("/signing/inspect", { secret: joined.body.secret });
  assert.equal(again.body.metadata.sha256_fingerprint, joined.body.metadata.sha256_fingerprint);

  // A PEM .cer is accepted too.
  const pem = `-----BEGIN CERTIFICATE-----\n${cer.match(/.{1,64}/g)!.join("\n")}\n-----END CERTIFICATE-----\n`;
  assert.equal((await post("/signing/apple-p12", { kind: "apple_ios_distribution", key_pem: csr.body.key_pem, certificate_b64: pem })).status, 200);

  // Wrong certificate type for the kind.
  const devId = await post("/signing/apple-p12", { kind: "apple_developer_id", key_pem: csr.body.key_pem, certificate_b64: cer });
  assert.equal(devId.body.code, "signing_identity_wrong_type");

  // A certificate issued for another request.
  const other = await post("/signing/apple-csr", { common_name: "Other" });
  const mismatch = await post("/signing/apple-p12", { kind: "apple_ios_distribution", key_pem: other.body.key_pem, certificate_b64: cer });
  assert.equal(mismatch.body.code, "signing_certificate_mismatch");

  assert.equal((await post("/signing/apple-p12", { kind: "apple_ios_distribution", key_pem: csr.body.key_pem, certificate_b64: "not a cert!" })).body.code, "signing_identity_invalid");
});
