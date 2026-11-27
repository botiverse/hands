/**
 * Request counts for the public Electron update route.
 *
 * Desktop clients that predate their own download telemetry report nothing, so
 * the route is the only place their patch, full and differential downloads are
 * visible. Every GET that resolves to a file is counted per file and UTC day:
 * whole-file requests and Range requests separately (electron-updater's
 * blockmap differential download is a series of Range requests against the
 * archive), plus the number of distinct requesters.
 *
 * Counting never blocks or fails a download: it runs after the response when
 * the runtime allows it, and every error is swallowed.
 */
import type { Context } from "hono";

export type ElectronFileRole = "patch" | "full" | "blockmap" | "metadata";

export function electronFileRole(
  asset: { filetype: string },
  file: string,
  isMetadata: boolean,
): ElectronFileRole {
  if (isMetadata) return "metadata";
  const type = asset.filetype.toLowerCase();
  const name = file.toLowerCase();
  if (type === "blockmap" || name.endsWith(".blockmap")) return "blockmap";
  if (type === "patch" || name.endsWith(".patch")) return "patch";
  return "full";
}

/** UTC day of a timestamp, YYYY-MM-DD. */
export function utcDay(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

/**
 * Per-day requester key: HMAC of the day, IP and user agent. The day is part of
 * the input, so one client cannot be linked across days, and no raw IP is kept.
 */
async function sourceHash(c: Context<{ Bindings: Env }>, day: string): Promise<string> {
  const ip =
    c.req.header("cf-connecting-ip") ||
    c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ||
    "unknown-ip";
  const userAgent = c.req.header("user-agent") || "unknown-ua";
  const salt =
    c.env.SHARE_STATS_SALT ||
    c.env.SIGNED_URL_SECRET ||
    c.env.ADMIN_API_TOKEN ||
    c.env.RAFT_CLIENT_SECRET;
  if (!salt) throw new Error("no salt configured for download source hashing");
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(salt),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`electron-download\n${day}\n${ip}\n${userAgent}`),
  );
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export type ElectronRequest = {
  appId: string;
  buildId: string;
  assetId: string;
  file: string;
  role: ElectronFileRole;
  /** The request carried a Range header (whether or not it could be honoured). */
  ranged: boolean;
};

/** Never throws. */
export async function recordElectronRequest(
  c: Context<{ Bindings: Env }>,
  req: ElectronRequest,
  nowMs = Date.now(),
): Promise<void> {
  try {
    const day = utcDay(nowMs);
    const hash = await sourceHash(c, day);
    await c.env.DB.batch([
      c.env.DB.prepare(
        `INSERT INTO electron_download_days
           (asset_id, day, app_id, build_id, file, role, full_requests, range_requests)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT (asset_id, day) DO UPDATE SET
           full_requests = full_requests + excluded.full_requests,
           range_requests = range_requests + excluded.range_requests`,
      ).bind(
        req.assetId,
        day,
        req.appId,
        req.buildId,
        req.file,
        req.role,
        req.ranged ? 0 : 1,
        req.ranged ? 1 : 0,
      ),
      c.env.DB.prepare(
        `INSERT OR IGNORE INTO electron_download_day_sources (asset_id, day, app_id, source_hash)
         VALUES (?1, ?2, ?3, ?4)`,
      ).bind(req.assetId, day, req.appId, hash),
    ]);
  } catch {
    // A missing table or hashing failure must not affect the download.
  }
}

/** Run the count after the response when possible; otherwise inline (tests). */
export async function countElectronRequest(
  c: Context<{ Bindings: Env }>,
  req: ElectronRequest,
): Promise<void> {
  const pending = recordElectronRequest(c, req);
  try {
    c.executionCtx.waitUntil(pending);
  } catch {
    await pending;
  }
}
