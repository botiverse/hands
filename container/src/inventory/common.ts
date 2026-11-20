import type { BuildInventory, InventoryCategory, InventoryFile, InventoryLibrary, InventorySdk, LibraryKind } from "./types.js";
import { MAX_INVENTORY_JSON_BYTES } from "./types.js";
import type { ZipEntry } from "./zip.js";

export const LARGEST_FILES = 30;
export const DIFF_FILES = 400;
export const MAX_LIST = 500;

export function categorize(
  entries: ZipEntry[],
  classify: (name: string) => { key: string; label: string },
  order: string[],
): { categories: InventoryCategory[]; files: InventoryFile[] } {
  const byKey = new Map<string, InventoryCategory>();
  const files: InventoryFile[] = [];
  for (const e of entries) {
    if (e.name.endsWith("/")) continue;
    const { key, label } = classify(e.name);
    const cat = byKey.get(key) ?? { key, label, bytes: 0, compressed_bytes: 0, files: 0 };
    cat.bytes += e.uncompressedSize;
    cat.compressed_bytes += e.compressedSize;
    cat.files += 1;
    byKey.set(key, cat);
    files.push({ path: e.name, bytes: e.uncompressedSize, compressed_bytes: e.compressedSize, category: key });
  }
  const rank = (k: string) => {
    const i = order.findIndex((o) => k === o || k.startsWith(`${o}/`));
    return i < 0 ? order.length : i;
  };
  const categories = [...byKey.values()].sort((a, b) => rank(a.key) - rank(b.key) || b.bytes - a.bytes);
  files.sort((a, b) => b.bytes - a.bytes || a.path.localeCompare(b.path));
  return { categories, files };
}

export function aggregateSdks(libraries: InventoryLibrary[]): InventorySdk[] {
  const out = new Map<string, InventorySdk>();
  for (const lib of libraries) {
    if (!lib.sdk) continue;
    const sdk = out.get(lib.sdk) ?? { name: lib.sdk, bytes: 0, compressed_bytes: 0, kinds: [] as LibraryKind[] };
    sdk.bytes += lib.bytes;
    sdk.compressed_bytes += lib.compressed_bytes ?? lib.bytes;
    if (!sdk.kinds.includes(lib.kind)) sdk.kinds.push(lib.kind);
    out.set(lib.sdk, sdk);
  }
  return [...out.values()].sort((a, b) => b.compressed_bytes - a.compressed_bytes || a.name.localeCompare(b.name));
}

export function uniqueSorted(values: Iterable<string>, max = MAX_LIST): string[] {
  return [...new Set(values)].sort().slice(0, max);
}

/**
 * Keeps the serialized inventory under the size budget by shrinking the
 * largest lists first. Sets `truncated` when anything was dropped.
 */
export function boundInventory(inv: BuildInventory, maxBytes = MAX_INVENTORY_JSON_BYTES): BuildInventory {
  const size = () => Buffer.byteLength(JSON.stringify(inv));
  for (let round = 0; round < 12 && size() > maxBytes; round++) {
    inv.truncated = true;
    inv.files = inv.files.slice(0, Math.floor(inv.files.length / 2));
    if (inv.libraries.length > 100) inv.libraries = inv.libraries.slice(0, Math.floor(inv.libraries.length * 0.75));
    for (const key of Object.keys(inv.components)) {
      const list = inv.components[key]!;
      if (list.length > 50) inv.components[key] = list.slice(0, Math.floor(list.length / 2));
    }
  }
  if (inv.truncated && !inv.notes.includes("Some lists were shortened to keep the inventory small.")) {
    inv.notes.push("Some lists were shortened to keep the inventory small.");
  }
  return inv;
}
