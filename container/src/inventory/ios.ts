/**
 * iOS IPA inventory: size by category inside Payload/<App>.app, embedded
 * frameworks and app extensions with their versions, Info.plist
 * capabilities (usage descriptions, background modes, URL schemes, ATS) and
 * entitlements (from the executable's code signature, else the embedded
 * provisioning profile; keys only, plus associated-domains values).
 */

import { parsePlist, type PlistDict, type PlistValue } from "../ios.js";
import { listZipEntries, readZipEntry, type ZipEntry } from "./zip.js";
import { sdkForFramework } from "./sdks.js";
import { aggregateSdks, boundInventory, categorize, DIFF_FILES, LARGEST_FILES, uniqueSorted } from "./common.js";
import { INVENTORY_GENERATOR, type BuildInventory, type InventoryLibrary } from "./types.js";

const LABELS: Record<string, string> = {
  executable: "Main executable",
  frameworks: "Frameworks",
  plugins: "App extensions (PlugIns)",
  watch: "Watch app",
  app_clips: "App Clips",
  assets_car: "Asset catalog (Assets.car)",
  bundles: "Resource bundles",
  localizations: "Localizations (.lproj)",
  signature: "Code signature and profile",
  swift_support: "SwiftSupport",
  other: "Other",
};

const ORDER = ["executable", "frameworks", "plugins", "watch", "app_clips", "assets_car", "bundles", "localizations", "signature", "swift_support", "other"];

export function classifyIpaEntry(name: string, appRoot: string, executable: string | null): { key: string; label: string } {
  const pick = (key: string) => ({ key, label: LABELS[key]! });
  if (!name.startsWith(appRoot)) {
    if (name.startsWith("SwiftSupport/")) return pick("swift_support");
    return pick("other");
  }
  const rel = name.slice(appRoot.length);
  if (executable && rel === executable) return pick("executable");
  if (rel.startsWith("Frameworks/")) return pick("frameworks");
  if (rel.startsWith("PlugIns/") || rel.startsWith("Extensions/")) return pick("plugins");
  if (rel.startsWith("Watch/")) return pick("watch");
  if (rel.startsWith("AppClips/")) return pick("app_clips");
  if (rel === "Assets.car") return pick("assets_car");
  if (/(^|\/)[^/]+\.bundle\//.test(rel)) return pick("bundles");
  if (/(^|\/)[^/]+\.lproj\//.test(rel)) return pick("localizations");
  if (rel.startsWith("_CodeSignature/") || rel === "embedded.mobileprovision") return pick("signature");
  return pick("other");
}

const isDict = (v: PlistValue | undefined): v is PlistDict =>
  typeof v === "object" && v !== null && !Array.isArray(v) && !(v instanceof Date) && !(v instanceof Uint8Array);
const asString = (v: PlistValue | undefined) => (typeof v === "string" && v.length > 0 ? v : null);
const strings = (v: PlistValue | undefined) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

function readPlist(bytes: Uint8Array, entry: ZipEntry | undefined): PlistDict | null {
  if (!entry) return null;
  try {
    const value = parsePlist(Buffer.from(readZipEntry(bytes, entry, 16 * 1024 * 1024)));
    return isDict(value) ? value : null;
  } catch {
    return null;
  }
}

export function summarizeInfoPlist(plist: PlistDict): { app: Record<string, string | number | null>; components: Record<string, string[]> } {
  const urlSchemes: string[] = [];
  const urlTypes = plist.CFBundleURLTypes;
  if (Array.isArray(urlTypes)) {
    for (const t of urlTypes) if (isDict(t)) urlSchemes.push(...strings(t.CFBundleURLSchemes));
  }
  const ats: string[] = [];
  const atsDict = plist.NSAppTransportSecurity;
  if (isDict(atsDict)) {
    for (const [k, v] of Object.entries(atsDict)) {
      if (k === "NSExceptionDomains" && isDict(v)) {
        for (const [domain, settings] of Object.entries(v)) {
          const flags = isDict(settings) ? Object.entries(settings).filter(([, s]) => s === true).map(([f]) => f) : [];
          ats.push(`${domain}${flags.length ? ` (${flags.sort().join(", ")})` : ""}`);
        }
      } else if (v === true) {
        ats.push(k);
      }
    }
  }
  return {
    app: {
      bundle_id: asString(plist.CFBundleIdentifier),
      version_name: asString(plist.CFBundleShortVersionString),
      build_number: asString(plist.CFBundleVersion),
      min_os: asString(plist.MinimumOSVersion),
      executable: asString(plist.CFBundleExecutable),
    },
    components: {
      permissions: uniqueSorted(Object.keys(plist).filter((k) => /UsageDescription$/.test(k))),
      background_modes: uniqueSorted(strings(plist.UIBackgroundModes)),
      url_schemes: uniqueSorted(urlSchemes),
      queries_schemes: uniqueSorted(strings(plist.LSApplicationQueriesSchemes)),
      ats_exceptions: uniqueSorted(ats),
    },
  };
}

/** Entitlement keys, plus one entry per associated domain. Other values are omitted. */
export function summarizeEntitlements(ent: PlistDict): string[] {
  const out: string[] = [];
  for (const [key, value] of Object.entries(ent)) {
    if (key === "com.apple.developer.associated-domains") {
      const domains = strings(value);
      if (domains.length === 0) out.push(key);
      for (const d of domains) out.push(`${key}: ${d}`);
    } else {
      out.push(key);
    }
  }
  return uniqueSorted(out);
}

const ENTITLEMENTS_MAGIC = Buffer.from([0xfa, 0xde, 0x71, 0x71]);

/** Finds the XML entitlements blob in a Mach-O code signature (CSMAGIC_EMBEDDED_ENTITLEMENTS). */
export function entitlementsFromExecutable(exe: Uint8Array): PlistDict | null {
  const buf = Buffer.from(exe.buffer, exe.byteOffset, exe.byteLength);
  let at = buf.indexOf(ENTITLEMENTS_MAGIC);
  while (at >= 0 && at + 8 < buf.length) {
    const length = buf.readUInt32BE(at + 4);
    const head = buf.subarray(at + 8, at + 16).toString("latin1");
    if (length > 8 && at + length <= buf.length && (head.startsWith("<?xml") || head.startsWith("<!DOCTY") || head.startsWith("<plist"))) {
      try {
        const value = parsePlist(buf.subarray(at + 8, at + length));
        if (isDict(value)) return value;
      } catch {
        // keep scanning
      }
    }
    at = buf.indexOf(ENTITLEMENTS_MAGIC, at + 4);
  }
  return null;
}

/** The Entitlements dictionary of a provisioning profile (a CMS envelope around an XML plist). */
export function entitlementsFromProfile(profile: Uint8Array): PlistDict | null {
  const buf = Buffer.from(profile.buffer, profile.byteOffset, profile.byteLength);
  const start = buf.indexOf("<?xml");
  const end = buf.indexOf("</plist>");
  if (start < 0 || end < start) return null;
  try {
    const value = parsePlist(buf.subarray(start, end + "</plist>".length));
    return isDict(value) && isDict(value.Entitlements) ? value.Entitlements : null;
  } catch {
    return null;
  }
}

export function buildIosInventory(bytes: Uint8Array): BuildInventory {
  const entries = listZipEntries(bytes);
  const notes: string[] = [];
  const appRootMatch = entries.map((e) => e.name.match(/^(Payload\/[^/]+\.app\/)/)?.[1]).find(Boolean);
  if (!appRootMatch) throw new Error("IPA has no Payload/*.app");
  const appRoot = appRootMatch;
  const byName = new Map(entries.map((e) => [e.name, e]));
  const info = readPlist(bytes, byName.get(`${appRoot}Info.plist`));
  if (!info) notes.push("Info.plist could not be read.");
  const summary = info ? summarizeInfoPlist(info) : { app: {}, components: {} as Record<string, string[]> };
  const executable = (summary.app.executable as string | null | undefined) ?? null;

  const { categories, files } = categorize(entries, (n) => classifyIpaEntry(n, appRoot, executable), ORDER);

  // Frameworks, dylibs and app extensions.
  const bundles = new Map<string, InventoryLibrary & { plistPath?: string }>();
  for (const e of entries) {
    if (!e.name.startsWith(appRoot) || e.name.endsWith("/")) continue;
    const rel = e.name.slice(appRoot.length);
    let key: string | null = null;
    let lib: (InventoryLibrary & { plistPath?: string }) | undefined;
    const fw = rel.match(/^Frameworks\/([^/]+)\.framework\//);
    const dylib = rel.match(/^Frameworks\/([^/]+\.dylib)$/);
    const appex = rel.match(/^(?:PlugIns|Extensions)\/([^/]+)\.appex\//);
    if (fw) {
      key = `framework:${fw[1]}`;
      lib = bundles.get(key) ?? { name: fw[1]!, kind: "framework", bytes: 0, compressed_bytes: 0, sdk: sdkForFramework(fw[1]!), plistPath: `${appRoot}Frameworks/${fw[1]}.framework/Info.plist` };
    } else if (dylib) {
      key = `framework:${dylib[1]}`;
      lib = bundles.get(key) ?? { name: dylib[1]!, kind: "framework", bytes: 0, compressed_bytes: 0, sdk: sdkForFramework(dylib[1]!) };
    } else if (appex) {
      const dir = rel.startsWith("PlugIns/") ? "PlugIns" : "Extensions";
      key = `extension:${appex[1]}`;
      lib = bundles.get(key) ?? { name: appex[1]!, kind: "extension", bytes: 0, compressed_bytes: 0, sdk: null, plistPath: `${appRoot}${dir}/${appex[1]}.appex/Info.plist` };
    }
    if (!key || !lib) continue;
    lib.bytes += e.uncompressedSize;
    lib.compressed_bytes! += e.compressedSize;
    bundles.set(key, lib);
  }
  const extensions: string[] = [];
  const libraries: InventoryLibrary[] = [];
  for (const lib of bundles.values()) {
    const { plistPath, ...rest } = lib;
    const plist = plistPath ? readPlist(bytes, byName.get(plistPath)) : null;
    if (plist) {
      rest.version = asString(plist.CFBundleShortVersionString) ?? asString(plist.CFBundleVersion);
      rest.bundle_id = asString(plist.CFBundleIdentifier);
      if (rest.kind === "extension") {
        const point = isDict(plist.NSExtension) ? asString(plist.NSExtension.NSExtensionPointIdentifier) : null;
        extensions.push(`${rest.bundle_id ?? rest.name}${point ? ` (${point})` : ""}`);
      }
    }
    libraries.push(rest);
  }
  libraries.sort((a, b) => b.bytes - a.bytes || a.name.localeCompare(b.name));

  // Entitlements: the signed executable first, the provisioning profile second.
  let entitlements: PlistDict | null = null;
  const exeEntry = executable ? byName.get(`${appRoot}${executable}`) : undefined;
  if (exeEntry && exeEntry.uncompressedSize <= 200 * 1024 * 1024) {
    try {
      entitlements = entitlementsFromExecutable(readZipEntry(bytes, exeEntry));
    } catch {
      entitlements = null;
    }
  }
  if (!entitlements) {
    const profileEntry = byName.get(`${appRoot}embedded.mobileprovision`);
    if (profileEntry) {
      try {
        entitlements = entitlementsFromProfile(readZipEntry(bytes, profileEntry, 4 * 1024 * 1024));
        if (entitlements) notes.push("Entitlements come from the embedded provisioning profile (what it allows), not the signed executable.");
      } catch {
        entitlements = null;
      }
    }
  }
  if (!entitlements) notes.push("No entitlements found.");

  const components: Record<string, string[]> = {
    ...summary.components,
    extensions: uniqueSorted(extensions),
    entitlements: entitlements ? summarizeEntitlements(entitlements) : [],
  };
  notes.push("Statically linked SDKs are part of the main executable and are not listed separately.");

  return boundInventory({
    schema: 1,
    platform: "ios",
    generator: INVENTORY_GENERATOR,
    total_bytes: bytes.byteLength,
    uncompressed_bytes: categories.reduce((s, c) => s + c.bytes, 0),
    file_count: files.length,
    app: summary.app,
    categories,
    largest_files: files.slice(0, LARGEST_FILES),
    files: files.slice(0, DIFF_FILES),
    components,
    libraries,
    sdks: aggregateSdks(libraries),
    notes,
    truncated: false,
  });
}
