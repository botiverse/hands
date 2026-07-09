import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");
const docsRoot = path.join(repoRoot, "docs/public");
const outRoot = path.join(repoRoot, "admin/public/docs");

// Docs are grouped by audience; CATEGORY_ORDER controls section order in the
// sidebar and on the index. Quiver is agent-native, so "For agents" leads.
const CATEGORY_ORDER = ["For agents", "Console", "SDKs & API"];

// Lucide "external-link" (24x24), used for the OpenAPI explorer nav entry.
const EXTERNAL_ICON = ` <svg class="ext-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></svg>`;

const pages = [
  {
    slug: "agent-guide",
    title: "Agent Guide",
    category: "For agents",
    description: "How AI agents authenticate (Raft Agent Login, deploy tokens) and run releases, tickets, and shares.",
    source: "agent-guide.md",
  },
  {
    slug: "agent-cli-feedback",
    title: "Agent CLI: Feedback Triage",
    category: "For agents",
    description: "Read and triage feedback/crash tickets from the command line with @botiverse/hands-cli.",
    source: "agent-cli-feedback.md",
  },
  {
    slug: "admin-user-guide",
    title: "Admin User Guide",
    category: "Console",
    description: "Using the Quiver admin console: apps, releases, builds, access, and troubleshooting.",
    source: "admin-user-guide.md",
  },
  {
    slug: "cli-reference",
    title: "CLI Reference",
    category: "SDKs & API",
    description: "Install and use @botiverse/hands-cli from local scripts or CI.",
    source: "cli-reference.md",
  },
  {
    slug: "android-sdk",
    title: "Android SDK",
    category: "SDKs & API",
    description: "In-app update checks, staged rollouts, feedback, and crash reporting for Android.",
    source: "android-sdk.md",
  },
  {
    slug: "ios-sdk",
    title: "iOS SDK",
    category: "SDKs & API",
    description: "Feedback tickets and store-then-send crash reporting for iOS (the Quiver CocoaPod).",
    source: "ios-sdk.md",
  },
  {
    slug: "ohos-sdk",
    title: "HarmonyOS SDK",
    category: "SDKs & API",
    description: "Feedback tickets and crash reporting for HarmonyOS (the @oranix/quiver ohpm package).",
    source: "ohos-sdk.md",
  },
  {
    slug: "electron-sdk",
    title: "Electron SDK",
    category: "SDKs & API",
    description: "Crashpad minidump crash reporting for Electron apps (main + renderer) via @botiverse/hands-electron.",
    source: "electron-sdk.md",
  },
  {
    slug: "public-api-reference",
    title: "Public API Reference",
    category: "SDKs & API",
    description: "Public update-check, latest-release, and client integration contracts.",
    source: "public-api-reference.md",
  },
];

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function slugify(value) {
  return value
    .toLowerCase()
    .replace(/`([^`]+)`/g, "$1")
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
}

function inlineMarkdown(value) {
  let html = escapeHtml(value);
  html = html.replace(/`([^`]+)`/g, "<code>$1</code>");
  html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/\*([^*]+)\*/g, "<em>$1</em>");
  html = html.replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    (_match, label, href) => {
      const rawHref = String(href);
      const localDoc = pages.find((page) => rawHref === page.source || rawHref === `docs/${page.source}`);
      const target = localDoc ? `/docs/${localDoc.slug}/` : rawHref;
      const external = /^https?:\/\//.test(target);
      return `<a href="${escapeHtml(target)}"${external ? ' target="_blank" rel="noopener noreferrer"' : ""}>${label}</a>`;
    },
  );
  return html;
}

function tableHtml(lines) {
  const rows = lines
    .filter((line) => line.trim().startsWith("|"))
    .map((line) =>
      line
        .trim()
        .replace(/^\||\|$/g, "")
        .split("|")
        .map((cell) => inlineMarkdown(cell.trim())),
    );
  if (rows.length < 2) return null;
  const [head, _divider, ...body] = rows;
  return `<div class="table-wrap"><table><thead><tr>${head
    .map((cell) => `<th>${cell}</th>`)
    .join("")}</tr></thead><tbody>${body
    .map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join("")}</tr>`)
    .join("")}</tbody></table></div>`;
}

function renderMarkdown(markdown) {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const html = [];
  let paragraph = [];
  let list = [];
  let listType = "ul";
  let code = [];
  let inCode = false;
  let table = [];

  function flushParagraph() {
    if (paragraph.length === 0) return;
    html.push(`<p>${inlineMarkdown(paragraph.join(" "))}</p>`);
    paragraph = [];
  }

  function flushList() {
    if (list.length === 0) return;
    html.push(`<${listType}>${list.map((item) => `<li>${inlineMarkdown(item)}</li>`).join("")}</${listType}>`);
    list = [];
  }

  function flushTable() {
    if (table.length === 0) return;
    const rendered = tableHtml(table);
    if (rendered) html.push(rendered);
    table = [];
  }

  for (const line of lines) {
    if (line.startsWith("```")) {
      if (inCode) {
        html.push(`<pre><code>${escapeHtml(code.join("\n"))}</code></pre>`);
        code = [];
        inCode = false;
      } else {
        flushParagraph();
        flushList();
        flushTable();
        inCode = true;
      }
      continue;
    }
    if (inCode) {
      code.push(line);
      continue;
    }
    if (line.trim().startsWith("|")) {
      flushParagraph();
      flushList();
      table.push(line);
      continue;
    }
    flushTable();
    const heading = /^(#{1,4})\s+(.+)$/.exec(line);
    if (heading) {
      flushParagraph();
      flushList();
      const level = heading[1].length;
      const text = heading[2].replace(/\s+#$/, "");
      const id = slugify(text);
      html.push(`<h${level} id="${id}">${inlineMarkdown(text)}</h${level}>`);
      continue;
    }
    const bullet = /^\s*[-*]\s+(.+)$/.exec(line);
    const ordered = bullet ? null : /^\s*\d+\.\s+(.+)$/.exec(line);
    if (bullet || ordered) {
      flushParagraph();
      const type = bullet ? "ul" : "ol";
      // Switching between bullet and numbered runs starts a new list.
      if (list.length && listType !== type) flushList();
      listType = type;
      list.push((bullet ?? ordered)[1]);
      continue;
    }
    if (line.trim() === "") {
      flushParagraph();
      flushList();
      continue;
    }
    if (list.length > 0) {
      list[list.length - 1] += ` ${line.trim()}`;
      continue;
    }
    paragraph.push(line.trim());
  }
  flushTable();
  flushParagraph();
  flushList();
  return html.join("\n");
}

function pagesByCategory() {
  const groups = new Map();
  for (const page of pages) {
    const cat = page.category ?? "Other";
    if (!groups.has(cat)) groups.set(cat, []);
    groups.get(cat).push(page);
  }
  const ordered = [];
  for (const cat of CATEGORY_ORDER) {
    if (groups.has(cat)) ordered.push([cat, groups.get(cat)]);
  }
  for (const [cat, list] of groups) {
    if (!CATEGORY_ORDER.includes(cat)) ordered.push([cat, list]);
  }
  return ordered;
}

function layout({ title, description, body, activeSlug }) {
  const nav = pagesByCategory()
    .map(
      ([category, list]) =>
        `<div class="nav-group"><div class="nav-cat">${escapeHtml(category)}</div>${list
          .map(
            (page) =>
              `<a class="${page.slug === activeSlug ? "active" : ""}" href="/docs/${page.slug}/">${escapeHtml(page.title)}</a>`,
          )
          .join("")}</div>` +
        (category === "SDKs & API"
          ? `<a class="nav-external" href="/api-docs" target="_blank" rel="noopener noreferrer">API explorer${EXTERNAL_ICON}</a>`
          : ""),
    )
    .join("");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)} - Hands Docs</title>
  <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
  <style>
    :root { color-scheme: light; --ink:#020617; --muted:#475569; --line:#e2e8f0; --bg:#f8fafc; --panel:#fff; --accent:#0f172a; }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif; color: var(--ink); background: var(--bg); }
    a { color: #0369a1; text-decoration: none; }
    a:hover { text-decoration: underline; }
    header { background: var(--panel); border-bottom: 1px solid var(--line); }
    .top { max-width: 1180px; margin: 0 auto; padding: 14px 20px; display: flex; align-items: center; justify-content: space-between; gap: 16px; }
    .brand { display: inline-flex; align-items: center; gap: 10px; font-weight: 500; font-size: 20px; color: var(--ink); }
    .brand img { width: 36px; height: 36px; border-radius: 8px; }
    .top nav { display: flex; align-items: center; gap: 8px; font-size: 14px; }
    .top nav a { color: var(--muted); padding: 9px 11px; border-radius: 6px; }
    .top nav a.primary { color: #fff; background: var(--accent); }
    .shell { max-width: 1180px; margin: 0 auto; padding: 28px 20px 56px; display: grid; grid-template-columns: 260px minmax(0, 1fr); gap: 28px; align-items: start; }
    aside { position: sticky; top: 18px; background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 10px; }
    aside a { display: block; padding: 9px 10px; border-radius: 6px; color: var(--muted); font-size: 14px; }
    aside a.active { background: #f1f5f9; color: var(--ink); font-weight: 700; }
    .nav-group + .nav-group { margin-top: 12px; }
    .nav-cat { padding: 6px 10px 4px; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; color: #94a3b8; }
    .nav-external { display: flex; align-items: center; justify-content: space-between; gap: 6px; }
    .ext-icon { width: 13px; height: 13px; flex: none; opacity: .6; }
    main { min-width: 0; background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 28px; }
    .eyebrow { color: var(--muted); font-size: 13px; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; }
    h1 { margin: 8px 0 10px; font-size: 38px; line-height: 1.12; letter-spacing: 0; }
    h2 { margin: 34px 0 12px; padding-top: 12px; border-top: 1px solid #f1f5f9; font-size: 24px; letter-spacing: 0; }
    h3 { margin: 26px 0 10px; font-size: 18px; letter-spacing: 0; }
    h4 { margin: 22px 0 8px; font-size: 15px; letter-spacing: 0; }
    p, li { color: var(--muted); line-height: 1.72; font-size: 15px; }
    p.lede { color: var(--muted); font-size: 17px; max-width: 780px; }
    ul { padding-left: 22px; }
    code { background: #f1f5f9; color: #0f172a; border: 1px solid #e2e8f0; padding: 1px 4px; border-radius: 4px; font-size: .92em; }
    pre { overflow-x: auto; background: #020617; color: #dbeafe; padding: 16px; border-radius: 8px; }
    pre code { background: transparent; border: 0; color: inherit; padding: 0; }
    .table-wrap { overflow-x: auto; margin: 14px 0; border: 1px solid var(--line); border-radius: 8px; }
    table { width: 100%; border-collapse: collapse; font-size: 14px; }
    th, td { padding: 10px 12px; border-bottom: 1px solid var(--line); vertical-align: top; text-align: left; }
    th { background: #f8fafc; color: #334155; font-weight: 700; }
    td { color: var(--muted); }
    .cards { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; margin-top: 24px; }
    .card { display: block; border: 1px solid var(--line); border-radius: 8px; padding: 16px; background: var(--panel); color: var(--ink); }
    .card strong { display: block; margin-bottom: 6px; }
    .card span { color: var(--muted); font-size: 14px; line-height: 1.55; }
    .cat-heading { margin: 28px 0 4px; padding-top: 0; border-top: 0; font-size: 15px; text-transform: uppercase; letter-spacing: .06em; color: #64748b; }
    .cat-heading:first-child { margin-top: 8px; }
    @media (max-width: 820px) {
      .top { align-items: flex-start; flex-direction: column; }
      .shell { grid-template-columns: 1fr; padding: 18px 16px 42px; }
      aside { position: static; }
      main { padding: 20px; }
      h1 { font-size: 31px; }
      .cards { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <header>
    <div class="top">
      <a class="brand" href="/"><img src="/favicon.svg" alt="" /> Hands</a>
      <nav>
        <a href="/docs/">Docs</a>
        <a href="/api-docs">API explorer</a>
        <a class="primary" href="/api/auth/login?return=%2F">Login</a>
      </nav>
    </div>
  </header>
  <div class="shell">
    <aside>${nav}</aside>
    <main>
      <div class="eyebrow">Hands Docs</div>
      <h1>${escapeHtml(title)}</h1>
      <p class="lede">${escapeHtml(description)}</p>
      ${body}
    </main>
  </div>
</body>
</html>`;
}

function indexPage() {
  const body = pagesByCategory()
    .map(
      ([category, list]) =>
        `<h2 class="cat-heading">${escapeHtml(category)}</h2><div class="cards">${list
          .map(
            (page) =>
              `<a class="card" href="/docs/${page.slug}/"><strong>${escapeHtml(page.title)}</strong><span>${escapeHtml(page.description)}</span></a>`,
          )
          .join("")}</div>`,
    )
    .join("");
  return layout({
    title: "Documentation",
    description: "Product, admin, CLI, and API documentation for Quiver.",
    body,
    activeSlug: "",
  });
}

// Agent-facing machine index (mirrors exe.dev's /docs.md): every page listed
// with its description and a link to its raw-markdown twin. Generated from the
// same pages[] as the HTML, so it never drifts.
function markdownIndex() {
  const lines = [
    "# Quiver Documentation",
    "",
    "Machine-readable index. Every page below has a raw-markdown twin at",
    "`/docs/<slug>.md` (this index is `/docs.md`). Fetch those for clean,",
    "chrome-free content — no HTML or JavaScript.",
    "",
  ];
  for (const [category, list] of pagesByCategory()) {
    lines.push(`## ${category}`, "");
    for (const page of list) {
      lines.push(`- [${page.title}](/docs/${page.slug}.md) — ${page.description}`);
    }
    lines.push("");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

await rm(outRoot, { recursive: true, force: true });
await mkdir(outRoot, { recursive: true });
await writeFile(path.join(outRoot, "index.html"), indexPage());

for (const page of pages) {
  const markdown = await readFile(path.join(docsRoot, page.source), "utf8");
  const pageDir = path.join(outRoot, page.slug);
  await mkdir(pageDir, { recursive: true });
  await writeFile(
    path.join(pageDir, "index.html"),
    layout({
      title: page.title,
      description: page.description,
      body: renderMarkdown(markdown.replace(/^#\s+.+\n/, "")),
      activeSlug: page.slug,
    }),
  );
  // Raw-markdown twin at /docs/<slug>.md — the exact source, always in sync.
  await writeFile(path.join(outRoot, `${page.slug}.md`), markdown);
}

// /docs.md machine index lives one level up (admin/public/docs.md) so its URL
// is /docs.md, alongside the /docs/ HTML tree.
await writeFile(path.join(outRoot, "..", "docs.md"), markdownIndex());

console.log(
  `Built ${pages.length + 1} docs pages + ${pages.length} markdown twins + docs.md index in ${path.relative(repoRoot, outRoot)}`,
);
