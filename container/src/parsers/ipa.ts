/**
 * iOS IPA parser — extracts app metadata from Payload/*.app/Info.plist.
 *
 * IPAs are zip archives. Xcode commonly writes Info.plist as a binary plist,
 * so this parser implements the subset of bplist needed for bundle metadata
 * instead of depending on macOS plutil.
 */

import { inflateRawSync } from "node:zlib";
import { sha256Hex } from "./index.js";
import type { ParsedMetadata } from "./index.js";

const ZIP_EOCD_SIG = 0x06054b50;
const ZIP_CENTRAL_DIR_SIG = 0x02014b50;
const ZIP_LOCAL_FILE_SIG = 0x04034b50;

export function parseIpa(bytes: Uint8Array): ParsedMetadata {
  const plistBytes = extractZipEntry(bytes, (name) =>
    /^Payload\/[^/]+\.app\/Info\.plist$/i.test(name),
  );
  if (!plistBytes) {
    throw new Error("IPA missing Payload/*.app/Info.plist");
  }

  const plist = parsePlist(plistBytes);
  const bundleId = stringValue(plist.CFBundleIdentifier);
  const version = stringValue(plist.CFBundleShortVersionString);
  const buildNumber = stringValue(plist.CFBundleVersion);
  const versionCode = parseVersionCode(buildNumber);
  const displayName =
    stringValue(plist.CFBundleDisplayName) ??
    stringValue(plist.CFBundleName) ??
    null;

  return {
    parser_kind: "ipa-info",
    platform: "ios",
    arch: null,
    version: version ?? null,
    version_code: versionCode,
    package_id: bundleId ?? null,
    app_label: displayName,
    size_bytes: bytes.byteLength,
    file_hash_sha256: sha256Hex(bytes),
    raw: {
      bundle_id: bundleId ?? null,
      build_number: buildNumber ?? null,
      minimum_os_version: stringValue(plist.MinimumOSVersion) ?? null,
      executable: stringValue(plist.CFBundleExecutable) ?? null,
      supported_platforms: arrayOfStrings(plist.CFBundleSupportedPlatforms),
      device_family: arrayOfNumbers(plist.UIDeviceFamily),
      plist_format: detectPlistFormat(plistBytes),
    },
  };
}

function extractZipEntry(
  bytes: Uint8Array,
  predicate: (name: string) => boolean,
): Uint8Array | null {
  const eocd = findEndOfCentralDirectory(bytes);
  if (eocd < 0) throw new Error("not a valid zip archive");

  const totalEntries = readUInt16LE(bytes, eocd + 10);
  const centralDirOffset = readUInt32LE(bytes, eocd + 16);

  let p = centralDirOffset;
  for (let i = 0; i < totalEntries; i++) {
    if (p + 46 > bytes.length || readUInt32LE(bytes, p) !== ZIP_CENTRAL_DIR_SIG) {
      throw new Error("invalid zip central directory");
    }
    const method = readUInt16LE(bytes, p + 10);
    const compressedSize = readUInt32LE(bytes, p + 20);
    const uncompressedSize = readUInt32LE(bytes, p + 24);
    const nameLen = readUInt16LE(bytes, p + 28);
    const extraLen = readUInt16LE(bytes, p + 30);
    const commentLen = readUInt16LE(bytes, p + 32);
    const localHeaderOffset = readUInt32LE(bytes, p + 42);
    const name = decodeUtf8(bytes.subarray(p + 46, p + 46 + nameLen));

    if (predicate(name)) {
      return readZipLocalEntry(
        bytes,
        localHeaderOffset,
        method,
        compressedSize,
        uncompressedSize,
      );
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}

function readZipLocalEntry(
  bytes: Uint8Array,
  offset: number,
  method: number,
  compressedSize: number,
  uncompressedSize: number,
): Uint8Array {
  if (offset + 30 > bytes.length || readUInt32LE(bytes, offset) !== ZIP_LOCAL_FILE_SIG) {
    throw new Error("invalid zip local file header");
  }
  const nameLen = readUInt16LE(bytes, offset + 26);
  const extraLen = readUInt16LE(bytes, offset + 28);
  const start = offset + 30 + nameLen + extraLen;
  const end = start + compressedSize;
  if (end > bytes.length) throw new Error("zip entry exceeds archive size");
  const compressed = bytes.subarray(start, end);

  if (method === 0) return compressed;
  if (method === 8) {
    const inflated = inflateRawSync(compressed);
    if (inflated.byteLength !== uncompressedSize) {
      throw new Error("zip entry inflated size mismatch");
    }
    return new Uint8Array(inflated);
  }
  throw new Error(`unsupported zip compression method ${method}`);
}

function findEndOfCentralDirectory(bytes: Uint8Array): number {
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (readUInt32LE(bytes, i) === ZIP_EOCD_SIG) return i;
  }
  return -1;
}

type PlistValue =
  | string
  | number
  | boolean
  | null
  | PlistValue[]
  | PlistDict;

interface PlistDict {
  [key: string]: PlistValue;
}

function parsePlist(bytes: Uint8Array): Record<string, PlistValue> {
  const format = detectPlistFormat(bytes);
  const value = format === "binary" ? parseBinaryPlist(bytes) : parseXmlPlist(bytes);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Info.plist root is not a dictionary");
  }
  return value as Record<string, PlistValue>;
}

function detectPlistFormat(bytes: Uint8Array): "binary" | "xml" {
  const head = decodeUtf8(bytes.subarray(0, Math.min(bytes.length, 16))).trimStart();
  return head.startsWith("bplist") ? "binary" : "xml";
}

function parseXmlPlist(bytes: Uint8Array): PlistValue {
  const xml = decodeUtf8(bytes);
  const dictMatch = xml.match(/<dict>([\s\S]*?)<\/dict>/);
  if (!dictMatch) throw new Error("XML plist missing root dict");

  const result: Record<string, PlistValue> = {};
  const re = /<key>([\s\S]*?)<\/key>\s*(<string>([\s\S]*?)<\/string>|<integer>([\s\S]*?)<\/integer>|<true\s*\/>|<false\s*\/>|<array>([\s\S]*?)<\/array>)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(dictMatch[1]!))) {
    const key = unescapeXml(m[1]!);
    const valueMarkup = m[2]!;
    if (valueMarkup.startsWith("<string>")) result[key] = unescapeXml(m[3] ?? "");
    else if (valueMarkup.startsWith("<integer>")) result[key] = Number(m[4] ?? "0");
    else if (valueMarkup.startsWith("<true")) result[key] = true;
    else if (valueMarkup.startsWith("<false")) result[key] = false;
    else result[key] = parseXmlArray(m[5] ?? "");
  }
  return result;
}

function parseXmlArray(markup: string): PlistValue[] {
  const values: PlistValue[] = [];
  const re = /<string>([\s\S]*?)<\/string>|<integer>([\s\S]*?)<\/integer>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(markup))) {
    if (m[1] !== undefined) values.push(unescapeXml(m[1]));
    else values.push(Number(m[2] ?? "0"));
  }
  return values;
}

function unescapeXml(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function parseBinaryPlist(bytes: Uint8Array): PlistValue {
  if (bytes.length < 40 || decodeUtf8(bytes.subarray(0, 8)) !== "bplist00") {
    throw new Error("invalid binary plist header");
  }

  const trailer = bytes.subarray(bytes.length - 32);
  const offsetIntSize = trailer[6]!;
  const objectRefSize = trailer[7]!;
  const numObjects = Number(readUIntBE(trailer, 8, 8));
  const topObject = Number(readUIntBE(trailer, 16, 8));
  const offsetTableOffset = Number(readUIntBE(trailer, 24, 8));

  const offsets: number[] = [];
  for (let i = 0; i < numObjects; i++) {
    offsets.push(Number(readUIntBE(bytes, offsetTableOffset + i * offsetIntSize, offsetIntSize)));
  }

  const cache = new Map<number, PlistValue>();
  const parseObject = (index: number): PlistValue => {
    const cached = cache.get(index);
    if (cached !== undefined) return cached;
    const offset = offsets[index];
    if (offset === undefined || offset >= bytes.length) throw new Error("plist object offset out of range");
    const marker = bytes[offset]!;
    const type = marker >> 4;
    const info = marker & 0x0f;

    let value: PlistValue;
    switch (type) {
      case 0x0:
        value = info === 0x8 ? false : info === 0x9 ? true : null;
        break;
      case 0x1: {
        const len = 1 << info;
        value = Number(readUIntBE(bytes, offset + 1, len));
        break;
      }
      case 0x5: {
        const { length, start } = readObjectLength(bytes, offset, info, parseObject);
        value = decodeUtf8(bytes.subarray(start, start + length));
        break;
      }
      case 0x6: {
        const { length, start } = readObjectLength(bytes, offset, info, parseObject);
        let s = "";
        for (let i = 0; i < length; i++) {
          s += String.fromCharCode(readUInt16BE(bytes, start + i * 2));
        }
        value = s;
        break;
      }
      case 0xa: {
        const { length, start } = readObjectLength(bytes, offset, info, parseObject);
        value = Array.from({ length }, (_, i) =>
          parseObject(Number(readUIntBE(bytes, start + i * objectRefSize, objectRefSize))),
        );
        break;
      }
      case 0xd: {
        const { length, start } = readObjectLength(bytes, offset, info, parseObject);
        const keysStart = start;
        const valuesStart = start + length * objectRefSize;
        const dict: Record<string, PlistValue> = {};
        cache.set(index, dict);
        for (let i = 0; i < length; i++) {
          const keyObj = parseObject(Number(readUIntBE(bytes, keysStart + i * objectRefSize, objectRefSize)));
          const valObj = parseObject(Number(readUIntBE(bytes, valuesStart + i * objectRefSize, objectRefSize)));
          if (typeof keyObj === "string") dict[keyObj] = valObj;
        }
        return dict;
      }
      default:
        value = null;
    }
    cache.set(index, value);
    return value;
  };

  return parseObject(topObject);
}

function readObjectLength(
  bytes: Uint8Array,
  offset: number,
  info: number,
  parseObject: (index: number) => PlistValue,
): { length: number; start: number } {
  if (info !== 0x0f) return { length: info, start: offset + 1 };
  const lengthObject = parseInlineInteger(bytes, offset + 1);
  return { length: lengthObject.value, start: lengthObject.nextOffset };
}

function parseInlineInteger(bytes: Uint8Array, offset: number): { value: number; nextOffset: number } {
  const marker = bytes[offset]!;
  if ((marker >> 4) !== 0x1) throw new Error("plist length marker is not an integer");
  const len = 1 << (marker & 0x0f);
  return {
    value: Number(readUIntBE(bytes, offset + 1, len)),
    nextOffset: offset + 1 + len,
  };
}

function stringValue(value: PlistValue | undefined): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function arrayOfStrings(value: PlistValue | undefined): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function arrayOfNumbers(value: PlistValue | undefined): number[] {
  return Array.isArray(value) ? value.filter((v): v is number => typeof v === "number") : [];
}

function parseVersionCode(buildNumber: string | null): number | null {
  if (!buildNumber) return null;
  const numeric = Number(buildNumber);
  return Number.isSafeInteger(numeric) ? numeric : null;
}

function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

function readUInt16LE(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! | (bytes[offset + 1]! << 8);
}

function readUInt16BE(bytes: Uint8Array, offset: number): number {
  return (bytes[offset]! << 8) | bytes[offset + 1]!;
}

function readUInt32LE(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset]! |
    (bytes[offset + 1]! << 8) |
    (bytes[offset + 2]! << 16) |
    (bytes[offset + 3]! << 24)
  ) >>> 0;
}

function readUIntBE(bytes: Uint8Array, offset: number, length: number): bigint {
  let out = 0n;
  for (let i = 0; i < length; i++) {
    out = (out << 8n) | BigInt(bytes[offset + i] ?? 0);
  }
  return out;
}
