/**
 * GET /api/apps/:appId/quota: how much of each rationed upstream call Hands has
 * spent for this app in the current window (lib/upstream_quota.ts), and what is
 * left per tier. Only quotas that apply to the app are listed: Google Play's
 * tracks.releases.list for an Android app with a verified Play binding, scoped
 * to its package. Read-only; it never calls the upstream.
 */
import type { Context } from "hono";
import type { AdminEnv } from "../middleware/auth";
import { getGooglePlayBinding, hasGooglePlayConfiguration } from "../lib/google_play_bindings";
import { PLAY_RELEASES_LIST, status } from "../lib/upstream_quota";

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
  return c.json({ quotas });
}
