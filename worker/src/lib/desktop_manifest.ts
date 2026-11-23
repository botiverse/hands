/**
 * Desktop app update payloads (platform `desktop`).
 *
 * A desktop build ships, per `<os>-<arch>` target, a manifest JSON that lists every
 * file of the app bundle or install directory. Regular files are stored once per app,
 * content-addressed at `apps/{appId}/files/sha256/{sha256}`, and shared by every
 * version that ships the same bytes. This module holds the pieces both the publishing
 * and the public side need: the manifest shape, its validation, and the storage key.
 *
 * See docs/public/desktop-apps.md for the public contract.
 */

export const DESKTOP_MANIFEST_KIND = "desktop-manifest";
export const DESKTOP_ARCHIVE_KIND = "desktop-archive";
export const DESKTOP_MANIFEST_FILETYPE = "json";
export const DESKTOP_MANIFEST_SCHEMA = 1;
/** The manifest is parsed in the Worker, so it is bounded well under its memory. */
export const DESKTOP_MANIFEST_MAX_BYTES = 8 * 1024 * 1024;
/** One content-addressed file may be as large as any other direct upload. */
export const DESKTOP_FILE_MAX_BYTES = 5 * 1024 * 1024 * 1024;
const MAX_PATH_LENGTH = 1024;
const MAX_MANIFEST_ENTRIES = 100_000;

export const DESKTOP_TARGETS = [
  "darwin-arm64",
  "darwin-x64",
  "win32-x64",
  "win32-arm64",
  "linux-x64",
  "linux-arm64",
] as const;

export type DesktopTarget = (typeof DESKTOP_TARGETS)[number];

export function isDesktopTarget(value: unknown): value is DesktopTarget {
  return typeof value === "string" && (DESKTOP_TARGETS as readonly string[]).includes(value);
}

export function splitDesktopTarget(target: DesktopTarget): { platform: string; arch: string } {
  const [platform, arch] = target.split("-") as [string, string];
  return { platform, arch };
}

export function desktopFileKey(appId: string, sha256: string): string {
  return `apps/${appId}/files/sha256/${sha256}`;
}

/**
 * Where a presigned PUT lands before `/complete` verifies it. One key per digest:
 * two uploads of the same file write the same bytes, and only a digest-verified copy
 * ever reaches the content-addressed key.
 */
export function desktopFileStagingKey(appId: string, sha256: string): string {
  return `apps/${appId}/files/staging/${sha256}`;
}

const SHA256_RE = /^[0-9a-f]{64}$/;

export function isSha256(value: unknown): value is string {
  return typeof value === "string" && SHA256_RE.test(value);
}

export interface DesktopManifestFile {
  path: string;
  sha256: string;
  size: number;
  mode: string;
}

export interface DesktopManifestLink {
  path: string;
  link: string;
}

export interface ValidatedDesktopManifest {
  target: DesktopTarget;
  root: string;
  files: DesktopManifestFile[];
  links: DesktopManifestLink[];
  total_size: number;
  /** Each referenced digest once, with the size every entry of that digest declares. */
  digests: Map<string, number>;
}

export class DesktopManifestError extends Error {
  constructor(message: string, readonly index: number | null = null) {
    super(index === null ? message : `files[${index}]: ${message}`);
  }
}

/** A relative, '/'-separated path whose every segment is a real name. */
function checkRelativePath(value: unknown, field: string, index: number | null): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new DesktopManifestError(`${field} must be a non-empty string`, index);
  }
  if (value.length > MAX_PATH_LENGTH) throw new DesktopManifestError(`${field} is too long`, index);
  if (value.includes("\\")) throw new DesktopManifestError(`${field} must use '/' separators`, index);
  if (value.includes("\0")) throw new DesktopManifestError(`${field} contains NUL`, index);
  if (value.startsWith("/") || /^[A-Za-z]:/.test(value)) {
    throw new DesktopManifestError(`${field} must be relative`, index);
  }
  for (const segment of value.split("/")) {
    if (segment === "" || segment === "." || segment === "..") {
      throw new DesktopManifestError(`${field} has an empty, '.' or '..' segment`, index);
    }
  }
  return value;
}

/**
 * A symlink target is relative to the link's own directory and must resolve inside the
 * bundle. Absolute targets and targets that climb out of the root are refused: an
 * updater that materialised them would write or read outside the install directory.
 */
function checkLinkTarget(path: string, value: unknown, index: number): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new DesktopManifestError("link must be a non-empty string", index);
  }
  if (value.length > MAX_PATH_LENGTH) throw new DesktopManifestError("link is too long", index);
  if (value.includes("\\") || value.includes("\0")) {
    throw new DesktopManifestError("link must use '/' separators and contain no NUL", index);
  }
  if (value.startsWith("/") || /^[A-Za-z]:/.test(value)) {
    throw new DesktopManifestError("link must be relative", index);
  }
  const resolved = path.split("/").slice(0, -1);
  for (const segment of value.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (resolved.length === 0) throw new DesktopManifestError("link escapes the bundle root", index);
      resolved.pop();
    } else {
      resolved.push(segment);
    }
  }
  return value;
}

function checkMode(value: unknown, index: number): string {
  if (typeof value !== "string" || !/^[0-7]{3,4}$/.test(value)) {
    throw new DesktopManifestError("mode must be an octal permission string such as \"644\" or \"755\"", index);
  }
  return value;
}

/**
 * Validate a parsed manifest. Throws DesktopManifestError naming the first problem.
 * `expectedTarget` is the target of the build asset the manifest was uploaded as; the
 * two must agree, or one target's update would carry another target's files.
 */
export function validateDesktopManifest(raw: unknown, expectedTarget: string | null): ValidatedDesktopManifest {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new DesktopManifestError("manifest must be a JSON object");
  }
  const doc = raw as Record<string, unknown>;
  if (doc.schema !== DESKTOP_MANIFEST_SCHEMA) {
    throw new DesktopManifestError(`schema must be ${DESKTOP_MANIFEST_SCHEMA}`);
  }
  if (!isDesktopTarget(doc.target)) {
    throw new DesktopManifestError(`target must be one of ${DESKTOP_TARGETS.join(", ")}`);
  }
  if (expectedTarget !== null && doc.target !== expectedTarget) {
    throw new DesktopManifestError(`target '${doc.target}' does not match the asset target '${expectedTarget}'`);
  }
  const root = checkRelativePath(doc.root, "root", null);
  if (root.includes("/")) throw new DesktopManifestError("root must be a single path segment");
  if (!Array.isArray(doc.files) || doc.files.length === 0) {
    throw new DesktopManifestError("files must be a non-empty array");
  }
  if (doc.files.length > MAX_MANIFEST_ENTRIES) {
    throw new DesktopManifestError(`files has more than ${MAX_MANIFEST_ENTRIES} entries`);
  }

  const files: DesktopManifestFile[] = [];
  const links: DesktopManifestLink[] = [];
  const digests = new Map<string, number>();
  const seen = new Set<string>();
  let totalSize = 0;
  doc.files.forEach((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new DesktopManifestError("entry must be an object", index);
    }
    const item = entry as Record<string, unknown>;
    const path = checkRelativePath(item.path, "path", index);
    if (seen.has(path)) throw new DesktopManifestError(`duplicate path '${path}'`, index);
    seen.add(path);
    if (item.link !== undefined && item.link !== null) {
      if (item.sha256 !== undefined && item.sha256 !== null) {
        throw new DesktopManifestError("a symlink entry carries no sha256", index);
      }
      links.push({ path, link: checkLinkTarget(path, item.link, index) });
      return;
    }
    if (!isSha256(item.sha256)) {
      throw new DesktopManifestError("sha256 must be 64 lowercase hexadecimal characters", index);
    }
    const size = item.size;
    if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0 || size > DESKTOP_FILE_MAX_BYTES) {
      throw new DesktopManifestError(`size must be an integer 0-${DESKTOP_FILE_MAX_BYTES}`, index);
    }
    const known = digests.get(item.sha256);
    if (known !== undefined && known !== size) {
      throw new DesktopManifestError(`sha256 ${item.sha256} is declared with two different sizes`, index);
    }
    digests.set(item.sha256, size);
    totalSize += size;
    files.push({ path, sha256: item.sha256, size, mode: checkMode(item.mode, index) });
  });

  // No entry may sit under another entry: under a file it cannot exist, and under a
  // symlink it would be written through the link, to wherever the link points.
  doc.files.forEach((entry, index) => {
    const path = (entry as { path: string }).path;
    const segments = path.split("/");
    for (let depth = 1; depth < segments.length; depth += 1) {
      const ancestor = segments.slice(0, depth).join("/");
      if (seen.has(ancestor)) {
        throw new DesktopManifestError(`'${path}' is nested under the file or symlink '${ancestor}'`, index);
      }
    }
  });

  if (doc.total_size !== undefined && doc.total_size !== totalSize) {
    throw new DesktopManifestError(`total_size ${String(doc.total_size)} does not equal the sum of file sizes ${totalSize}`);
  }
  return { target: doc.target, root, files, links, total_size: totalSize, digests };
}

/** Parse manifest bytes (UTF-8 JSON) and validate them. */
export function parseDesktopManifest(bytes: Uint8Array, expectedTarget: string | null): ValidatedDesktopManifest {
  if (bytes.byteLength > DESKTOP_MANIFEST_MAX_BYTES) {
    throw new DesktopManifestError(`manifest exceeds ${DESKTOP_MANIFEST_MAX_BYTES} bytes`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
  } catch {
    throw new DesktopManifestError("manifest is not valid UTF-8 JSON");
  }
  return validateDesktopManifest(parsed, expectedTarget);
}

/** Chunk an array so each SQL statement binds a bounded JSON parameter. */
export function chunked<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < items.length; index += size) out.push(items.slice(index, index + size));
  return out;
}

/** Digests per statement: a 64-character digest is ~67 bytes of JSON, so ~134 KB. */
export const DIGEST_CHUNK = 2000;

/**
 * Which of `digests` are not stored for this app with exactly the declared size.
 * Returns the offending digests (absent, or present with another size).
 */
export async function findUnstoredDesktopFiles(
  db: D1Database,
  appId: string,
  digests: Map<string, number>,
): Promise<Array<{ sha256: string; size: number; stored_size: number | null }>> {
  const stored = new Map<string, number>();
  for (const chunk of chunked([...digests.keys()], DIGEST_CHUNK)) {
    const { results } = await db.prepare(
      `SELECT f.sha256, f.size_bytes
         FROM desktop_files f
         JOIN json_each(?2) j ON j.value = f.sha256
        WHERE f.app_id = ?1`,
    ).bind(appId, JSON.stringify(chunk)).all<{ sha256: string; size_bytes: number }>();
    for (const row of results) stored.set(row.sha256, Number(row.size_bytes));
  }
  const bad: Array<{ sha256: string; size: number; stored_size: number | null }> = [];
  for (const [sha256, size] of digests) {
    const storedSize = stored.get(sha256);
    if (storedSize !== size) bad.push({ sha256, size, stored_size: storedSize ?? null });
  }
  return bad;
}
