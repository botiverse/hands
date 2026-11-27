// The update patch file: what it holds and how a reader checks it before using
// anything in it.
//
// File: an 8-byte magic ("HANDPAT1"; "RAFTPAT1" is the same format under the
// name Raft Desktop shipped it with), a u32 LE length of the zstd-compressed
// JSON manifest, the manifest, then the data the manifest's entries point into.
//
// An app patch rebuilds every file of the new .app from the installed one:
// `copy` (an installed file with the same bytes), `patch` (8 MB chunks, each
// either the installed file's bytes at that offset or zstd compressed with the
// installed file as dictionary) or `full` (zstd on its own). Every rebuilt file
// carries its sha256. A file patch (an AppImage) is one such `patch` entry.
//
// Authenticity comes from the update feed's sha512 of the patch file, exactly
// as for the release zip, and on macOS from Squirrel's signature check.

import path from "node:path";
import zlib from "node:zlib";

/** A patch file bigger than this is not worth it (an Electron upgrade is about 20 MB): never made, never used. */
export const MAX_PATCH_FILE = 64 << 20;
/** What new patches start with. */
export const PATCH_MAGIC = "HANDPAT1";
/** The same format as made by Raft Desktop; read, and written on request (`legacyMagic`). */
export const LEGACY_PATCH_MAGIC = "RAFTPAT1";
export const PATCH_MAGICS: readonly string[] = [PATCH_MAGIC, LEGACY_PATCH_MAGIC];
export const PATCH_FORMAT = 1;
/** The feed and asset name of this format. */
export const PATCH_ALGORITHM = "app-patch-v1";
export const PATCH_CHUNK = 8 << 20;
/** Up to this size the whole old file is the dictionary; larger files use the part around the chunk. */
export const PATCH_WHOLE_DICT_MAX = 48 << 20;
/** 128 MB: the decoder's default limit, and room for a dictionary plus a chunk. */
export const PATCH_WINDOW_LOG = 27;
const ZDICT_MAGIC = 0xec30a437;

export const MAX_MANIFEST = 4 << 20;
export const MAX_MANIFEST_JSON = 32 << 20;
const MAX_ENTRIES = 20_000;
const MAX_TOTAL = 2 ** 31; // a zip without zip64 ends at 4 GB; an Electron app is a few hundred MB

/** Why a patch could not be used. */
export type AppPatchReason =
  | "base_version_mismatch"
  | "base_missing"
  | "base_modified"
  | "patch_corrupt"
  | "verify_failed"
  | "unsupported_format"
  | "other";

export class AppPatchError extends Error {
  readonly reason: AppPatchReason;
  constructor(reason: AppPatchReason, detail: string) {
    super(`${reason}: ${detail}`);
    this.reason = reason;
    this.name = "AppPatchError";
  }
}

export interface PatchBlob { off: number; len: number }
/** null: the chunk equals the old file's bytes at the same offset. */
export type PatchChunk = PatchBlob | null;
export type PatchBuild =
  | { op: "copy"; from: string }
  | { op: "patch"; from: string; fromSize: number; fromSha256: string; chunks: PatchChunk[] }
  | { op: "full"; chunks: PatchBlob[] };
export type PatchFileEntry = { path: string; kind: "file"; mode: number; size: number; sha256: string; build: PatchBuild };
export type PatchEntry =
  | { path: string; kind: "dir"; mode: number }
  | { path: string; kind: "link"; target: string }
  | PatchFileEntry;

/** A patch for a single file (an AppImage): `file` is the new one, built from the installed one. */
export interface FilePatchManifest {
  format: number;
  kind: "file";
  arch: string;
  from: string;
  to: string;
  dataSize: number;
  size: number;
  sha256: string;
  build: Extract<PatchBuild, { op: "patch" }>;
}

export interface PatchManifest {
  format: number;
  arch: string;
  from: string;
  to: string;
  /** The bundle's folder name, "My App.app". */
  root: string;
  rootMode: number;
  dataSize: number;
  entries: PatchEntry[];
}

/** The old bytes that serve as the dictionary of the chunk at `off`. */
export function dictionaryRange(oldSize: number, off: number): { start: number; end: number } {
  if (oldSize <= PATCH_WHOLE_DICT_MAX) return { start: 0, end: oldSize };
  // Past the end of the old file (the new one is much longer): its last part.
  const at = Math.min(off, oldSize);
  return { start: Math.max(0, at - PATCH_CHUNK), end: Math.min(oldSize, at + 2 * PATCH_CHUNK) };
}

/** A raw dictionary zstd must not mistake for a trained one; undefined = compress without. */
export function asDictionary(buf: Buffer): Buffer | undefined {
  return buf.length >= 8 && buf.readUInt32LE(0) !== ZDICT_MAGIC ? buf : undefined;
}

/** node:zlib's zstd options, with the dictionary option older @types/node do not list. */
export type ZstdOptions = zlib.ZstdOptions & { dictionary?: Buffer };

let dictionarySupport: boolean | undefined;

/**
 * Whether this runtime's zstd uses a dictionary (Node 22.19+ / 24.6+). Older
 * ones accept the option and silently ignore it, which would turn every
 * patch into garbage, so neither making nor applying runs without it.
 */
export function zstdDictionarySupported(): boolean {
  if (dictionarySupport !== undefined) return dictionarySupport;
  try {
    if (typeof zlib.zstdCompressSync !== "function") return (dictionarySupport = false);
    const dictionary = Buffer.alloc(4096);
    for (let i = 0; i < dictionary.length; i++) dictionary[i] = (i * 7919) % 251;
    const data = Buffer.concat([dictionary.subarray(0, 2048), Buffer.from("x")]);
    const packed = zlib.zstdCompressSync(data, { dictionary } as ZstdOptions);
    let withoutWorks = true;
    try { zlib.zstdDecompressSync(packed); } catch { withoutWorks = false; }
    dictionarySupport = !withoutWorks && zlib.zstdDecompressSync(packed, { dictionary } as ZstdOptions).equals(data);
  } catch {
    dictionarySupport = false;
  }
  return dictionarySupport;
}

// --- manifest -------------------------------------------------------------

const isInt = (v: unknown, max = Number.MAX_SAFE_INTEGER): v is number => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= max;
const isSha = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{64}$/.test(v);

/** A relative path inside the bundle: no empty, "." or ".." parts, no backslash or control characters. */
function isInside(p: unknown): p is string {
  // eslint-disable-next-line no-control-regex
  return typeof p === "string" && p.length > 0 && p.length <= 1024 && !/[\\\u0000-\u001f]/.test(p)
    && p.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

/** A symlink stays inside the bundle. */
function linkStaysInside(entryPath: string, target: unknown): boolean {
  // eslint-disable-next-line no-control-regex
  if (typeof target !== "string" || target === "" || target.length > 1024 || target.startsWith("/") || /[\\\u0000-\u001f]/.test(target)) return false;
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(entryPath), target));
  return resolved !== ".." && !resolved.startsWith("../");
}

const bad = (detail: string): never => { throw new AppPatchError("unsupported_format", detail); };

function isBlob(b: PatchBlob, dataSize: number): boolean {
  return !!b && isInt(b.off) && isInt(b.len) && b.len > 0 && b.off + b.len <= dataSize;
}

export const chunkSize = (size: number, i: number): number => Math.min(PATCH_CHUNK, size - i * PATCH_CHUNK);

/** Throws unless the chunks rebuild `size` bytes from inside the old file and the patch's data. */
function checkPatchBuild(b: FilePatchManifest["build"], size: number, dataSize: number): void {
  if (!isInt(b.fromSize, MAX_TOTAL) || !isSha(b.fromSha256) || !Array.isArray(b.chunks) || b.chunks.length !== Math.ceil(size / PATCH_CHUNK)) bad("patch");
  b.chunks.forEach((c, i) => {
    if (c === null ? i * PATCH_CHUNK + chunkSize(size, i) > b.fromSize : !isBlob(c, dataSize)) bad("chunk");
  });
}

/** A single file's manifest, or an AppPatchError: nothing in it is used before this. */
export function checkFileManifest(value: unknown): FilePatchManifest {
  const m = value as FilePatchManifest;
  if (!m || typeof m !== "object" || m.format !== PATCH_FORMAT || m.kind !== "file") bad("format");
  if (typeof m.arch !== "string" || typeof m.from !== "string" || typeof m.to !== "string") bad("identity");
  if (!isInt(m.dataSize, MAX_TOTAL) || !isInt(m.size, MAX_TOTAL) || m.size === 0 || !isSha(m.sha256) || m.build?.op !== "patch") bad("shape");
  checkPatchBuild(m.build, m.size, m.dataSize);
  return m;
}

/** The manifest, or an AppPatchError: nothing in it is used before this. */
export function checkManifest(value: unknown): PatchManifest {
  const m = value as PatchManifest;
  if (!m || typeof m !== "object" || m.format !== PATCH_FORMAT || (m as { kind?: unknown }).kind !== undefined) bad("format");
  if (typeof m.arch !== "string" || typeof m.from !== "string" || typeof m.to !== "string") bad("identity");
  if (typeof m.root !== "string" || !/^[^/\\]+\.app$/.test(m.root) || !isInside(m.root) || !isInt(m.rootMode, 0o7777)) bad("root");
  if (!isInt(m.dataSize, MAX_TOTAL) || !Array.isArray(m.entries) || m.entries.length === 0 || m.entries.length > MAX_ENTRIES) bad("shape");
  const seen = new Map<string, string>();
  let total = 0;
  for (const e of m.entries) {
    if (!isInside(e?.path) || seen.has(e.path)) bad("path");
    const parent = path.posix.dirname(e.path);
    if (parent !== "." && seen.get(parent) !== "dir") bad("parent");
    seen.set(e.path, e.kind);
    if (e.kind === "link") {
      if (!linkStaysInside(e.path, e.target)) bad("link");
      continue;
    }
    if (!isInt(e.mode, 0o7777)) bad("mode");
    if (e.kind === "dir") continue;
    if (e.kind !== "file" || !isInt(e.size, MAX_TOTAL) || !isSha(e.sha256) || !e.build) bad("file");
    total += e.size;
    const b = e.build;
    const chunks = Math.ceil(e.size / PATCH_CHUNK);
    if (b.op === "copy") { if (!isInside(b.from)) bad("copy"); }
    else if (b.op === "patch") {
      if (!isInside(b.from)) bad("patch");
      checkPatchBuild(b, e.size, m.dataSize);
    } else if (b.op === "full") { if (b.chunks?.length !== chunks || !b.chunks.every((c) => isBlob(c, m.dataSize))) bad("full"); }
    else bad("op");
  }
  if (total > MAX_TOTAL) bad("size");
  return m;
}
