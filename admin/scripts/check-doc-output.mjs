#!/usr/bin/env node
// Verify the URLs users can actually follow after directory-style reshaping.
import { createRequire } from "node:module";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { JSDOM } from "jsdom";
import { tokenizeSearch } from "../../docs/.vitepress/search-tokenize.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const publicRoot = resolve(here, "../public");
const docsRoot = join(publicRoot, "docs");
const pages = new Map();
function collect(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const file = join(dir, entry.name);
    if (entry.isDirectory() && entry.name !== "assets") collect(file);
    else if (entry.name === "index.html") {
      const dom = new JSDOM(readFileSync(file, "utf8"));
      pages.set(file, {
        links: [...dom.window.document.querySelectorAll("a[href]")].map((a) => a.getAttribute("href")),
        ids: new Set([...dom.window.document.querySelectorAll("[id]")].map((el) => el.id)),
        lang: dom.window.document.documentElement.lang,
        html: dom.serialize(),
      });
      dom.window.close();
    }
  }
}
collect(docsRoot);
const errors = [];
for (const [file, page] of pages) {
  const dir = relative(publicRoot, dirname(file)).replaceAll("\\", "/");
  const base = `https://docs.invalid/${dir}/`;
  if (dir.startsWith("docs/zh") && page.lang !== "zh-CN") errors.push(`${file}: wrong HTML language`);
  if (dir.startsWith("docs/zh") && page.html.includes('aria-label="Permalink to ')) errors.push(`${file}: untranslated heading link`);
  for (const href of page.links) {
    let url;
    try { url = new URL(href, base); } catch { errors.push(`${file}: invalid link ${href}`); continue; }
    if (url.origin !== "https://docs.invalid" || !url.pathname.startsWith("/docs/")) continue;
    let target;
    try { target = resolve(publicRoot, decodeURIComponent(url.pathname).slice(1)); }
    catch { errors.push(`${file}: invalid URL encoding ${href}`); continue; }
    if (target !== docsRoot && !target.startsWith(`${docsRoot}/`)) { errors.push(`${file}: link escapes docs ${href}`); continue; }
    if (existsSync(target) && statSync(target).isDirectory()) target = join(target, "index.html");
    if (!existsSync(target)) errors.push(`${file}: missing ${href}`);
    else if (url.hash && pages.has(target)) {
      let anchor;
      try { anchor = decodeURIComponent(url.hash.slice(1)); } catch { errors.push(`${file}: invalid anchor ${href}`); continue; }
      if (!pages.get(target).ids.has(anchor)) errors.push(`${file}: missing anchor ${href}`);
    }
  }
}
// The same links must work after VitePress client-side navigation as well as
// on the server-rendered page.
for (const [prefix, expected] of [["getting-started.md.", 'href="/docs/agent-guide/"'], ["zh_getting-started.md.", 'href="/docs/zh/agent-guide/"']]) {
  const file = readdirSync(join(docsRoot, "assets")).find((name) => name.startsWith(prefix) && name.endsWith(".js") && !name.endsWith(".lean.js"));
  if (!file || !readFileSync(join(docsRoot, "assets", file), "utf8").includes(expected)) errors.push(`${prefix}: client navigation link missing`);
}

// Exercise the generated Chinese MiniSearch index with actual user queries.
const require = createRequire(import.meta.url);
const vitepressRequire = createRequire(require.resolve("vitepress/package.json"));
const MiniSearch = vitepressRequire("minisearch");
const chunkDir = join(docsRoot, "assets/chunks");
const searchChunk = readdirSync(chunkDir).find((name) => name.startsWith("@localSearchIndexzh.") && name.endsWith(".js"));
if (!searchChunk) errors.push("Chinese search index missing");
else {
  const data = (await import(pathToFileURL(join(chunkDir, searchChunk)).href)).default;
  const index = MiniSearch.loadJSON(data, {
    fields: ["title", "titles", "text"], storeFields: ["title", "titles"], tokenize: tokenizeSearch,
    searchOptions: { fuzzy: 0.2, prefix: true },
  });
  for (const query of ["崩溃报告", "权限", "反馈"]) {
    const hits = index.search(query);
    if (!hits.length || !hits[0].id.startsWith("/docs/zh/")) errors.push(`Chinese search failed for ${query}`);
  }
}
if (errors.length) throw new Error(`Documentation output checks failed:\n${errors.join("\n")}`);
console.log(`Verified ${pages.size} documentation pages, internal links, anchors, and Chinese search.`);
