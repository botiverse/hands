/**
 * Shared helpers for detecting platform / arch / filetype from a filename.
 *
 * Used by both:
 *   - components/ReleaseAssetsPanel.tsx (drop zone on each release row)
 *   - pages/Releases.tsx (NewReleaseDialog step 3)
 *
 * Detection order:
 *   1. Android arch tokens (arm64-v8a / armeabi-v7a / x86 / x86_64) — match
 *      before the extension.
 *   2. Electron filename hints (darwin / linux / win32 / windows) + arch.
 *   3. Extension → platform + filetype fallback.
 */

export interface DetectedFileMeta {
  platform: string;
  arch: string | null;
  variant: string | null;
  filetype: string;
}

export const KNOWN_ARCHES_ANDROID = [
  "arm64-v8a",
  "armeabi-v7a",
  "x86",
  "x86_64",
] as const;

export const KNOWN_ARCHES_ELECTRON = [
  "arm64",
  "x64",
  "ia32",
  "universal",
] as const;

export const KNOWN_PLATFORMS = [
  "android",
  "ios",
  "darwin",
  "linux",
  "win32",
  "rn-bundle",
] as const;

export const KNOWN_FILETYPES = [
  "apk",
  "aab",
  "ipa",
  "dmg",
  "pkg",
  "exe",
  "msi",
  "deb",
  "rpm",
  "AppImage",
  "zip",
  "tar.gz",
  "bundle",
] as const;

export function detectFromFilename(filename: string): DetectedFileMeta {
  const lower = filename.toLowerCase();
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";

  // Android: arch tokens commonly appear before the extension.
  // e.g. myapp-arm64-v8a-release.apk, app-armeabi-v7a.apk, app-x86_64.apk
  let arch: string | null = null;
  for (const a of KNOWN_ARCHES_ANDROID) {
    const token = a.replace("_", "[-_]?");
    if (new RegExp(`[-_]${token}(?=[-_.]|$)`, "i").test(lower)) {
      arch = a;
      break;
    }
  }
  let platform = "android";
  let filetype = ext || "apk";
  if (["dmg", "pkg"].includes(ext) || lower.includes("darwin") || lower.includes("macos")) {
    platform = "darwin";
    for (const a of KNOWN_ARCHES_ELECTRON) {
      if (lower.includes(`-${a}`) || lower.includes(`_${a}`)) {
        arch = a;
        break;
      }
    }
    if (arch == null) arch = "universal";
    filetype = ext === "pkg" ? "pkg" : "dmg";
  } else if (["exe", "msi"].includes(ext) || lower.includes("win32") || lower.includes("windows")) {
    platform = "win32";
    arch = KNOWN_ARCHES_ELECTRON.find((a) => lower.includes(a)) ?? "x64";
    filetype = ext === "msi" ? "msi" : "exe";
  } else if (["deb", "rpm", "appimage"].includes(ext) || lower.includes("linux")) {
    platform = "linux";
    arch = KNOWN_ARCHES_ELECTRON.find((a) => lower.includes(a)) ?? "x64";
    filetype = ext === "rpm" ? "rpm" : ext === "appimage" ? "AppImage" : "deb";
  } else if (ext === "ipa") {
    platform = "ios";
    filetype = "ipa";
  } else if (ext === "aab") {
    platform = "android";
    filetype = "aab";
  } else if (ext === "bundle") {
    platform = "rn-bundle";
    filetype = "bundle";
  }
  return { platform, arch, variant: null, filetype };
}

export interface PendingFile {
  file: File;
  platform: string;
  arch: string | null;
  variant: string | null;
  filetype: string;
  detected: DetectedFileMeta;
  status: "pending" | "uploading" | "registering" | "done" | "error";
  error?: string;
  assetId?: string;
}

function platformFromHint(hint?: string): string | null {
  if (!hint) return null;
  if ((KNOWN_PLATFORMS as readonly string[]).includes(hint)) return hint;
  if (hint.startsWith("android-")) return "android";
  if (hint.startsWith("ios-")) return "ios";
  if (hint.includes("electron")) return "darwin";
  if (hint.includes("rn") || hint.includes("bundle")) return "rn-bundle";
  return null;
}

export function pendingFileFromFile(file: File, platformHint?: string): PendingFile {
  const det = detectFromFilename(file.name);
  const hintedPlatform = platformFromHint(platformHint);
  return {
    file,
    platform: hintedPlatform || det.platform,
    arch: det.arch,
    variant: det.variant,
    filetype: det.filetype,
    detected: det,
    status: "pending",
  };
}
