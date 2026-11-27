// Making patches (format.ts has the format, apply.ts applies it). Run on the
// signed, notarized and stapled apps exactly as the release zips hold them: a
// patch made from other bytes does not rebuild the release.
//
// makeAppPatch / makeFilePatch write one patch. makeVerifiedAppPatch adds what a
// release pipeline needs around it: the size gate, and one real application of
// the patch to the very app it was made from, compared with `diff -r` against
// the new app as its zip unpacks.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { buildZipFromPatch } from "./apply.js";
import {
  LEGACY_PATCH_MAGIC,
  MAX_PATCH_FILE,
  PATCH_CHUNK,
  PATCH_FORMAT,
  PATCH_MAGIC,
  PATCH_WINDOW_LOG,
  asDictionary,
  checkFileManifest,
  checkManifest,
  dictionaryRange,
  zstdDictionarySupported,
} from "./format.js";
import type { FilePatchManifest, PatchBlob, PatchChunk, PatchEntry, PatchManifest, ZstdOptions } from "./format.js";

export interface MakeOptions {
  /** zstd level, 1 to 22 (default 19). */
  level?: number;
  /** Write Raft Desktop's magic ("RAFTPAT1"), for clients that only know that one. */
  legacyMagic?: boolean;
}

type Node = { kind: "dir"; mode: number } | { kind: "link"; target: string } | { kind: "file"; mode: number; abs: string };

const sha256 = (buf: Buffer): string => createHash("sha256").update(buf).digest("hex");

function requireDictionarySupport(): void {
  if (!zstdDictionarySupported()) {
    throw new Error(`Node ${process.version} has no zstd dictionary support (needs Node 22.19+ or 24.6+): patches cannot be made`);
  }
}

function walk(root: string): Map<string, Node> {
  const out = new Map<string, Node>();
  const visit = (rel: string): void => {
    const abs = path.join(root, rel);
    const st = lstatSync(abs);
    if (st.isSymbolicLink()) out.set(rel, { kind: "link", target: readlinkSync(abs) });
    else if (st.isDirectory()) {
      if (rel) out.set(rel, { kind: "dir", mode: st.mode & 0o7777 });
      for (const name of readdirSync(abs).sort()) visit(rel ? `${rel}/${name}` : name);
    } else if (st.isFile()) out.set(rel, { kind: "file", mode: st.mode & 0o7777, abs });
    else throw new Error(`unsupported file type: ${rel}`);
  };
  visit("");
  return out;
}

function plistString(file: string, key: string): string | undefined {
  const plist = readFileSync(file, "utf8");
  return new RegExp(`<key>${key}</key>\\s*<string>([^<]+)</string>`).exec(plist)?.[1];
}

/** CFBundleShortVersionString of a .app. */
export function appVersionOf(app: string): string {
  const version = plistString(path.join(app, "Contents/Info.plist"), "CFBundleShortVersionString");
  if (!version) throw new Error(`${app}: no CFBundleShortVersionString`);
  return version;
}

/** The Electron version a .app carries (its Electron Framework's CFBundleVersion). */
export function electronVersionOf(app: string): string {
  const version = plistString(path.join(app, "Contents/Frameworks/Electron Framework.framework/Versions/A/Resources/Info.plist"), "CFBundleVersion");
  if (!version) throw new Error(`${app}: no Electron version`);
  return version;
}

function compress(data: Buffer, level: number, dictionary?: Buffer): Buffer {
  const options: ZstdOptions = {
    params: {
      [zlib.constants.ZSTD_c_compressionLevel]: level,
      [zlib.constants.ZSTD_c_windowLog]: PATCH_WINDOW_LOG,
      [zlib.constants.ZSTD_c_enableLongDistanceMatching]: 1,
      [zlib.constants.ZSTD_c_checksumFlag]: 1,
    },
    ...(dictionary ? { dictionary } : {}),
  };
  return zlib.zstdCompressSync(data, options);
}

/** An old file as the base of a new one: its chunks, and whether they are the same bytes or compressed against the old ones. */
function diffChunks(was: Buffer, now: Buffer, level: number, put: (buf: Buffer) => PatchBlob): PatchChunk[] {
  const chunks: PatchChunk[] = [];
  for (let off = 0; off < now.length; off += PATCH_CHUNK) {
    const chunk = now.subarray(off, off + PATCH_CHUNK);
    if (off + chunk.length <= was.length && was.subarray(off, off + chunk.length).equals(chunk)) { chunks.push(null); continue; }
    const { start, end } = dictionaryRange(was.length, off);
    chunks.push(put(compress(chunk, level, asDictionary(was.subarray(start, end)))));
  }
  return chunks;
}

/** The patch file: magic, manifest length, manifest, data. */
function pack(manifest: object, data: Buffer[], level: number, legacyMagic: boolean): Buffer {
  const packed = compress(Buffer.from(JSON.stringify(manifest)), level);
  const head = Buffer.alloc(12);
  head.write(legacyMagic ? LEGACY_PATCH_MAGIC : PATCH_MAGIC, 0, "latin1");
  head.writeUInt32LE(packed.length, 8);
  return Buffer.concat([head, packed, ...data]);
}

function dataSink(): { data: Buffer[]; size: () => number; put: (buf: Buffer) => PatchBlob } {
  const data: Buffer[] = [];
  let size = 0;
  return {
    data,
    size: () => size,
    put: (buf) => {
      const blob = { off: size, len: buf.length };
      data.push(buf);
      size += buf.length;
      return blob;
    },
  };
}

export interface MadePatch {
  from: string;
  to: string;
  arch: string;
  size: number;
  /** base64, as in the update feed. */
  sha512: string;
  files: { copy: number; patch: number; full: number };
}

/** The patch that turns the .app `oldApp` into `newApp`; the versions come from their Info.plist. */
export function makeAppPatch(oldApp: string, newApp: string, outFile: string, arch: string, options: MakeOptions = {}): MadePatch {
  requireDictionarySupport();
  const level = options.level ?? 19;
  const before = walk(oldApp);
  const after = walk(newApp);
  const baseByHash = new Map<string, string>();
  for (const [rel, n] of before) {
    if (n.kind !== "file") continue;
    const hash = sha256(readFileSync(n.abs));
    if (!baseByHash.has(hash)) baseByHash.set(hash, rel);
  }
  const sink = dataSink();
  const files = { copy: 0, patch: 0, full: 0 };
  const entries: PatchEntry[] = [];
  for (const [rel, n] of after) {
    if (n.kind === "dir") { entries.push({ path: rel, kind: "dir", mode: n.mode }); continue; }
    if (n.kind === "link") { entries.push({ path: rel, kind: "link", target: n.target }); continue; }
    const now = readFileSync(n.abs);
    const entry = { path: rel, kind: "file" as const, mode: n.mode, size: now.length, sha256: sha256(now) };
    const same = baseByHash.get(entry.sha256);
    if (same !== undefined) { files.copy++; entries.push({ ...entry, build: { op: "copy", from: same } }); continue; }
    const old = before.get(rel);
    if (old?.kind !== "file") {
      const chunks: PatchBlob[] = [];
      for (let off = 0; off < now.length; off += PATCH_CHUNK) chunks.push(sink.put(compress(now.subarray(off, off + PATCH_CHUNK), level)));
      files.full++;
      entries.push({ ...entry, build: { op: "full", chunks } });
      continue;
    }
    const was = readFileSync(old.abs);
    const chunks = diffChunks(was, now, level, sink.put);
    files.patch++;
    entries.push({ ...entry, build: { op: "patch", from: rel, fromSize: was.length, fromSha256: sha256(was), chunks } });
  }
  const manifest: PatchManifest = {
    format: PATCH_FORMAT,
    arch,
    from: appVersionOf(oldApp),
    to: appVersionOf(newApp),
    root: path.basename(newApp),
    rootMode: lstatSync(newApp).mode & 0o7777,
    dataSize: sink.size(),
    entries,
  };
  checkManifest(manifest);
  const out = pack(manifest, sink.data, level, options.legacyMagic === true);
  writeFileSync(outFile, out);
  return { from: manifest.from, to: manifest.to, arch, size: out.length, sha512: createHash("sha512").update(out).digest("base64"), files };
}

export interface MadeFilePatch { from: string; to: string; arch: string; size: number; sha512: string; baseSize: number }

/** A patch for one file (an AppImage). The versions are the caller's: the file does not say its own. */
export function makeFilePatch(oldFile: string, newFile: string, outFile: string, id: { from: string; to: string; arch: string }, options: MakeOptions = {}): MadeFilePatch {
  requireDictionarySupport();
  const level = options.level ?? 19;
  const was = readFileSync(oldFile);
  const now = readFileSync(newFile);
  const sink = dataSink();
  const chunks = diffChunks(was, now, level, sink.put);
  const manifest: FilePatchManifest = {
    format: PATCH_FORMAT, kind: "file", ...id, dataSize: sink.size(), size: now.length, sha256: sha256(now),
    build: { op: "patch", from: "base", fromSize: was.length, fromSha256: sha256(was), chunks },
  };
  checkFileManifest(manifest);
  const out = pack(manifest, sink.data, level, options.legacyMagic === true);
  writeFileSync(outFile, out);
  return { ...id, size: out.length, sha512: createHash("sha512").update(out).digest("base64"), baseSize: was.length };
}

// --- release pipeline -----------------------------------------------------

/** The one .app in a release zip, unpacked into `dir` (which must not exist yet or be empty). `unzip` keeps symlinks and modes. */
export function unpackApp(zip: string, dir: string): string {
  execFileSync("unzip", ["-q", zip, "-d", dir]);
  const apps = readdirSync(dir).filter((name) => name.endsWith(".app"));
  if (apps.length !== 1) throw new Error(`${path.basename(zip)}: expected one .app, found ${apps.length}`);
  return path.join(dir, apps[0]!);
}

/** A patch this big a part of the zip saves too little to ship. */
export const DEFAULT_MAX_SHARE = 0.4;

export interface VerifiedPatchOptions extends MakeOptions {
  /** The installed app a client starts from, unpacked from the base release's zip. */
  oldApp: string;
  /** The new release's app, unpacked from its zip. */
  newApp: string;
  /** The new release zip's size: the size gate is a share of it. */
  newZipSize: number;
  from: string;
  to: string;
  arch: string;
  patchFile: string;
  /** Scratch space; emptied again. */
  workDir: string;
  /** Default 0.4. */
  maxShare?: number;
  /** Default 64 MiB, which is also what a client accepts. */
  maxBytes?: number;
}

export type VerifiedPatch =
  | { kept: true; patch: MadePatch }
  | { kept: false; size: number; limit: number };

/**
 * Makes the patch from `oldApp` to `newApp`, drops it when it is too big to be
 * worth it, and otherwise applies it once to `oldApp` and compares the app in
 * the built zip with `newApp` (`diff -r --no-dereference`). Throws when the
 * apps are not the versions given or the applied patch does not give back the
 * new app.
 */
export async function makeVerifiedAppPatch(opts: VerifiedPatchOptions): Promise<VerifiedPatch> {
  const made = makeAppPatch(opts.oldApp, opts.newApp, opts.patchFile, opts.arch, opts);
  if (made.from !== opts.from || made.to !== opts.to) {
    rmSync(opts.patchFile, { force: true });
    throw new Error(`${opts.arch}: the apps say ${made.from} -> ${made.to}, not ${opts.from} -> ${opts.to}`);
  }
  const limit = Math.floor(Math.min(opts.newZipSize * (opts.maxShare ?? DEFAULT_MAX_SHARE), opts.maxBytes ?? MAX_PATCH_FILE, MAX_PATCH_FILE));
  if (made.size > limit) {
    rmSync(opts.patchFile, { force: true });
    return { kept: false, size: made.size, limit };
  }
  const work = mkdtempSync(path.join(opts.workDir, "verify-"));
  try {
    const zipFile = path.join(work, "check.zip");
    await buildZipFromPatch({ baseApp: opts.oldApp, patchFile: opts.patchFile, zipFile, from: opts.from, to: opts.to, arch: opts.arch });
    // What the Mac unpacks is this zip, so compare the app in it, not the manifest.
    execFileSync("diff", ["-r", "--no-dereference", opts.newApp, unpackApp(zipFile, path.join(work, "check"))]);
    return { kept: true, patch: made };
  } catch (error) {
    rmSync(opts.patchFile, { force: true });
    throw error;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
