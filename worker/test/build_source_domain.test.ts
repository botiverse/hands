import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * `builds.source` documentation drift guard.
 *
 * Background: this column's domain was documented as `{web, cli, ci}` while the code
 * actually writes more values than that, and one writer (`qa-artifact`) had gone entirely
 * undocumented while `ci` is never written at all. That divergence survived many reviews
 * precisely because nothing tied the documentation to the writers.
 *
 * This test is that tie. It finds every `source:` literal inside a `createBuild(...)` call
 * in worker/src — i.e. the values that actually reach `builds.source` — and fails if the
 * set stops matching the documented domain in
 *   - worker/src/routes/builds.ts (the `BuildInput.source` comment), and
 *   - docs/publish-architecture.md.
 * A new writer therefore forces a deliberate documentation decision.
 *
 * NOTE ON PRECISION: a naive `grep "source:"` over worker/src produces false positives,
 * because `source:` is also a column/property name in unrelated places — notably
 * feedback.ts (`source: "inline"` / `"presigned"`) and android_release_artifacts.ts's CI
 * provenance. Only literals that are arguments of `createBuild` belong to this column.
 * This test therefore scopes the search to createBuild call sites rather than scanning
 * blindly (the blind scan is what produced the earlier, wrong "3 values + 1 surprise"
 * reading).
 */

/**
 * Values that reach `builds.source`, with the file that writes them.
 * `web` is not a literal at a call site: it is createBuild's `input.source ?? "web"`
 * default, so the only writer for it is builds.ts.
 */
const DOCUMENTED_WRITERS: Record<string, string[]> = {
  web: ["worker/src/routes/builds.ts"], // createBuild default
  cli: ["packages/cli/src/commands/builds.ts"], // CLI publish commands (outside worker/src)
  "qa-artifact": ["worker/src/routes/qa_artifacts.ts"],
  external: ["worker/src/routes/builds.ts"],
  "mobile-ci": ["worker/src/routes/android_release_artifacts.ts"],
};

/** Documented in older material as valid, but written by nothing anywhere. */
const NEVER_WRITTEN = ["ci"];

function tsFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...tsFilesUnder(full));
    } else if (entry.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Extract the argument object passed to each `createBuild(` call and collect its
 * `source: "<literal>"`. Brace-matching keeps us inside the call, so unrelated
 * `source:` properties elsewhere in the same file are ignored.
 */
function sourceLiteralsPassedToCreateBuild(text: string): string[] {
  const values: string[] = [];
  const marker = /createBuild\s*\(/g;
  for (const match of text.matchAll(marker)) {
    let i = match.index + match[0].length;
    // Walk to the first `{` at depth 0 of parentheses/braces, then match to its close.
    let depth = 1;
    while (i < text.length && text[i] !== "{") {
      if (text[i] === "(") depth++;
      else if (text[i] === ")") {
        depth--;
        if (depth === 0) break;
      } else if (text[i] === ",") {
        // still positional args; keep going
      }
      i++;
    }
    if (text[i] !== "{") continue;
    const start = i;
    let braces = 0;
    for (; i < text.length; i++) {
      if (text[i] === "{") braces++;
      else if (text[i] === "}") {
        braces--;
        if (braces === 0) {
          i++;
          break;
        }
      }
    }
    const argObject = text.slice(start, i);
    for (const hit of argObject.matchAll(/\bsource:\s*(["'])([^"']+)\1/g)) {
      const value = hit[2];
      if (value !== undefined) values.push(value);
    }
  }
  return values;
}

function writtenSources(repoRoot: string): Map<string, Set<string>> {
  const found = new Map<string, Set<string>>();
  for (const file of tsFilesUnder(join(repoRoot, "worker", "src"))) {
    const rel = relative(repoRoot, file).replaceAll("\\", "/");
    for (const value of sourceLiteralsPassedToCreateBuild(readFileSync(file, "utf8"))) {
      if (!found.has(value)) found.set(value, new Set());
      found.get(value)!.add(rel);
    }
  }
  return found;
}

describe("builds.source documented domain", () => {
  const repoRoot = join(__dirname, "..", "..");

  it("documents every source value that createBuild in worker/src actually writes", () => {
    const written = writtenSources(repoRoot);
    const undocumented = [...written.keys()].filter(
      (value) => !(value in DOCUMENTED_WRITERS),
    );

    expect(
      undocumented,
      `worker/src passes source value(s) to createBuild that are absent from the documented ` +
        `domain: ${undocumented.join(", ")}. Add them to docs/publish-architecture.md and the ` +
        `BuildInput.source comment in worker/src/routes/builds.ts, or stop writing them.`,
    ).toEqual([]);
  });

  it("keeps the documented writer for each value accurate", () => {
    const written = writtenSources(repoRoot);
    for (const [value, expectedFiles] of Object.entries(DOCUMENTED_WRITERS)) {
      if (value === "cli") continue; // written from packages/cli, outside worker/src
      if (value === "web") continue; // createBuild default, not a call-site literal
      const actual = [...(written.get(value) ?? [])];
      expect(
        actual,
        `documented writer(s) for source='${value}' are ${expectedFiles.join(", ")}, but ` +
          `worker/src writes it from ${actual.join(", ") || "(nowhere)"}`,
      ).toEqual(expect.arrayContaining(expectedFiles));
    }
  });

  it("does not write values that the docs correctly call dead", () => {
    const written = writtenSources(repoRoot);
    for (const dead of NEVER_WRITTEN) {
      expect(
        written.has(dead),
        `source='${dead}' is documented as never written, but worker/src now passes it to ` +
          `createBuild. Update docs/publish-architecture.md and BuildInput.source.`,
      ).toBe(false);
    }
  });

  it("scopes discovery to createBuild, so unrelated `source:` properties are not counted", () => {
    // Guards the precision of the scan itself: these belong to other tables/concerns and
    // must never appear as builds.source values.
    const written = writtenSources(repoRoot);
    for (const unrelated of ["inline", "presigned"]) {
      expect(
        written.has(unrelated),
        `'${unrelated}' is a property of a different table and must not be detected as a ` +
          `builds.source value; the createBuild-scoped scan has regressed.`,
      ).toBe(false);
    }
  });
});
