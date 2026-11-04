#!/usr/bin/env node
/**
 * Hands docs build (docs-kit pipeline).
 *
 *   1. VitePress renders the site from docs/public with the docs-kit theme
 *      (base /docs/), into admin/public/docs.
 *   2. Output is restructured to directory style — <slug>.html moves to
 *      <slug>/index.html — so the Worker keeps serving the historical
 *      /docs/<slug>/ URLs unchanged; the local search index is normalized to
 *      the same trailing-slash form.
 *   3. The docs-kit generator emits the agent artifacts: per-page .md twins
 *      (/docs/<slug>.md, /docs/zh/<slug>.md) and the machine indexes
 *      (/docs.md above the output dir, /docs/zh.md inside it).
 *
 * Replaces the hand-rolled build-docs.mjs renderer (PR-C of the docs-kit
 * migration). Output paths are unchanged from the old pipeline.
 */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");
const outRoot = join(repoRoot, "admin/public/docs");

function run(args) {
  execFileSync(process.execPath, args, { stdio: "inherit", cwd: repoRoot });
}

// 1. VitePress (the kit theme renders from docs.config.mjs).
rmSync(outRoot, { recursive: true, force: true });
run([join("node_modules/vitepress/bin/vitepress.js"), "build", "docs"]);

// 2. Directory-style restructure: <slug>.html -> <slug>/index.html.
function restructure(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (entry.name !== "assets" && entry.name !== "chunks") restructure(join(dir, entry.name));
      continue;
    }
    if (!entry.name.endsWith(".html") || entry.name === "index.html" || entry.name === "404.html") continue;
    const slug = entry.name.slice(0, -".html".length);
    const target = join(dir, slug, "index.html");
    mkdirSync(dirname(target), { recursive: true });
    renameSync(join(dir, entry.name), target);
  }
}
restructure(outRoot);

// Search index chunks: normalize route references to the trailing-slash form
// so search results match the URL contract even where the prefix is absent.
const chunksDir = join(outRoot, "assets/chunks");
if (existsSync(chunksDir)) {
  for (const file of readdirSync(chunksDir)) {
    if (!file.startsWith("@localSearchIndex")) continue;
    const path = join(chunksDir, file);
    const before = readFileSync(path, "utf8");
    const after = before.replace(/("\/docs\/(?:zh\/)?[A-Za-z0-9_-]+)(?=["#])/g, "$1/");
    if (after !== before) writeFileSync(path, after);
  }
}

// 3. Agent artifacts (page twins + machine indexes) via the docs-kit.
// The kit maps zh/index.md to zh.md, which is also the established Chinese
// machine index URL. Exclude only that locale home from its artifact input;
// VitePress still builds the real HTML home, and zh.md remains the index.
const contentRoot = join(repoRoot, "docs/public");
const artifactContent = mkdtempSync(join(tmpdir(), "hands-doc-artifacts-"));
try {
  cpSync(contentRoot, artifactContent, {
    recursive: true,
    // The draft tree is deliberately not part of the published site.
    filter: (source) => source !== join(contentRoot, "agc-market-packages"),
  });
  run([
    join("node_modules/@botiverse/docs-kit/src/scripts/check-i18n-coverage.mjs"),
    "--config",
    "docs.config.mjs",
    "--content",
    artifactContent,
    "--check",
  ]);
  rmSync(join(artifactContent, "zh/index.md"));
  run([
    join("node_modules/@botiverse/docs-kit/src/scripts/generate-agent-artifacts.mjs"),
    "--config",
    "docs.config.mjs",
    "--content",
    artifactContent,
  ]);
  // Keep the locale homepage's own Markdown twin distinct from /docs/zh.md,
  // which is the machine-readable index for the entire Chinese documentation.
  cpSync(join(contentRoot, "zh/index.md"), join(outRoot, "zh/index.md"));
} finally {
  rmSync(artifactContent, { recursive: true, force: true });
}

run([join("admin/scripts/check-doc-output.mjs")]);

console.log(
  `Built Hands docs with the docs-kit pipeline in ${relative(repoRoot, outRoot)} ` +
    `(directory-style pages + .md twins + /docs.md and /docs/zh.md indexes)`,
);
