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
 *   POST /signing/ipa-info          { input_url, expected_input_sha256 } -> { bundle_id, version, build, extensions }
 *   POST /signing/entitlements      { entitlements_b64 }               -> { entitlements } (the plist as JSON)
 *   POST /signing/apple-csr         { common_name }                    -> { key_pem, csr_pem }
 *   POST /signing/apple-p12         { kind, key_pem, certificate_b64, notary? } -> { secret, metadata }
 *
 * `apple-csr` and `apple-p12` let Hands make the Apple key itself: the key and
 * its certificate request are generated here, Apple issues the certificate
 * (through the App Store Connect API, or a person on the Apple Developer
 * site), and the issued certificate is joined with the key into a p12.
 *
 * An `ipa` is re-signed with an Apple Distribution identity and an App Store
 * provisioning profile: `provisioning_profile_b64` (one the Worker got from
 * App Store Connect) or, without it, the identity's uploaded profile that
 * covers the bundle. `entitlements_b64` is what the app asks for; every entry
 * must be allowed by the profile.
 */

import type { Hono } from "hono";
import { createHash, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { execFile } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  EntitlementError,
  PlistError,
  appStoreEntitlements,
  asDict,
  parsePlist,
  parseXmlPlist,
  profileCoversBundle,
  profileInfo,
  toXmlPlist,
  type PlistDict,
  type PlistValue,
  type ProfileInfo,
} from "./ios.js";

const execFileAsync = promisify(execFile);
const MAX_ARTIFACT_BYTES = 2 * 1024 * 1024 * 1024;
/** Uncompressed size and entry count an uploaded .app archive may expand to. */
const MAX_UNPACKED_BYTES = 4 * 1024 * 1024 * 1024;
const MAX_UNPACKED_ENTRIES = 200_000;
const APKSIGNER = join(process.env.SIGNING_BUILD_TOOLS ?? "/opt/android-sdk/build-tools/35.0.0", "apksigner");

type AndroidSecret = { kind: "android_keystore"; keystore_b64: string; store_password: string; key_alias: string; key_password: string };
type AppleSecret = {
  kind: "apple_developer_id" | "apple_ios_distribution";
  p12_b64: string;
  p12_password: string;
  notary?: { key_id: string; issuer_id: string; p8: string } | null;
  provisioning_profiles_b64?: string[];
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

/** Stream the input to disk, hashing as it goes; never more than one chunk in memory. */
async function download(url: string, dest: string): Promise<string> {
  let response: Response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(600_000) });
  } catch {
    throw new SignError(502, "signing_input_unavailable", "input download failed");
  }
  if (!response.ok || !response.body) throw new SignError(502, "signing_input_unavailable", `input download returned ${response.status}`);
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > MAX_ARTIFACT_BYTES) throw new SignError(400, "signing_input_too_large", "input is too large");
  const hash = createHash("sha256");
  let total = 0;
  const limiter = new Transform({
    transform(chunk: Buffer, _enc, done) {
      total += chunk.length;
      if (total > MAX_ARTIFACT_BYTES) return done(new SignError(400, "signing_input_too_large", "input is too large"));
      hash.update(chunk);
      done(null, chunk);
    },
  });
  try {
    await pipeline(Readable.fromWeb(response.body as never), limiter, createWriteStream(dest, { mode: 0o600 }));
  } catch (error) {
    if (error instanceof SignError) throw error;
    throw new SignError(502, "signing_input_unavailable", "input download was interrupted");
  }
  return hash.digest("hex");
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(path), hash);
  return hash.digest("hex");
}

/** Stream the output to its presigned URL. */
async function upload(url: string, path: string) {
  const { size } = await stat(path);
  const sha256 = await sha256File(path);
  let response: Response;
  try {
    response = await fetch(url, {
      method: "PUT",
      headers: { "content-type": "application/octet-stream", "content-length": String(size) },
      body: Readable.toWeb(createReadStream(path)) as never,
      duplex: "half",
      signal: AbortSignal.timeout(600_000),
    } as RequestInit);
  } catch {
    throw new SignError(502, "signing_output_upload_failed", "output upload failed");
  }
  if (!response.ok) throw new SignError(502, "signing_output_upload_failed", `output upload returned ${response.status}`);
  return { output_size: size, output_sha256: sha256 };
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

function assertAlias(alias: string) {
  // JDK launchers treat an argument starting with -J as a JVM option.
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(alias) || alias.startsWith("-")) {
    throw new SignError(400, "signing_identity_invalid", "key alias may contain only letters, digits, . _ - and cannot start with -");
  }
}

async function inspectAndroid(dir: string, secret: AndroidSecret) {
  assertAlias(secret.key_alias);
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
  assertAlias(secret.key_alias);
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
  // Refuse archives that would expand past the limits before writing anything.
  const { stdout } = await run("unzip", ["-Zt", archive], { failCode: "signing_input_invalid", failMessage: "input is not a zip archive" });
  const totals = stdout.match(/(\d+) files?, (\d+) bytes uncompressed/);
  if (!totals || Number(totals[1]) > MAX_UNPACKED_ENTRIES || Number(totals[2]) > MAX_UNPACKED_BYTES) {
    throw new SignError(400, "signing_input_too_large", "the archive expands past the allowed size");
  }
  const root = join(dir, "app");
  await mkdir(root);
  await run("unzip", ["-q", archive, "-d", root], { failCode: "signing_input_invalid", failMessage: "input is not a zip archive" });
  const apps = (await readdir(root)).filter((name) => name.endsWith(".app"));
  if (apps.length !== 1) throw new SignError(400, "signing_input_invalid", "the zip must contain exactly one .app at its top level");
  const appPath = join(root, apps[0]!);
  if ((await lstat(appPath)).isSymbolicLink() || !(await lstat(appPath)).isDirectory()) {
    throw new SignError(400, "signing_input_invalid", "the .app must be a directory");
  }
  await assertContained(root, appPath);
  return { root, app: apps[0]! };
}

/** Every symlink inside the bundle must resolve to a path inside it (frameworks use relative links). */
async function assertContained(root: string, path: string) {
  const realRoot = await realpath(root);
  const walk = async (current: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isSymbolicLink()) {
        let target: string;
        try {
          target = await realpath(full);
        } catch {
          throw new SignError(400, "signing_input_invalid", "the bundle contains a broken symbolic link");
        }
        if (target !== realRoot && !target.startsWith(`${realRoot}/`)) {
          throw new SignError(400, "signing_input_invalid", "the bundle contains a symbolic link that points outside it");
        }
      } else if (entry.isDirectory()) {
        await walk(full);
      }
    }
  };
  await walk(path);
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
  await rm(input, { force: true }); // free disk before signing
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
  const id = `${stdout}\n${stderr}`.match(/created submission ID: ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i)?.[1];
  if (!id) throw new SignError(502, "signing_notary_submit_failed", "Apple returned no submission id");
  return id;
}

async function staple(dir: string, input: string, output: string) {
  const { root, app } = await unpackApp(dir, input);
  await rm(input, { force: true });
  await run("rcodesign", ["staple", join(root, app)], { failCode: "signing_staple_failed", failMessage: "could not staple the notarization ticket" });
  await zipApp(root, app, output);
}

// ---------- iOS ----------

/** Unpack an .ipa: exactly one Payload/<name>.app, every symlink inside the archive. */
async function unpackIpa(dir: string, archive: string) {
  const { stdout } = await run("unzip", ["-Zt", archive], { failCode: "signing_input_invalid", failMessage: "input is not a zip archive" });
  const totals = stdout.match(/(\d+) files?, (\d+) bytes uncompressed/);
  if (!totals || Number(totals[1]) > MAX_UNPACKED_ENTRIES || Number(totals[2]) > MAX_UNPACKED_BYTES) {
    throw new SignError(400, "signing_input_too_large", "the archive expands past the allowed size");
  }
  const root = join(dir, "ipa");
  await mkdir(root);
  await run("unzip", ["-q", archive, "-d", root], { failCode: "signing_input_invalid", failMessage: "input is not a zip archive" });
  const payload = join(root, "Payload");
  if (!(await lstat(payload).catch(() => null))?.isDirectory()) throw new SignError(400, "signing_input_invalid", "the .ipa has no Payload folder");
  const apps = (await readdir(payload)).filter((name) => name.endsWith(".app"));
  if (apps.length !== 1) throw new SignError(400, "signing_input_invalid", "Payload must contain exactly one .app");
  const app = join(payload, apps[0]!);
  if ((await lstat(app)).isSymbolicLink() || !(await lstat(app)).isDirectory()) throw new SignError(400, "signing_input_invalid", "the .app must be a directory");
  await assertContained(root, root);
  return { root, app };
}

async function bundleFacts(app: string) {
  let info: PlistDict;
  try {
    info = asDict(parsePlist(await readFile(join(app, "Info.plist"))), "Info.plist");
  } catch (error) {
    throw new SignError(400, "signing_input_invalid", `cannot read the app's Info.plist: ${error instanceof Error ? error.message : "error"}`);
  }
  const bundleId = info.CFBundleIdentifier;
  if (typeof bundleId !== "string" || !/^[A-Za-z0-9.-]{1,155}$/.test(bundleId)) {
    throw new SignError(400, "signing_input_invalid", "Info.plist has no valid CFBundleIdentifier");
  }
  const executable = typeof info.CFBundleExecutable === "string" ? info.CFBundleExecutable : null;
  // App extensions and watch apps each need their own App ID and profile.
  const extensions: string[] = [];
  for (const sub of ["PlugIns", "Extensions", "Watch", "AppClips"]) {
    const entries = await readdir(join(app, sub)).catch(() => [] as string[]);
    extensions.push(...entries.filter((name) => /\.(appex|app)$/.test(name)).map((name) => `${sub}/${name}`));
  }
  return {
    bundle_id: bundleId,
    version: typeof info.CFBundleShortVersionString === "string" ? info.CFBundleShortVersionString : null,
    build: typeof info.CFBundleVersion === "string" ? info.CFBundleVersion : null,
    executable,
    extensions,
  };
}

/** The XML inside a .mobileprovision (a CMS envelope signed by Apple). */
async function decodeProfile(dir: string, profileB64: string, index: number): Promise<{ info: ProfileInfo; der: Buffer }> {
  const der = Buffer.from(profileB64, "base64");
  const path = join(dir, `profile-${index}.mobileprovision`);
  await writeFile(path, der);
  const { stdout } = await run("openssl", ["cms", "-verify", "-noverify", "-inform", "DER", "-in", path], {
    failCode: "signing_profile_invalid", failMessage: "a provisioning profile could not be read",
  });
  try {
    return { info: profileInfo(parseXmlPlist(stdout), (cert) => createHash("sha256").update(cert).digest("hex")), der };
  } catch (error) {
    throw new SignError(400, "signing_profile_invalid", `a provisioning profile is malformed: ${error instanceof Error ? error.message : "error"}`);
  }
}

async function signIos(
  dir: string,
  secret: AppleSecret,
  input: string,
  output: string,
  entitlementsB64: string | undefined,
  profileB64: string | undefined,
) {
  const facts = await certFacts(dir, await p12CertPem(dir, secret));
  const pem = await p12ToPem(dir, secret);
  const { root, app } = await unpackIpa(dir, input);
  await rm(input, { force: true });
  const bundle = await bundleFacts(app);
  if (bundle.extensions.length > 0) {
    throw new SignError(400, "signing_unsupported", `app extensions are not supported yet: ${bundle.extensions.join(", ")}`);
  }
  const candidates = profileB64 ? [profileB64] : (secret.provisioning_profiles_b64 ?? []);
  const now = Date.now();
  const reasons: string[] = [];
  let chosen: { info: ProfileInfo; der: Buffer } | null = null;
  for (const [index, b64] of candidates.entries()) {
    const profile = await decodeProfile(dir, b64, index);
    if (!profileCoversBundle(profile.info, bundle.bundle_id)) reasons.push(`${profile.info.name}: for ${profile.info.application_identifier}`);
    else if (Date.parse(profile.info.expiration) <= now) reasons.push(`${profile.info.name}: expired ${profile.info.expiration}`);
    else if (!profile.info.certificate_sha256.includes(facts.sha256_fingerprint ?? "")) reasons.push(`${profile.info.name}: does not include this certificate`);
    else { chosen = profile; break; }
  }
  if (!chosen) {
    throw new SignError(400, "signing_profile_missing", `no provisioning profile fits ${bundle.bundle_id}${reasons.length ? ` (${reasons.join("; ")})` : ""}`);
  }
  let requested: PlistDict = {};
  if (entitlementsB64) {
    try {
      requested = asDict(parsePlist(Buffer.from(entitlementsB64, "base64")), "entitlements");
    } catch (error) {
      throw new SignError(400, "signing_entitlements_invalid", `entitlements are not a property list: ${error instanceof PlistError ? error.message : "error"}`);
    }
  }
  let entitlements: PlistDict;
  try {
    entitlements = appStoreEntitlements(chosen.info, bundle.bundle_id, requested);
  } catch (error) {
    if (error instanceof EntitlementError) throw new SignError(400, "signing_entitlements_refused", error.message);
    throw error;
  }
  await writeFile(join(app, "embedded.mobileprovision"), chosen.der);
  await rm(join(app, "_CodeSignature"), { recursive: true, force: true });
  const entitlementsFile = join(dir, "entitlements.plist");
  await writeFile(entitlementsFile, toXmlPlist(entitlements));
  // The team ID in the code directory must match the profile; set it rather than rely on reading the certificate.
  await run("rcodesign", ["sign", "--pem-file", pem, "--team-name", chosen.info.team_id, "--entitlements-xml-file", entitlementsFile, app], {
    failCode: "signing_failed", failMessage: "rcodesign could not sign the app", timeout: 1_200_000,
  });
  // Re-pack every top-level entry (Payload, SwiftSupport, Symbols) with symlinks kept.
  const archive = `${output}.zip`;
  const entries = (await readdir(root)).sort((a, b) => (a === "Payload" ? -1 : b === "Payload" ? 1 : a.localeCompare(b)));
  await run("zip", ["-q", "-r", "-y", archive, ...entries], { cwd: root, failCode: "signing_failed", failMessage: "could not archive the signed app" });
  await rename(archive, output);
  return {
    bundle_id: bundle.bundle_id,
    version: bundle.version,
    build: bundle.build,
    profile: { name: chosen.info.name, uuid: chosen.info.uuid, expiration: chosen.info.expiration, team_id: chosen.info.team_id },
    entitlement_keys: Object.keys(entitlements).sort(),
  };
}

// ---------- Routes ----------


// ---------- Apple keys made in Hands ----------

function certificateDer(b64OrPem: string): Buffer {
  const text = b64OrPem.trim();
  const pem = text.match(/-----BEGIN CERTIFICATE-----([\s\S]+?)-----END CERTIFICATE-----/);
  const body = pem ? pem[1]!.replace(/\s+/g, "") : text.replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(body)) throw new SignError(400, "signing_identity_invalid", "certificate must be a .cer file (DER or PEM)");
  return Buffer.from(body, "base64");
}

async function appleCsr(dir: string, commonName: string) {
  const key = join(dir, "key.pem");
  const csr = join(dir, "request.csr");
  // Apple issues signing certificates for RSA 2048 requests.
  await run("openssl", [
    "req", "-new", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", csr, "-subj", `/CN=${commonName}/C=US`,
  ], { failCode: "signing_generate_failed", failMessage: "openssl could not generate the key" });
  return { key_pem: await readFile(key, "utf8"), csr_pem: await readFile(csr, "utf8") };
}

/** HarmonyOS signing keys are ECDSA P-256 (SHA256withECDSA); AGC issues the certificate for this CSR. */
async function harmonyCsr(dir: string, commonName: string) {
  const key = join(dir, "key.pem");
  const csr = join(dir, "request.csr");
  await run("openssl", ["ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", key],
    { failCode: "signing_generate_failed", failMessage: "openssl could not generate the key" });
  await run("openssl", ["req", "-new", "-sha256", "-key", key, "-out", csr, "-subj", `/CN=${commonName}/O=Hands/C=CN`],
    { failCode: "signing_generate_failed", failMessage: "openssl could not write the request" });
  return { key_pem: await readFile(key, "utf8"), csr_pem: await readFile(csr, "utf8") };
}

/**
 * Checks that the certificate AGC issued (PEM or DER, possibly a chain) is for
 * this key, and reports its public facts. The chain is returned as PEM.
 */
async function harmonyCertificate(dir: string, keyPem: string, certificate: string) {
  const key = await writeSecretFile(dir, "key.pem", keyPem);
  const raw = Buffer.from(certificate, "base64");
  const input = join(dir, "cert.in");
  await writeFile(input, raw);
  let text = raw.toString("utf8");
  if (!text.includes("-----BEGIN CERTIFICATE-----")) {
    // DER: one certificate, or a PKCS#7 bundle of several.
    const pem = join(dir, "cert.pem");
    try {
      await run("openssl", ["x509", "-inform", "DER", "-in", input, "-out", pem], { failCode: "x", failMessage: "x" });
    } catch {
      await run("openssl", ["pkcs7", "-inform", "DER", "-in", input, "-print_certs", "-out", pem], {
        failCode: "signing_identity_invalid", failMessage: "certificate could not be read",
      });
    }
    text = await readFile(pem, "utf8");
  }
  const blocks = text.replace(/\r\n/g, "\n").match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? [];
  if (blocks.length === 0) throw new SignError(400, "signing_identity_invalid", "certificate could not be read");
  const ownKey = (await run("openssl", ["pkey", "-in", key, "-pubout"], { failCode: "signing_internal", failMessage: "stored key could not be read" })).stdout.trim();
  // AGC may list the chain in any order: find this key's certificate, then
  // follow issuer to subject so the chain is end-entity first, as
  // hap-sign-tool requires.
  const certs: Array<{ pem: string; subject: string; issuer: string; pubkey: string; facts: string }> = [];
  for (const [i, block] of blocks.entries()) {
    const path = join(dir, `c${i}.pem`);
    await writeFile(path, `${block}\n`);
    const facts = (await run("openssl", ["x509", "-in", path, "-noout", "-subject", "-issuer", "-dates", "-fingerprint", "-sha256", "-nameopt", "RFC2253"], {
      failCode: "signing_identity_invalid", failMessage: "certificate could not be read",
    })).stdout;
    const pubkey = (await run("openssl", ["x509", "-in", path, "-noout", "-pubkey"], { failCode: "signing_identity_invalid", failMessage: "certificate has no public key" })).stdout.trim();
    const line = (name: string) => facts.split("\n").find((l) => l.startsWith(`${name}=`))?.slice(name.length + 1).trim() ?? "";
    certs.push({ pem: block, subject: line("subject"), issuer: line("issuer"), pubkey, facts });
  }
  const leaf = certs.find((c) => c.pubkey === ownKey);
  if (!leaf) throw new SignError(400, "signing_certificate_mismatch", "AGC issued the certificate for a different key");
  const ordered = [leaf];
  const rest = certs.filter((c) => c !== leaf);
  for (let next = rest.find((c) => c.subject === leaf.issuer); next; next = rest.find((c) => c.subject === ordered.at(-1)!.issuer && !ordered.includes(c))) {
    ordered.push(next);
    if (next.subject === next.issuer) break;
  }
  for (const c of rest) if (!ordered.includes(c)) ordered.push(c);
  const field = (name: string) => leaf.facts.split("\n").find((l) => l.startsWith(`${name}=`))?.slice(name.length + 1).trim();
  return {
    chain_pem: ordered.map((c) => `${c.pem}\n`).join(""),
    metadata: {
      subject: field("subject"), issuer: field("issuer"), not_before: field("notBefore"), not_after: field("notAfter"),
      sha256_fingerprint: leaf.facts.split("\n").find((l) => l.toLowerCase().includes("fingerprint="))?.split("=")[1]?.trim(),
      chain_length: ordered.length,
      key_algorithm: "ECDSA P-256",
    },
  };
}

const HAP_SIGN_TOOL = process.env.HAP_SIGN_TOOL ?? "/opt/hapsigner/hap-sign-tool.jar";

/**
 * Signs a HarmonyOS .hap or .app with Huawei's hap-sign-tool: the key and the
 * AGC certificate chain go into a one-use PKCS#12 store, the profile is the
 * .p7b AGC issued. The signed file is verified before it is returned.
 */
async function signHarmony(dir: string, type: "hap" | "app", secret: { key_pem: string; chain_pem: string }, profileB64: string, input: string, output: string, signCode: boolean) {
  // hap-sign-tool decides the format by the file name's suffix.
  const named = join(dir, `unsigned.${type}`);
  const signedNamed = join(dir, `signed.${type}`);
  await rename(input, named);
  const key = await writeSecretFile(dir, "key.pem", secret.key_pem);
  const chain = join(dir, "chain.pem");
  await writeFile(chain, secret.chain_pem);
  const leaf = join(dir, "leaf.pem");
  await writeFile(leaf, secret.chain_pem.slice(0, secret.chain_pem.indexOf("-----END CERTIFICATE-----") + 25) + "\n");
  const profile = join(dir, "profile.p7b");
  await writeFile(profile, Buffer.from(profileB64, "base64"));
  const password = randomPassword();
  const pass = await writeSecretFile(dir, "p12.pass", password);
  const p12 = join(dir, "id.p12");
  await run("openssl", ["pkcs12", "-export", "-inkey", key, "-in", leaf, "-name", "hands", "-passout", `file:${pass}`, "-out", p12], {
    failCode: "signing_identity_invalid", failMessage: "the signing key does not match its certificate",
  });
  await run("java", [
    "-jar", HAP_SIGN_TOOL, "sign-app", "-mode", "localSign", "-keyAlias", "hands", "-signAlg", "SHA256withECDSA",
    "-appCertFile", chain, "-profileFile", profile, "-inFile", named, "-keystoreFile", p12, "-outFile", signedNamed,
    "-keyPwd", password, "-keystorePwd", password, "-signCode", signCode ? "1" : "0",
  ], { timeout: 20 * 60_000, failCode: "signing_failed", failMessage: "hap-sign-tool could not sign the package (does the profile's bundle name and certificate match?)" });
  await run("java", ["-jar", HAP_SIGN_TOOL, "verify-app", "-inFile", signedNamed, "-outCertChain", join(dir, "verify.cer"), "-outProfile", join(dir, "verify.p7b")], {
    timeout: 10 * 60_000, failCode: "signing_failed", failMessage: "the signed package did not verify",
  });
  await rename(signedNamed, output);
}

/** Join a key made here with the certificate Apple issued for it. */
async function appleP12(dir: string, kind: AppleSecret["kind"], keyPem: string, certificate: string) {
  const key = await writeSecretFile(dir, "key.pem", keyPem);
  const der = join(dir, "cert.cer");
  await writeFile(der, certificateDer(certificate));
  const cert = join(dir, "cert.pem");
  await run("openssl", ["x509", "-inform", "DER", "-in", der, "-out", cert], {
    failCode: "signing_identity_invalid", failMessage: "certificate could not be read; download the .cer file from the Apple Developer site",
  });
  const certKey = (await run("openssl", ["x509", "-in", cert, "-noout", "-pubkey"], { failCode: "signing_identity_invalid", failMessage: "certificate has no public key" })).stdout;
  const ownKey = (await run("openssl", ["pkey", "-in", key, "-pubout"], { failCode: "signing_internal", failMessage: "stored key could not be read" })).stdout;
  if (certKey.trim() !== ownKey.trim()) {
    throw new SignError(400, "signing_certificate_mismatch", "this certificate was issued for a different request; upload the certificate made from this request's .certSigningRequest file");
  }
  const password = randomPassword();
  const pass = await writeSecretFile(dir, "p12.pass", password);
  const p12 = join(dir, "id.p12");
  await run("openssl", ["pkcs12", "-export", "-inkey", key, "-in", cert, "-passout", `file:${pass}`, "-out", p12], {
    failCode: "signing_generate_failed", failMessage: "openssl could not write the p12",
  });
  return { kind, p12_b64: (await readFile(p12)).toString("base64"), p12_password: password };
}

/** Entitlement values as JSON: dates as ISO strings, data as base64. */
function plistToJson(value: PlistValue): unknown {
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Uint8Array) return Buffer.from(value).toString("base64");
  if (Array.isArray(value)) return value.map(plistToJson);
  if (typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, plistToJson(v)]));
  return value;
}

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
      const alias = typeof body.alias === "string" && body.alias !== "" ? body.alias : "release";
      assertAlias(alias);
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
        artifact_type: "apk" | "aab" | "macos" | "ipa" | "hap" | "app";
        harmony_profile_b64?: string;
        sign_code?: boolean;
        secret: Secret;
        input_url: string;
        output_url: string;
        notarize?: boolean;
        entitlements_b64?: string;
        expected_input_sha256?: string;
        provisioning_profile_b64?: string;
      };
      const result = await withWorkdir(async (dir) => {
        const input = join(dir, "input");
        const output = join(dir, "output");
        const actual = await download(body.input_url, input);
        if (body.expected_input_sha256) {
          if (actual !== body.expected_input_sha256) {
            throw new SignError(400, "signing_input_mismatch", "uploaded file does not match the declared SHA-256");
          }
        }
        let notarySubmissionId: string | null = null;
        let ios: Awaited<ReturnType<typeof signIos>> | null = null;
        if ((body.artifact_type === "apk" || body.artifact_type === "aab") && body.secret.kind === "android_keystore") {
          await signAndroid(dir, body.secret, body.artifact_type, input, output);
        } else if (body.artifact_type === "macos" && body.secret.kind === "apple_developer_id") {
          notarySubmissionId = await signMac(dir, body.secret, input, output, body.entitlements_b64, body.notarize === true);
        } else if ((body.artifact_type === "hap" || body.artifact_type === "app") && (body.secret as { kind: string }).kind === "harmony") {
          if (typeof body.harmony_profile_b64 !== "string") throw new SignError(400, "invalid_request", "harmony_profile_b64 is required");
          await signHarmony(dir, body.artifact_type, body.secret as unknown as { key_pem: string; chain_pem: string }, body.harmony_profile_b64, input, output, body.sign_code !== false);
        } else if (body.artifact_type === "ipa" && body.secret.kind === "apple_ios_distribution") {
          ios = await signIos(dir, body.secret, input, output, body.entitlements_b64, body.provisioning_profile_b64);
        } else {
          throw new SignError(400, "signing_unsupported", `cannot sign ${body.artifact_type} with this identity`);
        }
        await stat(output);
        return { ...(await upload(body.output_url, output)), notary_submission_id: notarySubmissionId, ...(ios ? { ios } : {}) };
      });
      return c.json(result);
    } catch (error) {
      return respondError(c, error);
    }
  });

  app.post("/signing/ipa-info", async (c) => {
    try {
      const body = await c.req.json() as { input_url: string; expected_input_sha256?: string };
      const result = await withWorkdir(async (dir) => {
        const input = join(dir, "input");
        const actual = await download(body.input_url, input);
        if (body.expected_input_sha256 && actual !== body.expected_input_sha256) {
          throw new SignError(400, "signing_input_mismatch", "uploaded file does not match the declared SHA-256");
        }
        const { app } = await unpackIpa(dir, input);
        const { executable: _executable, ...facts } = await bundleFacts(app);
        return facts;
      });
      return c.json(result);
    } catch (error) {
      return respondError(c, error);
    }
  });

  app.post("/signing/entitlements", async (c) => {
    try {
      const body = await c.req.json() as { entitlements_b64?: unknown };
      if (typeof body.entitlements_b64 !== "string" || body.entitlements_b64.length > 64 * 1024) {
        throw new SignError(400, "signing_entitlements_invalid", "entitlements_b64 must be a property list of at most 48 KB");
      }
      let dict: PlistDict;
      try {
        dict = asDict(parsePlist(Buffer.from(body.entitlements_b64, "base64")), "entitlements");
      } catch (error) {
        throw new SignError(400, "signing_entitlements_invalid", `entitlements are not a property list: ${error instanceof PlistError ? error.message : "error"}`);
      }
      return c.json({ entitlements: plistToJson(dict) });
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

  app.post("/signing/apple-csr", async (c) => {
    try {
      const body = await c.req.json() as { common_name?: unknown };
      const name = typeof body.common_name === "string" && /^[\p{L}\p{N} ,.&_()-]{1,64}$/u.test(body.common_name) ? body.common_name : "Hands";
      return c.json(await withWorkdir((dir) => appleCsr(dir, name)));
    } catch (error) {
      return respondError(c, error);
    }
  });

  app.post("/signing/harmony-csr", async (c) => {
    try {
      const body = await c.req.json() as { common_name?: unknown };
      const name = typeof body.common_name === "string" && /^[\p{L}\p{N} ,.&_()-]{1,64}$/u.test(body.common_name) ? body.common_name : "Hands";
      return c.json(await withWorkdir((dir) => harmonyCsr(dir, name)));
    } catch (error) {
      return respondError(c, error);
    }
  });

  app.post("/signing/harmony-certificate", async (c) => {
    try {
      const body = await c.req.json() as { key_pem?: unknown; certificate_b64?: unknown };
      if (typeof body.key_pem !== "string" || typeof body.certificate_b64 !== "string") {
        throw new SignError(400, "invalid_request", "key_pem and certificate_b64 are required");
      }
      return c.json(await withWorkdir((dir) => harmonyCertificate(dir, body.key_pem as string, body.certificate_b64 as string)));
    } catch (error) {
      return respondError(c, error);
    }
  });

  app.post("/signing/apple-p12", async (c) => {
    try {
      const body = await c.req.json() as { kind?: unknown; key_pem?: unknown; certificate_b64?: unknown; notary?: AppleSecret["notary"] };
      const kind = body.kind === "apple_developer_id" || body.kind === "apple_ios_distribution" ? body.kind : null;
      if (!kind || typeof body.key_pem !== "string" || typeof body.certificate_b64 !== "string") {
        throw new SignError(400, "invalid_request", "kind, key_pem and certificate_b64 are required");
      }
      const result = await withWorkdir(async (dir) => {
        const identity = await appleP12(dir, kind, body.key_pem as string, body.certificate_b64 as string);
        const metadata = await inspectApple(dir, { ...identity, notary: body.notary ?? null });
        return { secret: identity, metadata: { ...metadata, key_algorithm: "RSA 2048" } };
      });
      return c.json(result);
    } catch (error) {
      return respondError(c, error);
    }
  });
}
