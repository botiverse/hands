/**
 * Public per-app version history page (task #68). Opt-in via
 * apps.public_history; lists published (active/superseded) releases with
 * localized changelogs and per-version signed downloads.
 */
import type { Context } from "hono";
import { requestOrigin } from "../lib/origin";
import { parseReleaseNotes } from "../lib/release_notes";
import { generateSignedR2Url, resolveChangelog, changelogToHtml, requestedLang } from "./public_v2";

// UI-chrome localization (task: localize surrounding chrome, not just the
// changelog). Detection reuses requestedLang() (Accept-Language / ?lang=);
// anything that isn't Chinese falls back to English.
type HistoryStrings = {
  htmlLang: string;
  versionsSuffix: string; // page <title>: "{app} — {suffix}"
  versionHistory: string; // header sub-line
  build: string; // "build {code}"
  latest: string; // history-page badge
  download: string; // download link
  noVersions: string; // empty state
  releaseNotesSuffix: string; // release-notes <title> suffix
  whatsNewIn: (name: string) => string; // release-notes h1
  releaseNotes: string; // release-notes sub-line
  draft: string; // badge
  current: string; // badge
  latestBadge: string; // badge
  noNotesForVersion: string; // per-version empty notes
  noNotesYet: string; // page empty state
};

const HISTORY_I18N: { en: HistoryStrings; zh: HistoryStrings } = {
  en: {
    htmlLang: "en",
    versionsSuffix: "Versions",
    versionHistory: "version history",
    build: "build",
    latest: "latest",
    download: "Download",
    noVersions: "No published versions yet.",
    releaseNotesSuffix: "Release Notes",
    whatsNewIn: (name) => `What's new in ${name}`,
    releaseNotes: "Release notes",
    draft: "Draft",
    current: "Current",
    latestBadge: "Latest",
    noNotesForVersion: "No release notes for this version.",
    noNotesYet: "No release notes yet.",
  },
  zh: {
    htmlLang: "zh",
    versionsSuffix: "版本",
    versionHistory: "版本历史",
    build: "构建",
    latest: "最新",
    download: "下载",
    noVersions: "暂无已发布的版本。",
    releaseNotesSuffix: "更新日志",
    whatsNewIn: (name) => `${name} 新功能`,
    releaseNotes: "更新日志",
    draft: "草稿",
    current: "当前",
    latestBadge: "最新",
    noNotesForVersion: "此版本暂无更新说明。",
    noNotesYet: "暂无更新说明。",
  },
};

function historyStrings(c: Context<{ Bindings: Env }>): HistoryStrings {
  const lang = (requestedLang(c) ?? "").toLowerCase();
  return lang.startsWith("zh") ? HISTORY_I18N.zh : HISTORY_I18N.en;
}

type HistoryRow = {
  release_id: string;
  release_status: string;
  released_at: number;
  channel_slug: string;
  version_name: string;
  version_code: number;
  changelog: string | null;
  size_bytes: number | null;
};

async function loadHistoryApp(db: D1Database, slug: string) {
  return db
    .prepare(
      "SELECT id, slug, name, platform, icon_r2_key, public_history FROM apps WHERE slug = ?1 AND archived = 0",
    )
    .bind(slug)
    .first<{
      id: string;
      slug: string;
      name: string;
      platform: string;
      icon_r2_key: string | null;
      public_history: number;
    }>();
}

const HISTORY_SQL = `
  SELECT r.id AS release_id, r.status AS release_status,
         COALESCE(b.completed_at, r.created_at) AS released_at,
         ch.slug AS channel_slug,
         b.version_name, b.version_code,
         COALESCE(r.changelog, b.changelog) AS changelog,
         (SELECT ba.size_bytes FROM build_assets ba
          WHERE ba.build_id = b.id AND ba.artifact_kind = 'installable'
          ORDER BY ba.created_at LIMIT 1) AS size_bytes
  FROM releases r
  JOIN builds b ON b.id = r.build_id
  JOIN channels ch ON ch.id = r.channel_id
  WHERE r.app_id = ?1 AND r.status IN ('active', 'superseded')
  ORDER BY b.version_code DESC, released_at DESC
  LIMIT 50`;

// Like HISTORY_SQL but also includes the single draft whose version_code
// equals ?2 — so the release-notes page can preview a not-yet-published
// version when its code is requested. Other drafts stay hidden; cancelled
// is always excluded. ?2 = -1 when no version_code is requested (matches no
// draft).
const NOTES_SQL = `
  SELECT r.id AS release_id, r.status AS release_status,
         COALESCE(b.completed_at, r.created_at) AS released_at,
         ch.slug AS channel_slug,
         b.version_name, b.version_code,
         COALESCE(r.changelog, b.changelog) AS changelog,
         (SELECT ba.size_bytes FROM build_assets ba
          WHERE ba.build_id = b.id AND ba.artifact_kind = 'installable'
          ORDER BY ba.created_at LIMIT 1) AS size_bytes
  FROM releases r
  JOIN builds b ON b.id = r.build_id
  JOIN channels ch ON ch.id = r.channel_id
  WHERE r.app_id = ?1 AND (
    r.status IN ('active', 'superseded')
    OR (r.status = 'draft' AND b.version_code = ?2)
  )
  ORDER BY b.version_code DESC, released_at DESC
  LIMIT 50`;

export async function handlePublicAppHistory(c: Context<{ Bindings: Env }>) {
  const slug = c.req.param("slug");
  if (!slug) return c.json({ error: "slug required" }, 400);
  const app = await loadHistoryApp(c.env.DB, slug);
  if (!app || !app.public_history) {
    return new Response("Not found", { status: 404 });
  }
  const { results } = await c.env.DB.prepare(HISTORY_SQL)
    .bind(app.id)
    .all<HistoryRow>();
  const lang =
    (c.req.header("accept-language") ?? "").split(",")[0]?.trim().split(";")[0] ?? null;
  return new Response(renderHistoryPage(app, results, lang, historyStrings(c)), {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

/**
 * Public raft-style release-notes page (task #90). Same data as the history
 * page (non-cancelled published releases, bilingual changelog) but
 * changelog-first and addressable by ?version_code=: the requested version is
 * featured + anchored at the top, followed by the previous non-cancelled
 * versions. Without version_code, shows the full history. ?lang= (or
 * Accept-Language) selects the changelog language. Embedded via WebView in the
 * app's Settings → About; public, no auth.
 */
export async function handlePublicReleaseNotes(c: Context<{ Bindings: Env }>) {
  const slug = c.req.param("slug");
  if (!slug) return c.json({ error: "slug required" }, 400);
  const app = await loadHistoryApp(c.env.DB, slug);
  if (!app || !app.public_history) {
    return new Response("Not found", { status: 404 });
  }
  const rawVc = c.req.query("version_code");
  const requestedCode =
    rawVc != null && rawVc !== "" && Number.isFinite(Number(rawVc))
      ? Number(rawVc)
      : null;

  // Published (active/superseded) versions, PLUS the single draft whose
  // version_code was explicitly requested — so a not-yet-published version can
  // be previewed by its code, marked "Draft". Other drafts stay hidden;
  // cancelled is always excluded.
  const { results } = await c.env.DB.prepare(NOTES_SQL)
    .bind(app.id, requestedCode ?? -1)
    .all<HistoryRow>();

  // With a version_code: show that version and everything older (previous
  // non-cancelled versions). Without it: the full history. Changelogs are
  // rendered as stored — raw text included — matching the share page; a
  // version without notes shows a neutral "no release notes" line rather
  // than being hidden (hiding made the page silently fall back to an older
  // version's notes, which read as the wrong changelog for the version).
  const visible = (results ?? []).filter(
    (r) => requestedCode == null || r.version_code <= requestedCode,
  );

  const lang =
    c.req.query("lang")?.trim() ||
    (c.req.header("accept-language") ?? "").split(",")[0]?.trim().split(";")[0] ||
    null;

  return new Response(
    renderReleaseNotesPage(app, visible, requestedCode, lang, historyStrings(c)),
    { headers: { "content-type": "text/html; charset=utf-8" } },
  );
}

export async function handlePublicReleaseNotesJson(c: Context<{ Bindings: Env }>) {
  const slug = c.req.param("slug");
  if (!slug) return c.json({ error: "slug required" }, 400);
  const app = await loadHistoryApp(c.env.DB, slug);
  if (!app || !app.public_history) {
    return c.json({ error: "not found" }, 404);
  }
  const rawVc = c.req.query("version_code");
  const requestedCode =
    rawVc != null && rawVc !== "" && Number.isFinite(Number(rawVc))
      ? Number(rawVc)
      : null;
  const { results } = await c.env.DB.prepare(NOTES_SQL)
    .bind(app.id, requestedCode ?? -1)
    .all<HistoryRow>();
  const lang =
    c.req.query("lang")?.trim() ||
    (c.req.header("accept-language") ?? "").split(",")[0]?.trim().split(";")[0] ||
    null;
  const releases = (results ?? [])
    .filter(
      (row) => requestedCode == null || row.version_code <= requestedCode,
    )
    .map((row) => ({
      release_id: row.release_id,
      status: row.release_status,
      channel: row.channel_slug,
      version: row.version_name,
      version_code: row.version_code,
      released_at: row.released_at,
      changelog: resolveChangelog(row.changelog, lang),
      release_notes: parseReleaseNotes(row.changelog),
    }));

  return c.json({
    app: { slug: app.slug, name: app.name, platform: app.platform },
    requested_version_code: requestedCode,
    lang,
    releases,
  });
}

export async function handlePublicAppHistoryDownload(
  c: Context<{ Bindings: Env }>,
) {
  const slug = c.req.param("slug");
  const releaseId = c.req.param("releaseId");
  if (!slug || !releaseId) return c.json({ error: "missing params" }, 400);
  const app = await loadHistoryApp(c.env.DB, slug);
  if (!app || !app.public_history) {
    return new Response("Not found", { status: 404 });
  }
  const asset = await c.env.DB.prepare(
    `SELECT ba.r2_key FROM releases r
     JOIN build_assets ba ON ba.build_id = r.build_id
     WHERE r.app_id = ?1 AND r.id = ?2 AND r.status IN ('active', 'superseded')
       AND ba.artifact_kind = 'installable'
     ORDER BY ba.created_at LIMIT 1`,
  )
    .bind(app.id, releaseId)
    .first<{ r2_key: string }>();
  if (!asset) return c.json({ error: "release not found" }, 404);
  const url = await generateSignedR2Url(
    c.env,
    asset.r2_key,
    Number(c.env.SIGNED_URL_TTL_SECONDS ?? "3600"),
    requestOrigin(c),
  );
  return c.redirect(url, 302);
}

function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatSize(bytes: number | null): string {
  if (!bytes) return "";
  const mb = bytes / (1024 * 1024);
  return `${mb.toFixed(1)} MB`;
}

function renderHistoryPage(
  app: { slug: string; name: string; platform: string; icon_r2_key: string | null },
  rows: HistoryRow[],
  lang: string | null,
  t: HistoryStrings,
): string {
  const items = rows
    .map((row) => {
      const changelog = resolveChangelog(row.changelog, lang);
      return `
    <li class="release">
      <div class="head">
        <div>
          <strong>${esc(row.version_name)}</strong>
          <span class="meta">${t.build} ${row.version_code} · ${esc(row.channel_slug)}</span>
          ${row.release_status === "active" ? `<span class="badge">${t.latest}</span>` : ""}
        </div>
        <a class="dl" href="/apps/${esc(app.slug)}/history/${esc(row.release_id)}/download">
          ${t.download}${row.size_bytes ? ` · ${formatSize(row.size_bytes)}` : ""}
        </a>
      </div>
      <div class="date" data-ts="${row.released_at}"></div>
      ${changelog ? `<div class="notes">${changelogToHtml(changelog)}</div>` : ""}
    </li>`;
    })
    .join("\n");

  return `<!doctype html>
<html lang="${t.htmlLang}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(app.name)} — ${t.versionsSuffix}</title>
  <style>
    :root { color-scheme: light dark; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { margin: 0; background: #f5f5f2; color: #1e1f22; }
    main { max-width: 640px; margin: 0 auto; padding: 32px 16px 48px; }
    header { display: flex; align-items: center; gap: 16px; margin-bottom: 24px; }
    header img { border-radius: 12px; }
    h1 { margin: 0; font-size: 24px; }
    .sub { color: #5b616e; font-size: 14px; }
    ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 12px; }
    .release { background: white; border: 1px solid #e4e4e0; border-radius: 8px; padding: 14px 16px; }
    .head { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
    .meta { color: #707782; font-size: 13px; margin-left: 8px; }
    .badge { background: #d8f3e8; color: #176f5d; border-radius: 4px; padding: 2px 6px; font-size: 12px; font-weight: 600; margin-left: 8px; }
    .dl { color: #176f5d; font-weight: 600; text-decoration: none; white-space: nowrap; }
    .date { color: #9aa0a9; font-size: 12px; margin-top: 4px; }
    .notes { margin: 10px 0 0; font-family: inherit; font-size: 14px; color: #3b3f45; }
    .notes ul { margin: 6px 0; padding-left: 20px; }
    .notes li { margin: 3px 0; }
    .notes p { margin: 6px 0; }
    .notes code { background: rgba(125,125,125,0.15); border-radius: 4px; padding: 1px 4px; font-size: 0.92em; }
    @media (prefers-color-scheme: dark) {
      body { background: #17191c; color: #f5f5f2; }
      .release { background: #1f2226; border-color: #33373d; }
      .sub, .meta { color: #aeb5bf; }
      .notes { color: #d2d6dc; }
    }
  </style>
</head>
<body>
  <main>
    <header>
      ${app.icon_r2_key ? `<img src="/public/apps/${esc(app.slug)}/icon" alt="" width="56" height="56">` : ""}
      <div>
        <h1>${esc(app.name)}</h1>
        <div class="sub">${esc(app.platform)} · ${t.versionHistory}</div>
      </div>
    </header>
    ${rows.length === 0 ? `<p class="sub">${t.noVersions}</p>` : `<ul>${items}</ul>`}
  </main>
  <script>
    document.querySelectorAll(".date").forEach((el) => {
      const ms = Number(el.dataset.ts);
      if (!Number.isFinite(ms)) return;
      try {
        el.textContent = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(ms));
      } catch { el.textContent = new Date(ms).toLocaleString(); }
    });
  </script>
</body>
</html>`;
}

function renderReleaseNotesPage(
  app: { slug: string; name: string; platform: string; icon_r2_key: string | null },
  rows: HistoryRow[],
  requestedCode: number | null,
  lang: string | null,
  t: HistoryStrings,
): string {
  const items = rows
    .map((row) => {
      const changelog = resolveChangelog(row.changelog, lang);
      const featured = requestedCode != null && row.version_code === requestedCode;
      const isDraft = row.release_status === "draft";
      const isLatest = row.release_status === "active";
      const badge = isDraft
        ? `<span class="badge draft">${t.draft}</span>`
        : featured
          ? `<span class="badge you">${t.current}</span>`
          : isLatest
            ? `<span class="badge latest">${t.latestBadge}</span>`
            : "";
      return `
    <li class="entry${featured ? " featured" : ""}" id="v${row.version_code}">
      <div class="rail"><span class="dot"></span></div>
      <div class="card">
        <div class="head">
          <div class="title">
            <strong>${esc(row.version_name)}</strong>
            <span class="meta">${t.build} ${row.version_code}</span>
            ${badge}
          </div>
          <span class="date" data-ts="${row.released_at}"></span>
        </div>
        ${
          changelog
            ? `<div class="notes">${changelogToHtml(changelog)}</div>`
            : `<div class="notes muted">${t.noNotesForVersion}</div>`
        }
      </div>
    </li>`;
    })
    .join("\n");

  return `<!doctype html>
<html lang="${t.htmlLang}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(app.name)} — ${t.releaseNotesSuffix}</title>
  <style>
    :root { color-scheme: light dark; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; --accent: #176f5d; }
    html { background: #f5f5f2; }
    body { margin: 0; min-height: 100vh; background: #f5f5f2; color: #1e1f22; }
    main { max-width: 640px; margin: 0 auto; padding: 28px 16px 56px; }
    header { margin-bottom: 20px; }
    h1 { margin: 0; font-size: 22px; letter-spacing: -0.01em; }
    .sub { color: #707782; font-size: 13px; margin-top: 3px; }
    ul { list-style: none; margin: 0; padding: 0; }
    .entry { position: relative; padding: 0 0 24px 26px; }
    .entry::before { content: ""; position: absolute; left: 4px; top: 10px; bottom: 0; width: 2px; background: #e0e0dc; }
    .entry:last-child::before { display: none; }
    .rail .dot { position: absolute; left: 0; top: 8px; width: 9px; height: 9px; border-radius: 50%; background: #c3c7cd; box-shadow: 0 0 0 3px #f5f5f2; }
    .featured .rail .dot { background: var(--accent); }
    .card { min-width: 0; }
    .featured .card { background: rgba(23,111,93,0.06); border-radius: 10px; padding: 12px 14px; margin: -6px -14px 0; }
    .head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
    .title strong { font-size: 16px; }
    .meta { color: #707782; font-size: 13px; margin-left: 8px; }
    .badge { border-radius: 999px; padding: 2px 8px; font-size: 11px; font-weight: 600; margin-left: 8px; vertical-align: middle; }
    .badge.latest { background: #d8f3e8; color: var(--accent); }
    .badge.you { background: var(--accent); color: #fff; }
    .badge.draft { background: #f59e0b; color: #fff; }
    .date { color: #9aa0a9; font-size: 12px; white-space: nowrap; }
    .notes { margin: 8px 0 0; font-size: 14px; line-height: 1.55; color: #3b3f45; overflow-wrap: anywhere; }
    .notes.muted { color: #9aa0a9; }
    .notes ul { margin: 6px 0; padding-left: 20px; list-style: disc; }
    .notes li { margin: 3px 0; }
    .notes p { margin: 6px 0; }
    .notes code { background: rgba(125,125,125,0.15); border-radius: 4px; padding: 1px 4px; font-size: 0.92em; }
    .empty { color: #707782; font-size: 14px; }
    @media (prefers-color-scheme: dark) {
      html { background: #17191c; }
      body { background: #17191c; color: #f5f5f2; }
      .sub, .meta, .date, .notes.muted { color: #aeb5bf; }
      .notes { color: #d2d6dc; }
      .rail .dot { box-shadow: 0 0 0 4px #17191c; }
      .entry::before { background: #33373d; }
      .featured .card { background: rgba(23,111,93,0.14); }
    }
  </style>
</head>
<body>
  <main>
    <header>
      <h1>${t.whatsNewIn(esc(app.name))}</h1>
      <div class="sub">${t.releaseNotes}</div>
    </header>
    ${rows.length === 0 ? `<p class="empty">${t.noNotesYet}</p>` : `<ul>${items}</ul>`}
  </main>
  <script>
    document.querySelectorAll(".date").forEach((el) => {
      const ms = Number(el.dataset.ts);
      if (!Number.isFinite(ms)) return;
      try {
        el.textContent = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(ms));
      } catch { el.textContent = new Date(ms).toLocaleDateString(); }
    });
  </script>
</body>
</html>`;
}
