/**
 * Walk a desktop app bundle (a macOS .app directory or an install directory) and
 * describe it as a Hands desktop manifest (schema 1).
 *
 * Every regular file is recorded with its sha256, size and permission bits; every
 * symlink with its target and no digest. Paths are relative to the bundle root and
 * '/'-separated. A symlink whose target is absolute or climbs out of the bundle is an
 * error: Hands refuses such a manifest, so the CLI refuses it before uploading
 * anything. Directories are implied by the paths under them; an empty directory is
 * not recorded.
 */

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readdir, readlink } from "node:fs/promises";
import { basename, join } from "node:path";
import { Writable } from "node:stream";
import { pipeline } from "node:stream/promises";

export const DESKTOP_TARGETS = [
  "darwin-arm64",
  "darwin-x64",
  "win32-x64",
  "win32-arm64",
  "linux-x64",
  "linux-arm64",
] as const;

export interface DesktopFileEntry {
  path: string;
  sha256: string;
  size: number;
  mode: string;
  link: null;
}

export interface DesktopLinkEntry {
  path: string;
  link: string;
}

export type DesktopManifestEntry = DesktopFileEntry | DesktopLinkEntry;

export interface DesktopManifest {
  schema: 1;
  target: string;
  root: string;
  files: DesktopManifestEntry[];
  total_size: number;
}

export interface WalkedBundle {
  root: string;
  entries: DesktopManifestEntry[];
  /** Absolute path of the first regular file seen for each digest. */
  pathsByDigest: Map<string, string>;
}

export function isFileEntry(entry: DesktopManifestEntry): entry is DesktopFileEntry {
  return !("link" in entry) || entry.link === null;
}

async function hashFile(path: string): Promise<{ sha256: string; size: number }> {
  const hash = createHash("sha256");
  let size = 0;
  await pipeline(createReadStream(path), new Writable({
    write(chunk: Buffer, _encoding, callback) {
      size += chunk.length;
      hash.update(chunk);
      callback();
    },
  }));
  return { sha256: hash.digest("hex"), size };
}

function checkSegment(name: string, at: string): void {
  if (name === "" || name === "." || name === ".." || name.includes("/") || name.includes("\\") || name.includes("\0")) {
    throw new Error(`bundle entry has a name Hands cannot store: ${at}`);
  }
}

/** The link must be relative and, resolved from the link's directory, stay in the bundle. */
export function checkLinkTarget(relativePath: string, target: string): void {
  if (!target || target.startsWith("/") || /^[A-Za-z]:/.test(target) || target.includes("\\") || target.includes("\0")) {
    throw new Error(`symlink ${relativePath} -> ${target} must be a relative '/'-separated path inside the bundle`);
  }
  const resolved = relativePath.split("/").slice(0, -1);
  for (const segment of target.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (resolved.length === 0) throw new Error(`symlink ${relativePath} -> ${target} points outside the bundle`);
      resolved.pop();
    } else {
      resolved.push(segment);
    }
  }
}

/**
 * Walk `bundlePath` with lstat (symlinks are recorded, never followed). Entries are
 * sorted by path so the same bundle always yields the same manifest bytes.
 */
export async function walkDesktopBundle(bundlePath: string): Promise<WalkedBundle> {
  const top = await lstat(bundlePath);
  if (!top.isDirectory()) throw new Error(`--bundle must be a directory (a .app bundle or an install directory): ${bundlePath}`);
  const root = basename(bundlePath.replace(/[\\/]+$/, ""));
  checkSegment(root, bundlePath);
  const entries: DesktopManifestEntry[] = [];
  const pathsByDigest = new Map<string, string>();

  async function visit(absolute: string, relative: string): Promise<void> {
    const names = (await readdir(absolute)).sort();
    for (const name of names) {
      const childAbsolute = join(absolute, name);
      const childRelative = relative ? `${relative}/${name}` : name;
      checkSegment(name, childRelative);
      const stat = await lstat(childAbsolute);
      if (stat.isSymbolicLink()) {
        const target = (await readlink(childAbsolute)).replace(/\\/g, "/");
        checkLinkTarget(childRelative, target);
        entries.push({ path: childRelative, link: target });
      } else if (stat.isDirectory()) {
        await visit(childAbsolute, childRelative);
      } else if (stat.isFile()) {
        const { sha256, size } = await hashFile(childAbsolute);
        if (!pathsByDigest.has(sha256)) pathsByDigest.set(sha256, childAbsolute);
        entries.push({
          path: childRelative,
          sha256,
          size,
          mode: (stat.mode & 0o777).toString(8).padStart(3, "0"),
          link: null,
        });
      } else {
        throw new Error(`bundle entry is neither a file, a directory nor a symlink: ${childRelative}`);
      }
    }
  }

  await visit(bundlePath, "");
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  if (!entries.some(isFileEntry)) throw new Error(`--bundle contains no files: ${bundlePath}`);
  return { root, entries, pathsByDigest };
}

export function buildDesktopManifest(target: string, walked: WalkedBundle): DesktopManifest {
  const totalSize = walked.entries.reduce((sum, entry) => sum + (isFileEntry(entry) ? entry.size : 0), 0);
  return { schema: 1, target, root: walked.root, files: walked.entries, total_size: totalSize };
}

/** Each digest once, with its size, in first-seen order. */
export function uniqueDigests(manifest: DesktopManifest): Array<{ sha256: string; size: number }> {
  const seen = new Map<string, number>();
  for (const entry of manifest.files) {
    if (isFileEntry(entry) && !seen.has(entry.sha256)) seen.set(entry.sha256, entry.size);
  }
  return [...seen].map(([sha256, size]) => ({ sha256, size }));
}
