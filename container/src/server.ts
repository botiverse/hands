/**
 * APK metadata parser — runs inside Cloudflare Container.
 *
 * Endpoint: POST /parse — body = raw APK bytes → returns JSON metadata.
 *
 * Uses `aapt dump badging` for Android metadata + `apksigner verify --print-certs`
 * for the SHA-256 of the signing certificate (we store this in D1 so consumers can
 * detect repackaged APKs).
 *
 * The APK binary itself is NOT persisted here — only metadata. The Worker uploads the
 * raw APK to R2 separately via a signed PUT URL.
 */

import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFile, unlink, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

const execFileAsync = promisify(execFile);

interface ApkMetadata {
  package_name: string;
  version_name: string;
  version_code: number;
  min_sdk: number | null;
  target_sdk: number | null;
  app_label: string | null;
  signature_sha256: string;
  size_bytes: number;
  file_hash_sha256: string;
}

const app = new Hono();

app.get("/health", (c) => c.json({ ok: true, service: "apk-parser" }));

app.post("/parse", async (c) => {
  const ab = await c.req.arrayBuffer();
  if (ab.byteLength === 0) return c.json({ error: "empty body" }, 400);
  if (ab.byteLength > 200 * 1024 * 1024) {
    return c.json({ error: "APK too large (>200MB)" }, 413);
  }

  // Write to tmpfile so aapt can read it
  const tmpDir = join(tmpdir(), `apk-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(tmpDir, { recursive: true });
  const apkPath = join(tmpDir, "input.apk");
  const bytes = new Uint8Array(ab);
  await writeFile(apkPath, bytes);

  try {
    const metadata = await parseApk(apkPath, bytes);
    return c.json(metadata);
  } catch (err) {
    console.error("parse error:", err);
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  } finally {
    await unlink(apkPath).catch(() => {});
  }
});

async function parseApk(apkPath: string, bytes: Uint8Array): Promise<ApkMetadata> {
  // 1. aapt dump badging — get package_name / version_name / version_code / sdk / app_label
  const { stdout: badging } = await execFileAsync("aapt", [
    "dump", "badging", apkPath,
  ], { maxBuffer: 1024 * 1024 });

  const packageName = badging.match(/^package: name='([^']+)'/m)?.[1] ?? "";
  const versionName = badging.match(/^package: name='[^']+'\s+versionCode='(\d+)'\s+versionName='([^']+)'/m);
  const versionCode = Number(versionName?.[1] ?? "0");
  const versionNameStr = versionName?.[2] ?? "";
  const sdkLine = badging.match(/sdkVersion:'(\d+)'/);
  const targetSdkLine = badging.match(/targetSdkVersion:'(\d+)'/);
  const labelLine = badging.match(/^application-label(?:-[a-z]+)?:'([^']+)'/m);
  const minSdk = sdkLine ? Number(sdkLine[1]) : null;
  const targetSdk = targetSdkLine ? Number(targetSdkLine[1]) : null;
  const appLabel = labelLine?.[1] ?? null;

  // 2. apksigner verify --print-certs — get signer cert SHA-256
  const { stdout: certsOut } = await execFileAsync("apksigner", [
    "verify", "--print-certs", apkPath,
  ], { maxBuffer: 1024 * 1024 });

  // apksigner output: "Signer #1 certificate DN: ..." followed by
  // "Signer #1 certificate SHA-256 digest: <hex>"
  const sha256Match = certsOut.match(/SHA-256 digest:\s*([0-9a-fA-F:]+)/);
  const signatureSha256 = sha256Match?.[1]?.replace(/:/g, "").toLowerCase() ?? "";

  // 3. APK file hash + size
  const fileHash = createHash("sha256").update(bytes).digest("hex");

  return {
    package_name: packageName,
    version_name: versionNameStr,
    version_code: versionCode,
    min_sdk: minSdk,
    target_sdk: targetSdk,
    app_label: appLabel,
    signature_sha256: signatureSha256,
    size_bytes: bytes.byteLength,
    file_hash_sha256: fileHash,
  };
}

const port = Number(process.env.PORT ?? 8080);

// Start the Node HTTP server. The default export of `app.fetch` is for Workers
// runtime; on Node we use @hono/node-server to actually bind a port.
serve({ fetch: app.fetch, port }, (info) => {
  console.log(`APK parser listening on :${info.port}`);
});