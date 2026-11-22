import { parse } from "yaml";

/** Largest replacement accepted; electron-builder metadata is a few KB. */
export const ELECTRON_METADATA_MAX_BYTES = 256 * 1024;

export type ElectronMetadataOverride = {
  id: string;
  release_id: string;
  asset_id: string;
  r2_key: string;
  sha256: string;
  size_bytes: number;
  created_by: string;
  created_at: number;
  reverted_at: number | null;
  reverted_by: string | null;
};

const OVERRIDE_COLUMNS =
  "id, release_id, asset_id, r2_key, sha256, size_bytes, created_by, created_at, reverted_at, reverted_by";

/** The replacement served for a release's metadata file, or null for the build's own file. */
export async function currentElectronMetadataOverride(
  db: D1Database,
  releaseId: string,
  assetId: string,
): Promise<ElectronMetadataOverride | null> {
  return db.prepare(
    `SELECT ${OVERRIDE_COLUMNS}
     FROM electron_metadata_overrides
     WHERE release_id = ?1 AND asset_id = ?2 AND reverted_at IS NULL
     ORDER BY created_at DESC, id DESC
     LIMIT 1`,
  ).bind(releaseId, assetId).first<ElectronMetadataOverride>();
}

export async function electronMetadataOverrideHistory(
  db: D1Database,
  releaseId: string,
  assetId: string,
): Promise<ElectronMetadataOverride[]> {
  const { results } = await db.prepare(
    `SELECT ${OVERRIDE_COLUMNS}
     FROM electron_metadata_overrides
     WHERE release_id = ?1 AND asset_id = ?2
     ORDER BY created_at DESC, id DESC`,
  ).bind(releaseId, assetId).all<ElectronMetadataOverride>();
  return results ?? [];
}

export type MetadataCheck =
  | { ok: true }
  | { ok: false; code: string; error: string; detail?: unknown };

function refuse(code: string, error: string, detail?: unknown): MetadataCheck {
  return { ok: false, code, error, ...(detail === undefined ? {} : { detail }) };
}

function parseMapping(text: string): Record<string, unknown> | null {
  try {
    const value = parse(text, { maxAliasCount: 0 });
    return value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const other = b as unknown[];
    return a.length === other.length && a.every((item, i) => sameValue(item, other[i]));
  }
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length &&
    keys.every((key) => Object.prototype.hasOwnProperty.call(right, key) && sameValue(left[key], right[key]));
}

function leafName(value: string): string {
  const withoutQuery = value.split(/[?#]/)[0] ?? value;
  return decodeURIComponent(withoutQuery.split("/").pop() ?? withoutQuery);
}

/** The file a `patches` entry points at: a string, or an object's `url`/`path`/`file`. */
function patchReference(entry: unknown): string | null {
  if (typeof entry === "string") return entry;
  if (entry && typeof entry === "object" && !Array.isArray(entry)) {
    for (const key of ["url", "path", "file"]) {
      const value = (entry as Record<string, unknown>)[key];
      if (typeof value === "string" && value.trim()) return value;
    }
  }
  return null;
}

/**
 * Checks a replacement for a published release's update metadata against the
 * build's own file. What clients install must not change: the version, every
 * `files` entry, and the legacy top-level `path`/`sha512` stay exactly as built.
 * `patches` may only reference files the build already holds. Anything else
 * (rollout fields, release notes) may change.
 */
export function checkReplacementMetadata(
  originalText: string,
  replacementText: string,
  buildFileNames: ReadonlySet<string>,
): MetadataCheck {
  if (new TextEncoder().encode(replacementText).byteLength > ELECTRON_METADATA_MAX_BYTES) {
    return refuse("metadata_too_large", `metadata must be at most ${ELECTRON_METADATA_MAX_BYTES} bytes`);
  }
  const original = parseMapping(originalText);
  if (!original) return refuse("original_metadata_unreadable", "the build's own metadata is not a YAML mapping");
  const replacement = parseMapping(replacementText);
  if (!replacement) return refuse("metadata_invalid", "metadata must be a YAML mapping");

  if (String(replacement.version ?? "") !== String(original.version ?? "")) {
    return refuse("version_changed", "version must stay the same", {
      expected: original.version ?? null,
      received: replacement.version ?? null,
    });
  }
  for (const key of ["files", "path", "sha512"]) {
    const inOriginal = Object.prototype.hasOwnProperty.call(original, key);
    const inReplacement = Object.prototype.hasOwnProperty.call(replacement, key);
    if (inOriginal !== inReplacement || (inOriginal && !sameValue(original[key], replacement[key]))) {
      return refuse("installer_entries_changed", `\`${key}\` must stay exactly as built`, { field: key });
    }
  }

  if (Object.prototype.hasOwnProperty.call(replacement, "patches")) {
    const patches = replacement.patches;
    if (patches !== null && !Array.isArray(patches)) {
      return refuse("patches_invalid", "`patches` must be a list");
    }
    const missing: string[] = [];
    for (const [index, entry] of (patches ?? []).entries()) {
      const reference = patchReference(entry);
      if (!reference) {
        return refuse("patches_invalid", "each `patches` entry needs a `url`, `path` or `file`", { index });
      }
      const name = leafName(reference);
      if (!buildFileNames.has(reference) && !buildFileNames.has(name)) missing.push(reference);
    }
    if (missing.length > 0) {
      return refuse("patch_file_not_in_build", "`patches` may only reference files in this build", { missing });
    }
  }
  return { ok: true };
}
