/**
 * Public download surfaces for external build targets (task #160):
 *
 *   /dl/{slug}/releases/{releaseId}/{target}[.gz]   — immutable, release-bound.
 *       active|superseded → 302 to the declared source URL; draft/cancelled
 *       404. A manifest that pinned a release keeps resolving the same bytes
 *       through supersession (rollback/audit continuity).
 *
 *   /dl/{slug}/{channel}/{target}[.gz]              — stable "latest".
 *       302 to the immutable release-bound route for the channel's current
 *       ACTIVE release (only active — that is what "latest" means), so
 *       install scripts can hardcode one URL.
 *
 * .gz addresses the gzip transport and requires a declared gzip digest.
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

export async function handleExternalReleaseDl(c: Context<{ Bindings: Env }>) {
  const slug = c.req.param("slug") ?? "";
  const releaseId = c.req.param("releaseId") ?? "";
  const parsed = parseFile(c.req.param("file") ?? "");
  if (!slug || !releaseId || !parsed) return c.json({ error: "invalid download parameters" }, 400);

  const release = await c.env.DB.prepare(
    `SELECT r.id, r.build_id FROM releases r
     JOIN apps a ON a.id = r.app_id
     WHERE a.slug = ?1 AND r.id = ?2 AND r.status IN ('active', 'superseded')`,
  )
    .bind(slug, releaseId)
    .first<{ id: string; build_id: string }>();
  if (!release) return c.json({ error: "release not found" }, 404);

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

  const release = await c.env.DB.prepare(
    `SELECT r.id FROM releases r
     JOIN apps a ON a.id = r.app_id
     JOIN channels ch ON ch.id = r.channel_id
     JOIN builds b ON b.id = r.build_id
     WHERE a.slug = ?1 AND ch.slug = ?2 AND r.status = 'active'
       AND b.source = 'external'
       AND (r.availability_at IS NULL OR r.availability_at <= ?3)
     ORDER BY r.created_at DESC LIMIT 1`,
  )
    .bind(slug, channel, Date.now())
    .first<{ id: string }>();
  if (!release) return c.json({ error: "no active release" }, 404);

  const location = `/dl/${encodeURIComponent(slug)}/releases/${encodeURIComponent(release.id)}/${encodeURIComponent(c.req.param("file") ?? "")}`;
  return new Response(null, { status: 302, headers: { location, ...noStore } });
}
