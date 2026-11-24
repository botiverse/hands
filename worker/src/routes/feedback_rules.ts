/**
 * Per-app noise rules for crash and error reports (lib/feedback_rules.ts):
 *   GET    /api/apps/:appId/feedback/rules
 *   POST   /api/apps/:appId/feedback/rules            {name, action, match, protect_high_risk?, enabled?}
 *   PATCH  /api/apps/:appId/feedback/rules/:ruleId    any of those
 *   DELETE /api/apps/:appId/feedback/rules/:ruleId
 *   POST   /api/apps/:appId/feedback/rules/preview    {match, protect_high_risk?, days?} (or {rule_id, days?})
 * Rules start disabled. Preview runs a rule against the app's past tickets
 * and changes nothing.
 */
import type { Context } from "hono";
import { currentActor, type AdminEnv } from "../middleware/auth";
import { ruleFromRow, ruleMatches, validateMatch, type FeedbackRuleMatch } from "../lib/feedback_rules";

type AdminContext = Context<AdminEnv & { Bindings: Env }>;

const PREVIEW_MAX_DAYS = 90;
const PREVIEW_SCAN = 5000;
const PREVIEW_SAMPLE = 20;
const MAX_RULES = 50;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function parseAction(value: unknown): "close" | "mute" | null {
  return value === "close" || value === "mute" ? value : null;
}

export async function handleListFeedbackRules(c: AdminContext) {
  const appId = c.req.param("appId") ?? "";
  const { results } = await c.env.DB.prepare("SELECT * FROM feedback_rules WHERE app_id = ?1 ORDER BY created_at, id")
    .bind(appId).all<Parameters<typeof ruleFromRow>[0]>();
  return c.json({ rules: results.map(ruleFromRow) });
}

export async function handleCreateFeedbackRule(c: AdminContext) {
  const appId = c.req.param("appId") ?? "";
  const body = record(await c.req.json().catch(() => ({})));
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name || name.length > 120) return c.json({ error: "name is required (at most 120 characters)" }, 400);
  const action = parseAction(body.action);
  if (!action) return c.json({ error: "action must be close or mute" }, 400);
  const match = validateMatch(body.match);
  if ("error" in match) return c.json({ error: match.error }, 400);
  if (body.protect_high_risk !== undefined && typeof body.protect_high_risk !== "boolean") {
    return c.json({ error: "protect_high_risk must be true or false" }, 400);
  }
  if (body.enabled !== undefined && typeof body.enabled !== "boolean") return c.json({ error: "enabled must be true or false" }, 400);
  const count = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM feedback_rules WHERE app_id = ?1").bind(appId).first<{ n: number }>();
  if (Number(count?.n ?? 0) >= MAX_RULES) return c.json({ error: "an app has at most 50 rules" }, 409);
  const id = crypto.randomUUID();
  const now = Date.now();
  await c.env.DB.prepare(
    `INSERT INTO feedback_rules (id, app_id, name, enabled, action, match_json, protect_high_risk, created_by, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)`,
  ).bind(id, appId, name, body.enabled === true ? 1 : 0, action, JSON.stringify(match.match),
    body.protect_high_risk === false ? 0 : 1, currentActor(c), now).run();
  await audit(c, appId, "feedback.rule_created", { rule_id: id, name, action, enabled: body.enabled === true });
  const row = await c.env.DB.prepare("SELECT * FROM feedback_rules WHERE id = ?1").bind(id).first<Parameters<typeof ruleFromRow>[0]>();
  return c.json({ rule: ruleFromRow(row!) }, 201);
}

export async function handleUpdateFeedbackRule(c: AdminContext) {
  const appId = c.req.param("appId") ?? "";
  const ruleId = c.req.param("ruleId") ?? "";
  const body = record(await c.req.json().catch(() => ({})));
  const sets: string[] = [];
  const binds: unknown[] = [];
  if (body.name !== undefined) {
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name || name.length > 120) return c.json({ error: "name is required (at most 120 characters)" }, 400);
    sets.push("name = ?"); binds.push(name);
  }
  if (body.action !== undefined) {
    const action = parseAction(body.action);
    if (!action) return c.json({ error: "action must be close or mute" }, 400);
    sets.push("action = ?"); binds.push(action);
  }
  if (body.match !== undefined) {
    const match = validateMatch(body.match);
    if ("error" in match) return c.json({ error: match.error }, 400);
    sets.push("match_json = ?"); binds.push(JSON.stringify(match.match));
  }
  for (const key of ["protect_high_risk", "enabled"] as const) {
    if (body[key] === undefined) continue;
    if (typeof body[key] !== "boolean") return c.json({ error: `${key} must be true or false` }, 400);
    sets.push(`${key} = ?`); binds.push(body[key] ? 1 : 0);
  }
  if (sets.length === 0) return c.json({ error: "nothing to update" }, 400);
  sets.push("updated_at = ?"); binds.push(Date.now(), ruleId, appId);
  const result = await c.env.DB.prepare(`UPDATE feedback_rules SET ${sets.join(", ")} WHERE id = ? AND app_id = ?`).bind(...binds).run();
  if (result.meta.changes === 0) return c.json({ error: "rule not found" }, 404);
  await audit(c, appId, "feedback.rule_updated", { rule_id: ruleId, changed: Object.keys(body) });
  const row = await c.env.DB.prepare("SELECT * FROM feedback_rules WHERE id = ?1").bind(ruleId).first<Parameters<typeof ruleFromRow>[0]>();
  return c.json({ rule: ruleFromRow(row!) });
}

export async function handleDeleteFeedbackRule(c: AdminContext) {
  const appId = c.req.param("appId") ?? "";
  const ruleId = c.req.param("ruleId") ?? "";
  const result = await c.env.DB.prepare("DELETE FROM feedback_rules WHERE id = ?1 AND app_id = ?2").bind(ruleId, appId).run();
  if (result.meta.changes === 0) return c.json({ error: "rule not found" }, 404);
  await audit(c, appId, "feedback.rule_deleted", { rule_id: ruleId });
  return c.json({ ok: true });
}

/**
 * What a rule would have matched among the app's tickets of the last `days`
 * days (default 14, at most 90; the newest 5000 crash and error tickets):
 * how many, how many open, by crash group, and a sample. Changes nothing.
 */
export async function handlePreviewFeedbackRule(c: AdminContext) {
  const appId = c.req.param("appId") ?? "";
  const body = record(await c.req.json().catch(() => ({})));
  let match: FeedbackRuleMatch;
  let protect = body.protect_high_risk !== false;
  if (typeof body.rule_id === "string") {
    const row = await c.env.DB.prepare("SELECT * FROM feedback_rules WHERE id = ?1 AND app_id = ?2").bind(body.rule_id, appId)
      .first<Parameters<typeof ruleFromRow>[0]>();
    if (!row) return c.json({ error: "rule not found" }, 404);
    const rule = ruleFromRow(row);
    match = rule.match; protect = rule.protect_high_risk;
  } else {
    const parsed = validateMatch(body.match);
    if ("error" in parsed) return c.json({ error: parsed.error }, 400);
    match = parsed.match;
  }
  const days = body.days === undefined ? 14 : Number(body.days);
  if (!Number.isInteger(days) || days < 1 || days > PREVIEW_MAX_DAYS) return c.json({ error: "days must be 1-90" }, 400);
  const since = Date.now() - days * 86_400_000;
  const { results } = await c.env.DB.prepare(
    `SELECT id, kind, status, signature, channel, device_model, version_name, version_code, metadata_json, created_at
     FROM feedback_tickets WHERE app_id = ?1 AND kind IN ('crash', 'error') AND created_at >= ?2
     ORDER BY created_at DESC LIMIT ?3`,
  ).bind(appId, since, PREVIEW_SCAN).all<{ id: string; kind: string; status: string; signature: string | null; channel: string | null;
    device_model: string | null; version_name: string | null; version_code: number | null; metadata_json: string | null; created_at: number }>();
  let matched = 0;
  let open = 0;
  const bySignature = new Map<string, number>();
  const sample: Array<Record<string, unknown>> = [];
  for (const t of results) {
    let metadata: Record<string, unknown> = {};
    try { metadata = record(JSON.parse(t.metadata_json || "{}")); } catch { metadata = {}; }
    if (!ruleMatches({ match, protect_high_risk: protect }, {
      kind: t.kind, signature: t.signature, channel: t.channel, device_model: t.device_model, version_code: t.version_code, metadata,
    })) continue;
    matched++;
    if (t.status === "open" || t.status === "in_progress") open++;
    const sig = t.signature ?? "(none)";
    bySignature.set(sig, (bySignature.get(sig) ?? 0) + 1);
    if (sample.length < PREVIEW_SAMPLE) {
      sample.push({ id: t.id, status: t.status, signature: t.signature, version_name: t.version_name, version_code: t.version_code,
        device_model: t.device_model, crash_type: metadata.crash_type ?? null, created_at: t.created_at });
    }
  }
  return c.json({
    days, scanned: results.length, scan_limit_reached: results.length >= PREVIEW_SCAN, matched, matched_open: open,
    by_signature: [...bySignature.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20).map(([signature, count]) => ({ signature, count })),
    sample,
  });
}

async function audit(c: AdminContext, appId: string, action: string, payload: Record<string, unknown>) {
  await c.env.DB.prepare("INSERT INTO audit_logs (id, app_id, action, actor, payload, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)")
    .bind(crypto.randomUUID(), appId, action, currentActor(c), JSON.stringify(payload), Date.now()).run().catch(() => undefined);
}
