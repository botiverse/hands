/**
 * Signs a .hap end to end with the real hap-sign-tool. Needs the jar and
 * OpenHarmony's public test keystore (developtools_hapsigner dist/), so it
 * runs only when HAP_SIGN_TOOL and HAPSIGNER_DIST point at them:
 *   HAP_SIGN_TOOL=.../dist/hap-sign-tool.jar HAPSIGNER_DIST=.../dist npx tsx --test src/harmony_sign.test.ts
 * The app certificate is issued by the test keystore's "openharmony
 * application ca" (as AGC's CA would) and the profile is signed with its
 * profile-release key (as AGC signs profiles).
 */
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Hono } from "hono";
import { registerSigningRoutes } from "./signing.js";

const jar = process.env.HAP_SIGN_TOOL;
const dist = process.env.HAPSIGNER_DIST;
const ready = !!jar && !!dist && existsSync(jar) && existsSync(join(dist ?? "", "OpenHarmony.p12"));

test("signs a .hap with the AGC-style key, chain and profile, and the result verifies", { skip: !ready && "set HAP_SIGN_TOOL and HAPSIGNER_DIST" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "harmony-sign-"));
  try {
    const sh = (cmd: string, args: string[]) => execFileSync(cmd, args, { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
    const app = new Hono();
    registerSigningRoutes(app);
    const post = async (path: string, body: unknown) => {
      const res = await app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      return { status: res.status, body: await res.json() as any };
    };
    // Key and CSR the way Hands makes them; certificate issued by the test CA.
    const csr = await post("/signing/harmony-csr", { common_name: "Raft Deck" });
    writeFileSync(join(dir, "req.csr"), csr.body.csr_pem);
    sh("keytool", ["-importkeystore", "-srckeystore", join(dist!, "OpenHarmony.p12"), "-srcstorepass", "123456", "-srcalias", "openharmony application ca",
      "-destkeystore", "ca.p12", "-deststorepass", "123456", "-deststoretype", "pkcs12", "-noprompt"]);
    sh("openssl", ["pkcs12", "-in", "ca.p12", "-passin", "pass:123456", "-nocerts", "-nodes", "-out", "ca.key"]);
    sh("openssl", ["pkcs12", "-in", "ca.p12", "-passin", "pass:123456", "-nokeys", "-out", "cachain.pem"]);
    const caChain = readFileSync(join(dir, "cachain.pem"), "utf8");
    writeFileSync(join(dir, "ca.pem"), caChain.slice(caChain.indexOf("-----BEGIN CERTIFICATE-----"), caChain.indexOf("-----END CERTIFICATE-----") + 25) + "\n");
    writeFileSync(join(dir, "ext.cnf"), "basicConstraints=CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=codeSigning\n");
    sh("openssl", ["x509", "-req", "-in", "req.csr", "-CA", "ca.pem", "-CAkey", "ca.key", "-set_serial", "77", "-days", "30", "-sha256", "-extfile", "ext.cnf", "-out", "leaf.pem"]);
    const leaf = readFileSync(join(dir, "leaf.pem"), "utf8");
    const checked = await post("/signing/harmony-certificate", { key_pem: csr.body.key_pem, certificate_b64: Buffer.from(leaf + caChain).toString("base64") });
    assert.equal(checked.status, 200, JSON.stringify(checked.body));
    // Profile for build.raft.deck naming this certificate, signed like AGC's.
    const now = Math.floor(Date.now() / 1000);
    writeFileSync(join(dir, "profile.json"), JSON.stringify({
      "version-name": "2.0.0", "version-code": 2, "app-distribution-type": "app_gallery", uuid: "5027b99e-5f9e-465d-9508-a9e0134ffe18",
      validity: { "not-before": now - 60, "not-after": now + 86400 }, type: "release",
      "bundle-info": { "developer-id": "OpenHarmony", "distribution-certificate": leaf, "bundle-name": "build.raft.deck", apl: "normal", "app-feature": "hos_normal_app" },
      acls: { "allowed-acls": [""] }, permissions: { "restricted-permissions": [] }, issuer: "pki_internal",
    }));
    sh("java", ["-jar", jar!, "sign-profile", "-keyAlias", "openharmony application profile release", "-signAlg", "SHA256withECDSA", "-mode", "localSign",
      "-profileCertFile", join(dist!, "OpenHarmonyProfileRelease.pem"), "-inFile", "profile.json", "-keystoreFile", join(dist!, "OpenHarmony.p12"),
      "-outFile", "profile.p7b", "-keyPwd", "123456", "-keystorePwd", "123456"]);
    writeFileSync(join(dir, "module.json"), JSON.stringify({ app: { bundleName: "build.raft.deck" }, module: { name: "entry" } }));
    sh("zip", ["-q", "-X", "unsigned.hap", "module.json"]);
    // Serve the input and take the output the way presigned R2 URLs do.
    let uploaded: Buffer | null = null;
    const server = createServer((req, res) => {
      if (req.method === "GET") { res.end(readFileSync(join(dir, "unsigned.hap"))); return; }
      const parts: Buffer[] = [];
      req.on("data", (d) => parts.push(d));
      req.on("end", () => { uploaded = Buffer.concat(parts); res.end("ok"); });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    try {
      const signed = await post("/signing/sign", {
        artifact_type: "hap", secret: { kind: "harmony", key_pem: csr.body.key_pem, chain_pem: checked.body.chain_pem },
        harmony_profile_b64: readFileSync(join(dir, "profile.p7b")).toString("base64"), sign_code: false,
        input_url: `http://127.0.0.1:${port}/in`, output_url: `http://127.0.0.1:${port}/out`,
      });
      assert.equal(signed.status, 200, JSON.stringify(signed.body));
      assert.ok(uploaded && (uploaded as Buffer).length > 0);
      writeFileSync(join(dir, "signed.hap"), uploaded!);
      const out = sh("java", ["-jar", jar!, "verify-app", "-inFile", "signed.hap", "-outCertChain", "v.cer", "-outProfile", "v.p7b"]).toString();
      assert.match(out, /verify-app success/);
      // A key that does not belong to the certificate is refused, not signed.
      const other = await post("/signing/harmony-csr", { common_name: "Other" });
      const refused = await post("/signing/sign", {
        artifact_type: "hap", secret: { kind: "harmony", key_pem: other.body.key_pem, chain_pem: checked.body.chain_pem },
        harmony_profile_b64: readFileSync(join(dir, "profile.p7b")).toString("base64"), sign_code: false,
        input_url: `http://127.0.0.1:${port}/in`, output_url: `http://127.0.0.1:${port}/out`,
      });
      assert.equal(refused.body.code, "signing_identity_invalid");
    } finally {
      server.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
