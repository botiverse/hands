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
import { usesHostedAssets } from "../lib/release_resolver";
import { resolvePublicChannelSlug } from "../lib/public_channel";

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
  gzip = false,
): Promise<Response | null> {
  // A `.gz` request names the gzip REPRESENTATION of this target, whose declared sha256/size
  // are of the COMPRESSED stream. It is a distinct object from the raw binary, so it is looked
  // up as such - never by falling back to the raw row, which would hand out a body whose
  // length/hash contradict the gzip metadata.
  const match = gzip
    ? c.env.DB.prepare(
      `SELECT r2_key, file_hash, size_bytes, filetype, variant
         FROM build_assets
        WHERE build_id = ?1
          AND variant = 'gzip'
          AND artifact_kind = 'installable'
          AND (platform || '-' || COALESCE(arch, '')) = ?2
        ORDER BY created_at ASC LIMIT 1`,
    ).bind(buildId, target)
    : kind.filetype !== null
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

  // A target is served by exactly one hosting mode. Which one decides the miss rule, so the
  // mode is established first and the byte source second:
  //
  //   hosted   - the build has installable rows in build_assets, so the bytes live in the Hands
  //              bucket and `?kind=` / the `.gz` suffix address sibling representations. Here a
  //              miss is FINAL: a `.gz` request for a build with no gzip row must 4xx, never
  //              fall through. Previously this call ran before the gzip check and had no gzip
  //              concept at all, so `<target>.gz` returned the RAW binary with a 200 - a silent
  //              downgrade whose body contradicts the gzip metadata.
  //   external - the build declares targets in external_build_targets, and this route only
  //              redirects to the declared URL. Its `.gz` behaviour (`gzip_source_url`, else
  //              `<source_url>.gz`, else 404) is unchanged.
  const isHosted = await buildIsHosted(c.env, release.build_id);
  if (isHosted) {
    const hosted = await serveHostedAsset(c, release.build_id, parsed.target, kind, parsed.gzip);
    if (hosted) return hosted;
    if (parsed.gzip) {
      return c.json({ error: "no gzip transport declared for this target" }, 404);
    }
    return c.json({ error: "asset not found" }, 404);
  }
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

/**
 * Whether this build's artifacts live in the Hands bucket rather than as declarations on
 * external_build_targets. Used to pick the hosting mode - and therefore the miss rule - before
 * looking for any particular representation.
 */
async function buildIsHosted(env: Env, buildId: string): Promise<boolean> {
  // Read the DECLARED placement, the same source `handleExternalLatestDl` selects on
  // (`artifact_mode = 'external' OR EXISTS(build_assets …)`). Inferring hosted-ness from the
  // presence of build_assets rows made the two disagree for a build that declares
  // `artifact_mode='external'` but carries stray asset rows: the selector would offer it as
  // serviceable and this would then 404 it. One question, one producer.
  //
  // `artifact_mode` is the column added by migration 0073 for exactly this purpose - stating
  // where the bytes live instead of deducing it. A build with no declared mode predates that
  // column, so fall back to the presence of installable assets.
  const row = await env.DB.prepare(
    `SELECT b.artifact_mode AS mode,
            EXISTS (SELECT 1 FROM build_assets ba
                     WHERE ba.build_id = b.id AND ba.artifact_kind = 'installable') AS has_assets
       FROM builds b WHERE b.id = ?1`,
  ).bind(buildId).first<{ mode: string | null; has_assets: number }>();
  if (!row) return false;
  return usesHostedAssets(row.mode, row.has_assets === 1);
}

export async function handleExternalLatestDl(c: Context<{ Bindings: Env }>) {
  const slug = c.req.param("slug") ?? "";
  const requestedChannel = c.req.param("channel") ?? "";
  const parsed = parseFile(c.req.param("file") ?? "");
  if (!slug || !requestedChannel || requestedChannel === "releases" || !parsed) {
    return c.json({ error: "invalid download parameters" }, 400);
  }

  // Stable `/dl/{slug}/{channel}/...` alias resolution, with the same rule as
  // the public v2 routes: a real channel wins over an alias of the same name.
  // Unknown names pass through and keep the existing no-active-release answer.
  // (This resolves the channel FIRST; the query below then selects by placement.)
  const appRow = await c.env.DB.prepare(
    "SELECT id FROM apps WHERE slug = ?1",
  ).bind(slug).first<{ id: string }>();
  const channel = appRow
    ? await resolvePublicChannelSlug(c.env.DB, appRow.id, requestedChannel)
    : requestedChannel;

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
     ORDER BY r.activated_at DESC, r.id ASC LIMIT 1`,
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
