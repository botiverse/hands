import type { BuildAsset } from "./api";
import type { Locale } from "./localePreference";

type AssetDisplaySource = Pick<BuildAsset, "metadata_json" | "r2_key">;

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function assetMetadata(metadataJson: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(metadataJson || "{}");
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/**
 * Prefer the upload-time filename retained in asset metadata. Historical rows
 * may not have it, so fall back to the final R2 path segment rather than
 * rendering an empty identity in a destructive-action dialog.
 */
export function buildAssetFilename(asset: AssetDisplaySource, locale: Locale = "en"): string {
  const metadata = assetMetadata(asset.metadata_json);
  return (
    nonEmptyString(metadata.original_filename) ??
    nonEmptyString(metadata.filename) ??
    nonEmptyString(asset.r2_key.split("/").filter(Boolean).at(-1)) ??
    (locale === "zh-CN" ? "未命名文件" : "Unnamed asset")
  );
}

/**
 * Human-readable binary size. Bytes stay exact so a 64-byte patch is never
 * shown as 0.00 MB.
 */
export function formatBuildAssetSize(sizeBytes: number, locale: Locale = "en"): string {
  if (!Number.isFinite(sizeBytes) || sizeBytes < 0) return locale === "zh-CN" ? "大小未知" : "Unknown size";

  const roundedBytes = Math.round(sizeBytes);
  if (roundedBytes < 1024) return `${roundedBytes.toLocaleString(locale)} B`;

  const units = ["KiB", "MiB", "GiB", "TiB"] as const;
  let value = roundedBytes / 1024;
  let unitIndex = 0;
  while (unitIndex < units.length - 1 && value >= 1024) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(2)} ${units[unitIndex]!}`;
}

export function formatBuildAssetExactSize(sizeBytes: number, locale: Locale = "en"): string {
  const readable = formatBuildAssetSize(sizeBytes, locale);
  if (!Number.isFinite(sizeBytes) || sizeBytes < 0) return readable;
  return `${readable} (${Math.round(sizeBytes).toLocaleString(locale)} ${locale === "zh-CN" ? "字节" : "bytes"})`;
}
