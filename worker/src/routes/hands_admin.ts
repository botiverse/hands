import type { Context } from "hono";
import { getCachedHandsObservabilityOverview } from "../observability_rpc";
import { currentActorInfo, type AdminEnv } from "../middleware/auth";

export async function handleHandsAdminOverview(c: Context<AdminEnv & { Bindings: Env }>) {
  const actor = currentActorInfo(c);
  const measured = await getCachedHandsObservabilityOverview(c.env);
  await c.env.DB.prepare(
    `INSERT INTO hands_admin_access_audit
       (id, actor_account_id, actor_type, server_id, action, created_at)
     VALUES (?1, ?2, ?3, ?4, 'overview.view', ?5)`,
  ).bind(
    crypto.randomUUID(),
    actor.id,
    actor.type,
    (c.get("admin_account") as { server_id: string }).server_id,
    Date.now(),
  ).run();
  return c.json(measured);
}
