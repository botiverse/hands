/**
 * Public download accounting (task #48).
 *
 * WHY THIS EXISTS
 * build_assets.download_count has exactly two writers, both on the admin
 * surface (builds.ts incrementBuildAssetDownloadCount via
 * handleDownloadBuildAsset, and qa_artifacts.ts). The path real clients use,
 * bindApp("/apps/:slug/latest/download", handlePublicLatestReleaseDownload),
 * only 302-redirects to R2 and never touched the counter -- so the number
 * measured internal console downloads, not user downloads. During the 1.12
 * retention analysis we nearly used it as an update conversion rate.
 *
 * WHY NOT JUST INCREMENT download_count
 * The acceptance criterion is that one visitor downloading twice counts once.
 * A counter cannot dedupe, and the existing counter already mixes admin and QA
 * traffic. Events are recorded separately so the old column keeps its old
 * meaning instead of silently changing under existing dashboards.
 */
import type { Context } from "hono";

/**
 * Stable, non-reversible per-visitor key. Deliberately the same inputs and
 * precedence as shareVisitorHash (shares.ts) so the two public surfaces agree
 * on what "the same visitor" means.
 *
 * No raw IP is stored anywhere: only the HMAC digest reaches the database.
 */
async function downloadVisitorHash(c: Context<{ Bindings: Env }>): Promise<string> {
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
    throw new Error(
      "SHARE_STATS_SALT, SIGNED_URL_SECRET, ADMIN_API_TOKEN, or RAFT_CLIENT_SECRET must be configured",
    );
  }
  const data = new TextEncoder().encode(`${ip}\n${userAgent}\n${language}`);
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(salt),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, data);
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Record that this visitor downloaded this asset, at most once.
 *
 * Returns true when a new row was written, false when the visitor had already
 * been counted (or when counting was skipped/failed).
 *
 * NEVER THROWS. A download that already has a signed URL must not fail because
 * an analytics write failed; the redirect is the product, the count is a
 * measurement of it. Callers are not required to handle an error that cannot
 * occur.
 */
export async function recordPublicAssetDownload(
  c: Context<{ Bindings: Env }>,
  assetId: string,
  buildId: string,
): Promise<boolean> {
  try {
    const visitorHash = await downloadVisitorHash(c);
    // INSERT ... SELECT WHERE NOT EXISTS is a single statement, so two
    // concurrent requests from the same visitor cannot both insert: D1
    // serializes writes, and the guard is part of the same statement.
    const result = await c.env.DB.prepare(
      `INSERT INTO build_asset_download_events (id, asset_id, build_id, visitor_hash, created_at)
       SELECT ?1, ?2, ?3, ?4, ?5
        WHERE NOT EXISTS (
          SELECT 1 FROM build_asset_download_events
           WHERE asset_id = ?2 AND visitor_hash = ?4
        )`,
    )
      .bind(crypto.randomUUID(), assetId, buildId, visitorHash, Date.now())
      .run();
    return (result.meta?.changes ?? 0) > 0;
  } catch {
    // Intentional: see "NEVER THROWS" above. A missing table (migration not yet
    // applied) or a crypto failure must not turn a working download into a 500.
    return false;
  }
}
