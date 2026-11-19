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
