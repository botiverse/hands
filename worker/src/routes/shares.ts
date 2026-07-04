import type { Context } from "hono";
import qrcode from "qrcode-generator";
import { requestOrigin } from "../lib/origin";
import { currentActor, type AdminEnv } from "../middleware/auth";
import { generateSignedR2Url } from "./public_v2";

type AdminContext = Context<AdminEnv & { Bindings: Env }>;

type ShareRow = {
  id: string;
  token_hash: string;
  created_at: number;
  expires_at: number;
  revoked_at: number | null;
  view_count: number;
  unique_view_count: number;
  download_count: number;
  unique_download_count: number;
};

type SharePageRow = {
  password_hash: string | null;
  share_id: string;
  expires_at: number;
  app_slug: string;
  app_name: string;
  channel_slug: string;
  release_id: string;
  release_status: string;
  changelog: string | null;
  build_id: string;
  version_name: string;
  version_code: number;
  platform: string;
  arch: string | null;
  variant: string | null;
  filetype: string;
  size_bytes: number;
  r2_key: string;
  file_hash: string;
};

type ShareStats = {
  view_count: number;
  unique_view_count: number;
  download_count: number;
  unique_download_count: number;
};

const DEFAULT_SHARE_TTL_SECONDS = 7 * 24 * 60 * 60;
const MAX_SHARE_TTL_SECONDS = 30 * 24 * 60 * 60;

export async function handleCreateReleaseShare(c: AdminContext) {
  const appId = c.req.param("appId");
  const releaseId = c.req.param("releaseId");
  const body = await c.req.json().catch(() => ({})) as {
    ttl_seconds?: number;
    expires_at?: number;
    password?: string;
  };
  const password = typeof body.password === "string" ? body.password.trim() : "";
  if (password.length > 128) {
    return c.json({ error: "password too long (max 128 chars)" }, 400);
  }

  const release = await c.env.DB.prepare(
    "SELECT id, status FROM releases WHERE app_id = ?1 AND id = ?2",
  )
    .bind(appId, releaseId)
    .first<{ id: string; status: string }>();
  if (!release) return c.json({ error: "release not found" }, 404);
  if (release.status === "cancelled") {
    return c.json({ error: "cannot share cancelled release" }, 409);
  }

  const now = Date.now();
  let expiresAt: number;
  try {
    const ttlSeconds = normalizeShareTtl(body.ttl_seconds);
    expiresAt = normalizeExpiresAt(body.expires_at, now, ttlSeconds);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
  }
  const token = randomToken();
  const tokenHash = await sha256Hex(token);
  const id = crypto.randomUUID();
  const passwordHash = password ? await sharePasswordHash(id, password) : null;

  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO release_shares
       (id, release_id, token_hash, created_by, created_at, expires_at, revoked_at, password_hash)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, ?7)`,
    ).bind(id, releaseId, tokenHash, currentActor(c), now, expiresAt, passwordHash),
    c.env.DB.prepare(
      `INSERT INTO audit_logs (id, app_id, action, actor, payload, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
    ).bind(
      crypto.randomUUID(),
      appId,
      "release_share.create",
      currentActor(c),
      JSON.stringify({ id, release_id: releaseId, expires_at: expiresAt, has_password: Boolean(passwordHash) }),
      now,
    ),
  ]);

  const shareUrl = new URL(`/share/${token}`, publicRequestOrigin(c)).toString();
  return c.json({
    id,
    release_id: releaseId,
    share_url: shareUrl,
    expires_at: expiresAt,
    revoked_at: null,
    has_password: Boolean(passwordHash),
  }, 201);
}

export async function handleListReleaseShares(c: AdminContext) {
  const appId = c.req.param("appId");
  const releaseId = c.req.param("releaseId");
  const release = await c.env.DB.prepare(
    "SELECT id FROM releases WHERE app_id = ?1 AND id = ?2",
  )
    .bind(appId, releaseId)
    .first<{ id: string }>();
  if (!release) return c.json({ error: "release not found" }, 404);

  const { results } = await c.env.DB.prepare(
    `SELECT
       rs.id,
       rs.token_hash,
       rs.created_at,
       rs.expires_at,
       rs.revoked_at,
       (rs.password_hash IS NOT NULL) AS has_password,
       COALESCE(SUM(CASE WHEN rse.event_type = 'view' THEN 1 ELSE 0 END), 0) AS view_count,
       COALESCE(COUNT(DISTINCT CASE WHEN rse.event_type = 'view' THEN rse.visitor_hash END), 0) AS unique_view_count,
       COALESCE(SUM(CASE WHEN rse.event_type = 'download' THEN 1 ELSE 0 END), 0) AS download_count,
       COALESCE(COUNT(DISTINCT CASE WHEN rse.event_type = 'download' THEN rse.visitor_hash END), 0) AS unique_download_count
     FROM release_shares rs
     LEFT JOIN release_share_events rse ON rse.share_id = rs.id
     WHERE rs.release_id = ?1
     GROUP BY rs.id
     ORDER BY rs.created_at DESC`,
  )
    .bind(releaseId)
    .all<ShareRow>();
  return c.json({ shares: results });
}

export async function handleListAppShares(c: AdminContext) {
  const appId = c.req.param("appId");
  const { results } = await c.env.DB.prepare(
    `SELECT
       rs.id,
       rs.release_id,
       rs.created_by,
       rs.created_at,
       rs.expires_at,
       rs.revoked_at,
       (rs.password_hash IS NOT NULL) AS has_password,
       r.status AS release_status,
       ch.slug AS channel_slug,
       b.version_name,
       b.version_code,
       COALESCE(SUM(CASE WHEN rse.event_type = 'view' THEN 1 ELSE 0 END), 0) AS view_count,
       COALESCE(COUNT(DISTINCT CASE WHEN rse.event_type = 'view' THEN rse.visitor_hash END), 0) AS unique_view_count,
       COALESCE(SUM(CASE WHEN rse.event_type = 'download' THEN 1 ELSE 0 END), 0) AS download_count,
       COALESCE(COUNT(DISTINCT CASE WHEN rse.event_type = 'download' THEN rse.visitor_hash END), 0) AS unique_download_count
     FROM release_shares rs
     JOIN releases r ON r.id = rs.release_id
     JOIN channels ch ON ch.id = r.channel_id
     JOIN builds b ON b.id = r.build_id
     LEFT JOIN release_share_events rse ON rse.share_id = rs.id
     WHERE r.app_id = ?1
     GROUP BY rs.id
     ORDER BY rs.created_at DESC
     LIMIT 500`,
  )
    .bind(appId)
    .all();
  return c.json({ shares: results });
}

export async function handleRevokeReleaseShare(c: AdminContext) {
  const appId = c.req.param("appId");
  const releaseId = c.req.param("releaseId");
  const shareId = c.req.param("shareId");
  const now = Date.now();

  const existing = await c.env.DB.prepare(
    `SELECT rs.id, rs.revoked_at
     FROM release_shares rs
     JOIN releases r ON r.id = rs.release_id
     WHERE r.app_id = ?1 AND r.id = ?2 AND rs.id = ?3`,
  )
    .bind(appId, releaseId, shareId)
    .first<{ id: string; revoked_at: number | null }>();
  if (!existing) return c.json({ error: "share not found" }, 404);
  if (existing.revoked_at) {
    return c.json({ ok: true, id: shareId, revoked_at: existing.revoked_at });
  }

  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE release_shares SET revoked_at = ?1 WHERE id = ?2")
      .bind(now, shareId),
    c.env.DB.prepare(
      `INSERT INTO audit_logs (id, app_id, action, actor, payload, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
    ).bind(
      crypto.randomUUID(),
      appId,
      "release_share.revoke",
      currentActor(c),
      JSON.stringify({ id: shareId, release_id: releaseId }),
      now,
    ),
  ]);

  return c.json({ ok: true, id: shareId, revoked_at: now });
}

export async function handleUpdateReleaseShare(c: AdminContext) {
  const appId = c.req.param("appId");
  const releaseId = c.req.param("releaseId");
  const shareId = c.req.param("shareId");
  const body = await c.req.json().catch(() => ({})) as {
    ttl_seconds?: number;
    expires_at?: number;
  };
  const now = Date.now();

  const existing = await c.env.DB.prepare(
    `SELECT rs.id, rs.expires_at, rs.revoked_at
     FROM release_shares rs
     JOIN releases r ON r.id = rs.release_id
     WHERE r.app_id = ?1 AND r.id = ?2 AND rs.id = ?3`,
  )
    .bind(appId, releaseId, shareId)
    .first<{ id: string; expires_at: number; revoked_at: number | null }>();
  if (!existing) return c.json({ error: "share not found" }, 404);
  if (existing.revoked_at) {
    return c.json({ error: "cannot update revoked share" }, 409);
  }

  let expiresAt: number;
  try {
    const ttlSeconds = normalizeShareTtl(body.ttl_seconds);
    expiresAt = normalizeExpiresAt(body.expires_at, now, ttlSeconds);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
  }

  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE release_shares SET expires_at = ?1 WHERE id = ?2")
      .bind(expiresAt, shareId),
    c.env.DB.prepare(
      `INSERT INTO audit_logs (id, app_id, action, actor, payload, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
    ).bind(
      crypto.randomUUID(),
      appId,
      "release_share.update",
      currentActor(c),
      JSON.stringify({
        id: shareId,
        release_id: releaseId,
        previous_expires_at: existing.expires_at,
        expires_at: expiresAt,
      }),
      now,
    ),
  ]);

  return c.json({
    id: shareId,
    release_id: releaseId,
    expires_at: expiresAt,
    revoked_at: null,
  });
}

export async function handlePublicReleaseShare(c: Context<{ Bindings: Env }>) {
  const token = c.req.param("token");
  if (!token) return htmlResponse(renderErrorPage("Missing share token"), 400);

  const row = await findActiveShare(c.env.DB, token);

  if (!row) {
    return htmlResponse(renderErrorPage("This share link is expired, revoked, or unavailable."), 404);
  }

  if (row.password_hash && !(await hasValidUnlockCookie(c, row))) {
    await recordShareEvent(c, row.share_id, "view");
    return htmlResponse(renderPasswordPage(token, false));
  }

  await recordShareEvent(c, row.share_id, "view");
  const stats = await loadShareStats(c.env.DB, row.share_id);
  const origin = publicRequestOrigin(c);
  const downloadUrl = new URL(`/share/${token}/download`, origin).toString();
  const shareUrl = new URL(`/share/${token}`, origin).toString();
  return htmlResponse(renderSharePage(row, stats, downloadUrl, shareUrl));
}

export async function handlePublicReleaseShareDownload(c: Context<{ Bindings: Env }>) {
  const token = c.req.param("token");
  if (!token) return htmlResponse(renderErrorPage("Missing share token"), 400);

  const row = await findActiveShare(c.env.DB, token);
  if (!row) {
    return htmlResponse(renderErrorPage("This share link is expired, revoked, or unavailable."), 404);
  }

  if (row.password_hash && !(await hasValidUnlockCookie(c, row))) {
    return c.redirect(`/share/${token}`, 302);
  }

  await recordShareEvent(c, row.share_id, "download");
  const ttl = Number(c.env.SIGNED_URL_TTL_SECONDS ?? "3600");
  const signedUrl = await generateSignedR2Url(
    c.env,
    row.r2_key,
    ttl,
    publicRequestOrigin(c),
  );
  return c.redirect(signedUrl, 302);
}

export async function handlePublicReleaseShareUnlock(c: Context<{ Bindings: Env }>) {
  const token = c.req.param("token");
  if (!token) return htmlResponse(renderErrorPage("Missing share token"), 400);
  const row = await findActiveShare(c.env.DB, token);
  if (!row) {
    return htmlResponse(renderErrorPage("This share link is expired, revoked, or unavailable."), 404);
  }
  if (!row.password_hash) return c.redirect(`/share/${token}`, 302);

  const form = await c.req.parseBody().catch(() => ({} as Record<string, unknown>));
  const password = typeof form["password"] === "string" ? (form["password"] as string).trim() : "";
  const candidate = password ? await sharePasswordHash(row.share_id, password) : "";
  if (!password || candidate !== row.password_hash) {
    // share_events only allows view/download; failed unlocks belong in the
    // audit trail anyway.
    await c.env.DB.prepare(
      `INSERT INTO audit_logs (id, app_id, action, actor, payload, created_at)
       SELECT ?1, r.app_id, 'release_share.unlock_failed', 'public', ?2, ?3
       FROM releases r WHERE r.id = ?4`,
    )
      .bind(
        crypto.randomUUID(),
        JSON.stringify({ share_id: row.share_id }),
        Date.now(),
        row.release_id,
      )
      .run();
    return htmlResponse(renderPasswordPage(token, true), 401);
  }

  const proof = await shareUnlockProof(row, currentDayBucket());
  const headers = new Headers({
    location: `/share/${token}`,
    "set-cookie":
      `${unlockCookieName(row.share_id)}=${proof}; Path=/share/${encodeURIComponent(token)}; ` +
      "Max-Age=86400; HttpOnly; Secure; SameSite=Lax",
  });
  return new Response(null, { status: 303, headers });
}

/** Salted password hash; salt is the share id so equal passwords differ per share. */
async function sharePasswordHash(shareId: string, password: string): Promise<string> {
  return sha256Hex(`quiver-share-password:${shareId}:${password}`);
}

/**
 * Stateless unlock proof: derivable only when the stored password hash is
 * known server-side, bucketed by day so cookies age out within 48h.
 */
async function shareUnlockProof(
  row: Pick<SharePageRow, "share_id" | "password_hash">,
  dayBucket: number,
): Promise<string> {
  return sha256Hex(`quiver-share-unlock:${row.share_id}:${row.password_hash}:${dayBucket}`);
}

function currentDayBucket(): number {
  return Math.floor(Date.now() / 86_400_000);
}

function unlockCookieName(shareId: string): string {
  return `qshare_${shareId.slice(0, 8)}`;
}

async function hasValidUnlockCookie(
  c: Context<{ Bindings: Env }>,
  row: Pick<SharePageRow, "share_id" | "password_hash">,
): Promise<boolean> {
  const cookieHeader = c.req.header("cookie") ?? "";
  const name = unlockCookieName(row.share_id);
  const value = cookieHeader
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`))
    ?.slice(name.length + 1);
  if (!value) return false;
  const today = currentDayBucket();
  for (const bucket of [today, today - 1]) {
    if (value === (await shareUnlockProof(row, bucket))) return true;
  }
  return false;
}

async function findActiveShare(db: D1Database, token: string): Promise<SharePageRow | null> {
  const tokenHash = await sha256Hex(token);
  return db.prepare(
    `SELECT
       rs.id AS share_id,
       rs.expires_at AS expires_at,
       rs.password_hash AS password_hash,
       a.slug AS app_slug,
       a.name AS app_name,
       ch.slug AS channel_slug,
       r.id AS release_id,
       r.status AS release_status,
       r.changelog AS changelog,
       b.id AS build_id,
       b.version_name AS version_name,
       b.version_code AS version_code,
       ba.platform AS platform,
       ba.arch AS arch,
       ba.variant AS variant,
       ba.filetype AS filetype,
       ba.size_bytes AS size_bytes,
       ba.r2_key AS r2_key,
       ba.file_hash AS file_hash
     FROM release_shares rs
     JOIN releases r ON r.id = rs.release_id
     JOIN apps a ON a.id = r.app_id
     JOIN channels ch ON ch.id = r.channel_id
     JOIN builds b ON b.id = r.build_id
     JOIN build_assets ba ON ba.build_id = b.id
     WHERE rs.token_hash = ?1
       AND rs.revoked_at IS NULL
       AND rs.expires_at > ?2
       AND r.status = 'active'
       AND ba.artifact_kind = 'installable'
     ORDER BY ba.filetype = 'apk' DESC, ba.created_at ASC
     LIMIT 1`,
  )
    .bind(tokenHash, Date.now())
    .first<SharePageRow>();
}

async function recordShareEvent(
  c: Context<{ Bindings: Env }>,
  shareId: string,
  eventType: "view" | "download",
): Promise<void> {
  const visitorHash = await shareVisitorHash(c);
  await c.env.DB.prepare(
    `INSERT INTO release_share_events (id, share_id, event_type, visitor_hash, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5)`,
  )
    .bind(crypto.randomUUID(), shareId, eventType, visitorHash, Date.now())
    .run();
}

async function loadShareStats(db: D1Database, shareId: string): Promise<ShareStats> {
  const row = await db.prepare(
    `SELECT
       COALESCE(SUM(CASE WHEN event_type = 'view' THEN 1 ELSE 0 END), 0) AS view_count,
       COALESCE(COUNT(DISTINCT CASE WHEN event_type = 'view' THEN visitor_hash END), 0) AS unique_view_count,
       COALESCE(SUM(CASE WHEN event_type = 'download' THEN 1 ELSE 0 END), 0) AS download_count,
       COALESCE(COUNT(DISTINCT CASE WHEN event_type = 'download' THEN visitor_hash END), 0) AS unique_download_count
     FROM release_share_events
     WHERE share_id = ?1`,
  )
    .bind(shareId)
    .first<ShareStats>();
  return {
    view_count: Number(row?.view_count ?? 0),
    unique_view_count: Number(row?.unique_view_count ?? 0),
    download_count: Number(row?.download_count ?? 0),
    unique_download_count: Number(row?.unique_download_count ?? 0),
  };
}

function normalizeShareTtl(ttl: number | undefined): number {
  if (ttl === undefined || ttl === null) return DEFAULT_SHARE_TTL_SECONDS;
  if (!Number.isFinite(ttl) || ttl <= 0) {
    throw new Error("ttl_seconds must be positive");
  }
  return Math.min(Math.floor(ttl), MAX_SHARE_TTL_SECONDS);
}

function normalizeExpiresAt(
  expiresAt: number | undefined,
  now: number,
  ttlSeconds: number,
): number {
  if (expiresAt === undefined || expiresAt === null) {
    return now + ttlSeconds * 1000;
  }
  if (!Number.isFinite(expiresAt) || expiresAt <= now) {
    throw new Error("expires_at must be a future unix millisecond timestamp");
  }
  return Math.min(Math.floor(expiresAt), now + MAX_SHARE_TTL_SECONDS * 1000);
}

function randomToken(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return base64Url(bytes);
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function publicRequestOrigin(c: Context<any>): string {
  return requestOrigin(c);
}

async function shareVisitorHash(c: Context<{ Bindings: Env }>): Promise<string> {
  const ip =
    c.req.header("cf-connecting-ip") ||
    c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ||
    (c.req.raw as Request & { cf?: { clientIp?: string } }).cf?.clientIp ||
    "unknown-ip";
  const userAgent = c.req.header("user-agent") || "unknown-ua";
  const language = c.req.header("accept-language") || "";
  const salt =
    c.env.SHARE_STATS_SALT ||
    c.env.SIGNED_URL_SECRET ||
    c.env.ADMIN_API_TOKEN ||
    c.env.RAFT_CLIENT_SECRET;
  if (!salt) {
    throw new Error("SHARE_STATS_SALT, SIGNED_URL_SECRET, ADMIN_API_TOKEN, or RAFT_CLIENT_SECRET must be configured");
  }
  return sha256Hex(`${salt}\n${ip}\n${userAgent}\n${language}`);
}

function htmlResponse(html: string, status = 200): Response {
  return new Response(html, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "private, max-age=0, no-store",
    },
  });
}

function renderSharePage(
  row: SharePageRow,
  stats: ShareStats,
  downloadUrl: string,
  shareUrl: string,
): string {
  const title = `${row.app_slug} ${row.version_name} (${row.version_code})`;
  const expiresIso = new Date(row.expires_at).toISOString();
  const qrSvg = renderShareQrSvg(shareUrl);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    :root { color-scheme: light dark; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f5f5f2; color: #1e1f22; }
    main { width: min(560px, calc(100vw - 32px)); padding: 32px 0; }
    h1 { margin: 0 0 8px; font-size: 28px; line-height: 1.15; letter-spacing: 0; }
    p { margin: 0; color: #5b616e; line-height: 1.5; }
    dl { display: grid; grid-template-columns: 140px 1fr; gap: 10px 16px; margin: 28px 0; }
    dt { color: #707782; }
    dd { margin: 0; font-weight: 600; overflow-wrap: anywhere; }
    a.download { display: inline-flex; align-items: center; justify-content: center; min-height: 44px; padding: 0 18px; border-radius: 6px; background: #176f5d; color: white; text-decoration: none; font-weight: 700; }
    .get-it { display: flex; align-items: center; gap: 20px; flex-wrap: wrap; }
    .qr { display: none; }
    .qr svg { display: block; width: 128px; height: 128px; border-radius: 8px; background: white; padding: 6px; box-sizing: border-box; }
    .qr span { display: block; margin-top: 6px; color: #707782; font-size: 12px; text-align: center; }
    @media (pointer: fine) and (min-width: 480px) { .qr { display: block; } }
    .notes { margin-top: 22px; white-space: pre-wrap; color: #3b3f45; }
    .stats { display: flex; flex-wrap: wrap; gap: 8px 16px; }
    .stat strong { display: block; color: #1e1f22; font-size: 18px; }
    .stat span { display: block; color: #707782; font-size: 12px; font-weight: 500; }
    @media (prefers-color-scheme: dark) {
      body { background: #17191c; color: #f5f5f2; }
      p, dt { color: #aeb5bf; }
      .notes { color: #d2d6dc; }
      .stat strong { color: #f5f5f2; }
      .stat span { color: #aeb5bf; }
    }
  </style>
</head>
<body>
  <main>
    <h1>${escapeHtml(row.app_name || row.app_slug)}</h1>
    <p>${escapeHtml(row.version_name)} · build ${row.version_code} · ${escapeHtml(row.channel_slug)}</p>
    <dl>
      <dt>Package</dt><dd>${escapeHtml(row.app_slug)}</dd>
      <dt>Version</dt><dd>${escapeHtml(row.version_name)} (${row.version_code})</dd>
      <dt>Artifact</dt><dd>${escapeHtml(row.filetype.toUpperCase())} · ${formatBytes(row.size_bytes)}</dd>
      <dt>Platform</dt><dd>${escapeHtml([row.platform, row.arch, row.variant].filter(Boolean).join(" / "))}</dd>
      <dt>Checksum</dt><dd>${escapeHtml(row.file_hash)}</dd>
      <dt>Expires</dt><dd><time id="expires-at" datetime="${escapeAttribute(expiresIso)}" data-expires-at="${row.expires_at}">${escapeHtml(expiresIso)}</time></dd>
      <dt>Stats</dt>
      <dd class="stats">
        <span class="stat"><strong>${stats.unique_view_count}</strong><span>visitors</span></span>
        <span class="stat"><strong>${stats.view_count}</strong><span>views</span></span>
        <span class="stat"><strong>${stats.unique_download_count}</strong><span>downloaders</span></span>
        <span class="stat"><strong>${stats.download_count}</strong><span>downloads</span></span>
      </dd>
    </dl>
    <div class="get-it">
      <a class="download" href="${escapeAttribute(downloadUrl)}">Download APK</a>
      <div class="qr">${qrSvg}<span>Scan to open on your phone</span></div>
    </div>
    ${row.changelog ? `<div class="notes">${escapeHtml(row.changelog)}</div>` : ""}
  </main>
  <script>
    (() => {
      const el = document.getElementById("expires-at");
      const ms = Number(el?.dataset.expiresAt);
      if (!el || !Number.isFinite(ms)) return;
      try {
        el.textContent = new Intl.DateTimeFormat(undefined, {
          dateStyle: "medium",
          timeStyle: "short",
          timeZoneName: "short",
        }).format(new Date(ms));
      } catch {
        el.textContent = new Date(ms).toLocaleString();
      }
    })();
  </script>
</body>
</html>`;
}

function renderShareQrSvg(url: string): string {
  // type 0 = auto-size, error correction M; pure JS so it runs in Workers.
  const qr = qrcode(0, "M");
  qr.addData(url);
  qr.make();
  return qr.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
}

function renderPasswordPage(token: string, failed: boolean): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Password required</title>
  <style>
    :root { color-scheme: light dark; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f5f5f2; color: #1e1f22; }
    main { width: min(360px, calc(100vw - 32px)); }
    h1 { margin: 0 0 8px; font-size: 22px; }
    p { margin: 0 0 20px; color: #5b616e; }
    .error { color: #b3261e; font-weight: 600; }
    input { width: 100%; box-sizing: border-box; min-height: 44px; padding: 0 12px; border: 1px solid #c8ccd2; border-radius: 6px; font-size: 16px; background: white; color: inherit; }
    button { margin-top: 12px; width: 100%; min-height: 44px; border: 0; border-radius: 6px; background: #176f5d; color: white; font-weight: 700; font-size: 15px; cursor: pointer; }
    @media (prefers-color-scheme: dark) {
      body { background: #17191c; color: #f5f5f2; }
      p { color: #aeb5bf; }
      input { background: #1f2226; border-color: #3a3f45; }
    }
  </style>
</head>
<body>
  <main>
    <h1>Password required</h1>
    <p>${failed ? '<span class="error">Wrong password. Try again.</span>' : "This download is password protected."}</p>
    <form method="post" action="/share/${escapeAttribute(encodeURIComponent(token))}/unlock">
      <input type="password" name="password" placeholder="Password" autofocus autocomplete="off" required>
      <button type="submit">Unlock</button>
    </form>
  </main>
</body>
</html>`;
}

function renderErrorPage(message: string): string {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Share unavailable</title></head>
<body><main><h1>Share unavailable</h1><p>${escapeHtml(message)}</p></main></body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttribute(value: string): string {
  return escapeHtml(value);
}

function formatBytes(size: number): string {
  if (!Number.isFinite(size)) return "unknown size";
  const mib = size / (1024 * 1024);
  return `${mib.toFixed(mib >= 10 ? 0 : 1)} MiB`;
}
