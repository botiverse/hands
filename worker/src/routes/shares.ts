import type { Context } from "hono";
import { currentActor, type AdminEnv } from "../middleware/auth";
import { generateSignedR2Url } from "./public_v2";

type AdminContext = Context<AdminEnv & { Bindings: Env }>;

type ShareRow = {
  id: string;
  token_hash: string;
  created_at: number;
  expires_at: number;
  revoked_at: number | null;
};

type SharePageRow = {
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

const DEFAULT_SHARE_TTL_SECONDS = 24 * 60 * 60;
const MAX_SHARE_TTL_SECONDS = 30 * 24 * 60 * 60;

export async function handleCreateReleaseShare(c: AdminContext) {
  const appId = c.req.param("appId");
  const releaseId = c.req.param("releaseId");
  const body = await c.req.json().catch(() => ({})) as {
    ttl_seconds?: number;
    expires_at?: number;
  };

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

  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO release_shares
       (id, release_id, token_hash, created_by, created_at, expires_at, revoked_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL)`,
    ).bind(id, releaseId, tokenHash, currentActor(c), now, expiresAt),
    c.env.DB.prepare(
      `INSERT INTO audit_logs (id, app_id, action, actor, payload, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
    ).bind(
      crypto.randomUUID(),
      appId,
      "release_share.create",
      currentActor(c),
      JSON.stringify({ id, release_id: releaseId, expires_at: expiresAt }),
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
    `SELECT id, token_hash, created_at, expires_at, revoked_at
     FROM release_shares
     WHERE release_id = ?1
     ORDER BY created_at DESC`,
  )
    .bind(releaseId)
    .all<ShareRow>();
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

export async function handlePublicReleaseShare(c: Context<{ Bindings: Env }>) {
  const token = c.req.param("token");
  if (!token) return htmlResponse(renderErrorPage("Missing share token"), 400);

  const tokenHash = await sha256Hex(token);
  const now = Date.now();
  const row = await c.env.DB.prepare(
    `SELECT
       rs.id AS share_id,
       rs.expires_at AS expires_at,
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
    .bind(tokenHash, now)
    .first<SharePageRow>();

  if (!row) {
    return htmlResponse(renderErrorPage("This share link is expired, revoked, or unavailable."), 404);
  }

  const ttl = Number(c.env.SIGNED_URL_TTL_SECONDS ?? "3600");
  const downloadUrl = await generateSignedR2Url(
    c.env,
    row.r2_key,
    ttl,
    publicRequestOrigin(c),
  );
  return htmlResponse(renderSharePage(row, downloadUrl));
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
  return new URL(c.req.url).origin;
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

function renderSharePage(row: SharePageRow, downloadUrl: string): string {
  const title = `${row.app_slug} ${row.version_name} (${row.version_code})`;
  const expiresIso = new Date(row.expires_at).toISOString();
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
    .notes { margin-top: 22px; white-space: pre-wrap; color: #3b3f45; }
    @media (prefers-color-scheme: dark) {
      body { background: #17191c; color: #f5f5f2; }
      p, dt { color: #aeb5bf; }
      .notes { color: #d2d6dc; }
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
    </dl>
    <a class="download" href="${escapeAttribute(downloadUrl)}">Download APK</a>
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
