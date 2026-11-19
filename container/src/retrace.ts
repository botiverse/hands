/**
 * R8/ProGuard retrace support.
 *
 * Release mappings for large apps are hundreds of MB, more than a Worker can
 * hold and more than retrace needs. The mapping is streamed from R2 to disk
 * and reduced to the class blocks whose obfuscated names appear in the trace
 * (plus the file header), so memory stays small whatever the mapping size.
 */
import { createReadStream, createWriteStream } from "node:fs";
import { createInterface } from "node:readline";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { once } from "node:events";

export const MAX_MAPPING_BYTES = 2 * 1024 * 1024 * 1024;

export class RetraceError extends Error {
  constructor(readonly status: 400 | 413 | 502, readonly code: string, message: string) {
    super(message);
  }
}

/**
 * Every dotted identifier in the trace and each of its dotted prefixes:
 * "e74.i(" yields "e74.i" and "e74"; "a.b.C$D.m" yields "a", "a.b",
 * "a.b.C$D" and "a.b.C$D.m".
 */
export function traceNames(trace: string): Set<string> {
  const names = new Set<string>();
  for (const match of trace.matchAll(/[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*/g)) {
    const parts = match[0].split(".");
    for (let i = 1; i <= parts.length; i++) names.add(parts.slice(0, i).join("."));
  }
  return names;
}

/** "orig.Class -> obf.Name:" → "obf.Name"; null for any other line. */
export function classHeaderTarget(line: string): string | null {
  if (line.length === 0 || line[0] === " " || line[0] === "\t" || line[0] === "#") return null;
  const match = /^\S+ -> (\S+):\s*$/.exec(line);
  return match ? match[1]! : null;
}

/**
 * Copy the mapping's leading header comments and the class blocks (header
 * line, member lines and in-block `#` metadata) whose obfuscated class name
 * is in `names`. Returns how many class blocks were kept.
 */
export async function filterMapping(
  input: NodeJS.ReadableStream,
  outputPath: string,
  names: Set<string>,
): Promise<number> {
  const out = createWriteStream(outputPath, { mode: 0o600 });
  const write = async (line: string) => {
    if (!out.write(`${line}\n`)) await once(out, "drain");
  };
  let kept = 0;
  let inHeader = true;
  let keep = false;
  const lines = createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    const target = classHeaderTarget(line);
    if (target !== null) {
      inHeader = false;
      keep = names.has(target);
      if (keep) kept += 1;
    }
    if (inHeader || keep) await write(line);
  }
  out.end();
  await once(out, "finish");
  return kept;
}

/** Stream a mapping URL to disk, refusing more than MAX_MAPPING_BYTES. */
export async function downloadMapping(url: string, dest: string): Promise<void> {
  let response: Response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(600_000) });
  } catch {
    throw new RetraceError(502, "mapping_unavailable", "mapping download failed");
  }
  if (!response.ok || !response.body) {
    throw new RetraceError(502, "mapping_unavailable", `mapping download returned ${response.status}`);
  }
  if (Number(response.headers.get("content-length") ?? "0") > MAX_MAPPING_BYTES) {
    throw new RetraceError(413, "mapping_too_large", "mapping is too large");
  }
  let total = 0;
  const limiter = new Transform({
    transform(chunk: Buffer, _enc, done) {
      total += chunk.length;
      if (total > MAX_MAPPING_BYTES) return done(new RetraceError(413, "mapping_too_large", "mapping is too large"));
      done(null, chunk);
    },
  });
  try {
    await pipeline(Readable.fromWeb(response.body as never), limiter, createWriteStream(dest, { mode: 0o600 }));
  } catch (error) {
    if (error instanceof RetraceError) throw error;
    throw new RetraceError(502, "mapping_unavailable", "mapping download was interrupted");
  }
}

export function openMapping(path: string): NodeJS.ReadableStream {
  return createReadStream(path);
}

export const MAPPING_INDEX_VERSION = "r8index v1";

/**
 * Index a mapping file by class so later retraces read only the bytes they
 * need. Byte offsets are exact (computed on the raw file, CRLF included):
 *
 *   r8index v1
 *   header\t<length of the leading comment header>
 *   <obfuscated class>\t<offset>\t<length>      (one line per class block)
 *
 * A block runs from its class header line to the next class header (or end of
 * file), matching what filterMapping keeps for that class.
 */
export async function indexMapping(input: NodeJS.ReadableStream): Promise<string> {
  const entries: string[] = [];
  // Mutated inside onLine; held in an object so the end-of-file code sees it.
  const state: { headerLength: number | null; current: { name: string; start: number } | null } = {
    headerLength: null,
    current: null,
  };
  let offset = 0;
  let carry: Buffer = Buffer.alloc(0);
  const onLine = (line: Buffer, start: number) => {
    // Class headers never start with whitespace or '#'.
    const first = line[0];
    if (first === undefined || first === 0x20 || first === 0x09 || first === 0x23) return;
    const target = classHeaderTarget(line.toString("utf8").replace(/\r$/, ""));
    if (target === null) return;
    if (state.headerLength === null) state.headerLength = start;
    const current = state.current;
    if (current) entries.push(`${current.name}\t${current.start}\t${start - current.start}`);
    state.current = { name: target, start };
  };
  for await (const raw of input) {
    const chunk = typeof raw === "string" ? Buffer.from(raw) : (raw as Buffer);
    const data = carry.length > 0 ? Buffer.concat([carry, chunk]) : chunk;
    const base = offset - carry.length;
    let lineStart = 0;
    for (let i = data.indexOf(0x0a); i !== -1; i = data.indexOf(0x0a, i + 1)) {
      onLine(data.subarray(lineStart, i), base + lineStart);
      lineStart = i + 1;
    }
    carry = Buffer.from(data.subarray(lineStart));
    offset += chunk.length;
  }
  if (carry.length > 0) onLine(carry, offset - carry.length);
  const last = state.current;
  if (last) entries.push(`${last.name}\t${last.start}\t${offset - last.start}`);
  return [MAPPING_INDEX_VERSION, `header\t${state.headerLength ?? offset}`, ...entries].join("\n") + "\n";
}
