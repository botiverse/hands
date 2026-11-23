/**
 * Path rules for a desktop bundle, shared in spirit with the CLI's copy
 * (packages/cli/src/lib/desktop_paths.ts): keep the two in step.
 *
 * A manifest describes a whole bundle, so every symlink can be resolved against the
 * manifest itself, the way the target filesystem will resolve it. That is what makes
 * a chain safe to accept: `d/up -> ..` is harmless alone, but `l -> d/up/..` climbs
 * out of the root once `d/up` is followed, which a lexical check cannot see.
 */

const WIN_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
const WIN_FORBIDDEN = /[<>:"|?*]/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;
/** The same limit Linux applies to nested symlink resolution. */
const MAX_LINK_HOPS = 40;

export class BundlePathError extends Error {
  constructor(message: string, readonly index: number) {
    super(message);
  }
}

/**
 * The key two paths collide on. macOS (APFS/HFS+ default) and Windows compare names
 * case-insensitively and macOS also normalises Unicode, so `Raft` and `raft`, or a
 * composed and a decomposed `é`, are the same file there. Linux compares bytes.
 */
export function bundlePathKey(path: string, target: string): string {
  if (target.startsWith("linux-")) return path;
  return path.normalize("NFC").toLowerCase();
}

/** Why a single path segment cannot exist on the target, or null. */
export function segmentProblem(segment: string, target: string): string | null {
  if (CONTROL.test(segment)) return "contains a control character";
  if (!target.startsWith("win32-")) return null;
  if (WIN_FORBIDDEN.test(segment)) return "contains a character Windows does not allow (< > : \" | ? *)";
  if (/[. ]$/.test(segment)) return "ends with a dot or a space, which Windows strips";
  if (WIN_RESERVED.test(segment)) return "is a reserved Windows device name";
  return null;
}

/**
 * Check every entry's path and every symlink against the whole entry list. Paths are
 * assumed already to be relative, '/'-separated and free of empty, '.' and '..'
 * segments, and link targets already relative; this adds the checks that need the
 * target and the other entries.
 */
export function checkBundleEntries(target: string, entries: Array<{ path: string; link: string | null }>): void {
  const keys = new Map<string, number>();
  const linkByKey = new Map<string, string>();
  entries.forEach((entry, index) => {
    for (const segment of entry.path.split("/")) {
      const problem = segmentProblem(segment, target);
      if (problem) throw new BundlePathError(`'${entry.path}': segment '${segment}' ${problem}`, index);
    }
    const key = bundlePathKey(entry.path, target);
    const other = keys.get(key);
    if (other !== undefined) {
      throw new BundlePathError(`'${entry.path}' is the same path as '${entries[other]!.path}' on ${target}`, index);
    }
    keys.set(key, index);
    if (entry.link !== null) linkByKey.set(key, entry.link);
  });

  // No entry may sit under another entry: under a file it cannot exist, and under a
  // symlink it would be written through the link, to wherever the link points.
  entries.forEach((entry, index) => {
    const segments = entry.path.split("/");
    for (let depth = 1; depth < segments.length; depth += 1) {
      const ancestor = segments.slice(0, depth).join("/");
      const at = keys.get(bundlePathKey(ancestor, target));
      if (at !== undefined) {
        throw new BundlePathError(`'${entry.path}' is nested under the file or symlink '${entries[at]!.path}'`, index);
      }
    }
  });

  const key = (segments: string[]) => bundlePathKey(segments.join("/"), target);
  const resolve = (base: string[], link: string, budget: { hops: number }, index: number): string[] => {
    let current = base;
    for (const segment of link.split("/")) {
      if (segment === "" || segment === ".") continue;
      if (segment === "..") {
        if (current.length === 0) throw new BundlePathError("link resolves outside the bundle root", index);
        current = current.slice(0, -1);
        continue;
      }
      const problem = segmentProblem(segment, target);
      if (problem) throw new BundlePathError(`link segment '${segment}' ${problem}`, index);
      current = [...current, segment];
      const next = linkByKey.get(key(current));
      if (next !== undefined) {
        budget.hops += 1;
        if (budget.hops > MAX_LINK_HOPS) throw new BundlePathError("link chain is too long or loops", index);
        current = resolve(current.slice(0, -1), next, budget, index);
      }
    }
    return current;
  };
  entries.forEach((entry, index) => {
    if (entry.link === null) return;
    resolve(entry.path.split("/").slice(0, -1), entry.link, { hops: 0 }, index);
  });
}
