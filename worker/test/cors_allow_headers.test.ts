/**
 * `allowHeaders` must stay non-empty on the global CORS middleware.
 *
 * GHSA-8j4g-w8fx-2239: hono's CORS handler runs a regex over the request's
 * Access-Control-Request-Headers **only when `allowHeaders` is empty or
 * unset** — that path is quadratic and reachable without authentication, on
 * every route, by anyone who can send a preflight.
 *
 * The dependency is patched, so this is not what protects us today. It exists
 * because **the immunity comes from a configuration value, not from the shape
 * of the code**: deleting this one array reinstates the vulnerable path
 * everywhere, and reads like tidying up a verbose config. Nothing else in the
 * suite would notice.
 *
 * Asserted against the real registration in index.ts rather than a fixture,
 * for the reason a whole day of this went wrong yesterday: a test that builds
 * its own config only tells you what happens if that config is used.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const source = readFileSync(fileURLToPath(new URL("../src/index.ts", import.meta.url)), "utf8");

/** The global `app.use("*", cors({...}))` block, bounded by its own closing paren. */
function globalCorsBlock(): string {
  const at = source.indexOf("cors({");
  expect(at, "global cors() registration not found").toBeGreaterThan(-1);
  const end = source.indexOf("}),", at);
  expect(end, "cors() block is not closed as expected").toBeGreaterThan(at);
  return source.slice(at, end);
}

describe("global CORS keeps allowHeaders non-empty (GHSA-8j4g-w8fx-2239)", () => {
  it("declares allowHeaders with at least one header", () => {
    const block = globalCorsBlock();
    const match = block.match(/allowHeaders:\s*\[([^\]]*)\]/);
    expect(match, "allowHeaders is absent from the global cors() config").not.toBeNull();
    const entries = match![1].split(",").map((s) => s.trim()).filter(Boolean);
    expect(entries.length).toBeGreaterThan(0);
  });

  it("still carries the headers the API actually needs", () => {
    // Keeps the assertion honest: a non-empty array of the wrong headers would
    // dodge the ReDoS path and break every authenticated browser request.
    const block = globalCorsBlock();
    expect(block).toContain("content-type");
    expect(block).toContain("authorization");
  });

  it("resolves hono to a version at or above the advisory floor", () => {
    const pkg = JSON.parse(
      readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"),
    ) as { dependencies: Record<string, string> };
    const range = pkg.dependencies.hono;
    const floor = range.replace(/^[^0-9]*/, "").split(".").map(Number);
    // The range floor itself must exclude the vulnerable versions, so a fresh
    // resolve cannot land on one — a lockfile pin alone would not do that.
    const atLeast = floor[0] > 4
      || (floor[0] === 4 && (floor[1] > 12 || (floor[1] === 12 && floor[2] >= 34)));
    expect(atLeast, `hono range ${range} still permits vulnerable versions`).toBe(true);
  });
});
