/**
 * Build content inventories (schema 1) and the version-to-version diff.
 *
 * The container (container/src/inventory/) extracts an inventory from an APK
 * or IPA. The worker stores it in R2 at apps/<app>/builds/<build>/inventory.json
 * with a row in build_inventories, and diffs two of them here.
 */

export interface InventoryCategory {
  key: string;
  label: string;
  bytes: number;
  compressed_bytes: number;
  files: number;
}

export interface InventoryFile {
  path: string;
  bytes: number;
  compressed_bytes: number;
  category: string;
}

export interface InventoryLibrary {
  name: string;
  kind: string;
  bytes: number;
  compressed_bytes?: number;
  version?: string | null;
  sdk?: string | null;
  classes?: number;
  methods?: number;
  estimated?: boolean;
  abis?: string[];
  bundle_id?: string | null;
}

export interface InventorySdk {
  name: string;
  bytes: number;
  compressed_bytes: number;
  kinds: string[];
}

export interface BuildInventory {
  schema: 1;
  platform: "android" | "ios";
  generator?: string;
  total_bytes: number;
  uncompressed_bytes: number;
  file_count: number;
  app: Record<string, string | number | null>;
  categories: InventoryCategory[];
  largest_files: InventoryFile[];
  files: InventoryFile[];
  components: Record<string, string[]>;
  libraries: InventoryLibrary[];
  sdks: InventorySdk[];
  /** `dex.obfuscated`: the dex class names look R8-minified (judged before any mapping). */
  dex?: Record<string, unknown> & { obfuscated?: boolean };
  /** Android: present when the build's R8 mapping restored class names. */
  mapping?: { used: true; classes_mapped: number; classes_unmapped: number };
  notes: string[];
  truncated: boolean;
}

/** Stored inventories larger than this are refused (the container aims for < 300 KB). */
export const MAX_STORED_INVENTORY_BYTES = 1024 * 1024;

export function inventoryR2Key(appId: string, buildId: string): string {
  return `apps/${appId}/builds/${buildId}/inventory.json`;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Shape check before storing: a schema-1 inventory for android or ios. */
export function validateInventory(value: unknown): BuildInventory {
  if (!isObject(value)) throw new Error("inventory is not an object");
  if (value.schema !== 1) throw new Error("unsupported inventory schema");
  if (value.platform !== "android" && value.platform !== "ios") throw new Error("inventory platform must be android or ios");
  if (typeof value.total_bytes !== "number") throw new Error("inventory total_bytes missing");
  for (const key of ["categories", "largest_files", "libraries", "sdks"]) {
    if (!Array.isArray(value[key])) throw new Error(`inventory ${key} must be an array`);
  }
  if (!isObject(value.components)) throw new Error("inventory components must be an object");
  const inv = value as unknown as BuildInventory;
  inv.files ??= inv.largest_files;
  inv.notes ??= [];
  inv.app ??= {};
  return inv;
}

// ---------- diff ----------

export interface CategoryDelta {
  key: string;
  label: string;
  before: number;
  after: number;
  delta: number;
  compressed_before: number;
  compressed_after: number;
  compressed_delta: number;
}

export interface LibraryChange {
  name: string;
  kind: string;
  sdk: string | null;
  before: number;
  after: number;
  delta: number;
  compressed_delta: number;
  version_before: string | null;
  version_after: string | null;
}

export interface FileDelta {
  path: string;
  category: string;
  before: number;
  after: number;
  delta: number;
}

export interface InventoryDiff {
  schema: 1;
  platform: "android" | "ios";
  total: { before: number; after: number; delta: number; uncompressed_before: number; uncompressed_after: number; uncompressed_delta: number };
  categories: CategoryDelta[];
  components: Record<string, { added: string[]; removed: string[] }>;
  libraries: { added: InventoryLibrary[]; removed: InventoryLibrary[]; changed: LibraryChange[] };
  sdks: { added: InventorySdk[]; removed: InventorySdk[]; changed: Array<{ name: string; before: number; after: number; delta: number }> };
  files: { grown: FileDelta[]; shrunk: FileDelta[]; added: FileDelta[]; removed: FileDelta[] };
  notes: string[];
}

const MAX_LIBRARY_ROWS = 100;
const MAX_FILE_ROWS = 20;

/** "(37 smaller packages)" rows change name with the count; compare them as one row. */
function libraryKey(lib: InventoryLibrary): string {
  const name = /^\(\d+ smaller packages\)$/.test(lib.name) ? "(smaller packages)" : lib.name;
  return `${lib.kind}:${name}`;
}

const impact = (lib: InventoryLibrary) => lib.compressed_bytes ?? lib.bytes;
const byImpact = <T>(size: (t: T) => number) => (a: T, b: T) => Math.abs(size(b)) - Math.abs(size(a));

export function diffInventories(base: BuildInventory, head: BuildInventory): InventoryDiff {
  const notes: string[] = [];
  if (base.platform !== head.platform) notes.push(`Comparing a ${head.platform} build with a ${base.platform} build.`);
  if (base.truncated || head.truncated) notes.push("One of the inventories was shortened; small items may be missing from the comparison.");
  if (Boolean(base.mapping?.used) !== Boolean(head.mapping?.used)) {
    notes.push(
      `Class names were restored with the R8 mapping for the ${head.mapping?.used ? "newer" : "older"} build only, so package rows do not line up between the two.`,
    );
  }
  if (base.generator !== head.generator) notes.push(`Inventories come from different extractors (${base.generator ?? "unknown"} and ${head.generator ?? "unknown"}).`);

  // Categories.
  const catKeys = new Map<string, string>();
  for (const c of [...base.categories, ...head.categories]) catKeys.set(c.key, c.label);
  const findCat = (inv: BuildInventory, key: string) => inv.categories.find((c) => c.key === key);
  const categories: CategoryDelta[] = [...catKeys.entries()].map(([key, label]) => {
    const b = findCat(base, key);
    const h = findCat(head, key);
    return {
      key,
      label,
      before: b?.bytes ?? 0,
      after: h?.bytes ?? 0,
      delta: (h?.bytes ?? 0) - (b?.bytes ?? 0),
      compressed_before: b?.compressed_bytes ?? 0,
      compressed_after: h?.compressed_bytes ?? 0,
      compressed_delta: (h?.compressed_bytes ?? 0) - (b?.compressed_bytes ?? 0),
    };
  }).sort((a, b) => Math.abs(b.compressed_delta) - Math.abs(a.compressed_delta) || Math.abs(b.delta) - Math.abs(a.delta) || a.key.localeCompare(b.key));

  // Components.
  const components: InventoryDiff["components"] = {};
  for (const key of new Set([...Object.keys(base.components), ...Object.keys(head.components)])) {
    const before = new Set(base.components[key] ?? []);
    const after = new Set(head.components[key] ?? []);
    const added = [...after].filter((v) => !before.has(v)).sort();
    const removed = [...before].filter((v) => !after.has(v)).sort();
    if (added.length || removed.length) components[key] = { added, removed };
  }

  // Libraries.
  const baseLibs = new Map(base.libraries.map((l) => [libraryKey(l), l]));
  const headLibs = new Map(head.libraries.map((l) => [libraryKey(l), l]));
  const added = [...headLibs.entries()].filter(([k]) => !baseLibs.has(k)).map(([, l]) => l).sort(byImpact(impact));
  const removed = [...baseLibs.entries()].filter(([k]) => !headLibs.has(k)).map(([, l]) => l).sort(byImpact(impact));
  const changed: LibraryChange[] = [];
  for (const [k, h] of headLibs) {
    const b = baseLibs.get(k);
    if (!b) continue;
    const versionChanged = (b.version ?? null) !== (h.version ?? null);
    if (h.bytes === b.bytes && !versionChanged) continue;
    changed.push({
      name: h.name,
      kind: h.kind,
      sdk: h.sdk ?? null,
      before: b.bytes,
      after: h.bytes,
      delta: h.bytes - b.bytes,
      compressed_delta: impact(h) - impact(b),
      version_before: b.version ?? null,
      version_after: h.version ?? null,
    });
  }
  changed.sort((a, b) => Math.abs(b.compressed_delta) - Math.abs(a.compressed_delta) || Math.abs(b.delta) - Math.abs(a.delta));

  // SDKs.
  const baseSdks = new Map(base.sdks.map((s) => [s.name, s]));
  const headSdks = new Map(head.sdks.map((s) => [s.name, s]));
  const sdks: InventoryDiff["sdks"] = {
    added: head.sdks.filter((s) => !baseSdks.has(s.name)),
    removed: base.sdks.filter((s) => !headSdks.has(s.name)),
    changed: head.sdks
      .filter((s) => baseSdks.has(s.name) && baseSdks.get(s.name)!.compressed_bytes !== s.compressed_bytes)
      .map((s) => {
        const before = baseSdks.get(s.name)!.compressed_bytes;
        return { name: s.name, before, after: s.compressed_bytes, delta: s.compressed_bytes - before };
      })
      .sort(byImpact((s: { delta: number }) => s.delta)),
  };

  // Files: each inventory keeps only its largest files, so a path missing from
  // one side is "added"/"removed" only when it is larger than that side's cutoff.
  const baseFiles = new Map(base.files.map((f) => [f.path, f]));
  const headFiles = new Map(head.files.map((f) => [f.path, f]));
  const cutoff = (files: InventoryFile[], full: boolean) => (full ? Math.min(...files.map((f) => f.bytes)) : -1);
  const baseCut = cutoff(base.files, base.files.length >= 400 || base.truncated);
  const headCut = cutoff(head.files, head.files.length >= 400 || head.truncated);
  const grown: FileDelta[] = [];
  const shrunk: FileDelta[] = [];
  const addedFiles: FileDelta[] = [];
  const removedFiles: FileDelta[] = [];
  for (const h of head.files) {
    const b = baseFiles.get(h.path);
    if (b) {
      const d = { path: h.path, category: h.category, before: b.bytes, after: h.bytes, delta: h.bytes - b.bytes };
      if (d.delta > 0) grown.push(d);
      else if (d.delta < 0) shrunk.push(d);
    } else if (h.bytes > baseCut) {
      addedFiles.push({ path: h.path, category: h.category, before: 0, after: h.bytes, delta: h.bytes });
    }
  }
  for (const b of base.files) {
    if (!headFiles.has(b.path) && b.bytes > headCut) {
      removedFiles.push({ path: b.path, category: b.category, before: b.bytes, after: 0, delta: -b.bytes });
    }
  }
  const sortFiles = (list: FileDelta[]) => list.sort(byImpact((f: FileDelta) => f.delta)).slice(0, MAX_FILE_ROWS);

  return {
    schema: 1,
    platform: head.platform,
    total: {
      before: base.total_bytes,
      after: head.total_bytes,
      delta: head.total_bytes - base.total_bytes,
      uncompressed_before: base.uncompressed_bytes,
      uncompressed_after: head.uncompressed_bytes,
      uncompressed_delta: head.uncompressed_bytes - base.uncompressed_bytes,
    },
    categories,
    components,
    libraries: {
      added: added.slice(0, MAX_LIBRARY_ROWS),
      removed: removed.slice(0, MAX_LIBRARY_ROWS),
      changed: changed.slice(0, MAX_LIBRARY_ROWS),
    },
    sdks,
    files: { grown: sortFiles(grown), shrunk: sortFiles(shrunk), added: sortFiles(addedFiles), removed: sortFiles(removedFiles) },
    notes,
  };
}
