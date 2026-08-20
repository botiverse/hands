import type { Context } from "hono";
import { getCachedHandsObservabilityOverview } from "../observability_rpc";
import { type AdminEnv } from "../middleware/auth";

export async function handleHandsAdminOverview(c: Context<AdminEnv & { Bindings: Env }>) {
  // Audit the identity the authorization decision actually used —
  // authenticated_account (the session identity), NOT admin_account / currentActorInfo,
  // which reflect the org-switchable (x-hands-org-id) view. requireHandsAdmin gates on
  // authenticated_account, so the actor and server recorded here must match it, or a
  // row could name an identity/server that was never the authorized one.
  const authed = c.get("authenticated_account") as {
    id: string; principal_type: "human" | "agent"; server_id: string;
  };
  const measured = await getCachedHandsObservabilityOverview(c.env);
  await c.env.DB.prepare(
    `INSERT INTO hands_admin_access_audit
       (id, actor_account_id, actor_type, server_id, action, created_at)
     VALUES (?1, ?2, ?3, ?4, 'overview.view', ?5)`,
  ).bind(
    crypto.randomUUID(),
    authed.id,
    authed.principal_type,
    authed.server_id,
    Date.now(),
  ).run();
  return c.json(measured);
}
