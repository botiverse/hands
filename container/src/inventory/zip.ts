/**
 * Minimal zip reader for package inventories: lists the central directory
 * (names, compressed and uncompressed sizes) and inflates single entries.
 * Handles zip64 sizes and offsets, which large IPAs can use.
 */

import { inflateRawSync } from "node:zlib";

export interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

const EOCD_SIG = 0x06054b50;
const ZIP64_LOCATOR_SIG = 0x07064b50;
const ZIP64_EOCD_SIG = 0x06064b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;

function u16(b: Uint8Array, o: number): number {
  return b[o]! | (b[o + 1]! << 8);
}

function u32(b: Uint8Array, o: number): number {
  return (b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16) | (b[o + 3]! << 24)) >>> 0;
}

function u64(b: Uint8Array, o: number): number {
  return u32(b, o) + u32(b, o + 4) * 0x1_0000_0000;
}

function findEocd(b: Uint8Array): number {
  for (let i = b.length - 22; i >= Math.max(0, b.length - 65557); i--) {
    if (u32(b, i) === EOCD_SIG) return i;
  }
  return -1;
}

const utf8 = new TextDecoder("utf-8", { fatal: false });

export function listZipEntries(b: Uint8Array): ZipEntry[] {
  const eocd = findEocd(b);
  if (eocd < 0) throw new Error("not a zip archive");
  let total = u16(b, eocd + 10);
  let cdOffset = u32(b, eocd + 16);
  if ((total === 0xffff || cdOffset === 0xffffffff) && eocd >= 20 && u32(b, eocd - 20) === ZIP64_LOCATOR_SIG) {
    const z64 = u64(b, eocd - 20 + 8);
    if (z64 + 56 <= b.length && u32(b, z64) === ZIP64_EOCD_SIG) {
      total = u64(b, z64 + 32);
      cdOffset = u64(b, z64 + 48);
    }
  }
  const entries: ZipEntry[] = [];
  let p = cdOffset;
  for (let i = 0; i < total; i++) {
    if (p + 46 > b.length || u32(b, p) !== CENTRAL_SIG) throw new Error("invalid zip central directory");
    const method = u16(b, p + 10);
    let compressedSize = u32(b, p + 20);
    let uncompressedSize = u32(b, p + 24);
    const nameLen = u16(b, p + 28);
    const extraLen = u16(b, p + 30);
    const commentLen = u16(b, p + 32);
    let localHeaderOffset = u32(b, p + 42);
    const name = utf8.decode(b.subarray(p + 46, p + 46 + nameLen));
    if (uncompressedSize === 0xffffffff || compressedSize === 0xffffffff || localHeaderOffset === 0xffffffff) {
      // zip64 extended information extra field (id 0x0001): the 64-bit
      // values appear only for the fields that are saturated, in this order.
      let e = p + 46 + nameLen;
      const end = e + extraLen;
      while (e + 4 <= end) {
        const id = u16(b, e);
        const size = u16(b, e + 2);
        if (id === 0x0001) {
          let q = e + 4;
          if (uncompressedSize === 0xffffffff) { uncompressedSize = u64(b, q); q += 8; }
          if (compressedSize === 0xffffffff) { compressedSize = u64(b, q); q += 8; }
          if (localHeaderOffset === 0xffffffff) { localHeaderOffset = u64(b, q); }
          break;
        }
        e += 4 + size;
      }
    }
    entries.push({ name, method, compressedSize, uncompressedSize, localHeaderOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** Inflates one entry. Refuses entries above `maxBytes` uncompressed. */
export function readZipEntry(b: Uint8Array, entry: ZipEntry, maxBytes = 256 * 1024 * 1024): Uint8Array {
  const o = entry.localHeaderOffset;
  if (o + 30 > b.length || u32(b, o) !== LOCAL_SIG) throw new Error(`invalid local header for ${entry.name}`);
  if (entry.uncompressedSize > maxBytes) throw new Error(`${entry.name} is too large to read`);
  const start = o + 30 + u16(b, o + 26) + u16(b, o + 28);
  const end = start + entry.compressedSize;
  if (end > b.length) throw new Error(`${entry.name} exceeds the archive`);
  const data = b.subarray(start, end);
  if (entry.method === 0) return data;
  if (entry.method === 8) return new Uint8Array(inflateRawSync(data, { maxOutputLength: Math.max(entry.uncompressedSize, 1) }));
  throw new Error(`unsupported compression method ${entry.method} for ${entry.name}`);
}
