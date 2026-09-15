/**
 * Public download surfaces for external and hosted build targets.
 *
 *   /dl/{slug}/releases/{releaseId}/{target}[.gz]   — immutable, release-bound.
 *       External (artifact_mode='external'): active|superseded → 302 to the declared
 *       source URL; draft/cancelled 404. A manifest that pinned a release keeps
 *       resolving the same bytes through supersession (rollback/audit
 *       continuity).
 *       Hosted (bytes in the Hands bucket): streamed directly from R2, so a
 *       pinned release keeps serving the same object.
 *
 *   /dl/{slug}/{channel}/{target}[.gz]              — stable "latest".
 *       Resolves to the channel's current ACTIVE release, then serves it the
 *       same way the release-bound route does. Install scripts can hardcode one
 *       URL. `?kind=<variant|filetype>` addresses an additional asset of the
 *       same release (e.g. a runner sidecar or a SHA256SUMS listing) so every
 *       file of one release is fetched from that same release — never by
 *       re-resolving "latest" per file, which could split across versions.
 *
 * .gz addresses the gzip transport and requires a declared gzip digest. It is
 * available for external targets; hosted assets declare their own compression.
 *
 * How "hosted" is decided: by fact, not by label — a build whose bytes live in
 * the Hands bucket has R2-backed build_assets rows, and an externally-hosted
 * build does not. That is the same rule /public/v2/.../latest already applies
 * (see the external arm there), kept in one shape across both surfaces.
 */
import type { Context } from "hono";

type DlTargetRow = {
  target: string;
  source_url: string;
  gzip_source_url: string | null;
  gzip_sha256: string | null;
};

function parseFile(file: string): { target: string; gzip: boolean } | null {
  const gzip = file.endsWith(".gz");
  const target = gzip ? file.slice(0, -3) : file;
  if (!/^[a-z0-9]+-[a-z0-9_]+$/.test(target)) return null;
  return { target, gzip };
}

const noStore = { "cache-control": "no-store" };

/**
 * Address an additional asset of the same release, so a caller that needs the
 * main binary plus a sidecar (or a SHA256SUMS listing) resolves release once
 * and then reads every file from that one release.
 *
 *   ?kind=runner        → variant = "runner"
 *   ?kind=sha256sums    → filetype = "sha256sums"
 *
 * Absent `kind` addresses the primary asset (the one with no variant).
 */
function parseAssetKind(raw: string | undefined): { variant: string | null; filetype: string | null } | null {
  if (raw === undefined || raw === "") return { variant: null, filetype: null };
  // Bounded, lowercase, hyphen/underscore only: these are column values, not
  // free text, and both are matched exactly below.
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(raw)) return null;
  return raw === "sha256sums"
    ? { variant: null, filetype: raw }
    : { variant: raw, filetype: null };
}

type HostedAssetRow = {
  r2_key: string;
  file_hash: string;
  size_bytes: number;
  filetype: string;
  variant: string | null;
};

/**
 * Serve a hosted build asset straight from the Hands bucket.
 *
 * Returns null when the build has no such asset, so the caller keeps its own
 * not-found path. This is the hosted counterpart of the external 302 branch.
 */
async function serveHostedAsset(
  c: Context<{ Bindings: Env }>,
  buildId: string,
  target: string,
  kind: { variant: string | null; filetype: string | null },
): Promise<Response | null> {
  const match = kind.filetype !== null
    ? c.env.DB.prepare(
      `SELECT r2_key, file_hash, size_bytes, filetype, variant
         FROM build_assets
        WHERE build_id = ?1 AND filetype = ?2 AND (platform || '-' || COALESCE(arch, '')) LIKE ?3 || '%'
        ORDER BY created_at ASC LIMIT 1`,
    ).bind(buildId, kind.filetype, target)
    : c.env.DB.prepare(
      `SELECT r2_key, file_hash, size_bytes, filetype, variant
         FROM build_assets
        WHERE build_id = ?1
          AND variant IS ?2
          AND (platform || '-' || COALESCE(arch, '')) = ?3
        ORDER BY created_at ASC LIMIT 1`,
    ).bind(buildId, kind.variant, target);

  const asset = await match.first<HostedAssetRow>();
  if (!asset) return null;

  const object = await c.env.APK_BUCKET.get(asset.r2_key);
  if (!object) return null;

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  // Immutable bytes addressed by hash-bearing key: safe to cache hard.
  headers.set("cache-control", "public, max-age=31536000, immutable");
  if (!headers.has("content-type")) {
    headers.set("content-type", "application/octet-stream");
  }
  headers.set("content-length", String(asset.size_bytes));
  return new Response(object.body, { headers });
}

export async function handleExternalReleaseDl(c: Context<{ Bindings: Env }>) {
  const slug = c.req.param("slug") ?? "";
  const releaseId = c.req.param("releaseId") ?? "";
  const parsed = parseFile(c.req.param("file") ?? "");
  if (!slug || !releaseId || !parsed) return c.json({ error: "invalid download parameters" }, 400);

  const kind = parseAssetKind(c.req.query("kind"));
  if (!kind) return c.json({ error: "invalid asset kind" }, 400);

  const release = await c.env.DB.prepare(
    `SELECT r.id, r.build_id FROM releases r
     JOIN apps a ON a.id = r.app_id
     WHERE a.slug = ?1 AND r.id = ?2 AND r.status IN ('active', 'superseded')`,
  )
    .bind(slug, releaseId)
    .first<{ id: string; build_id: string }>();
  if (!release) return c.json({ error: "release not found" }, 404);

  // Hosted first: this release's bytes live in the Hands bucket, so serve them
  // directly (and honour `?kind=` for its sidecars). The external branch below
  // is unchanged for externally-declared targets.
  const hosted = await serveHostedAsset(c, release.build_id, parsed.target, kind);
  if (hosted) return hosted;
  if (kind.variant !== null || kind.filetype !== null) {
    return c.json({ error: "asset not found" }, 404);
  }

  const row = await c.env.DB.prepare(
    `SELECT target, source_url, gzip_source_url, gzip_sha256
     FROM external_build_targets WHERE build_id = ?1 AND target = ?2`,
  )
    .bind(release.build_id, parsed.target)
    .first<DlTargetRow>();
  if (!row) return c.json({ error: "target not found" }, 404);

  if (parsed.gzip) {
    if (!row.gzip_sha256) return c.json({ error: "no gzip transport declared for this target" }, 404);
    const url = row.gzip_source_url ?? `${row.source_url}.gz`;
    return new Response(null, { status: 302, headers: { location: url, ...noStore } });
  }
  return new Response(null, { status: 302, headers: { location: row.source_url, ...noStore } });
}

export async function handleExternalLatestDl(c: Context<{ Bindings: Env }>) {
  const slug = c.req.param("slug") ?? "";
  const channel = c.req.param("channel") ?? "";
  const parsed = parseFile(c.req.param("file") ?? "");
  if (!slug || !channel || channel === "releases" || !parsed) {
    return c.json({ error: "invalid download parameters" }, 400);
  }

  // Resolve the channel's current active release for both delivery shapes:
  // externally-declared targets (artifact_mode='external') and hosted ones whose
  // bytes live in the Hands bucket. Hosted is decided by fact — a build with
  // R2-backed build_assets rows — matching how /public/v2/.../latest already
  // decides it. The external arm reads the placement column rather than the
  // `source` label, so it finds an externally-placed build regardless of which
  // creation path produced it; releases that are neither stay excluded.
  const release = await c.env.DB.prepare(
    // `b.artifact_mode = 'external'` states the placement directly: the bytes are declared
    // externally rather than stored in R2. Reading the dedicated column instead of the
    // `source` label means a build whose bytes are external is found regardless of which
    // creation path produced it.
    // Also note the 404 body below is deliberately UNIFORM for every cause
    // (app missing / channel missing / no active release): it must not become an
    // existence oracle for app slugs and channels. See task #219.
    `SELECT r.id FROM releases r
     JOIN apps a ON a.id = r.app_id
     JOIN channels ch ON ch.id = r.channel_id
     JOIN builds b ON b.id = r.build_id
     WHERE a.slug = ?1 AND ch.slug = ?2 AND r.status = 'active'
       AND (r.availability_at IS NULL OR r.availability_at <= ?3)
       AND (
         b.artifact_mode = 'external'
         OR EXISTS (SELECT 1 FROM build_assets ba WHERE ba.build_id = b.id)
       )
     ORDER BY r.created_at DESC LIMIT 1`,
  )
    .bind(slug, channel, Date.now())
    .first<{ id: string }>();
  if (!release) return c.json({ error: "no active release" }, 404);

  // The channel route resolves the release only; every file is then fetched
  // from the release-bound path (see the module comment), so a multi-file
  // caller cannot split across versions.
  const location = `/dl/${encodeURIComponent(slug)}/releases/${encodeURIComponent(release.id)}/${encodeURIComponent(c.req.param("file") ?? "")}`;
  return new Response(null, { status: 302, headers: { location, ...noStore } });
}
