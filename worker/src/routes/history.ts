/**
 * Public per-app version history page (task #68). Opt-in via
 * apps.public_history; lists published (active/superseded) releases with
 * localized changelogs and per-version signed downloads.
 */
import type { Context } from "hono";
import { requestOrigin } from "../lib/origin";
import { generateSignedR2Url, resolveChangelog } from "./public_v2";

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
  return new Response(renderHistoryPage(app, results, lang), {
    headers: { "content-type": "text/html; charset=utf-8" },
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
): string {
  const items = rows
    .map((row) => {
      const changelog = resolveChangelog(row.changelog, lang);
      return `
    <li class="release">
      <div class="head">
        <div>
          <strong>${esc(row.version_name)}</strong>
          <span class="meta">build ${row.version_code} · ${esc(row.channel_slug)}</span>
          ${row.release_status === "active" ? '<span class="badge">latest</span>' : ""}
        </div>
        <a class="dl" href="/apps/${esc(app.slug)}/history/${esc(row.release_id)}/download">
          Download${row.size_bytes ? ` · ${formatSize(row.size_bytes)}` : ""}
        </a>
      </div>
      <div class="date" data-ts="${row.released_at}"></div>
      ${changelog ? `<pre class="notes">${esc(changelog)}</pre>` : ""}
    </li>`;
    })
    .join("\n");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(app.name)} — Versions</title>
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
    .notes { margin: 10px 0 0; white-space: pre-wrap; font-family: inherit; font-size: 14px; color: #3b3f45; }
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
        <div class="sub">${esc(app.platform)} · version history</div>
      </div>
    </header>
    ${rows.length === 0 ? '<p class="sub">No published versions yet.</p>' : `<ul>${items}</ul>`}
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
