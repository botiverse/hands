/**
 * Every `cors()` registration must declare a non-empty `allowHeaders`.
 *
 * GHSA-8j4g-w8fx-2239: hono's CORS handler runs a regex over the request's
 * Access-Control-Request-Headers **only when `allowHeaders` is empty or
 * unset** — that path is quadratic and reachable without authentication, on
 * every route it is mounted on, by anyone who can send a preflight.
 *
 * The dependency is patched, so this is not what protects us today. It exists
 * because **the immunity comes from a configuration value, not from the shape
 * of the code**: deleting one array reinstates the vulnerable path, and reads
 * like tidying up a verbose config. Nothing else in the suite would notice.
 *
 * Checks **every** registration in both packages that depend on hono, not the
 * first one in one file. The earlier version anchored to `indexOf("cors({")`
 * and passed green with a second, empty registration sitting beside the good
 * one. A guard that only sees the call site it was written against is a guard
 * against edits nobody makes.
 *
 * container has no `cors()` today and its own suite does not run here, so its
 * source is scanned from this side: "we have not called it yet" is the same
 * brittle immunity this file exists to replace.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const SOURCE_DIRS = ["worker/src", "container/src"];
const MANIFESTS = ["worker/package.json", "container/package.json"];

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (at: string) => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const full = join(at, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".ts")) out.push(full);
    }
  };
  walk(join(ROOT, dir));
  return out;
}

/**
 * Slice from just after `(` to its matching `)`, skipping strings and comments.
 *
 * Matched rather than searched for a closing delimiter, so a registration is
 * read to its real end whatever its formatting — the previous version cut at
 * the first `}),` and would stop early on a nested object.
 */
function balanced(source: string, open: number): string {
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === "/" && source[i + 1] === "/") {
      const nl = source.indexOf("\n", i);
      if (nl === -1) break;
      i = nl;
      continue;
    }
    if (ch === "/" && source[i + 1] === "*") {
      i = source.indexOf("*/", i) + 1;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      i += 1;
      while (i < source.length && source[i] !== ch) i += source[i] === "\\" ? 2 : 1;
      continue;
    }
    if (ch === "(") depth += 1;
    else if (ch === ")") {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, i);
    }
  }
  throw new Error(`unterminated cors( at offset ${open}`);
}

/** Every `cors(...)` call's arguments. Bare `cors()` yields "" — the unset case. */
function corsRegistrations(): Array<{ file: string; args: string }> {
  const found: Array<{ file: string; args: string }> = [];
  for (const dir of SOURCE_DIRS) {
    for (const file of sourceFiles(dir)) {
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(/\bcors\s*\(/g)) {
        const open = match.index! + match[0].length - 1;
        found.push({ file: file.slice(ROOT.length), args: balanced(source, open) });
      }
    }
  }
  return found;
}

function honoRange(manifest: string): string {
  const pkg = JSON.parse(readFileSync(join(ROOT, manifest), "utf8")) as {
    dependencies?: Record<string, string>;
  };
  return pkg.dependencies?.hono ?? "";
}

describe("CORS keeps allowHeaders non-empty (GHSA-8j4g-w8fx-2239)", () => {
  it("declares a non-empty allowHeaders on every registration", () => {
    const registrations = corsRegistrations();
    // Guards the guard: if the scan stops finding anything — renamed import,
    // moved file — the loop below would pass vacuously and prove nothing.
    expect(registrations.length, "no cors() registration found to check").toBeGreaterThan(0);

    const vulnerable = registrations
      .map(({ file, args }) => {
        const match = args.match(/allowHeaders:\s*\[([^\]]*)\]/);
        const entries = match?.[1].split(",").map((s) => s.trim()).filter(Boolean) ?? [];
        if (entries.length > 0) return null;
        return `${file}: allowHeaders is ${match ? "empty" : "absent"}`;
      })
      .filter(Boolean);
    expect(vulnerable).toEqual([]);
  });

  it("still carries the headers the API actually needs", () => {
    // Keeps the assertion honest: a non-empty array of the wrong headers would
    // dodge the ReDoS path and break every authenticated browser request.
    const withHeaders = corsRegistrations().filter(({ args }) => args.includes("allowHeaders"));
    expect(withHeaders.length).toBeGreaterThan(0);
    for (const { file, args } of withHeaders) {
      expect(args, `${file}: allowHeaders lost content-type`).toContain("content-type");
      expect(args, `${file}: allowHeaders lost authorization`).toContain("authorization");
    }
  });

  it("declares a hono range that excludes the vulnerable versions", () => {
    // The range floor, not the lockfile: a pin fixes the current install, while
    // a range starting below the advisory lets a fresh resolve land back on a
    // vulnerable version. Checked in every package that depends on hono.
    const below = MANIFESTS
      .map((manifest) => ({ manifest, range: honoRange(manifest) }))
      .filter(({ range }) => {
        const floor = range.replace(/^[^0-9]*/, "").split(".").map(Number);
        return !(floor[0] > 4
          || (floor[0] === 4 && (floor[1] > 12 || (floor[1] === 12 && floor[2] >= 34))));
      })
      .map(({ manifest, range }) => `${manifest}: hono ${range} still permits vulnerable versions`);
    expect(below).toEqual([]);
  });
});
