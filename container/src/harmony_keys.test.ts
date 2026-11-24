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

/** Issue a certificate for a request the way AGC does, as a PEM chain (leaf, then the issuing CA). */
function issueChain(csrPem: string): string {
  const dir = mkdtempSync(join(tmpdir(), "agc-ca-"));
  try {
    const openssl = (...args: string[]) => execFileSync("openssl", args, { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
    openssl("ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", "ca.key");
    openssl("req", "-x509", "-key", "ca.key", "-out", "ca.pem", "-subj", "/CN=Huawei CBG Developer Relations CA G2", "-days", "30");
    writeFileSync(join(dir, "req.csr"), csrPem);
    openssl("x509", "-req", "-in", "req.csr", "-CA", "ca.pem", "-CAkey", "ca.key", "-set_serial", "9", "-days", "30", "-out", "leaf.pem");
    return Buffer.from(readFileSync(join(dir, "leaf.pem"), "utf8") + readFileSync(join(dir, "ca.pem"), "utf8")).toString("base64");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("makes a HarmonyOS ECDSA P-256 key, checks the certificate AGC issued for it, keeps the chain", async () => {
  const csr = await post("/signing/harmony-csr", { common_name: "Raft Deck" });
  assert.equal(csr.status, 200);
  assert.match(csr.body.key_pem, /BEGIN EC PRIVATE KEY/);
  assert.match(csr.body.csr_pem, /BEGIN CERTIFICATE REQUEST/);
  const text = execFileSync("openssl", ["req", "-noout", "-text"], { input: csr.body.csr_pem }).toString();
  assert.match(text, /prime256v1|P-256/);
  assert.match(text, /ecdsa-with-SHA256/);

  const chain = issueChain(csr.body.csr_pem);
  const checked = await post("/signing/harmony-certificate", { key_pem: csr.body.key_pem, certificate_b64: chain });
  assert.equal(checked.status, 200, JSON.stringify(checked.body));
  assert.equal((checked.body.chain_pem.match(/BEGIN CERTIFICATE/g) ?? []).length, 2);
  assert.match(checked.body.metadata.issuer, /Huawei CBG Developer Relations CA G2/);
  assert.equal(checked.body.metadata.key_algorithm, "ECDSA P-256");

  // AGC can list the chain CA first: the key's own certificate still leads.
  const pems = Buffer.from(chain, "base64").toString("utf8").match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g)!;
  const reversed = Buffer.from(`${pems[1]}\n${pems[0]}\n`).toString("base64");
  const reordered = await post("/signing/harmony-certificate", { key_pem: csr.body.key_pem, certificate_b64: reversed });
  assert.equal(reordered.status, 200, JSON.stringify(reordered.body));
  assert.equal(reordered.body.chain_pem, checked.body.chain_pem);
  assert.equal(reordered.body.metadata.chain_length, 2);

  const other = await post("/signing/harmony-csr", { common_name: "Other" });
  const mismatch = await post("/signing/harmony-certificate", { key_pem: other.body.key_pem, certificate_b64: chain });
  assert.equal(mismatch.body.code, "signing_certificate_mismatch");
});
