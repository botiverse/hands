/**
 * `hands sign` — sign an artifact with a signing identity held by Hands — and
 * `hands signing identities ...` to manage those identities (org admin).
 *
 * The file is uploaded to Hands, signed there (and for macOS notarized and
 * stapled), and downloaded back; keys never reach the machine running this.
 */

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, open, readFile, rm, stat, writeFile, rename } from "node:fs/promises";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import type { Command } from "commander";
import { apiRequest } from "../lib/api.js";
import { jsonRequested } from "../lib/json_output.js";
import { resolveAppId } from "./deploy_tokens.js";

const execFileAsync = promisify(execFile);

interface SigningJob {
  id: string;
  status: "awaiting_upload" | "signing" | "notarizing" | "stapling" | "succeeded" | "failed";
  artifact_type: string;
  output_sha256: string | null;
  output_size: number | null;
  notary_submission_id: string | null;
  notary_status: string | null;
  error_code: string | null;
  error_message: string | null;
  download_url?: string;
}

interface SigningIdentity {
  id: string;
  kind: string;
  name: string;
  origin: string;
  metadata: Record<string, unknown>;
  backup_exported_at: number | null;
  apps: Array<{ app_id: string; slug: string }>;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function inferType(path: string): "apk" | "aab" | "macos" | "ipa" | null {
  if (path.endsWith(".apk")) return "apk";
  if (path.endsWith(".ipa")) return "ipa";
  if (path.endsWith(".aab")) return "aab";
  if (path.endsWith(".app") || path.endsWith(".app.zip")) return "macos";
  return null;
}

/** A .app directory is zipped (symlinks kept) for upload; a .zip is sent as-is. */
async function packInput(path: string, work: string): Promise<string> {
  const info = await stat(path);
  if (!info.isDirectory()) return path;
  if (!path.endsWith(".app")) throw new Error(`${path} is a directory but not a .app bundle`);
  const zip = join(work, `${basename(path)}.zip`);
  try {
    await execFileAsync("ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", path, zip]);
  } catch {
    await execFileAsync("zip", ["-q", "-r", "-y", zip, basename(path)], { cwd: dirname(path) });
  }
  return zip;
}

async function unpackOutput(signedZip: string, original: string, work: string) {
  // Replace the .app directory with the signed one from the archive.
  const extract = join(work, "signed");
  await execFileAsync("mkdir", ["-p", extract]);
  try {
    await execFileAsync("ditto", ["-x", "-k", signedZip, extract]);
  } catch {
    await execFileAsync("unzip", ["-q", signedZip, "-d", extract]);
  }
  const signedApp = join(extract, basename(original));
  await stat(signedApp);
  await rm(original, { recursive: true, force: true });
  await rename(signedApp, original);
}

export async function signFile(opts: {
  app: string;
  file: string;
  type?: string;
  identity?: string;
  notarize?: boolean;
  entitlements?: string;
  out?: string;
  timeoutMs: number;
  log: (line: string) => void;
}): Promise<SigningJob> {
  const appId = await resolveAppId(opts.app);
  const type = opts.type ?? inferType(opts.file);
  if (type !== "apk" && type !== "aab" && type !== "macos" && type !== "ipa") {
    throw new Error("Pass --type apk|aab|macos|ipa (could not infer it from the file name).");
  }
  const work = await mkdtemp(join(tmpdir(), "hands-sign-"));
  try {
    const input = await packInput(opts.file, work);
    const size = (await stat(input)).size;
    const inputHash = createHash("sha256");
    await pipeline(createReadStream(input), inputHash);
    const sha256 = inputHash.digest("hex");
    const created = await apiRequest<{ job: SigningJob; upload_url: string; upload_headers: Record<string, string> }>(
      `/api/apps/${appId}/signing/jobs`,
      {
        method: "POST",
        body: {
          artifact_type: type,
          filename: basename(input),
          size,
          sha256,
          notarize: opts.notarize === true,
          ...(opts.identity ? { identity_id: opts.identity } : {}),
        },
        retryOnUnauthorized: false,
      },
    );
    opts.log(`Signing job ${created.job.id}: uploading ${size} bytes`);
    const put = await fetch(created.upload_url, {
      method: "PUT",
      headers: { ...created.upload_headers, "content-length": String(size) },
      body: Readable.toWeb(createReadStream(input)) as never,
      duplex: "half",
    } as RequestInit);
    if (!put.ok) throw new Error(`upload failed (${put.status})`);
    const entitlements = opts.entitlements ? (await readFile(opts.entitlements)).toString("base64") : undefined;
    let { job } = await apiRequest<{ job: SigningJob }>(`/api/apps/${appId}/signing/jobs/${created.job.id}/sign`, {
      method: "POST",
      body: entitlements ? { entitlements_b64: entitlements } : {},
      retryOnUnauthorized: false,
    });
    const deadline = Date.now() + opts.timeoutMs;
    let lastStatus = "";
    while (job.status !== "succeeded" && job.status !== "failed") {
      const status = `${job.status}${job.notary_status ? ` (${job.notary_status})` : ""}`;
      if (status !== lastStatus) opts.log(`Signing job ${job.id}: ${status}`);
      lastStatus = status;
      if (Date.now() > deadline) throw new Error(`timed out waiting for signing job ${job.id} (${status})`);
      await sleep(job.status === "notarizing" ? 20_000 : 3_000);
      ({ job } = await apiRequest<{ job: SigningJob }>(`/api/apps/${appId}/signing/jobs/${job.id}`));
    }
    if (job.status === "failed") throw new Error(`signing failed: ${job.error_code ?? "error"}: ${job.error_message ?? ""}`);
    if (!job.download_url) throw new Error("signed file has no download URL");
    const response = await fetch(job.download_url);
    if (!response.ok || !response.body) throw new Error(`download failed (${response.status})`);
    // Stream to a temporary file while hashing; only a verified file replaces the target.
    const downloaded = join(work, "signed.bin");
    const outputHash = createHash("sha256");
    const tap = new Transform({ transform(chunk: Buffer, _enc, done) { outputHash.update(chunk); done(null, chunk); } });
    await pipeline(Readable.fromWeb(response.body as never), tap, createWriteStream(downloaded));
    if (outputHash.digest("hex") !== job.output_sha256) throw new Error("downloaded file does not match the signed file's SHA-256");
    if (type === "macos" && (await stat(opts.file)).isDirectory()) {
      await unpackOutput(downloaded, opts.out ?? opts.file, work);
    } else {
      await rename(downloaded, opts.out ?? opts.file).catch(async () => {
        // Across filesystems: copy instead.
        await pipeline(createReadStream(downloaded), createWriteStream(opts.out ?? opts.file));
      });
    }
    return job;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

function parseDuration(value: string): number {
  const match = /^(\d+)(s|m|h)?$/.exec(value.trim());
  if (!match) throw new Error(`invalid duration ${value}`);
  const n = Number(match[1]);
  return n * (match[2] === "h" ? 3_600_000 : match[2] === "s" ? 1000 : 60_000);
}

/** An App Store Connect API key given as files, or copied from an app that holds one. */
async function apiKeyOption(fromApp: string | undefined, keyId: string | undefined, issuerId: string | undefined, keyPath: string | undefined) {
  if (fromApp) {
    if (keyId || issuerId || keyPath) throw new Error("give either --*-from-app or the key id, issuer id and .p8, not both");
    return { from_app: await resolveAppId(fromApp) };
  }
  if (!keyId && !issuerId && !keyPath) return null;
  if (!keyId || !issuerId || !keyPath) throw new Error("an App Store Connect API key needs its key id, issuer id and .p8 file");
  return { key_id: keyId, issuer_id: issuerId, p8: await readFile(keyPath, "utf8") };
}

export function registerSigningCommands(program: Command): void {
  program
    .command("sign <file>")
    .description(
      "Sign an APK, AAB, macOS .app (directory or .app.zip) or iOS .ipa with a signing identity held by Hands. " +
      "macOS apps can be notarized and stapled. The signed file replaces the input unless --out is given.",
    )
    .requiredOption("--app <appIdOrSlug>", "App whose granted signing identity to use.")
    .option("--type <type>", "apk | aab | macos | ipa (inferred from the file name when omitted)")
    .option("--identity <id>", "Signing identity id, when several are granted to the app.")
    .option("--notarize", "macOS: notarize with Apple and staple the ticket.", false)
    .option("--entitlements <plist>", "macOS and iOS: entitlements plist for the main executable (iOS: each entry must be allowed by the App Store profile).")
    .option("--out <path>", "Write the signed file here instead of replacing the input.")
    .option("--timeout <duration>", "Give up after this long (e.g. 30m).", "45m")
    .option("--json", "Output JSON.", false)
    .action(async (file: string, opts: { app: string; type?: string; identity?: string; notarize?: boolean; entitlements?: string; out?: string; timeout: string; json?: boolean }) => {
      const json = jsonRequested(program, opts.json);
      const job = await signFile({
        app: opts.app,
        file,
        ...(opts.type ? { type: opts.type } : {}),
        ...(opts.identity ? { identity: opts.identity } : {}),
        notarize: opts.notarize === true,
        ...(opts.entitlements ? { entitlements: opts.entitlements } : {}),
        ...(opts.out ? { out: opts.out } : {}),
        timeoutMs: parseDuration(opts.timeout),
        log: (line) => (json ? console.error(line) : console.log(line)),
      });
      if (json) {
        const { download_url: _url, ...rest } = job;
        console.log(JSON.stringify(rest, null, 2));
        return;
      }
      console.log(`Signed ${opts.out ?? file} (sha256 ${job.output_sha256}${job.notary_submission_id ? `, notarized ${job.notary_submission_id}` : ""}).`);
    });

  const signing = program.command("signing").description("Manage signing identities held by Hands (org admin).");
  const identities = signing.command("identities").description("Signing keys and certificates of an organization.");

  const orgOf = async (org?: string) => {
    if (org) return org;
    const me = await apiRequest<{ account?: { org_id?: string } }>("/api/auth/me");
    if (!me.account?.org_id) throw new Error("Pass --org.");
    return me.account.org_id;
  };

  identities.command("list")
    .option("--org <orgId>", "Organization (default: your current org).")
    .option("--json", "Output JSON.", false)
    .action(async (opts: { org?: string; json?: boolean }) => {
      const orgId = await orgOf(opts.org);
      const res = await apiRequest<{ signing_identities: SigningIdentity[] }>(`/api/orgs/${orgId}/signing-identities`);
      if (jsonRequested(program, opts.json)) {
        console.log(JSON.stringify(res, null, 2));
        return;
      }
      if (res.signing_identities.length === 0) {
        console.log("No signing identities.");
        return;
      }
      console.log(["NAME", "KIND", "ORIGIN", "FINGERPRINT", "EXPIRES", "APPS", "ID"].join("\t"));
      for (const i of res.signing_identities) {
        console.log([
          i.name, i.kind, i.origin, String(i.metadata.sha256_fingerprint ?? "-").slice(0, 16),
          String(i.metadata.not_after ?? "-"), i.apps.map((a) => a.slug).join(",") || "-", i.id,
        ].join("\t"));
      }
    });

  identities.command("generate-android <name>")
    .description("Create a new Android signing key inside Hands (RSA 4096, valid 30 years).")
    .option("--org <orgId>", "Organization (default: your current org).")
    .option("--common-name <cn>", "Certificate common name.")
    .option("--organization <o>", "Certificate organization.")
    .option("--alias <alias>", "Key alias.", "release")
    .action(async (name: string, opts: { org?: string; commonName?: string; organization?: string; alias: string }) => {
      const orgId = await orgOf(opts.org);
      const res = await apiRequest<{ signing_identity: SigningIdentity }>(`/api/orgs/${orgId}/signing-identities/generate-android`, {
        method: "POST",
        body: { name, common_name: opts.commonName, organization: opts.organization, alias: opts.alias },
        retryOnUnauthorized: false,
      });
      console.log(`Created ${res.signing_identity.name} (${res.signing_identity.id}), SHA-256 ${res.signing_identity.metadata.sha256_fingerprint}.`);
    });

  identities.command("upload-android <name> <keystore>")
    .description("Upload an existing Android keystore (PKCS12 or JKS converted to PKCS12). Passwords are read from HANDS_KEYSTORE_PASSWORD / HANDS_KEY_PASSWORD.")
    .requiredOption("--alias <alias>", "Key alias.")
    .option("--org <orgId>", "Organization (default: your current org).")
    .action(async (name: string, keystore: string, opts: { alias: string; org?: string }) => {
      const orgId = await orgOf(opts.org);
      const storePassword = process.env.HANDS_KEYSTORE_PASSWORD;
      if (!storePassword) throw new Error("Set HANDS_KEYSTORE_PASSWORD.");
      const res = await apiRequest<{ signing_identity: SigningIdentity }>(`/api/orgs/${orgId}/signing-identities`, {
        method: "POST",
        body: {
          kind: "android_keystore",
          name,
          keystore_b64: (await readFile(keystore)).toString("base64"),
          store_password: storePassword,
          key_alias: opts.alias,
          key_password: process.env.HANDS_KEY_PASSWORD ?? storePassword,
        },
        retryOnUnauthorized: false,
      });
      console.log(`Uploaded ${res.signing_identity.name} (${res.signing_identity.id}), SHA-256 ${res.signing_identity.metadata.sha256_fingerprint}.`);
    });

  identities.command("upload-apple <name> <p12>")
    .description("Upload a Developer ID Application certificate (.p12; password from HANDS_P12_PASSWORD) and, for notarization, an App Store Connect API key.")
    .option("--notary-key-id <id>", "App Store Connect API key id.")
    .option("--notary-issuer-id <id>", "App Store Connect issuer id.")
    .option("--notary-key <p8>", "Path to the AuthKey_<id>.p8 file.")
    .option("--notary-from-app <appIdOrSlug>", "Use the App Store Connect API key that this app already holds for TestFlight.")
    .option("--org <orgId>", "Organization (default: your current org).")
    .action(async (name: string, p12: string, opts: { notaryKeyId?: string; notaryIssuerId?: string; notaryKey?: string; notaryFromApp?: string; org?: string }) => {
      const orgId = await orgOf(opts.org);
      const notary = await apiKeyOption(opts.notaryFromApp, opts.notaryKeyId, opts.notaryIssuerId, opts.notaryKey);
      const res = await apiRequest<{ signing_identity: SigningIdentity }>(`/api/orgs/${orgId}/signing-identities`, {
        method: "POST",
        body: {
          kind: "apple_developer_id",
          name,
          p12_b64: (await readFile(p12)).toString("base64"),
          p12_password: process.env.HANDS_P12_PASSWORD ?? "",
          notary,
        },
        retryOnUnauthorized: false,
      });
      console.log(`Uploaded ${res.signing_identity.name} (${res.signing_identity.id}): ${res.signing_identity.metadata.subject}.`);
    });

  identities.command("upload-apple-ios <name> <p12>")
    .description(
      "Upload an Apple Distribution certificate (.p12; password from HANDS_P12_PASSWORD) for iOS. Give an App Store Connect " +
      "API key (App Manager or Admin role) so Hands creates the App Store provisioning profile, or upload profiles with --profile.",
    )
    .option("--asc-key-id <id>", "App Store Connect API key id.")
    .option("--asc-issuer-id <id>", "App Store Connect issuer id.")
    .option("--asc-key <p8>", "Path to the AuthKey_<id>.p8 file.")
    .option("--asc-from-app <appIdOrSlug>", "Use the App Store Connect API key that this app already holds for TestFlight.")
    .option("--profile <path>", "A .mobileprovision file. Repeatable.", (value: string, all: string[]) => [...all, value], [] as string[])
    .option("--org <orgId>", "Organization (default: your current org).")
    .action(async (name: string, p12: string, opts: { ascKeyId?: string; ascIssuerId?: string; ascKey?: string; ascFromApp?: string; profile: string[]; org?: string }) => {
      const orgId = await orgOf(opts.org);
      const asc = await apiKeyOption(opts.ascFromApp, opts.ascKeyId, opts.ascIssuerId, opts.ascKey);
      const res = await apiRequest<{ signing_identity: SigningIdentity }>(`/api/orgs/${orgId}/signing-identities`, {
        method: "POST",
        body: {
          kind: "apple_ios_distribution",
          name,
          p12_b64: (await readFile(p12)).toString("base64"),
          p12_password: process.env.HANDS_P12_PASSWORD ?? "",
          asc,
          provisioning_profiles_b64: await Promise.all(opts.profile.map(async (path) => (await readFile(path)).toString("base64"))),
        },
        retryOnUnauthorized: false,
      });
      console.log(`Uploaded ${res.signing_identity.name} (${res.signing_identity.id}): ${res.signing_identity.metadata.subject}.`);
    });

  identities.command("generate-apple-ios <name>")
    .description(
      "Create an Apple Distribution certificate for iOS inside Hands: the key is made in Hands and App Store Connect issues " +
      "the certificate. Needs an API key with the Admin role; Hands also uses it for provisioning profiles.",
    )
    .option("--asc-key-id <id>", "App Store Connect API key id.")
    .option("--asc-issuer-id <id>", "App Store Connect issuer id.")
    .option("--asc-key <p8>", "Path to the AuthKey_<id>.p8 file.")
    .option("--asc-from-app <appIdOrSlug>", "Use the App Store Connect API key that this app already holds for TestFlight.")
    .option("--org <orgId>", "Organization (default: your current org).")
    .action(async (name: string, opts: { ascKeyId?: string; ascIssuerId?: string; ascKey?: string; ascFromApp?: string; org?: string }) => {
      const orgId = await orgOf(opts.org);
      const asc = await apiKeyOption(opts.ascFromApp, opts.ascKeyId, opts.ascIssuerId, opts.ascKey);
      if (!asc) throw new Error("give an App Store Connect API key: --asc-from-app, or --asc-key-id, --asc-issuer-id and --asc-key");
      const res = await apiRequest<{ signing_identity: SigningIdentity }>(`/api/orgs/${orgId}/signing-identities/generate-apple-ios`, {
        method: "POST", body: { name, asc }, retryOnUnauthorized: false,
      });
      console.log(`Created ${res.signing_identity.name} (${res.signing_identity.id}): ${res.signing_identity.metadata.subject}.`);
    });

  identities.command("request-apple <name> <outFile>")
    .description(
      "Make an Apple key inside Hands and write its certificate request (.certSigningRequest). Create the certificate from it " +
      "on the Apple Developer site, then run `complete-request` with the .cer. Developer ID certificates can only be made this way.",
    )
    .requiredOption("--kind <kind>", "developer-id (macOS) or distribution (iOS).")
    .option("--notary-from-app <appIdOrSlug>", "macOS: notarize with the API key this app already holds.")
    .option("--asc-from-app <appIdOrSlug>", "iOS: manage provisioning profiles with the API key this app already holds.")
    .option("--org <orgId>", "Organization (default: your current org).")
    .action(async (name: string, outFile: string, opts: { kind: string; notaryFromApp?: string; ascFromApp?: string; org?: string }) => {
      const kind = opts.kind === "developer-id" ? "apple_developer_id" : opts.kind === "distribution" ? "apple_ios_distribution" : null;
      if (!kind) throw new Error("--kind must be developer-id or distribution");
      const orgId = await orgOf(opts.org);
      const key = kind === "apple_developer_id"
        ? { notary: await apiKeyOption(opts.notaryFromApp, undefined, undefined, undefined) }
        : { asc: await apiKeyOption(opts.ascFromApp, undefined, undefined, undefined) };
      const res = await apiRequest<{ certificate_request: { id: string; csr_pem: string } }>(`/api/orgs/${orgId}/signing-certificate-requests`, {
        method: "POST", body: { kind, name, ...key }, retryOnUnauthorized: false,
      });
      await writeFile(outFile, res.certificate_request.csr_pem);
      console.log(`Wrote ${outFile}. Request id ${res.certificate_request.id}: upload the file at https://developer.apple.com/account/resources/certificates/add, then run`);
      console.log(`  hands signing identities complete-request ${res.certificate_request.id} <downloaded .cer>`);
    });

  identities.command("complete-request <requestId> <cerFile>")
    .description("Add the certificate Apple issued for a request made with `request-apple`; it becomes a signing identity.")
    .option("--org <orgId>", "Organization (default: your current org).")
    .action(async (requestId: string, cerFile: string, opts: { org?: string }) => {
      const orgId = await orgOf(opts.org);
      const res = await apiRequest<{ signing_identity: SigningIdentity }>(
        `/api/orgs/${orgId}/signing-certificate-requests/${encodeURIComponent(requestId)}/complete`,
        { method: "POST", body: { certificate_b64: (await readFile(cerFile)).toString("base64") }, retryOnUnauthorized: false },
      );
      console.log(`Created ${res.signing_identity.name} (${res.signing_identity.id}): ${res.signing_identity.metadata.subject}.`);
    });

  identities.command("grant <identityId> <appIdOrSlug>")
    .description("Let an app sign with this identity.")
    .option("--org <orgId>", "Organization (default: your current org).")
    .action(async (identityId: string, app: string, opts: { org?: string }) => {
      const orgId = await orgOf(opts.org);
      const appId = await resolveAppId(app);
      await apiRequest(`/api/orgs/${orgId}/signing-identities/${identityId}/apps/${appId}`, { method: "PUT" });
      console.log(`Granted ${identityId} to ${app}.`);
    });

  identities.command("ungrant <identityId> <appIdOrSlug>")
    .option("--org <orgId>", "Organization (default: your current org).")
    .action(async (identityId: string, app: string, opts: { org?: string }) => {
      const orgId = await orgOf(opts.org);
      const appId = await resolveAppId(app);
      await apiRequest(`/api/orgs/${orgId}/signing-identities/${identityId}/apps/${appId}`, { method: "DELETE" });
      console.log(`Removed ${identityId} from ${app}.`);
    });

  identities.command("revoke <identityId>")
    .option("--org <orgId>", "Organization (default: your current org).")
    .action(async (identityId: string, opts: { org?: string }) => {
      const orgId = await orgOf(opts.org);
      await apiRequest(`/api/orgs/${orgId}/signing-identities/${identityId}`, { method: "DELETE" });
      console.log(`Revoked ${identityId}.`);
    });

  identities.command("backup <identityId> <outFile>")
    .description("Download the one-time backup of a key generated in Hands (PKCS12). Works once.")
    .option("--org <orgId>", "Organization (default: your current org).")
    .action(async (identityId: string, outFile: string, opts: { org?: string }) => {
      const orgId = await orgOf(opts.org);
      const res = await apiRequest<{ keystore_b64: string; store_password: string; key_alias: string }>(
        `/api/orgs/${orgId}/signing-identities/${identityId}/backup`,
        { method: "POST", retryOnUnauthorized: false },
      );
      // Never overwrite an existing file: create both exclusively, owner-only.
      for (const [path, content] of [[outFile, Buffer.from(res.keystore_b64, "base64")], [`${outFile}.password`, `${res.store_password}\n`]] as const) {
        const handle = await open(path, "wx", 0o600);
        try {
          await handle.writeFile(content);
        } finally {
          await handle.close();
        }
      }
      console.log(`Wrote ${outFile} (alias ${res.key_alias}) and ${outFile}.password. Store both offline; this was the only copy Hands will give out.`);
    });
}
