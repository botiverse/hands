/**
 * Per-class index of an R8/ProGuard mapping file (built by the container's
 * indexMapping, stored next to the mapping in R2). With it, a retrace reads
 * only the mapping's comment header and the class blocks the trace names,
 * instead of streaming the whole file (hundreds of MB for a large app).
 *
 * Format:
 *   r8index v1
 *   header\t<length>
 *   <obfuscated class>\t<offset>\t<length>
 */
export const MAPPING_INDEX_VERSION = "r8index v1";

/** The R2 key of a mapping's index. */
export function mappingIndexKey(mappingKey: string): string {
  return `${mappingKey}.r8index`;
}

/**
 * Every dotted identifier in the trace and each of its dotted prefixes, the
 * same names the container keeps when it filters a full mapping.
 */
export function traceNames(trace: string): Set<string> {
  const names = new Set<string>();
  for (const match of trace.matchAll(/[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*/g)) {
    const parts = match[0].split(".");
    for (let i = 1; i <= parts.length; i++) names.add(parts.slice(0, i).join("."));
  }
  return names;
}

export type MappingRange = { offset: number; length: number };

/**
 * The byte ranges to read for a trace: the header first, then each named
 * class block in file order. Null when the index is not a v1 index.
 */
export function rangesForTrace(index: string, trace: string): MappingRange[] | null {
  const lines = index.split("\n");
  if (lines[0] !== MAPPING_INDEX_VERSION) return null;
  const header = /^header\t(\d+)$/.exec(lines[1] ?? "");
  if (!header) return null;
  const names = traceNames(trace);
  const ranges: MappingRange[] = [];
  const headerLength = Number(header[1]);
  if (headerLength > 0) ranges.push({ offset: 0, length: headerLength });
  for (let i = 2; i < lines.length; i++) {
    const line = lines[i]!;
    const tab = line.indexOf("\t");
    if (tab <= 0 || !names.has(line.slice(0, tab))) continue;
    const parts = line.split("\t");
    const offset = Number(parts[1]);
    const length = Number(parts[2]);
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length <= 0) return null;
    ranges.push({ offset, length });
  }
  return ranges;
}

/** How much of a log without a stack section is retraced (the stored result is cut to 20,000 characters). */
const RETRACE_HEAD_CHARS = 24_000;

/**
 * The part of a crash log worth retracing. The Hands Android SDK writes the
 * crashing exception under a "Stack trace:" line, ended by a blank line, and
 * then process info, file descriptors, log lines and every thread's stack.
 * Only the exception is used (grouping, alerts, the ticket's symbolicated
 * stack), so that section alone is retraced, which keeps retrace fast however
 * long the rest of the log is. A log without the section is retraced from its
 * start, up to about the length that is stored.
 */
export function retraceInput(log: string): string {
  const lines = log.split("\n");
  const start = lines.findIndex((line) => line.trimEnd() === "Stack trace:");
  if (start >= 0) {
    let end = start + 1;
    while (end < lines.length && lines[end]!.trim() !== "") end++;
    if (end > start + 1) return `${lines.slice(start, end).join("\n")}\n`;
  }
  if (log.length <= RETRACE_HEAD_CHARS) return log;
  const cut = log.lastIndexOf("\n", RETRACE_HEAD_CHARS);
  return log.slice(0, cut > 0 ? cut + 1 : RETRACE_HEAD_CHARS);
}

/**
 * The obfuscated methods each class is entered through in the trace's frames
 * ("at x26.c(...)" gives x26 -> {c}).
 */
export function traceFrameMethods(trace: string): Map<string, Set<string>> {
  const methods = new Map<string, Set<string>>();
  for (const match of trace.matchAll(/^\s*at\s+([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\.([\w$<>-]+)\s*\(/gm)) {
    const set = methods.get(match[1]!) ?? new Set<string>();
    set.add(match[2]!);
    methods.set(match[1]!, set);
  }
  return methods;
}

/**
 * One class block cut to what retrace can use for this trace: the class
 * header, its class-level `#` metadata, and the member lines (with their
 * indented metadata) whose obfuscated name is one of `methods`. Inlined
 * frames share the residual method's obfuscated name, so whole inline chains
 * are kept. A class named in the trace but not entered by a frame (an
 * exception type, say) keeps only its header and class-level metadata.
 */
export function filterClassBlock(block: string, methods: Set<string> | undefined): string {
  const lines = block.split("\n");
  const out: string[] = [];
  let memberSeen = false;
  let keepMember = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (i === 0) {
      out.push(line);
      continue;
    }
    const trimmed = line.trimStart();
    if (trimmed.startsWith("#")) {
      if (!memberSeen || keepMember) out.push(line);
      continue;
    }
    if (trimmed === "" || trimmed === "\r") {
      continue;
    }
    memberSeen = true;
    const arrow = line.lastIndexOf(" -> ");
    const name = arrow >= 0 ? line.slice(arrow + 4).trim() : "";
    keepMember = methods !== undefined && methods.has(name);
    if (keepMember) out.push(line);
  }
  return `${out.join("\n")}\n`;
}
