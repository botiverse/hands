/**
 * R8/ProGuard mapping class names for the inventory.
 *
 * With `-repackageclasses` R8 moves obfuscated classes into the default (or a
 * single) package, so grouping dex classes by package says nothing about which
 * library they came from. The build's mapping.txt restores the original class
 * names. Mappings run to hundreds of MB, almost all of it member lines, so the
 * reader streams the file, skips member and comment lines by their first byte,
 * and keeps only the class lines as obfuscated -> original.
 */

import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { downloadMapping, RetraceError } from "../retrace.js";
import type { AndroidMappingInput } from "./android.js";

/** "orig.Class -> obf.Name:" -> { original, obfuscated }; null for any other line. */
export function mappingClassLine(line: string): { original: string; obfuscated: string } | null {
  if (line.length === 0 || line[0] === " " || line[0] === "\t" || line[0] === "#") return null;
  const match = /^(\S+) -> (\S+):\s*$/.exec(line);
  return match ? { original: match[1]!, obfuscated: match[2]! } : null;
}

/** Streams a mapping and returns its class map, obfuscated name -> original name. */
export async function readMappingClassMap(input: AsyncIterable<Buffer | string>): Promise<Map<string, string>> {
  const classes = new Map<string, string>();
  const onLine = (line: Buffer) => {
    // Member lines start with whitespace and comments with '#': skip them undecoded.
    const first = line[0];
    if (first === undefined || first === 0x20 || first === 0x09 || first === 0x23) return;
    const parsed = mappingClassLine(line.toString("utf8"));
    if (parsed) classes.set(parsed.obfuscated, parsed.original);
  };
  let carry: Buffer = Buffer.alloc(0);
  for await (const raw of input) {
    const chunk = typeof raw === "string" ? Buffer.from(raw) : raw;
    const data = carry.length > 0 ? Buffer.concat([carry, chunk]) : chunk;
    let lineStart = 0;
    for (let i = data.indexOf(0x0a); i !== -1; i = data.indexOf(0x0a, i + 1)) {
      onLine(data.subarray(lineStart, i));
      lineStart = i + 1;
    }
    carry = Buffer.from(data.subarray(lineStart));
  }
  if (carry.length > 0) onLine(carry);
  return classes;
}

/**
 * Whether a class name looks R8-minified: the simple name (before any `$`) is
 * one to three lowercase letters, optionally followed by digits ("a", "bc",
 * "e74"). Real class names are almost never like that.
 */
export function looksMinified(className: string): boolean {
  const simple = className.slice(className.lastIndexOf(".") + 1).split("$")[0]!;
  return /^[a-z]{1,3}\d{0,4}$/.test(simple);
}

/** A dex is treated as obfuscated when at least this share of its classes looks minified. */
export const OBFUSCATED_SHARE = 0.25;
/** ...and it has at least this many classes (tiny dex files say nothing). */
export const OBFUSCATED_MIN_CLASSES = 50;

/**
 * Runs `fn` with the R8 mapping named by the request's `X-Mapping-URL` header
 * downloaded to a temp file, and deletes it afterwards. A failed download is
 * passed on as `mappingError` so the inventory still computes, without names.
 * The URL is presigned: it is never logged or echoed.
 */
export async function withRequestMapping<T>(
  mappingUrl: string | undefined,
  fn: (mapping: AndroidMappingInput) => Promise<T>,
): Promise<T> {
  if (!mappingUrl) return fn({});
  if (!/^https?:\/\//i.test(mappingUrl)) return fn({ mappingError: "the mapping URL is not an http(s) URL" });
  const dir = join(tmpdir(), `inventory-mapping-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const path = join(dir, "mapping.txt");
  try {
    await mkdir(dir, { recursive: true });
    try {
      await downloadMapping(mappingUrl, path);
    } catch (err) {
      return await fn({ mappingError: err instanceof RetraceError ? err.message : "mapping download failed" });
    }
    return await fn({ mappingPath: path });
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
