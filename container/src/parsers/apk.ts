/**
 * APK metadata parser — wraps the existing aapt + apksigner pipeline.
 *
 * Used by the dispatcher when parser_kind === 'apk-aapt' (also the fallback
 * default for backward compat with the original /parse endpoint).
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFile, unlink, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256Hex } from "./index.js";
import type { ParsedMetadata } from "./index.js";

const execFileAsync = promisify(execFile);

const AAPT_BIN = "/opt/android-sdk/build-tools/34.0.0/aapt";
const APKSIGNER_BIN = "/opt/android-sdk/build-tools/34.0.0/apksigner";

export async function parseApk(
  bytes: Uint8Array,
  precomputedPath: string | null,
): Promise<ParsedMetadata> {
  const tmpDir = precomputedPath
    ? null
    : join(
        tmpdir(),
        `apk-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      );
  const apkPath =
    precomputedPath ?? join(tmpDir!, "input.apk");

  if (!precomputedPath) {
    await mkdir(tmpDir!, { recursive: true });
    await writeFile(apkPath, bytes);
  }

  try {
    const { stdout: badging } = await execFileAsync(
      AAPT_BIN,
      ["dump", "badging", apkPath],
      { maxBuffer: 1024 * 1024 },
    );

    const packageName =
      badging.match(/^package: name='([^']+)'/m)?.[1] ?? "";
    const versionMatch = badging.match(
      /^package: name='[^']+'\s+versionCode='(\d+)'\s+versionName='([^']+)'/m,
    );
    const versionCode = Number(versionMatch?.[1] ?? "0");
    const version = versionMatch?.[2] ?? "";
    const minSdk = Number(badging.match(/sdkVersion:'(\d+)'/)?.[1] ?? "0") || null;
    const targetSdk =
      Number(badging.match(/targetSdkVersion:'(\d+)'/)?.[1] ?? "0") || null;
    const appLabel =
      badging.match(/^application-label(?:-[a-z]+)?:'([^']+)'/m)?.[1] ?? null;

    // Launcher icon: prefer the highest-density PNG/WebP entry from
    // application-icon-<density> lines; adaptive-icon XML entries are
    // skipped (no rasterizer in this container).
    let iconBase64: string | null = null;
    let iconContentType: string | null = null;
    const iconCandidates = [
      ...badging.matchAll(/^application-icon-(\d+):'([^']+)'/gm),
    ]
      .map((m) => ({ density: Number(m[1]), path: m[2]! }))
      .sort((a, b) => b.density - a.density);
    const singleIcon = badging.match(/^application:.*icon='([^']+)'/m)?.[1];
    if (singleIcon) iconCandidates.push({ density: 0, path: singleIcon });
    for (const candidate of iconCandidates) {
      const lower = candidate.path.toLowerCase();
      const isPng = lower.endsWith(".png");
      const isWebp = lower.endsWith(".webp");
      if (!isPng && !isWebp) continue;
      try {
        const { stdout: iconBytes } = await execFileAsync(
          "unzip",
          ["-p", apkPath, candidate.path],
          { maxBuffer: 5 * 1024 * 1024, encoding: "buffer" },
        );
        const buf = iconBytes as unknown as Buffer;
        if (buf.length === 0) continue;
        iconBase64 = buf.toString("base64");
        iconContentType = isPng ? "image/png" : "image/webp";
        break;
      } catch {
        // entry missing or unzip failure — try the next density
      }
    }

    const { stdout: certsOut } = await execFileAsync(
      APKSIGNER_BIN,
      ["verify", "--print-certs", apkPath],
      { maxBuffer: 1024 * 1024 },
    );
    const sha256Match = certsOut.match(/SHA-256 digest:\s*([0-9a-fA-F:]+)/);
    const signatureSha256 =
      sha256Match?.[1]?.replace(/:/g, "").toLowerCase() ?? "";

    return {
      parser_kind: "apk-aapt",
      platform: "android",
      arch: null,
      version: version || null,
      version_code: Number.isFinite(versionCode) ? versionCode : null,
      package_id: packageName || null,
      app_label: appLabel,
      icon_base64: iconBase64,
      icon_content_type: iconContentType,
      size_bytes: bytes.byteLength,
      file_hash_sha256: sha256Hex(bytes),
      raw: {
        min_sdk: minSdk,
        target_sdk: targetSdk,
        signature_sha256: signatureSha256,
      },
    };
  } finally {
    if (!precomputedPath) {
      await unlink(apkPath).catch(() => {});
    }
  }
}
