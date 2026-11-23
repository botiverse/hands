/**
 * GET /api/apps/:appId/quota: how much of each rationed upstream call Hands has
 * spent for this app in the current window (lib/upstream_quota.ts), and what is
 * left per tier. Only quotas that apply to the app are listed: Google Play's
 * tracks.releases.list for an Android app with a verified Play binding, scoped
 * to its package, and App Store Connect's per-key hourly quota as Apple last
 * reported it (lib/asc_quota.ts) for an app with an ASC key. Read-only; it
 * never calls the upstream.
 */
import type { Context } from "hono";
import type { AdminEnv } from "../middleware/auth";
import { getGooglePlayBinding, hasGooglePlayConfiguration } from "../lib/google_play_bindings";
import { PLAY_RELEASES_LIST, status } from "../lib/upstream_quota";
import { getAscCredentialsMeta } from "../lib/asc_credentials";
import { ASC_API_QUOTA, ascQuotaObservation } from "../lib/asc_quota";

type AdminContext = Context<AdminEnv & { Bindings: Env }>;

export async function handleGetAppQuota(c: AdminContext) {
  const appId = c.req.param("appId") ?? "";
  const app = await c.env.DB.prepare("SELECT platform FROM apps WHERE id = ?1").bind(appId).first<{ platform: string | null }>();
  if (!app) return c.json({ error: "app not found" }, 404);
  const quotas = [];
  if (app.platform === "android") {
    const binding = await getGooglePlayBinding(c.env.DB, appId, c.env.PLAY_CRED_ENC_KEYS).catch(() => null);
    if (binding && hasGooglePlayConfiguration(binding) && binding.enabled === 1
      && binding.verification_state === "verified" && binding.package_name) {
      for (const quota of await status(c.env.DB, binding.package_name, Date.now(), [PLAY_RELEASES_LIST])) {
        quotas.push({ ...quota, scope_key: binding.package_name });
      }
    }
  }
  const asc = await getAscCredentialsMeta(c.env.DB, appId).catch(() => null);
  if (asc) {
    const now = Date.now();
    const seen = await ascQuotaObservation(c.env.DB, asc.key_id).catch(() => null);
    // Apple counts a rolling hour: an observation older than that says nothing.
    const fresh = seen && now - seen.observed_at < 60 * 60_000 ? seen : null;
    quotas.push({
      key: ASC_API_QUOTA,
      service: "app_store_connect",
      operation: "api",
      scope: "api_key",
      scope_key: asc.key_id,
      limit: fresh?.limit ?? null,
      remaining: fresh?.remaining ?? null,
      observed_at: seen?.observed_at ?? null,
      exhausted_until: seen?.exhausted_until && seen.exhausted_until > now ? seen.exhausted_until : null,
      window: "rolling_hour",
      source: "reported by Apple (X-Rate-Limit)",
    });
  }
  return c.json({ quotas });
}
