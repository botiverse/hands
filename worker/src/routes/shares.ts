import type { Context } from "hono";
import qrcode from "qrcode-generator";
import { requestOrigin } from "../lib/origin";
import { currentActor, type AdminEnv } from "../middleware/auth";
import { generateSignedR2Url, resolveChangelog , changelogToHtml, requestedLang } from "./public_v2";

// UI-chrome localization for the public share/password/error pages. Detection
// reuses requestedLang() (Accept-Language / ?lang=); anything not Chinese falls
// back to English. The changelog itself is still localized separately via
// resolveChangelog().
type ShareStrings = {
  htmlLang: string;
  preRelease: string; // draft tag
  build: string; // "build {code}"
  packageLabel: string;
  versionLabel: string;
  artifactLabel: string;
  platformLabel: string;
  checksumLabel: string;
  statsLabel: string;
  visitors: string;
  views: string;
  downloadApk: string;
  scanHint: string;
  passwordRequired: string; // password page title + heading
  wrongPassword: string;
  passwordProtected: string;
  passwordPlaceholder: string;
  unlock: string;
  shareUnavailable: string; // error page title + heading
  errMissingToken: string;
  errUnavailable: string;
};

const SHARE_I18N: { en: ShareStrings; zh: ShareStrings } = {
  en: {
    htmlLang: "en",
    preRelease: "Pre-release",
    build: "build",
    packageLabel: "Package",
    versionLabel: "Version",
    artifactLabel: "Artifact",
    platformLabel: "Platform",
    checksumLabel: "Checksum",
    statsLabel: "Stats",
    visitors: "visitors",
    views: "views",
    downloadApk: "Download APK",
    scanHint: "Scan to open on your phone",
    passwordRequired: "Password required",
    wrongPassword: "Wrong password. Try again.",
    passwordProtected: "This download is password protected.",
    passwordPlaceholder: "Password",
    unlock: "Unlock",
    shareUnavailable: "Share unavailable",
    errMissingToken: "Missing share token",
    errUnavailable: "This share link is expired, revoked, or unavailable.",
  },
  zh: {
    htmlLang: "zh",
    preRelease: "预发布",
    build: "构建",
    packageLabel: "包名",
    versionLabel: "版本",
    artifactLabel: "安装包",
    platformLabel: "平台",
    checksumLabel: "校验和",
    statsLabel: "统计",
    visitors: "访客数",
    views: "浏览次数",
    downloadApk: "下载 APK",
    scanHint: "扫码在手机上打开",
    passwordRequired: "需要密码",
    wrongPassword: "密码错误，请重试。",
    passwordProtected: "此下载受密码保护。",
    passwordPlaceholder: "密码",
    unlock: "解锁",
    shareUnavailable: "分享不可用",
    errMissingToken: "缺少分享令牌",
    errUnavailable: "此分享链接已过期、被撤销或不可用。",
  },
};

function shareStrings(c: Context<{ Bindings: Env }>): ShareStrings {
  const lang = (requestedLang(c) ?? "").toLowerCase();
  return lang.startsWith("zh") ? SHARE_I18N.zh : SHARE_I18N.en;
}

type AdminContext = Context<AdminEnv & { Bindings: Env }>;

type ShareRow = {
  id: string;
  token_hash: string;
  created_at: number;
  expires_at: number | null;
  revoked_at: number | null;
  view_count: number;
  unique_view_count: number;
  download_count: number;
  unique_download_count: number;
};

type SharePageRow = {
  password_hash: string | null;
  icon_r2_key: string | null;
  package_id: string | null;
  share_id: string;
  expires_at: number | null;
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

// Shares have no default expiry: a share without an explicit ttl_seconds /
// expires_at lives until revoked (expires_at NULL). Old-version links handed
// out in chats must not silently die.

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
  let expiresAt: number | null;
  try {
    expiresAt = resolveExpiry(body.ttl_seconds, body.expires_at, now);
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
       (id, release_id, token, token_hash, created_by, created_at, expires_at, revoked_at, password_hash)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, NULL, ?8)`,
    ).bind(id, releaseId, token, tokenHash, currentActor(c), now, expiresAt, passwordHash),
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
       rs.token,
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
    .all<ShareRow & { token: string | null }>();
  return c.json({ shares: (results ?? []).map((row) => withShareUrl(c, row)) });
}

/** Replace the stored token with a copyable share_url. Legacy rows (created
 *  before tokens were stored) have no token, so their URL is unrecoverable. */
function withShareUrl<T extends { token?: string | null }>(
  c: AdminContext,
  row: T,
): Omit<T, "token"> & { share_url: string | null } {
  const { token, ...rest } = row;
  return {
    ...rest,
    share_url: token ? new URL(`/share/${token}`, publicRequestOrigin(c)).toString() : null,
  };
}

export async function handleListAppShares(c: AdminContext) {
  const appId = c.req.param("appId");
  const { results } = await c.env.DB.prepare(
    `SELECT
       rs.id,
       rs.release_id,
       rs.token,
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
    .all<{ token: string | null }>();
  return c.json({ shares: (results ?? []).map((row) => withShareUrl(c, row)) });
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
    ttl_seconds?: number | null;
    expires_at?: number | null;
    password?: string | null;
  };
  const now = Date.now();

  const existing = await c.env.DB.prepare(
    `SELECT rs.id, rs.expires_at, rs.revoked_at
     FROM release_shares rs
     JOIN releases r ON r.id = rs.release_id
     WHERE r.app_id = ?1 AND r.id = ?2 AND rs.id = ?3`,
  )
    .bind(appId, releaseId, shareId)
    .first<{ id: string; expires_at: number | null; revoked_at: number | null }>();
  if (!existing) return c.json({ error: "share not found" }, 404);
  if (existing.revoked_at) {
    return c.json({ error: "cannot update revoked share" }, 409);
  }

  // Expiry semantics mirror the password field: both keys absent = leave
  // unchanged; explicit null (either key) = clear, the share never expires;
  // a value = set.
  let expiresAt: number | null;
  try {
    expiresAt =
      body.ttl_seconds === undefined && body.expires_at === undefined
        ? existing.expires_at
        : resolveExpiry(body.ttl_seconds, body.expires_at, now);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
  }

  // password: undefined = leave unchanged, null/"" = clear, string = set.
  let passwordChange: "unchanged" | "cleared" | "set" = "unchanged";
  let passwordHash: string | null = null;
  if (body.password !== undefined) {
    const trimmed = typeof body.password === "string" ? body.password.trim() : "";
    if (trimmed.length > 128) {
      return c.json({ error: "password too long (max 128 chars)" }, 400);
    }
    if (trimmed) {
      passwordHash = await sharePasswordHash(existing.id, trimmed);
      passwordChange = "set";
    } else {
      passwordChange = "cleared";
    }
  }

  const updateStmt =
    passwordChange === "unchanged"
      ? c.env.DB.prepare("UPDATE release_shares SET expires_at = ?1 WHERE id = ?2")
          .bind(expiresAt, shareId)
      : c.env.DB.prepare(
          "UPDATE release_shares SET expires_at = ?1, password_hash = ?2 WHERE id = ?3",
        ).bind(expiresAt, passwordHash, shareId);

  await c.env.DB.batch([
    updateStmt,
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
        password_change: passwordChange,
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
  const t = shareStrings(c);
  const token = c.req.param("token");
  if (!token) return htmlResponse(renderErrorPage(t, t.errMissingToken), 400);

  const row = await findActiveShare(c.env.DB, token);

  if (!row) {
    return htmlResponse(renderErrorPage(t, t.errUnavailable), 404);
  }

  if (row.password_hash && !(await hasValidUnlockCookie(c, row))) {
    await recordShareEvent(c, row.share_id, "view");
    return htmlResponse(renderPasswordPage(t, token, false));
  }

  await recordShareEvent(c, row.share_id, "view");
  const stats = await loadShareStats(c.env.DB, row.share_id);
  const origin = publicRequestOrigin(c);
  const downloadUrl = new URL(`/share/${token}/download`, origin).toString();
  const shareUrl = new URL(`/share/${token}`, origin).toString();
  const lang = (c.req.header("accept-language") ?? "").split(",")[0]?.trim().split(";")[0] ?? null;
  const localized = { ...row, changelog: resolveChangelog(row.changelog, lang) };
  return htmlResponse(renderSharePage(t, localized, stats, downloadUrl, shareUrl, token));
}

export async function handlePublicReleaseShareDownload(c: Context<{ Bindings: Env }>) {
  const t = shareStrings(c);
  const token = c.req.param("token");
  if (!token) return htmlResponse(renderErrorPage(t, t.errMissingToken), 400);

  const row = await findActiveShare(c.env.DB, token);
  if (!row) {
    return htmlResponse(renderErrorPage(t, t.errUnavailable), 404);
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

export async function handlePublicReleaseShareIcon(c: Context<{ Bindings: Env }>) {
  const token = c.req.param("token");
  if (!token) return c.json({ error: "missing token" }, 400);
  const row = await findActiveShare(c.env.DB, token);
  if (!row?.icon_r2_key) return c.json({ error: "no icon" }, 404);
  const object = await c.env.APK_BUCKET.get(row.icon_r2_key);
  if (!object) return c.json({ error: "no icon" }, 404);
  const headers = new Headers({ "cache-control": "public, max-age=300" });
  object.writeHttpMetadata?.(headers);
  return new Response(object.body, { headers });
}

export async function handlePublicReleaseShareUnlock(c: Context<{ Bindings: Env }>) {
  const t = shareStrings(c);
  const token = c.req.param("token");
  if (!token) return htmlResponse(renderErrorPage(t, t.errMissingToken), 400);
  const row = await findActiveShare(c.env.DB, token);
  if (!row) {
    return htmlResponse(renderErrorPage(t, t.errUnavailable), 404);
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
    return htmlResponse(renderPasswordPage(t, token, true), 401);
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
       COALESCE(
         (SELECT ia.r2_key FROM build_assets ia
          WHERE ia.build_id = b.id AND ia.artifact_kind = 'app-icon'
          ORDER BY ia.created_at DESC LIMIT 1),
         a.icon_r2_key
       ) AS icon_r2_key,
       COALESCE(
         json_extract(b.parsed_metadata_json, '$.package_id'),
         json_extract(b.parsed_metadata_json, '$.package_name'),
         json_extract(b.build_metadata_json, '$.package_id'),
         json_extract(b.build_metadata_json, '$.package_name'),
         json_extract(b.build_metadata_json, '$.android.package_id')
       ) AS package_id,
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
       AND (rs.expires_at IS NULL OR rs.expires_at > ?2)
       -- Release status does not gate a share: a link the user actively
       -- created serves until the user revokes it (or its optional expiry
       -- passes), even after the release is superseded or cancelled.
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

/** Resolve an optional expiry: no ttl_seconds/expires_at (or explicit null)
 *  means the share never expires. expires_at wins over ttl_seconds. */
function resolveExpiry(
  ttlSeconds: number | null | undefined,
  expiresAt: number | null | undefined,
  now: number,
): number | null {
  if (expiresAt !== undefined && expiresAt !== null) {
    if (!Number.isFinite(expiresAt) || expiresAt <= now) {
      throw new Error("expires_at must be a future unix millisecond timestamp");
    }
    return Math.floor(expiresAt);
  }
  if (ttlSeconds !== undefined && ttlSeconds !== null) {
    if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
      throw new Error("ttl_seconds must be positive");
    }
    return now + Math.floor(ttlSeconds) * 1000;
  }
  return null;
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
  t: ShareStrings,
  row: SharePageRow,
  stats: ShareStats,
  downloadUrl: string,
  shareUrl: string,
  shareToken: string,
): string {
  const title = `${row.app_slug} ${row.version_name} (${row.version_code})`;
  const qrSvg = renderShareQrSvg(shareUrl);
  return `<!doctype html>
<html lang="${t.htmlLang}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    :root { color-scheme: light dark; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f5f5f2; color: #1e1f22; }
    main { width: min(560px, calc(100vw - 32px)); padding: 32px 0; }
    h1 { margin: 0 0 8px; font-size: 28px; line-height: 1.15; letter-spacing: 0; }
    .draft-tag { font-size: 12px; font-weight: 600; vertical-align: middle; padding: 2px 8px; border-radius: 999px; background: #f59e0b; color: #fff; letter-spacing: .02em; }
    .apphead { display: flex; align-items: center; gap: 16px; }
    .apphead .appicon { border-radius: 12px; flex: none; }
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
    .notes { margin-top: 22px; color: #3b3f45; text-align: left; }
    .notes ul { margin: 8px 0; padding-left: 20px; }
    .notes li { margin: 4px 0; }
    .notes p { margin: 8px 0; }
    .notes code { background: rgba(125,125,125,0.15); border-radius: 4px; padding: 1px 4px; font-size: 0.92em; }
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
    <div class="apphead">
      ${row.icon_r2_key ? `<img class="appicon" src="/share/${escapeAttribute(encodeURIComponent(shareToken))}/icon" alt="" width="56" height="56">` : ""}
      <div>
        <h1>${escapeHtml(row.app_name || row.app_slug)}${
          row.release_status === "draft"
            ? ` <span class="draft-tag">${t.preRelease}</span>`
            : ""
        }</h1>
        <p>${escapeHtml(row.version_name)} · ${t.build} ${row.version_code} · ${escapeHtml(row.channel_slug)}</p>
      </div>
    </div>
    <dl>
      <dt>${t.packageLabel}</dt><dd>${escapeHtml(row.package_id || row.app_slug)}</dd>
      <dt>${t.versionLabel}</dt><dd>${escapeHtml(row.version_name)} (${row.version_code})</dd>
      <dt>${t.artifactLabel}</dt><dd>${escapeHtml(row.filetype.toUpperCase())} · ${formatBytes(row.size_bytes)}</dd>
      <dt>${t.platformLabel}</dt><dd>${escapeHtml([row.platform, row.arch, row.variant].filter(Boolean).join(" / "))}</dd>
      <dt>${t.checksumLabel}</dt><dd>${escapeHtml(row.file_hash)}</dd>
      <dt>${t.statsLabel}</dt>
      <dd class="stats">
        <span class="stat"><strong>${stats.unique_view_count}</strong><span>${t.visitors}</span></span>
        <span class="stat"><strong>${stats.view_count}</strong><span>${t.views}</span></span>
      </dd>
    </dl>
    <div class="get-it">
      <a class="download" href="${escapeAttribute(downloadUrl)}">${t.downloadApk}</a>
      <div class="qr">${qrSvg}<span>${t.scanHint}</span></div>
    </div>
    ${row.changelog ? `<div class="notes">${changelogToHtml(row.changelog)}</div>` : ""}
  </main>
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

function renderPasswordPage(t: ShareStrings, token: string, failed: boolean): string {
  return `<!doctype html>
<html lang="${t.htmlLang}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${t.passwordRequired}</title>
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
    <h1>${t.passwordRequired}</h1>
    <p>${failed ? `<span class="error">${t.wrongPassword}</span>` : t.passwordProtected}</p>
    <form method="post" action="/share/${escapeAttribute(encodeURIComponent(token))}/unlock">
      <input type="password" name="password" placeholder="${escapeAttribute(t.passwordPlaceholder)}" autofocus autocomplete="off" required>
      <button type="submit">${t.unlock}</button>
    </form>
  </main>
</body>
</html>`;
}

function renderErrorPage(t: ShareStrings, message: string): string {
  return `<!doctype html>
<html lang="${t.htmlLang}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${t.shareUnavailable}</title>
  <style>
    :root { color-scheme: light dark; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f5f5f2; color: #1e1f22; }
    main { width: min(360px, calc(100vw - 32px)); text-align: center; }
    .badge { width: 44px; height: 44px; margin: 0 auto 16px; border-radius: 12px; display: grid; place-items: center; background: rgba(125,125,125,0.12); font-size: 22px; }
    h1 { margin: 0 0 8px; font-size: 22px; line-height: 1.2; }
    p { margin: 0; color: #5b616e; line-height: 1.5; }
    @media (prefers-color-scheme: dark) {
      body { background: #17191c; color: #f5f5f2; }
      p { color: #aeb5bf; }
    }
  </style>
</head>
<body>
  <main>
    <div class="badge" aria-hidden="true">🔗</div>
    <h1>${t.shareUnavailable}</h1>
    <p>${escapeHtml(message)}</p>
  </main>
</body>
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
