/**
 * Signing endpoints. The Worker decrypts a signing identity and sends it here
 * with presigned URLs for the input and output; key material is written only
 * to a private temporary directory for the duration of one command and removed
 * afterwards. Responses never echo secrets or tool output that could hold them.
 *
 *   POST /signing/inspect           { secret }                         -> { metadata }
 *   POST /signing/generate-android  { common_name, organization, alias } -> { secret, metadata }
 *   POST /signing/sign              { artifact_type, secret, input_url, output_url, notarize, entitlements_b64? }
 *                                                                       -> { output_size, output_sha256, notary_submission_id? }
 *   POST /signing/staple            { input_url, output_url }           -> { output_size, output_sha256 }
 */

import type { Hono } from "hono";
import { createHash, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MAX_ARTIFACT_BYTES = 2 * 1024 * 1024 * 1024;
const APKSIGNER = join(process.env.SIGNING_BUILD_TOOLS ?? "/opt/android-sdk/build-tools/35.0.0", "apksigner");

type AndroidSecret = { kind: "android_keystore"; keystore_b64: string; store_password: string; key_alias: string; key_password: string };
type AppleSecret = {
  kind: "apple_developer_id" | "apple_ios_distribution";
  p12_b64: string;
  p12_password: string;
  notary?: { key_id: string; issuer_id: string; p8: string } | null;
};
type Secret = AndroidSecret | AppleSecret;

class SignError extends Error {
  constructor(readonly status: 400 | 500 | 502, readonly code: string, message: string) {
    super(message);
  }
}

async function withWorkdir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "hands-sign-"));
  await chmod(dir, 0o700);
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

async function run(cmd: string, args: string[], opts: { cwd?: string; timeout?: number; failCode: string; failMessage: string }) {
  try {
    return await execFileAsync(cmd, args, { cwd: opts.cwd, timeout: opts.timeout ?? 600_000, maxBuffer: 32 * 1024 * 1024 });
  } catch (error) {
    // Tool stderr can contain paths and, for some tools, argument echoes; keep
    // only a short, filtered tail for diagnosis.
    const stderr = String((error as { stderr?: unknown }).stderr ?? "").split("\n")
      .filter((line) => !/pass|secret|key/i.test(line)).slice(-6).join(" ").slice(0, 600);
    throw new SignError(400, opts.failCode, `${opts.failMessage}${stderr ? `: ${stderr}` : ""}`);
  }
}

async function writeSecretFile(dir: string, name: string, content: string | Buffer) {
  const path = join(dir, name);
  await writeFile(path, content, { mode: 0o600 });
  return path;
}

async function download(url: string, dest: string) {
  const response = await fetch(url, { signal: AbortSignal.timeout(600_000) });
  if (!response.ok) throw new SignError(502, "signing_input_unavailable", `input download returned ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > MAX_ARTIFACT_BYTES) throw new SignError(400, "signing_input_too_large", "input is too large");
  await writeFile(dest, bytes);
}

async function upload(url: string, path: string) {
  const bytes = await readFile(path);
  const response = await fetch(url, {
    method: "PUT",
    headers: { "content-type": "application/octet-stream" },
    body: bytes,
    signal: AbortSignal.timeout(600_000),
  });
  if (!response.ok) throw new SignError(502, "signing_output_upload_failed", `output upload returned ${response.status}`);
  return { output_size: bytes.length, output_sha256: createHash("sha256").update(bytes).digest("hex") };
}

// ---------- Certificate facts ----------

function parseX509Text(text: string) {
  const field = (name: string) => text.match(new RegExp(`^${name}=(.*)$`, "m"))?.[1]?.trim();
  const subject = field("subject");
  const fingerprint = text.match(/Fingerprint=([0-9A-F:]+)/i)?.[1]?.replaceAll(":", "").toLowerCase();
  const teamId = subject?.match(/OU\s*=\s*([A-Z0-9]{10})\b/)?.[1];
  return {
    subject,
    issuer: field("issuer"),
    sha256_fingerprint: fingerprint,
    not_before: field("notBefore"),
    not_after: field("notAfter"),
    ...(teamId ? { team_id: teamId } : {}),
  };
}

async function certFacts(dir: string, certPem: string) {
  const certPath = join(dir, "cert.pem");
  await writeFile(certPath, certPem);
  const { stdout } = await run("openssl", ["x509", "-in", certPath, "-noout", "-subject", "-issuer", "-dates", "-fingerprint", "-sha256", "-nameopt", "RFC2253"], {
    failCode: "signing_identity_invalid", failMessage: "certificate could not be read",
  });
  return parseX509Text(stdout);
}

async function inspectAndroid(dir: string, secret: AndroidSecret) {
  const ks = await writeSecretFile(dir, "ks.p12", Buffer.from(secret.keystore_b64, "base64"));
  const storePass = await writeSecretFile(dir, "store.pass", secret.store_password);
  const { stdout } = await run("keytool", [
    "-exportcert", "-rfc", "-keystore", ks, "-storetype", "PKCS12", "-storepass:file", storePass, "-alias", secret.key_alias,
  ], { failCode: "signing_identity_invalid", failMessage: "keystore, password or alias is wrong" });
  // Prove the key password opens the private key, not only the store.
  const keyPass = await writeSecretFile(dir, "key.pass", secret.key_password);
  await run("keytool", [
    "-certreq", "-keystore", ks, "-storetype", "PKCS12", "-storepass:file", storePass, "-keypass:file", keyPass,
    "-alias", secret.key_alias, "-file", join(dir, "probe.csr"),
  ], { failCode: "signing_identity_invalid", failMessage: "key password does not open the key" });
  const facts = await certFacts(dir, stdout);
  return { ...facts, key_alias: secret.key_alias };
}

async function p12CertPem(dir: string, secret: AppleSecret) {
  const p12 = await writeSecretFile(dir, "id.p12", Buffer.from(secret.p12_b64, "base64"));
  const pass = await writeSecretFile(dir, "p12.pass", secret.p12_password);
  const args = ["pkcs12", "-in", p12, "-passin", `file:${pass}`, "-nokeys", "-clcerts"];
  try {
    return (await run("openssl", args, { failCode: "signing_identity_invalid", failMessage: "certificate file or password is wrong" })).stdout;
  } catch {
    // Keychain Access exports older p12 encryption that OpenSSL 3 reads only with -legacy.
    return (await run("openssl", [...args, "-legacy"], { failCode: "signing_identity_invalid", failMessage: "certificate file or password is wrong" })).stdout;
  }
}

/**
 * The p12's key and certificates as one PEM file (0600). rcodesign reads only
 * the older p12 encryption; OpenSSL reads both, so the key is handed over as PEM.
 */
async function p12ToPem(dir: string, secret: AppleSecret) {
  const p12 = await writeSecretFile(dir, "id.p12", Buffer.from(secret.p12_b64, "base64"));
  const pass = await writeSecretFile(dir, "p12.pass", secret.p12_password);
  const pem = join(dir, "identity.pem");
  const args = ["pkcs12", "-in", p12, "-passin", `file:${pass}`, "-nodes", "-out", pem];
  try {
    await run("openssl", args, { failCode: "signing_identity_invalid", failMessage: "certificate file or password is wrong" });
  } catch {
    await run("openssl", [...args, "-legacy"], { failCode: "signing_identity_invalid", failMessage: "certificate file or password is wrong" });
  }
  await chmod(pem, 0o600);
  return pem;
}

async function inspectApple(dir: string, secret: AppleSecret) {
  const facts = await certFacts(dir, await p12CertPem(dir, secret));
  if (secret.kind === "apple_developer_id" && !/Developer ID Application/.test(facts.subject ?? "")) {
    throw new SignError(400, "signing_identity_wrong_type", "certificate is not a Developer ID Application certificate");
  }
  if (secret.kind === "apple_ios_distribution" && !/(Apple Distribution|iPhone Distribution)/.test(facts.subject ?? "")) {
    throw new SignError(400, "signing_identity_wrong_type", "certificate is not an Apple Distribution certificate");
  }
  return { ...facts, notary_key_id: secret.notary?.key_id ?? null };
}

function inspect(dir: string, secret: Secret): Promise<Record<string, unknown>> {
  return secret.kind === "android_keystore" ? inspectAndroid(dir, secret) : inspectApple(dir, secret);
}

// ---------- Signing ----------

async function signAndroid(dir: string, secret: AndroidSecret, type: "apk" | "aab", input: string, output: string) {
  const ks = await writeSecretFile(dir, "ks.p12", Buffer.from(secret.keystore_b64, "base64"));
  const storePass = await writeSecretFile(dir, "store.pass", secret.store_password);
  const keyPass = await writeSecretFile(dir, "key.pass", secret.key_password);
  if (type === "apk") {
    // apksigner 35 aligns while signing: native libraries to 16 KB pages (the
    // Play requirement for Android 15+), everything else to 4 bytes.
    await run(APKSIGNER, [
      "sign", "--ks", ks, "--ks-type", "PKCS12", "--ks-pass", `file:${storePass}`, "--ks-key-alias", secret.key_alias,
      "--key-pass", `file:${keyPass}`, "--lib-page-alignment", "16384", "--out", output, input,
    ], { failCode: "signing_failed", failMessage: "apksigner failed" });
    await run(APKSIGNER, ["verify", output], { failCode: "signing_verify_failed", failMessage: "signed APK does not verify" });
  } else {
    await run("jarsigner", [
      "-keystore", ks, "-storetype", "PKCS12", "-storepass:file", storePass, "-keypass:file", keyPass,
      "-sigalg", "SHA256withRSA", "-digestalg", "SHA-256", "-signedjar", output, input, secret.key_alias,
    ], { failCode: "signing_failed", failMessage: "jarsigner failed" });
    await run("jarsigner", ["-verify", output], { failCode: "signing_verify_failed", failMessage: "signed bundle does not verify" });
  }
}

/** Unzip a .app archive and return the single .app bundle inside. */
async function unpackApp(dir: string, archive: string) {
  const root = join(dir, "app");
  await mkdir(root);
  await run("unzip", ["-q", archive, "-d", root], { failCode: "signing_input_invalid", failMessage: "input is not a zip archive" });
  const apps = (await readdir(root)).filter((name) => name.endsWith(".app"));
  if (apps.length !== 1) throw new SignError(400, "signing_input_invalid", "the zip must contain exactly one .app at its top level");
  return { root, app: apps[0]! };
}

async function zipApp(root: string, app: string, output: string) {
  // zip appends ".zip" to a name without an extension, so write that name and move it.
  const archive = `${output}.zip`;
  await run("zip", ["-q", "-r", "-y", archive, app], { cwd: root, failCode: "signing_failed", failMessage: "could not archive the signed app" });
  await rename(archive, output);
}

async function notaryKeyFile(dir: string, notary: NonNullable<AppleSecret["notary"]>) {
  const p8 = await writeSecretFile(dir, "notary.p8", notary.p8);
  const keyJson = join(dir, "notary.json");
  await run("rcodesign", ["encode-app-store-connect-api-key", "-o", keyJson, notary.issuer_id, notary.key_id, p8], {
    failCode: "signing_identity_invalid", failMessage: "notary API key is invalid",
  });
  await chmod(keyJson, 0o600);
  return keyJson;
}

async function signMac(dir: string, secret: AppleSecret, input: string, output: string, entitlementsB64: string | undefined, notarize: boolean) {
  const pem = await p12ToPem(dir, secret);
  const { root, app } = await unpackApp(dir, input);
  // --for-notarization: hardened runtime and a secure timestamp on every signed item.
  // rcodesign refuses it for a non-Apple certificate, so local tests with a
  // self-signed certificate set HANDS_SIGNING_TEST_SELF_SIGNED=1 (never set in
  // the deployed container) to sign with the hardened runtime only.
  const args = ["sign", "--pem-file", pem, ...(process.env.HANDS_SIGNING_TEST_SELF_SIGNED === "1" ? ["--code-signature-flags", "runtime"] : ["--for-notarization"])];
  if (entitlementsB64) {
    args.push("--entitlements-xml-file", await writeSecretFile(dir, "entitlements.plist", Buffer.from(entitlementsB64, "base64")));
  }
  args.push(join(root, app));
  await run("rcodesign", args, { failCode: "signing_failed", failMessage: "rcodesign could not sign the app", timeout: 1_200_000 });
  await zipApp(root, app, output);
  if (!notarize) return null;
  if (!secret.notary) throw new SignError(400, "signing_notary_not_configured", "this identity has no notary API key");
  const key = await notaryKeyFile(dir, secret.notary);
  const { stdout, stderr } = await run("rcodesign", ["notary-submit", "--api-key-file", key, output], {
    failCode: "signing_notary_submit_failed", failMessage: "Apple did not accept the notarization upload", timeout: 1_200_000,
  });
  const id = `${stdout}\n${stderr}`.match(/created submission ID: ([0-9a-f-]{36})/i)?.[1]
    ?? `${stdout}\n${stderr}`.match(/\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i)?.[1];
  if (!id) throw new SignError(502, "signing_notary_submit_failed", "Apple returned no submission id");
  return id;
}

async function staple(dir: string, input: string, output: string) {
  const { root, app } = await unpackApp(dir, input);
  await run("rcodesign", ["staple", join(root, app)], { failCode: "signing_staple_failed", failMessage: "could not staple the notarization ticket" });
  await zipApp(root, app, output);
}

// ---------- Routes ----------

function respondError(c: { json: (body: unknown, status: number) => Response }, error: unknown) {
  if (error instanceof SignError) return c.json({ error: error.message, code: error.code }, error.status);
  // Name and message only: never the request body, which carries key material.
  console.error(JSON.stringify({ event: "signing_internal_error", name: error instanceof Error ? error.name : "unknown", message: error instanceof Error ? error.message.slice(0, 300) : "" }));
  return c.json({ error: "signing failed unexpectedly", code: "signing_internal" }, 500);
}

const randomPassword = () => randomBytes(24).toString("base64url");

export function registerSigningRoutes(app: Hono) {
  app.post("/signing/inspect", async (c) => {
    try {
      const { secret } = await c.req.json() as { secret: Secret };
      const metadata = await withWorkdir((dir) => inspect(dir, secret));
      return c.json({ metadata });
    } catch (error) {
      return respondError(c, error);
    }
  });

  app.post("/signing/generate-android", async (c) => {
    try {
      const body = await c.req.json() as { common_name?: string; organization?: string; alias?: string };
      const alias = /^[A-Za-z0-9_-]{1,64}$/.test(body.alias ?? "") ? body.alias! : "release";
      const clean = (v: unknown, fallback: string) =>
        typeof v === "string" && /^[\p{L}\p{N} ._-]{1,64}$/u.test(v) ? v : fallback;
      const dname = `CN=${clean(body.common_name, "Android")}, O=${clean(body.organization, "Hands")}`;
      const result = await withWorkdir(async (dir) => {
        const password = randomPassword();
        const ks = join(dir, "ks.p12");
        const pass = await writeSecretFile(dir, "pass", password);
        // PKCS12 stores use one password for store and key. 30 years: Play
        // requires validity beyond 2033-10-22.
        await run("keytool", [
          "-genkeypair", "-keystore", ks, "-storetype", "PKCS12", "-storepass:file", pass, "-keypass:file", pass,
          "-alias", alias, "-keyalg", "RSA", "-keysize", "4096", "-validity", "10950", "-dname", dname,
        ], { failCode: "signing_generate_failed", failMessage: "keytool could not generate the key" });
        const secret: AndroidSecret = {
          kind: "android_keystore",
          keystore_b64: (await readFile(ks)).toString("base64"),
          store_password: password,
          key_alias: alias,
          key_password: password,
        };
        const metadata = await inspectAndroid(dir, secret);
        return { secret, metadata: { ...metadata, key_algorithm: "RSA 4096" } };
      });
      return c.json(result);
    } catch (error) {
      return respondError(c, error);
    }
  });

  app.post("/signing/sign", async (c) => {
    try {
      const body = await c.req.json() as {
        artifact_type: "apk" | "aab" | "macos" | "ipa";
        secret: Secret;
        input_url: string;
        output_url: string;
        notarize?: boolean;
        entitlements_b64?: string;
        expected_input_sha256?: string;
      };
      const result = await withWorkdir(async (dir) => {
        const input = join(dir, "input");
        const output = join(dir, "output");
        await download(body.input_url, input);
        if (body.expected_input_sha256) {
          const actual = createHash("sha256").update(await readFile(input)).digest("hex");
          if (actual !== body.expected_input_sha256) {
            throw new SignError(400, "signing_input_mismatch", "uploaded file does not match the declared SHA-256");
          }
        }
        let notarySubmissionId: string | null = null;
        if ((body.artifact_type === "apk" || body.artifact_type === "aab") && body.secret.kind === "android_keystore") {
          await signAndroid(dir, body.secret, body.artifact_type, input, output);
        } else if (body.artifact_type === "macos" && body.secret.kind === "apple_developer_id") {
          notarySubmissionId = await signMac(dir, body.secret, input, output, body.entitlements_b64, body.notarize === true);
        } else {
          throw new SignError(400, "signing_unsupported", `cannot sign ${body.artifact_type} with this identity`);
        }
        await stat(output);
        return { ...(await upload(body.output_url, output)), notary_submission_id: notarySubmissionId };
      });
      return c.json(result);
    } catch (error) {
      return respondError(c, error);
    }
  });

  app.post("/signing/staple", async (c) => {
    try {
      const body = await c.req.json() as { input_url: string; output_url: string };
      const result = await withWorkdir(async (dir) => {
        const input = join(dir, "input.zip");
        const output = join(dir, "output.zip");
        await download(body.input_url, input);
        await staple(dir, input, output);
        return upload(body.output_url, output);
      });
      return c.json(result);
    } catch (error) {
      return respondError(c, error);
    }
  });
}
