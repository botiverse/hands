// Building the next release from the installed copy plus a patch.
//
// macOS: the result is a zip of the release's .app, byte for byte (every file
// is checked against the release's sha256), so Apple's signature holds and
// Squirrel checks and installs it like the zip it would have downloaded. The
// zip is stored, not compressed: it only goes to Squirrel on this machine.
//
// A single file (an AppImage): the result is the release's file exactly.
//
// The installed copy is only read. Any failure throws AppPatchError with a
// reason and removes what was written; the caller then downloads the full
// update.

import { createHash } from "node:crypto";
import fs, { constants as fsConstants } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import zlib from "node:zlib";
import {
  AppPatchError,
  MAX_MANIFEST,
  MAX_MANIFEST_JSON,
  PATCH_CHUNK,
  PATCH_MAGICS,
  PATCH_WINDOW_LOG,
  asDictionary,
  checkFileManifest,
  checkManifest,
  chunkSize,
  dictionaryRange,
  zstdDictionarySupported,
} from "./format.js";
import type { PatchFileEntry, ZstdOptions } from "./format.js";

// Electron's node:fs shows app.asar as a folder, so the installed app would
// always look changed. original-fs is the same API on the real files.
const { lstat, open, realpath, rm } = ((process.versions.electron && (process.getBuiltinModule?.("original-fs") as typeof fs | undefined)) || fs).promises;

// Looked up when called: on a Node without zstd, importing this module still works.
const zstdDecompress = (data: Buffer, options: ZstdOptions): Promise<Buffer> =>
  new Promise((resolve, reject) => zlib.zstdDecompress(data, options, (error, result) => (error ? reject(error) : resolve(result))));

async function decompress(data: Buffer, dictionary: Buffer | undefined, size: number): Promise<Buffer> {
  return zstdDecompress(data, {
    params: { [zlib.constants.ZSTD_d_windowLogMax]: PATCH_WINDOW_LOG },
    maxOutputLength: Math.max(size, 1),
    ...(dictionary ? { dictionary } : {}),
  });
}

async function readExact(handle: FileHandle, length: number, position: number): Promise<Buffer> {
  const buf = Buffer.allocUnsafe(length);
  let got = 0;
  while (got < length) {
    const { bytesRead } = await handle.read(buf, got, length - got, position + got);
    if (bytesRead === 0) throw new RangeError("unexpected end of file");
    got += bytesRead;
  }
  return buf;
}

// --- zip ------------------------------------------------------------------

const S_IFREG = 0o100000;
const S_IFDIR = 0o040000;
const S_IFLNK = 0o120000;

/** A stored (uncompressed) zip with Unix modes and symlinks, as ditto reads it. */
class StoredZip {
  private at = 0;
  private readonly central: Buffer[] = [];
  private readonly time: number;
  private readonly date: number;
  private readonly out: FileHandle;

  constructor(out: FileHandle, now: Date) {
    this.out = out;
    this.time = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
    // Zip years are 1980 to 2107, whatever the clock says.
    this.date = (Math.min(127, Math.max(0, now.getFullYear() - 1980)) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  }

  async write(buf: Buffer): Promise<void> {
    let done = 0;
    while (done < buf.length) done += (await this.out.write(buf, done, buf.length - done, this.at + done)).bytesWritten;
    this.at += buf.length;
  }

  /** `body` writes exactly `size` bytes with write() and returns their crc32. */
  async add(name: string, unixMode: number, size: number, body: () => Promise<number>): Promise<void> {
    const nameBytes = Buffer.from(name, "utf8");
    const start = this.at;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(this.time, 10);
    local.writeUInt16LE(this.date, 12);
    local.writeUInt32LE(size, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    await this.write(Buffer.concat([local, nameBytes]));
    const dataStart = this.at;
    const crc = await body();
    if (this.at - dataStart !== size) throw new AppPatchError("other", "zip entry size");
    const crcBytes = Buffer.alloc(4);
    crcBytes.writeUInt32LE(crc >>> 0, 0);
    await this.out.write(crcBytes, 0, 4, start + 14);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4); // made by: Unix
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(this.time, 12);
    central.writeUInt16LE(this.date, 14);
    crcBytes.copy(central, 16);
    central.writeUInt32LE(size, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE((unixMode << 16) >>> 0, 38);
    central.writeUInt32LE(start, 42);
    this.central.push(central, nameBytes);
  }

  async finish(): Promise<void> {
    const entries = this.central.length / 2;
    const start = this.at;
    const directory = Buffer.concat(this.central);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(entries, 8);
    end.writeUInt16LE(entries, 10);
    end.writeUInt32LE(directory.length, 12);
    end.writeUInt32LE(start, 16);
    await this.write(Buffer.concat([directory, end]));
  }

  get size(): number { return this.at; }
}

// --- build ----------------------------------------------------------------

export interface BuildFromPatchOptions {
  /** The installed "My App.app". Only read. */
  baseApp: string;
  patchFile: string;
  /** Written; removed again on failure. */
  zipFile: string;
  from: string;
  to: string;
  arch: string;
  now?: Date;
}

export interface BuildFileFromPatchOptions {
  /** The installed file. Only read. */
  baseFile: string;
  patchFile: string;
  /** Written; removed again on failure. */
  outFile: string;
  from: string;
  to: string;
  arch: string;
}

/** Builds the file of version `to` from the installed one and the patch; its size and sha512 (base64, as in the feed). */
export async function buildFileFromPatch(opts: BuildFileFromPatchOptions): Promise<{ size: number; sha512: string }> {
  return cleaningUp(opts.outFile, async () => {
    const patch = await open(opts.patchFile, "r");
    try {
      const { manifest, dataStart } = await readManifest(patch, checkFileManifest);
      checkIdentity(manifest, opts);
      const out = await open(opts.outFile, fsConstants.O_CREAT | fsConstants.O_TRUNC | fsConstants.O_RDWR, 0o600);
      try {
        let at = 0;
        const sink = {
          async write(buf: Buffer): Promise<void> {
            let done = 0;
            while (done < buf.length) done += (await out.write(buf, done, buf.length - done, at + done)).bytesWritten;
            at += buf.length;
          },
        };
        // The person may keep the AppImage behind a symlink of their own.
        const real = await realpath(opts.baseFile).catch(() => { throw new AppPatchError("base_missing", path.basename(opts.baseFile)); });
        const build = { ...manifest.build, from: path.basename(real) };
        await writeFileEntry(sink, path.dirname(real), { path: build.from, kind: "file", mode: 0o600, size: manifest.size, sha256: manifest.sha256, build }, patch, dataStart);
        await out.sync();
        return { size: at, sha512: await sha512Base64(out, at) };
      } finally {
        await out.close();
      }
    } finally {
      await patch.close();
    }
  });
}

async function cleaningUp<T>(file: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    await rm(file, { force: true }).catch(() => undefined);
    throw error instanceof AppPatchError ? error : new AppPatchError("other", error instanceof Error ? error.message : String(error));
  }
}

function checkIdentity(m: { from: string; to: string; arch: string }, opts: { from: string; to: string; arch: string }): void {
  if (m.from !== opts.from || m.to !== opts.to || m.arch !== opts.arch) throw new AppPatchError("base_version_mismatch", `${m.arch} ${m.from} -> ${m.to}`);
}

/** Builds the zip of version `to` from the installed app and the patch; its size and sha512 (base64, as in the feed). */
export async function buildZipFromPatch(opts: BuildFromPatchOptions): Promise<{ size: number; sha512: string }> {
  return cleaningUp(opts.zipFile, () => build(opts));
}

async function readManifest<M extends { dataSize: number }>(patch: FileHandle, check: (value: unknown) => M): Promise<{ manifest: M; dataStart: number }> {
  const size = (await patch.stat()).size;
  const corrupt = (detail: string): AppPatchError => new AppPatchError("patch_corrupt", detail);
  if (size < 12) throw corrupt("too short");
  const head = await readExact(patch, 12, 0);
  if (!PATCH_MAGICS.includes(head.toString("latin1", 0, 8))) throw new AppPatchError("unsupported_format", "magic");
  if (!zstdDictionarySupported()) throw new AppPatchError("unsupported_format", "this runtime's zstd has no dictionary support");
  const length = head.readUInt32LE(8);
  if (length === 0 || length > MAX_MANIFEST || 12 + length > size) throw corrupt("manifest length");
  let value: unknown;
  try {
    value = JSON.parse((await decompress(await readExact(patch, length, 12), undefined, MAX_MANIFEST_JSON)).toString("utf8"));
  } catch {
    throw corrupt("manifest");
  }
  const manifest = check(value);
  if (12 + length + manifest.dataSize !== size) throw corrupt("data size");
  return { manifest, dataStart: 12 + length };
}

async function build(opts: BuildFromPatchOptions): Promise<{ size: number; sha512: string }> {
  const patch = await open(opts.patchFile, "r");
  try {
    const { manifest, dataStart } = await readManifest(patch, checkManifest);
    checkIdentity(manifest, opts);
    const zipHandle = await open(opts.zipFile, fsConstants.O_CREAT | fsConstants.O_TRUNC | fsConstants.O_RDWR, 0o600);
    try {
      const zip = new StoredZip(zipHandle, opts.now ?? new Date());
      await zip.add(`${manifest.root}/`, S_IFDIR | manifest.rootMode, 0, async () => 0);
      for (const e of manifest.entries) {
        const name = `${manifest.root}/${e.path}`;
        if (e.kind === "dir") await zip.add(`${name}/`, S_IFDIR | e.mode, 0, async () => 0);
        else if (e.kind === "link") {
          const target = Buffer.from(e.target, "utf8");
          await zip.add(name, S_IFLNK | 0o755, target.length, async () => { await zip.write(target); return zlib.crc32(target); });
        } else {
          await zip.add(name, S_IFREG | e.mode, e.size, () => writeFileEntry(zip, opts.baseApp, e, patch, dataStart));
        }
      }
      await zip.finish();
      await zipHandle.sync();
      return { size: zip.size, sha512: await sha512Base64(zipHandle, zip.size) };
    } finally {
      await zipHandle.close();
    }
  } finally {
    await patch.close();
  }
}

async function writeFileEntry(zip: { write(buf: Buffer): Promise<void> }, baseApp: string, e: PatchFileEntry, patch: FileHandle, dataStart: number): Promise<number> {
  const b = e.build;
  const base = b.op === "full" ? null : await openBase(baseApp, b.from, b.op === "copy" ? e.size : b.fromSize);
  try {
    const hash = createHash("sha256");
    let crc = 0;
    let dictionaryCache: { start: number; end: number; buf: Buffer } | null = null;
    const dictionary = async (off: number): Promise<Buffer | undefined> => {
      if (b.op !== "patch") return undefined;
      const { start, end } = dictionaryRange(b.fromSize, off);
      if (!dictionaryCache || dictionaryCache.start !== start || dictionaryCache.end !== end) {
        dictionaryCache = { start, end, buf: await readExact(base!, end - start, start) };
      }
      return asDictionary(dictionaryCache.buf);
    };
    for (let off = 0, i = 0; off < e.size; off += PATCH_CHUNK, i++) {
      const size = chunkSize(e.size, i);
      const blob = b.op === "copy" ? null : b.chunks[i];
      if (blob === undefined) throw new AppPatchError("unsupported_format", "chunk");
      let out: Buffer;
      if (blob === null) {
        out = await readExact(base!, size, off);
      } else {
        const data = await readExact(patch, blob.len, dataStart + blob.off);
        try {
          out = await decompress(data, await dictionary(off), size);
        } catch (error) {
          throw await whyNot(base, b, error);
        }
        if (out.length !== size) throw await whyNot(base, b, "chunk size");
      }
      hash.update(out);
      crc = zlib.crc32(out, crc);
      await zip.write(out);
    }
    if (hash.digest("hex") !== e.sha256) throw await whyNot(base, b, e.path);
    return crc;
  } finally {
    await base?.close();
  }
}

/** A wrong result: the installed file was changed (the usual cause), else the patch does not produce the release. */
async function whyNot(base: FileHandle | null, b: PatchFileEntry["build"], cause: unknown): Promise<AppPatchError> {
  const detail = cause instanceof Error ? cause.message : String(cause);
  if (b.op === "copy") return new AppPatchError("base_modified", detail);
  if (b.op === "patch" && base) {
    const hash = createHash("sha256");
    for (let off = 0; off < b.fromSize; off += PATCH_CHUNK) hash.update(await readExact(base, Math.min(PATCH_CHUNK, b.fromSize - off), off));
    if (hash.digest("hex") !== b.fromSha256) return new AppPatchError("base_modified", detail);
  }
  return new AppPatchError("verify_failed", detail);
}

/** The installed file, which must be a regular file of the expected size, with no symlink on its way. */
async function openBase(baseApp: string, from: string, size: number): Promise<FileHandle> {
  let current = baseApp;
  const parts = from.split("/");
  for (const [i, part] of parts.entries()) {
    current = path.join(current, part);
    const info = await lstat(current).catch(() => null);
    if (!info) throw new AppPatchError("base_missing", from);
    if (i === parts.length - 1) {
      if (!info.isFile() || info.size !== size) throw new AppPatchError("base_modified", from);
    } else if (!info.isDirectory()) throw new AppPatchError("base_modified", from);
  }
  const handle = await open(current, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0)).catch((error: NodeJS.ErrnoException) => {
    throw new AppPatchError(error.code === "ENOENT" ? "base_missing" : "base_modified", from);
  });
  // The opened file, not the one looked at above.
  const info = await handle.stat();
  if (!info.isFile() || info.size !== size) {
    await handle.close();
    throw new AppPatchError("base_modified", from);
  }
  return handle;
}

async function sha512Base64(handle: FileHandle, size: number): Promise<string> {
  const hash = createHash("sha512");
  for (let off = 0; off < size; off += PATCH_CHUNK) hash.update(await readExact(handle, Math.min(PATCH_CHUNK, size - off), off));
  return hash.digest("base64");
}
