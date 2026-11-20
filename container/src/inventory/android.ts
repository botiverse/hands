/**
 * Android APK inventory: size by category from the zip central directory,
 * native libraries per ABI, dex classes grouped by package (see dex.ts for
 * the size estimate), and manifest components from `aapt dump xmltree`.
 * With the build's R8 mapping, obfuscated class names are restored before
 * grouping (see mapping.ts).
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createReadStream } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listZipEntries, readZipEntry } from "./zip.js";
import { parseDex } from "./dex.js";
import { looksMinified, OBFUSCATED_MIN_CLASSES, OBFUSCATED_SHARE, readMappingClassMap } from "./mapping.js";
import { packageGroup, sdkForJavaPackage, sdkForNativeLib } from "./sdks.js";
import { aggregateSdks, boundInventory, categorize, DIFF_FILES, LARGEST_FILES, uniqueSorted } from "./common.js";
import { INVENTORY_GENERATOR, type BuildInventory, type InventoryLibrary } from "./types.js";

const execFileAsync = promisify(execFile);
const AAPT_BIN = "/opt/android-sdk/build-tools/34.0.0/aapt";

/** Dex packages listed individually; the rest are summed into one row. */
const MAX_DEX_PACKAGES = 150;

export function classifyApkEntry(name: string): { key: string; label: string } {
  if (/^classes\d*\.dex$/.test(name)) return { key: "dex", label: "DEX code" };
  const lib = name.match(/^lib\/([^/]+)\//);
  if (lib) return { key: `native/${lib[1]}`, label: `Native libraries (${lib[1]})` };
  if (name === "resources.arsc" || name.startsWith("res/")) return { key: "resources", label: "Resources (res/, resources.arsc)" };
  if (name.startsWith("assets/")) return { key: "assets", label: "Assets" };
  if (name.startsWith("kotlin/")) return { key: "kotlin", label: "Kotlin metadata" };
  if (name.startsWith("META-INF/")) return { key: "meta_inf", label: "META-INF" };
  // Files in other directories are Java resources merged from library JARs.
  if (name.includes("/")) return { key: "java_resources", label: "Java resources (from libraries)" };
  return { key: "other", label: "Other" };
}

const CATEGORY_ORDER = ["dex", "native", "resources", "assets", "kotlin", "java_resources", "meta_inf", "other"];

// ---------- aapt dump xmltree ----------

interface XmlNode {
  name: string;
  attrs: Record<string, AttrValue>;
  children: XmlNode[];
}

type AttrValue =
  | { type: "string"; value: string }
  | { type: "bool"; value: boolean }
  | { type: "int"; value: number }
  | { type: "ref"; value: string };

function parseAttrValue(raw: string): AttrValue {
  const str = raw.match(/^"((?:[^"\\]|\\.)*)"/);
  if (str) return { type: "string", value: str[1]!.replace(/\\(.)/g, "$1") };
  const typed = raw.match(/^\(type 0x([0-9a-f]+)\)0x([0-9a-f]+)/i);
  if (typed) {
    const type = parseInt(typed[1]!, 16);
    const value = parseInt(typed[2]!, 16);
    if (type === 0x12) return { type: "bool", value: value !== 0 };
    return { type: "int", value: value | 0 };
  }
  return { type: "ref", value: raw.trim() };
}

/** Parses `aapt dump xmltree <apk> AndroidManifest.xml` output into a tree. */
export function parseAaptXmlTree(text: string): XmlNode | null {
  const root: XmlNode = { name: "#root", attrs: {}, children: [] };
  const stack: Array<{ indent: number; node: XmlNode }> = [{ indent: -1, node: root }];
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^(\s*)([EAN]): (.*)$/);
    if (!m) continue;
    const indent = m[1]!.length;
    const kind = m[2]!;
    const body = m[3]!;
    if (kind === "N") continue;
    if (kind === "E") {
      const name = body.match(/^([^\s(]+)/)?.[1] ?? "";
      while (stack.length > 1 && stack[stack.length - 1]!.indent >= indent) stack.pop();
      const node: XmlNode = { name, attrs: {}, children: [] };
      stack[stack.length - 1]!.node.children.push(node);
      stack.push({ indent, node });
    } else {
      while (stack.length > 1 && stack[stack.length - 1]!.indent >= indent) stack.pop();
      const a = body.match(/^(.+?)(?:\(0x[0-9a-fA-F]+\))?=(.*)$/);
      if (!a) continue;
      const attrName = a[1]!.split(":").pop()!;
      stack[stack.length - 1]!.node.attrs[attrName] = parseAttrValue(a[2]!);
    }
  }
  return root.children.find((c) => c.name === "manifest") ?? null;
}

const str = (v: AttrValue | undefined) => (v?.type === "string" ? v.value : null);

/** Meta-data values are included only for integer version markers; never strings (they can be API keys). */
function metaDataEntry(node: XmlNode): string | null {
  const name = str(node.attrs.name);
  if (!name) return null;
  const value = node.attrs.value;
  if (value?.type === "int" && /version/i.test(name)) return `${name}=${value.value}`;
  return name;
}

export interface ManifestSummary {
  app: Record<string, string | number | null>;
  components: Record<string, string[]>;
}

export function summarizeManifest(manifest: XmlNode): ManifestSummary {
  const pkg = str(manifest.attrs.package) ?? "";
  const resolve = (n: string) => (n.startsWith(".") ? `${pkg}${n}` : n.includes(".") || !pkg ? n : `${pkg}.${n}`);
  const named = (node: XmlNode) => {
    const name = str(node.attrs.name);
    if (!name) return null;
    const exported = node.attrs.exported;
    return `${resolve(name)}${exported?.type === "bool" && exported.value ? " (exported)" : ""}`;
  };
  const out: Record<string, string[]> = {
    permissions: [], declared_permissions: [], features: [], activities: [], services: [], receivers: [], providers: [], meta_data: [],
  };
  const app: Record<string, string | number | null> = { package_id: pkg || null };
  const vc = manifest.attrs.versionCode;
  if (vc?.type === "int") app.version_code = vc.value;
  const vn = str(manifest.attrs.versionName);
  if (vn) app.version_name = vn;

  const walk = (node: XmlNode, inApplication: boolean) => {
    for (const child of node.children) {
      switch (child.name) {
        case "uses-permission":
        case "uses-permission-sdk-23":
        case "uses-permission-sdk-m": {
          const n = str(child.attrs.name);
          if (n) out.permissions!.push(n);
          break;
        }
        case "permission": {
          const n = str(child.attrs.name);
          if (n) out.declared_permissions!.push(n);
          break;
        }
        case "uses-feature": {
          const n = str(child.attrs.name);
          if (n) out.features!.push(n);
          break;
        }
        case "uses-sdk": {
          const min = child.attrs.minSdkVersion;
          const target = child.attrs.targetSdkVersion;
          if (min?.type === "int") app.min_sdk = min.value;
          if (target?.type === "int") app.target_sdk = target.value;
          break;
        }
        case "activity":
        case "activity-alias": {
          const n = named(child);
          if (n) out.activities!.push(n);
          break;
        }
        case "service": { const n = named(child); if (n) out.services!.push(n); break; }
        case "receiver": { const n = named(child); if (n) out.receivers!.push(n); break; }
        case "provider": { const n = named(child); if (n) out.providers!.push(n); break; }
        case "meta-data": {
          if (inApplication) {
            const n = metaDataEntry(child);
            if (n) out.meta_data!.push(n);
          }
          break;
        }
      }
      if (child.name === "application") walk(child, true);
      else if (inApplication && child.children.length > 0 && child.name !== "intent-filter") walk(child, true);
    }
  };
  walk(manifest, false);
  const components: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(out)) components[k] = uniqueSorted(v);
  return { app, components };
}

// ---------- inventory ----------

export interface AndroidInventoryInput {
  bytes: Uint8Array;
  /** `aapt dump xmltree ... AndroidManifest.xml` output, when aapt ran. */
  manifestXmlTree?: string | null;
  manifestError?: string | null;
  /** R8 mapping classes, obfuscated name -> original name (readMappingClassMap). */
  classMap?: ReadonlyMap<string, string> | null;
  /** Why a mapping that was offered could not be used. */
  mappingError?: string | null;
}

export function buildAndroidInventory(input: AndroidInventoryInput): BuildInventory {
  const { bytes, classMap } = input;
  const entries = listZipEntries(bytes);
  if (!entries.some((e) => e.name === "AndroidManifest.xml")) throw new Error("not an APK (no AndroidManifest.xml at the root)");
  const { categories, files } = categorize(entries, classifyApkEntry, CATEGORY_ORDER);
  const notes: string[] = [];

  // Native libraries, one row per .so name; bytes sum every ABI it ships for.
  const natives = new Map<string, InventoryLibrary>();
  for (const e of entries) {
    const m = e.name.match(/^lib\/([^/]+)\/([^/]+\.so)$/);
    if (!m) continue;
    const [, abi, file] = m;
    const lib = natives.get(file!) ?? { name: file!, kind: "native" as const, bytes: 0, compressed_bytes: 0, abis: [], sdk: sdkForNativeLib(file!) };
    lib.bytes += e.uncompressedSize;
    lib.compressed_bytes! += e.compressedSize;
    lib.abis!.push(abi!);
    natives.set(file!, lib);
  }
  for (const lib of natives.values()) lib.abis!.sort();

  // Dex packages.
  const packages = new Map<string, { classes: number; methods: number; bytes: number; compressed: number }>();
  let dexFiles = 0;
  let dexClasses = 0;
  let dexMethods = 0;
  let methodIds = 0;
  let minified = 0;
  let classesMapped = 0;
  for (const e of entries) {
    if (!/^classes\d*\.dex$/.test(e.name)) continue;
    try {
      const dex = parseDex(readZipEntry(bytes, e));
      dexFiles += 1;
      methodIds += dex.methodIds;
      const total = dex.totalWeight || 1;
      for (const cls of dex.classes) {
        if (looksMinified(cls.name)) minified += 1;
        let name = cls.name;
        const original = classMap?.get(cls.name);
        if (original !== undefined) {
          name = original;
          classesMapped += 1;
        }
        const group = packageGroup(name);
        const p = packages.get(group) ?? { classes: 0, methods: 0, bytes: 0, compressed: 0 };
        p.classes += 1;
        p.methods += cls.methods;
        p.bytes += (cls.weight / total) * e.uncompressedSize;
        p.compressed += (cls.weight / total) * e.compressedSize;
        packages.set(group, p);
        dexClasses += 1;
        dexMethods += cls.methods;
      }
    } catch (err) {
      notes.push(`Could not read ${e.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const dexLibs: InventoryLibrary[] = [...packages.entries()]
    .map(([name, p]) => ({
      name,
      kind: "dex-package" as const,
      bytes: Math.round(p.bytes),
      compressed_bytes: Math.round(p.compressed),
      classes: p.classes,
      methods: p.methods,
      estimated: true,
      sdk: sdkForJavaPackage(name),
    }))
    .sort((a, b) => b.bytes - a.bytes || a.name.localeCompare(b.name));
  let listedDex = dexLibs;
  if (dexLibs.length > MAX_DEX_PACKAGES) {
    const rest = dexLibs.slice(MAX_DEX_PACKAGES);
    listedDex = dexLibs.slice(0, MAX_DEX_PACKAGES);
    listedDex.push({
      name: `(${rest.length} smaller packages)`,
      kind: "dex-package",
      bytes: rest.reduce((s, l) => s + l.bytes, 0),
      compressed_bytes: rest.reduce((s, l) => s + (l.compressed_bytes ?? 0), 0),
      classes: rest.reduce((s, l) => s + (l.classes ?? 0), 0),
      methods: rest.reduce((s, l) => s + (l.methods ?? 0), 0),
      estimated: true,
      sdk: null,
    });
  }
  const obfuscated = dexClasses >= OBFUSCATED_MIN_CLASSES && minified / dexClasses >= OBFUSCATED_SHARE;
  if (classMap && dexClasses > 0 && classesMapped / dexClasses < 0.5) {
    notes.push(`The R8 mapping matched only ${classesMapped} of ${dexClasses} classes; it may belong to a different build.`);
  }
  if (input.mappingError) notes.push(`The R8 mapping could not be used: ${input.mappingError}`);
  // SDK totals use every package, not only the listed ones.
  const sdks = aggregateSdks([...dexLibs, ...natives.values()]);

  let app: Record<string, string | number | null> = {};
  let components: Record<string, string[]> = {};
  const manifest = input.manifestXmlTree ? parseAaptXmlTree(input.manifestXmlTree) : null;
  if (manifest) {
    const summary = summarizeManifest(manifest);
    app = summary.app;
    components = summary.components;
  } else {
    notes.push(`Manifest components unavailable${input.manifestError ? `: ${input.manifestError}` : "."}`);
  }

  const libraries = [
    ...listedDex,
    ...[...natives.values()].sort((a, b) => b.bytes - a.bytes || a.name.localeCompare(b.name)),
  ];

  return boundInventory({
    schema: 1,
    platform: "android",
    generator: INVENTORY_GENERATOR,
    total_bytes: bytes.byteLength,
    uncompressed_bytes: categories.reduce((s, c) => s + c.bytes, 0),
    file_count: files.length,
    app,
    categories,
    largest_files: files.slice(0, LARGEST_FILES),
    files: files.slice(0, DIFF_FILES),
    components,
    libraries,
    sdks,
    dex: {
      files: dexFiles,
      classes: dexClasses,
      methods: dexMethods,
      method_ids: methodIds,
      size_estimate: "Package bytes are the dex file size split by each package's share of method code (code items, plus fixed per-class, field and method overhead).",
      obfuscated,
    },
    ...(classMap ? { mapping: { used: true as const, classes_mapped: classesMapped, classes_unmapped: dexClasses - classesMapped } } : {}),
    notes,
    truncated: false,
  });
}

export interface AndroidMappingInput {
  /** A downloaded mapping.txt on disk. */
  mappingPath?: string | null;
  /** Why the mapping could not be downloaded. */
  mappingError?: string | null;
}

/**
 * Runs aapt for the manifest, reads the mapping's class lines when one is
 * given, then builds the inventory. Writes a temp file when no path is given.
 */
export async function androidInventory(
  bytes: Uint8Array,
  filePath: string | null,
  mapping: AndroidMappingInput = {},
): Promise<BuildInventory> {
  let classMap: Map<string, string> | null = null;
  let mappingError = mapping.mappingError ?? null;
  if (mapping.mappingPath) {
    try {
      classMap = await readMappingClassMap(createReadStream(mapping.mappingPath));
    } catch (err) {
      mappingError = err instanceof Error ? err.message : String(err);
    }
  }
  let dir: string | null = null;
  let path = filePath;
  let manifestXmlTree: string | null = null;
  let manifestError: string | null = null;
  try {
    if (!path) {
      dir = await mkdtemp(join(tmpdir(), "inventory-"));
      path = join(dir, "input.apk");
      await writeFile(path, bytes);
    }
    const { stdout } = await execFileAsync(AAPT_BIN, ["dump", "xmltree", path, "AndroidManifest.xml"], { maxBuffer: 32 * 1024 * 1024 });
    manifestXmlTree = stdout;
  } catch (err) {
    manifestError = err instanceof Error ? err.message.split("\n")[0]!.slice(0, 200) : String(err);
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
  return buildAndroidInventory({ bytes, manifestXmlTree, manifestError, classMap, mappingError });
}
