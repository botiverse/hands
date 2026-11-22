import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// A Tailwind colour class whose token has no `--color-*` definition still
// compiles, but resolves to nothing and inherits the page's text colour. The
// landing terminal shipped dark-on-dark that way.
const root = join(__dirname, "..");
const css = [
  readFileSync(join(root, "src/index.css"), "utf8"),
  readFileSync(join(root, "node_modules/@botiverse/raft-ui/dist/styles.css"), "utf8"),
].join("\n");

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

describe("design-system colour tokens", () => {
  it("every semantic colour class used in the console has a theme definition", () => {
    const used = new Set<string>();
    for (const file of sources(join(root, "src"))) {
      for (const match of readFileSync(file, "utf8").matchAll(/\b(?:text|bg|border|ring|divide|outline|fill|stroke)-((?:layer|foreground|line|fill|info|success|warning|danger)-[a-z-]*[a-z])/g)) {
        used.add(match[1]!);
      }
    }
    expect(used.size).toBeGreaterThan(0);
    const missing = [...used].filter((token) => !css.includes(`--color-${token}:`));
    expect(missing).toEqual([]);
  });
});
