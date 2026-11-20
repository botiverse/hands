/** Shape of a build content inventory (schema 1). Shared with the worker by copy. */

export interface InventoryCategory {
  key: string;
  label: string;
  /** Uncompressed bytes of the files in this category. */
  bytes: number;
  /** Bytes the files take inside the archive (what downloads cost). */
  compressed_bytes: number;
  files: number;
}

export interface InventoryFile {
  path: string;
  bytes: number;
  compressed_bytes: number;
  category: string;
}

export type LibraryKind = "dex-package" | "native" | "framework" | "extension";

export interface InventoryLibrary {
  name: string;
  kind: LibraryKind;
  bytes: number;
  compressed_bytes?: number;
  version?: string | null;
  sdk?: string | null;
  /** dex-package: class and method counts; bytes are an estimate (see dex.ts). */
  classes?: number;
  methods?: number;
  estimated?: boolean;
  /** native: the ABIs the library ships for; bytes sum all of them. */
  abis?: string[];
  bundle_id?: string | null;
}

export interface InventorySdk {
  name: string;
  bytes: number;
  compressed_bytes: number;
  kinds: LibraryKind[];
}

export interface InventoryMapping {
  used: true;
  /** Dex classes found in the mapping (named by their original class). */
  classes_mapped: number;
  /** Dex classes not in the mapping; they stay under their name in the dex. */
  classes_unmapped: number;
}

export interface BuildInventory {
  schema: 1;
  platform: "android" | "ios";
  generator: string;
  /** Size of the package file. */
  total_bytes: number;
  uncompressed_bytes: number;
  file_count: number;
  app: Record<string, string | number | null>;
  categories: InventoryCategory[];
  /** The 30 largest files, for display. */
  largest_files: InventoryFile[];
  /** A larger slice of the biggest files (up to 400), for version-to-version file growth. */
  files: InventoryFile[];
  components: Record<string, string[]>;
  libraries: InventoryLibrary[];
  sdks: InventorySdk[];
  /** `obfuscated`: the raw class names look R8-minified (judged before any mapping is applied). */
  dex?: { files: number; classes: number; methods: number; method_ids: number; size_estimate: string; obfuscated?: boolean };
  /** Android: present when an R8 mapping was applied to restore original class names. */
  mapping?: InventoryMapping;
  notes: string[];
  truncated: boolean;
}

export const INVENTORY_GENERATOR = "hands-inventory/1";
export const MAX_INVENTORY_JSON_BYTES = 300 * 1024;
