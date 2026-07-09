/**
 * Parser dispatcher — routes file bytes to the right metadata extractor.
 *
 * Supported parser_kinds:
 *   - apk-aapt    (Android APK + AAB; existing, re-exported)
 *   - ipa-info    (iOS IPA Info.plist metadata)
 *   - electron-asar (zip-with-asar Electron installers — mac/win/linux)
 *   - rn-bundle   (React Native Metro bundle)
 *   - cli-binary  (single-file ELF executable — Linux/macOS CLI tools)
 *
 * Dispatch order:
 *   1. Explicit ?parser_kind=... or X-Quiver-Parser-Kind header wins.
 *   2. Filename extension hint (X-Quiver-Filename or URL ?filename=...).
 *   3. Magic byte detection (zip, ELF, RN bundle, asar).
 *   4. Falls back to apk-aapt (backward compat with v1 /parse endpoint).
 */

import { parseApk } from "./apk.js";
import { parseIpa } from "./ipa.js";
import { parseElectronAsar } from "./electron_asar.js";
import { parseRnBundle } from "./rn_bundle.js";
import { parseCliBinary } from "./cli_binary.js";

export type ParserKind = "apk-aapt" | "ipa-info" | "electron-asar" | "rn-bundle" | "cli-binary";

export interface ParsedMetadata {
  parser_kind: ParserKind;
  platform: string;             // 'android' | 'darwin' | 'linux' | 'win32' | 'rn-bundle' | ...
  arch: string | null;          // 'arm64' | 'x64' | 'arm64-v8a' | null
  version: string | null;       // human-readable version (best effort)
  version_code: number | null;  // monotonic integer (best effort)
  package_id: string | null;    // bundle id / product name
  app_label: string | null;     // display name
  size_bytes: number;
  file_hash_sha256: string;
  raw: Record<string, unknown>; // parser-specific extras
  /** Launcher icon extracted from the package, when available. */
  icon_base64?: string | null;
  icon_content_type?: string | null;
}

const EXT_TO_KIND: Record<string, ParserKind> = {
  apk: "apk-aapt",
  aab: "apk-aapt",
  ipa: "ipa-info",
  asar: "electron-asar",
  dmg: "electron-asar",   // dmg is a macOS installer; we read any embedded asar via the parent zip
  pkg: "electron-asar",
  exe: "electron-asar",
  msi: "electron-asar",
  deb: "cli-binary",
  rpm: "cli-binary",
  AppImage: "cli-binary",
  bundle: "rn-bundle",
};

export function detectParserKind(opts: {
  explicit?: ParserKind | null;
  filename?: string | null;
  bytes: Uint8Array;
}): ParserKind {
  if (opts.explicit && isKnownKind(opts.explicit)) return opts.explicit;

  // Filename extension hint
  const filename = (opts.filename ?? "").toLowerCase();
  const ext = filename.includes(".") ? filename.split(".").pop() ?? "" : "";
  if (ext && EXT_TO_KIND[ext]) return EXT_TO_KIND[ext]!;

  // Magic bytes
  if (isZip(opts.bytes)) {
    // Could be apk / aab / asar-container-in-zip. Differentiate by looking
    // for the central directory hint of an asar header.
    if (looksLikeAsarContainer(opts.bytes)) return "electron-asar";
    return "apk-aapt"; // default: most common zip upload today
  }
  if (isElf(opts.bytes)) return "cli-binary";
  if (isRnBundle(opts.bytes)) return "rn-bundle";

  // Fallback (preserves backward compat)
  return "apk-aapt";
}

export async function parseWithDispatcher(opts: {
  parserKind: ParserKind;
  bytes: Uint8Array;
  filename?: string | null;
  filePath?: string | null;
}): Promise<ParsedMetadata> {
  switch (opts.parserKind) {
    case "apk-aapt":
      return parseApk(opts.bytes, opts.filePath ?? null);
    case "ipa-info":
      return parseIpa(opts.bytes);
    case "electron-asar":
      return parseElectronAsar(opts.bytes, opts.filePath ?? null);
    case "rn-bundle":
      return parseRnBundle(opts.bytes);
    case "cli-binary":
      return parseCliBinary(opts.bytes);
  }
}

// ---------- magic-byte helpers ----------

function isKnownKind(s: string): s is ParserKind {
  return ["apk-aapt", "ipa-info", "electron-asar", "rn-bundle", "cli-binary"].includes(s);
}

function isZip(b: Uint8Array): boolean {
  return (
    b.length >= 4 &&
    b[0] === 0x50 &&
    b[1] === 0x4b &&
    (b[2] === 0x03 || b[2] === 0x05) &&
    (b[3] === 0x04 || b[3] === 0x06)
  );
}

function isElf(b: Uint8Array): boolean {
  return (
    b.length >= 4 &&
    b[0] === 0x7f &&
    b[1] === 0x45 &&
    b[2] === 0x4c &&
    b[3] === 0x46
  );
}

function isRnBundle(b: Uint8Array): boolean {
  // React Native Metro bundles start with `__d(function(` (the define wrapper).
  // Allow a small prefix (BOM / leading whitespace) up to 16 bytes.
  const head = new TextDecoder("utf-8", { fatal: false })
    .decode(b.subarray(0, Math.min(b.length, 64)))
    .trimStart();
  return head.startsWith("__d(") || head.startsWith("__r(");
}

/**
 * Cheap heuristic for "this zip contains an asar archive" without unzipping
 * the whole thing. We scan the End-of-Central-Directory record for filename
 * hints like "/app.asar" or "node_modules/app.asar".
 */
function looksLikeAsarContainer(b: Uint8Array): boolean {
  // EOCD signature: 50 4B 05 06 (little-endian). Scan the last 64KiB.
  const scanEnd = b.length;
  const scanStart = Math.max(0, b.length - 65536);
  const target = new Uint8Array([0x50, 0x4b, 0x05, 0x06]);
  let eocd = -1;
  outer: for (let i = scanStart; i < scanEnd - 22; i++) {
    if (
      b[i] === target[0] &&
      b[i + 1] === target[1] &&
      b[i + 2] === target[2] &&
      b[i + 3] === target[3]
    ) {
      eocd = i;
      break outer;
    }
  }
  if (eocd < 0) return false;
  // EOCD layout (from PKZip spec):
  //   offset+0  : sig (4)
  //   offset+12 : comment length (2)
  // We'll grab the comment-length and the comment itself.
  const commentLen =
    b[eocd + 20]! | (b[eocd + 21]! << 8);
  if (commentLen <= 0) return false;
  const comment = new TextDecoder("utf-8", { fatal: false })
    .decode(b.subarray(eocd + 22, eocd + 22 + commentLen));
  return comment.toLowerCase().includes("asar");
}

// ---------- sha256 helper shared by parsers ----------

import { createHash } from "node:crypto";

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
