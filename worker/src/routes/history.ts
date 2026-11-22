/**
 * Public per-app version history page (task #68). Opt-in via
 * apps.public_history; lists published (active/superseded) releases with
 * localized changelogs and per-version signed downloads.
 */
import type { Context } from "hono";
import { requestOrigin } from "../lib/origin";
import { parseReleaseNotes } from "../lib/release_notes";
import { generateSignedR2Url, resolveChangelog, changelogToHtml } from "./public_v2";
import { publicPageLanguage, publicLanguageMenu } from "../lib/public_locale";
import { RAFT_PAGE_BASE_CSS, RAFT_PAGE_FONTS } from "../lib/raft_page_style";
import { resolvePublicChannelSlug } from "../lib/public_channel";
import { INSTALLABLE_ORDER_BY } from "../lib/installable_precedence";
import { recordPublicAssetDownload } from "../lib/download_stats";

// UI chrome and release notes follow the selected page language; chrome has
// English, Chinese and Japanese, anything else falls back to English.
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
  packageLabel: string;
  artifactLabel: string;
  platformLabel: string;
  checksumLabel: string;
};

const HISTORY_I18N: { en: HistoryStrings; zh: HistoryStrings; ja: HistoryStrings } = {
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
    packageLabel: "Package",
    artifactLabel: "Artifact",
    platformLabel: "Platform",
    checksumLabel: "Checksum",
  },
  zh: {
    htmlLang: "zh-CN",
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
    packageLabel: "包名",
    artifactLabel: "安装包",
    platformLabel: "平台",
    checksumLabel: "校验和",
  },
  ja: {
    htmlLang: "ja",
    versionsSuffix: "バージョン",
    versionHistory: "バージョン履歴",
    build: "ビルド",
    latest: "最新",
    download: "ダウンロード",
    noVersions: "公開済みのバージョンはまだありません。",
    releaseNotesSuffix: "リリースノート",
    whatsNewIn: (name) => `${name} の新機能`,
    releaseNotes: "リリースノート",
    draft: "下書き",
    current: "現在",
    latestBadge: "最新",
    noNotesForVersion: "このバージョンのリリースノートはありません。",
    noNotesYet: "リリースノートはまだありません。",
    packageLabel: "パッケージ",
    artifactLabel: "成果物",
    platformLabel: "プラットフォーム",
    checksumLabel: "チェックサム",
  },
};

function historyStrings(c: Context<{ Bindings: Env }>): HistoryStrings {
  const lang = (publicPageLanguage(c) ?? "").toLowerCase();
  if (lang.startsWith("zh")) return HISTORY_I18N.zh;
  if (lang.startsWith("ja")) return HISTORY_I18N.ja;
  return HISTORY_I18N.en;
}

const NOTES_LANGUAGE_ORDER = ["en", "zh-CN", "zh-TW", "ja", "ko"];

/** Languages the shown changelogs are written in, for the page's language switch. */
export function releaseNotesLanguages(changelogs: Array<string | null>): string[] {
  const found = new Set<string>();
  for (const raw of changelogs) {
    for (const key of Object.keys(parseReleaseNotes(raw) ?? {})) found.add(key);
  }
  const rank = (key: string) => {
    const index = NOTES_LANGUAGE_ORDER.indexOf(key);
    return index < 0 ? NOTES_LANGUAGE_ORDER.length : index;
  };
  const languages = [...found].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  // Plain-text changelogs carry no language; keep the two console languages.
  return languages.length > 0 ? languages : ["en", "zh-CN"];
}

function publicPageNotFound(c: Context<{ Bindings: Env }>, english: string, chinese: string): Response {
  const lang = (publicPageLanguage(c) ?? "").toLowerCase();
  return new Response(lang.startsWith("zh") ? chinese : english, {
    status: 404,
    headers: { "cache-control": "private, no-store", "vary": "*" },
  });
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

type LatestLandingRow = HistoryRow & {
  /** Present on LATEST_LANDING_SQL rows (the public download path). */
  asset_id?: string;
  build_id?: string;
  package_id: string | null;
  platform: string;
  arch: string | null;
  variant: string | null;
  filetype: string;
  r2_key: string;
  file_hash: string;
};

async function loadHistoryApp(db: D1Database, slug: string) {
  return db
    .prepare(
      "SELECT id, slug, name, platform, icon_r2_key, public_history, history_channels, history_show_downloads FROM apps WHERE slug = ?1 AND archived = 0",
    )
    .bind(slug)
    .first<{
      id: string;
      slug: string;
      name: string;
      platform: string;
      icon_r2_key: string | null;
      public_history: number;
      history_channels: string | null;
      history_show_downloads: number;
    }>();
}

// `history_channels` is a JSON array of channel slugs the public pages may
// list; NULL/empty/invalid means "all channels" (the pre-migration behaviour).
// The app writes this column through PATCH /api/apps/:id, which validates
// slugs against the app's real channels — here we only decode defensively.
function historyChannelJson(app: { history_channels: string | null }): string | null {
  if (!app.history_channels) return null;
  try {
    const parsed = JSON.parse(app.history_channels);
    if (!Array.isArray(parsed) || parsed.length === 0) return null;
    return app.history_channels;
  } catch {
    return null;
  }
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
  WHERE r.app_id = ?1 AND r.hidden = 0 AND r.status IN ('active', 'superseded')
    AND b.product_type != 'ios-simulator-qa' AND b.release_type != 'qa'
    AND (?2 IS NULL OR ch.slug IN (SELECT value FROM json_each(?2)))
  ORDER BY b.version_code DESC, released_at DESC
  LIMIT ?3 OFFSET ?4`;

const LATEST_LANDING_SQL = `
  SELECT r.id AS release_id, r.status AS release_status,
         COALESCE(b.completed_at, r.created_at) AS released_at,
         ch.slug AS channel_slug,
         b.version_name, b.version_code,
         COALESCE(r.changelog, b.changelog) AS changelog,
         COALESCE(
           json_extract(b.parsed_metadata_json, '$.package_id'),
           json_extract(b.parsed_metadata_json, '$.package_name'),
           json_extract(b.build_metadata_json, '$.package_id'),
           json_extract(b.build_metadata_json, '$.package_name'),
           json_extract(b.build_metadata_json, '$.android.package_id')
         ) AS package_id,
         b.id AS build_id,
         ba.id AS asset_id,
         ba.platform, ba.arch, ba.variant, ba.filetype,
         ba.size_bytes, ba.r2_key, ba.file_hash
  FROM releases r
  JOIN builds b ON b.id = r.build_id
  JOIN channels ch ON ch.id = r.channel_id
  JOIN build_assets ba ON ba.build_id = b.id AND ba.artifact_kind = 'installable'
  WHERE r.app_id = ?1 AND r.hidden = 0 AND r.status = 'active'
    AND b.product_type != 'ios-simulator-qa' AND b.release_type != 'qa'
    AND (?2 IS NULL OR ch.slug = ?2)
    AND (?3 IS NULL OR ch.slug IN (SELECT value FROM json_each(?3)))
  ORDER BY CASE WHEN ?2 IS NULL AND ch.slug = 'main' THEN 0 ELSE 1 END,
           b.version_code DESC, released_at DESC,
           ${INSTALLABLE_ORDER_BY}
  LIMIT 1`;

async function loadLatestLanding(
  db: D1Database,
  appId: string,
  channel: string | null,
  channelList: string | null,
): Promise<LatestLandingRow | null> {
  return db.prepare(LATEST_LANDING_SQL).bind(appId, channel, channelList).first<LatestLandingRow>();
}

/** Stable public landing page for the current active release. Unlike a share
 * token, this URL is app-level and intentionally rolls forward on publish. */
export async function handlePublicLatestReleaseLanding(c: Context<{ Bindings: Env }>) {
  const slug = c.req.param("slug");
  if (!slug) return c.json({ error: "slug required" }, 400);
  const app = await loadHistoryApp(c.env.DB, slug);
  if (!app || !app.public_history) return publicPageNotFound(c, "Not found", "未找到");
  const requested = c.req.query("channel")?.trim() || null;
  const channel = requested
    ? await resolvePublicChannelSlug(c.env.DB, app.id, requested)
    : null;
  const row = await loadLatestLanding(c.env.DB, app.id, channel, historyChannelJson(app));
  if (!row) return publicPageNotFound(c, "No active release", "没有可用的发布版本");
  const lang = publicPageLanguage(c);
  const t = historyStrings(c);
  return new Response(
    renderLatestLandingPage(app, row, lang, t, {
      showDownloads: app.history_show_downloads !== 0,
      languageMenu: publicLanguageMenu(c, t.htmlLang),
    }),
    {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "private, no-store",
        "vary": "*",
      },
    },
  );
}

// Same row shape as LATEST_LANDING_SQL, pinned to one published version by
// its version_name. superseded releases still resolve (an announcement link
// must not rot when the next version ships); drafts, cancelled, hidden and QA
// builds never do. When several channels shipped the same version_name, main
// wins, then the highest build number.
const VERSION_LANDING_SQL = `
  SELECT r.id AS release_id, r.status AS release_status,
         COALESCE(b.completed_at, r.created_at) AS released_at,
         ch.slug AS channel_slug,
         b.version_name, b.version_code,
         COALESCE(r.changelog, b.changelog) AS changelog,
         COALESCE(
           json_extract(b.parsed_metadata_json, '$.package_id'),
           json_extract(b.parsed_metadata_json, '$.package_name'),
           json_extract(b.build_metadata_json, '$.package_id'),
           json_extract(b.build_metadata_json, '$.package_name'),
           json_extract(b.build_metadata_json, '$.android.package_id')
         ) AS package_id,
         ba.platform, ba.arch, ba.variant, ba.filetype,
         ba.size_bytes, ba.r2_key, ba.file_hash
  FROM releases r
  JOIN builds b ON b.id = r.build_id
  JOIN channels ch ON ch.id = r.channel_id
  JOIN build_assets ba ON ba.build_id = b.id AND ba.artifact_kind = 'installable'
  WHERE r.app_id = ?1 AND r.hidden = 0 AND r.status IN ('active', 'superseded')
    AND b.product_type != 'ios-simulator-qa' AND b.release_type != 'qa'
    AND b.version_name = ?2
    AND (?3 IS NULL OR ch.slug = ?3)
    AND (?4 IS NULL OR ch.slug IN (SELECT value FROM json_each(?4)))
  ORDER BY CASE WHEN ?3 IS NULL AND ch.slug = 'main' THEN 0 ELSE 1 END,
           b.version_code DESC, released_at DESC,
           ${INSTALLABLE_ORDER_BY}
  LIMIT 1`;

/** Version-pinned public landing page: `/apps/<slug>/v/<version_name>`.
 * Unlike `/latest` it never rolls forward, so release announcements can link
 * the exact version (notes + download) without minting a share token. Same
 * `public_history` gate as the rest of the public history surface. */
export async function handlePublicVersionLanding(c: Context<{ Bindings: Env }>) {
  const slug = c.req.param("slug");
  const version = c.req.param("version");
  if (!slug || !version) return publicPageNotFound(c, "Not found", "未找到");
  const app = await loadHistoryApp(c.env.DB, slug);
  if (!app || !app.public_history) return publicPageNotFound(c, "Not found", "未找到");
  const requested = c.req.query("channel")?.trim() || null;
  const channel = requested
    ? await resolvePublicChannelSlug(c.env.DB, app.id, requested)
    : null;
  const row = await c.env.DB.prepare(VERSION_LANDING_SQL)
    .bind(app.id, version, channel, historyChannelJson(app))
    .first<LatestLandingRow>();
  if (!row) return publicPageNotFound(c, "Version not found", "未找到此版本");
  const lang = publicPageLanguage(c);
  const t = historyStrings(c);
  return new Response(
    renderLatestLandingPage(app, row, lang, t, {
      pinned: true,
      showDownloads: app.history_show_downloads !== 0,
      languageMenu: publicLanguageMenu(c, t.htmlLang),
    }),
    {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "private, no-store",
        "vary": "*",
      },
    },
  );
}

export async function handlePublicLatestReleaseDownload(c: Context<{ Bindings: Env }>) {
  const slug = c.req.param("slug");
  if (!slug) return c.json({ error: "slug required" }, 400);
  const app = await loadHistoryApp(c.env.DB, slug);
  if (!app || !app.public_history) return new Response("Not found", { status: 404 });
  if (!app.history_show_downloads) {
    return new Response("Not found", { status: 404 });
  }
  const requested = c.req.query("channel")?.trim() || null;
  const channel = requested
    ? await resolvePublicChannelSlug(c.env.DB, app.id, requested)
    : null;
  const row = await loadLatestLanding(c.env.DB, app.id, channel, historyChannelJson(app));
  if (!row) return c.json({ error: "no active release" }, 404);
  const url = await generateSignedR2Url(
    c.env,
    row.r2_key,
    Number(c.env.SIGNED_URL_TTL_SECONDS ?? "3600"),
    requestOrigin(c),
  );
  // Count the download only after a signed URL exists, so a failed mint never
  // records a download that could not have happened. recordPublicAssetDownload
  // never throws: an analytics failure must not break a working download.
  if (row.asset_id && row.build_id) {
    await recordPublicAssetDownload(c, row.asset_id, row.build_id);
  }
  return c.redirect(url, 302);
}

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
  WHERE r.app_id = ?1 AND r.hidden = 0 AND (
    r.status IN ('active', 'superseded')
    OR (r.status = 'draft' AND b.version_code = ?2)
  )
    AND b.product_type != 'ios-simulator-qa' AND b.release_type != 'qa'
    AND (?3 IS NULL OR ch.slug IN (SELECT value FROM json_each(?3)))
  ORDER BY b.version_code DESC, released_at DESC
  LIMIT 50`;

const HISTORY_PAGE_SIZE = 30;

export async function handlePublicAppHistory(c: Context<{ Bindings: Env }>) {
  const slug = c.req.param("slug");
  if (!slug) return c.json({ error: "slug required" }, 400);
  const app = await loadHistoryApp(c.env.DB, slug);
  if (!app || !app.public_history) {
    return publicPageNotFound(c, "Not found", "未找到");
  }
  // offset-based paging; `fragment=1` returns the bare <li> rows so the page
  // can lazy-append without re-rendering the shell.
  const rawOffset = typeof c.req.query === "function" ? c.req.query("offset") : null;
  const offset = Math.max(0, Number.parseInt(rawOffset ?? "0", 10) || 0);
  const { results } = await c.env.DB.prepare(HISTORY_SQL)
    .bind(app.id, historyChannelJson(app), HISTORY_PAGE_SIZE + 1, offset)
    .all<HistoryRow>();
  const rows = results ?? [];
  const hasMore = rows.length > HISTORY_PAGE_SIZE;
  const page = hasMore ? rows.slice(0, HISTORY_PAGE_SIZE) : rows;
  const lang = publicPageLanguage(c);
  const t = historyStrings(c);
  if (typeof c.req.query === "function" && c.req.query("fragment") === "1") {
    return new Response(
      renderHistoryItems(app, page, lang, t, { showDownloads: app.history_show_downloads !== 0 }),
      { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "private, no-store", "vary": "*" } },
    );
  }
  return new Response(
    renderHistoryPage(app, page, lang, t, {
      showDownloads: app.history_show_downloads !== 0,
      hasMore,
      nextOffset: offset + page.length,
      languageMenu: publicLanguageMenu(c, t.htmlLang),
    }),
    {
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "private, no-store", "vary": "*" },
    },
  );
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
    return publicPageNotFound(c, "Not found", "未找到");
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
    .bind(app.id, requestedCode ?? -1, historyChannelJson(app))
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

  const lang = publicPageLanguage(c);
  const t = historyStrings(c);

  return new Response(
    renderReleaseNotesPage(
      app, visible, requestedCode, lang, t,
      publicLanguageMenu(c, lang ?? t.htmlLang, undefined, releaseNotesLanguages(visible.map((row) => row.changelog))),
    ),
    { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "private, no-store", "vary": "*" } },
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
    .bind(app.id, requestedCode ?? -1, historyChannelJson(app))
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
  if (!app.history_show_downloads) {
    return new Response("Not found", { status: 404 });
  }
  const asset = await c.env.DB.prepare(
    `SELECT ba.r2_key FROM releases r
     JOIN builds b ON b.id = r.build_id
     JOIN build_assets ba ON ba.build_id = r.build_id
     WHERE r.app_id = ?1 AND r.id = ?2 AND r.hidden = 0 AND r.status IN ('active', 'superseded')
       AND b.product_type != 'ios-simulator-qa' AND b.release_type != 'qa'
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

function renderLatestLandingPage(
  app: { slug: string; name: string; platform: string; icon_r2_key: string | null },
  row: LatestLandingRow,
  lang: string | null,
  t: HistoryStrings,
  opts: { pinned?: boolean; showDownloads?: boolean; languageMenu?: string } = {},
): string {
  const notes = resolveChangelog(row.changelog, lang);
  const channelQuery = `?channel=${encodeURIComponent(row.channel_slug)}`;
  // Pinned (per-version) pages download that exact release and only show the
  // "latest" badge while it still is; /latest keeps its rolling link.
  const downloadHref = opts.pinned
    ? `/apps/${esc(app.slug)}/history/${esc(row.release_id)}/download`
    : `/apps/${esc(app.slug)}/latest/download${channelQuery}`;
  const showLatestBadge = !opts.pinned || row.release_status === "active";
  const showDownloads = opts.showDownloads !== false;
  return `<!doctype html>
<html lang="${t.htmlLang}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(app.name)} — ${esc(row.version_name)}</title>
  ${RAFT_PAGE_FONTS}
  <style>${RAFT_PAGE_BASE_CSS}
    main { max-width: 560px; margin: 0 auto; padding: 20px 16px 48px; }
    .actions { display: flex; align-items: center; gap: 16px; flex-wrap: wrap; }
    .notes { margin-top: 28px; }
  </style>
</head>
<body>
  <main>
    ${opts.languageMenu ?? ""}
    <header class="apphead">
      ${app.icon_r2_key ? `<img src="/public/apps/${esc(app.slug)}/icon" alt="" width="56" height="56">` : ""}
      <div>
        <h1>${esc(app.name)}${showLatestBadge ? ` <span class="badge latest">${t.latestBadge}</span>` : ""}</h1>
        <p class="sub">${esc(row.version_name)} · ${t.build} ${row.version_code} · ${esc(row.channel_slug)}</p>
      </div>
    </header>
    <dl class="facts">
      <dt>${t.packageLabel}</dt><dd>${esc(row.package_id || app.slug)}</dd>
      <dt>${t.artifactLabel}</dt><dd>${esc(row.filetype.toUpperCase())} · ${formatSize(row.size_bytes)}</dd>
      <dt>${t.platformLabel}</dt><dd>${esc([row.platform, row.arch, row.variant].filter(Boolean).join(" / "))}</dd>
      <dt>${t.checksumLabel}</dt><dd class="mono">${esc(row.file_hash)}</dd>
    </dl>
    <div class="actions">
      ${showDownloads ? `<a class="button download" href="${downloadHref}">${t.download}</a>` : ""}
      <a class="text-link history" href="/apps/${esc(app.slug)}/history?lang=${encodeURIComponent(t.htmlLang)}">${t.versionHistory}</a>
    </div>
    ${notes ? `<div class="notes">${changelogToHtml(notes)}</div>` : ""}
  </main>
</body>
</html>`;
}

function renderHistoryItems(
  app: { slug: string },
  rows: HistoryRow[],
  lang: string | null,
  t: HistoryStrings,
  opts: { showDownloads?: boolean } = {},
): string {
  const showDownloads = opts.showDownloads !== false;
  return rows
    .map((row) => {
      const changelog = resolveChangelog(row.changelog, lang);
      const downloadLink = showDownloads
        ? `<a class="dl" href="/apps/${esc(app.slug)}/history/${esc(row.release_id)}/download">
          ${t.download}${row.size_bytes ? ` · ${formatSize(row.size_bytes)}` : ""}
        </a>`
        : "";
      return `
    <li class="release" id="v-${esc(row.version_name)}">
      <div class="head">
        <div>
          <strong>${esc(row.version_name)}</strong>
          <span class="meta">${t.build} ${row.version_code} · ${esc(row.channel_slug)}</span>
          ${row.release_status === "active" ? `<span class="badge latest">${t.latestBadge}</span>` : ""}
        </div>
        ${downloadLink}
      </div>
      <div class="date" data-ts="${row.released_at}"></div>
      ${changelog ? `<div class="notes">${changelogToHtml(changelog)}</div>` : ""}
    </li>`;
    })
    .join("\n");
}

function renderHistoryPage(
  app: { slug: string; name: string; platform: string; icon_r2_key: string | null },
  rows: HistoryRow[],
  lang: string | null,
  t: HistoryStrings,
  opts: { showDownloads?: boolean; hasMore?: boolean; nextOffset?: number; languageMenu?: string } = {},
): string {
  const items = renderHistoryItems(app, rows, lang, t, opts);
  const hasMore = opts.hasMore === true;
  const nextOffset = opts.nextOffset ?? rows.length;

  return `<!doctype html>
<html lang="${t.htmlLang}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(app.name)} — ${t.versionsSuffix}</title>
  ${RAFT_PAGE_FONTS}
  <style>${RAFT_PAGE_BASE_CSS}
    main { max-width: 640px; margin: 0 auto; padding: 20px 16px 48px; }
    header.apphead { margin-bottom: 24px; }
    ul { list-style: none; margin: 0; padding: 0; }
    .release { padding: 16px 0; border-top: 1px solid var(--line-hairline); }
    .release:first-child { border-top: 0; padding-top: 0; }
    .head { display: flex; align-items: center; justify-content: space-between; gap: 8px 12px; flex-wrap: wrap; }
    .head > div { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .head strong { font-size: 17px; line-height: 22px; font-weight: 700; }
    .meta, .date { font-family: var(--mono); font-size: 12px; line-height: 16px; color: var(--fg-hint); }
    .date { margin-top: 2px; }
    .dl { color: var(--fg); font-weight: 600; font-size: 14px; white-space: nowrap; text-decoration: underline; text-underline-offset: 3px; text-decoration-color: var(--line-hairline); }
    .notes { margin-top: 10px; }
  </style>
</head>
<body>
  <main>
    ${opts.languageMenu ?? ""}
    <header class="apphead">
      ${app.icon_r2_key ? `<img src="/public/apps/${esc(app.slug)}/icon" alt="" width="56" height="56">` : ""}
      <div>
        <h1>${esc(app.name)}</h1>
        <div class="sub">${esc(app.platform)} · ${t.versionHistory}</div>
      </div>
    </header>
    ${rows.length === 0 ? `<p class="sub">${t.noVersions}</p>` : `<ul id="hist-list">${items}</ul>`}
    ${hasMore ? `<div id="hist-more" data-offset="${nextOffset}" class="sub" style="text-align:center;padding:8px 0;">…</div>` : ""}
  </main>
  <script>
    function formatDates(root) {
      (root || document).querySelectorAll(".date").forEach((el) => {
        const ms = Number(el.dataset.ts);
        if (!Number.isFinite(ms)) return;
        try {
          el.textContent = new Intl.DateTimeFormat(document.documentElement.lang, { dateStyle: "medium", timeStyle: "short" }).format(new Date(ms));
        } catch { el.textContent = new Date(ms).toLocaleString(); }
      });
    }
    formatDates(document);
    // Lazy-load older versions when the sentinel scrolls into view.
    (function () {
      const more = document.getElementById("hist-more");
      if (!more) return;
      const list = document.getElementById("hist-list");
      let loading = false;
      const observer = new IntersectionObserver(async (entries) => {
        if (!entries.some((e) => e.isIntersecting) || loading) return;
        loading = true;
        try {
          const next = new URL(location.href);
          next.searchParams.set("fragment", "1");
          next.searchParams.set("offset", more.dataset.offset);
          next.searchParams.set("lang", document.documentElement.lang);
          const res = await fetch(next);
          if (!res.ok) { observer.disconnect(); more.remove(); return; }
          const html = await res.text();
          more.insertAdjacentHTML("beforebegin", html);
          formatDates(list);
          const parsed = Number(more.dataset.offset) + (html.match(/class="release"/g) || []).length;
          // A short page means we've hit the end.
          if ((html.match(/class="release"/g) || []).length === 0) { observer.disconnect(); more.remove(); return; }
          more.dataset.offset = String(parsed);
        } catch { observer.disconnect(); more.remove(); }
        loading = false;
      }, { rootMargin: "400px" });
      observer.observe(more);
    })();
    // Deep-link: if a #v-<version> fragment targets a row not in the first
    // page, the row is absent — fall back to letting the browser no-op.
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
  languageMenu: string,
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
  ${RAFT_PAGE_FONTS}
  <style>${RAFT_PAGE_BASE_CSS}
    main { max-width: 640px; margin: 0 auto; padding: 20px 16px 48px; }
    header { margin-bottom: 20px; }
    ul { list-style: none; margin: 0; padding: 0; }
    .entry { position: relative; padding: 0 0 20px 22px; }
    .entry::before { content: ""; position: absolute; left: 4px; top: 14px; bottom: 0; width: 1px; background: var(--line-hairline); }
    .entry:last-child::before { display: none; }
    .rail .dot { position: absolute; left: 0; top: 7px; width: 9px; height: 9px; border-radius: 50%; box-sizing: border-box; border: 1px solid var(--line-strong); background: var(--canvas); }
    .featured .rail .dot { background: var(--success); }
    .card { min-width: 0; }
    .head { display: flex; align-items: center; justify-content: space-between; gap: 4px 12px; flex-wrap: wrap; }
    .title { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .title strong { font-size: 17px; line-height: 22px; font-weight: 700; }
    .meta, .date { font-family: var(--mono); font-size: 12px; line-height: 16px; color: var(--fg-hint); white-space: nowrap; }
    .notes { margin: 10px 0 0; }
    .empty { color: var(--fg-muted); font-size: 15px; }
  </style>
</head>
<body>
  <main>
    ${languageMenu}
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
        el.textContent = new Intl.DateTimeFormat(document.documentElement.lang, { dateStyle: "medium" }).format(new Date(ms));
      } catch { el.textContent = new Date(ms).toLocaleDateString(); }
    });
  </script>
</body>
</html>`;
}
