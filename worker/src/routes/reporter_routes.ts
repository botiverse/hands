import type { Context } from "hono";
import type { AdminContext } from "../lib/permissions";
import { authenticateReporter } from "../lib/reporter_auth";

type ReporterContext = Context<{ Bindings: Env }>;

const SUBJECT_RE = /^rfr_v1_[A-Za-z0-9_-]+$/;

export async function handleBindReporterRouteSubject(c: ReporterContext) {
  const auth = await authenticateReporter(c, "feedback:route");
  if (!auth.ok) return auth.response;

  const body = (await c.req.json().catch(() => null)) as { route_subject?: unknown } | null;
  if (!body || Object.keys(body).length !== 1 || typeof body.route_subject !== "string") {
    return c.json({ error: "exact route_subject body required" }, 400);
  }
  const subject = body.route_subject;
  if (subject.length > 160 || !SUBJECT_RE.test(subject)) {
    return c.json({ error: "invalid route_subject" }, 400);
  }

  const now = Date.now();
  const result = await c.env.DB.prepare(
    `INSERT OR IGNORE INTO app_reporter_routes
     (app_id, reporter_integration_id, reporter_id, route_subject, subject_version, created_at)
     SELECT ?1, ?2, ?3, ?4, 'v1', ?5
     FROM app_reporter_integrations
     WHERE id = ?2 AND app_id = ?1 AND archived_at IS NULL`,
  ).bind(
    auth.principal.appId,
    auth.principal.integrationId,
    auth.principal.reporterId,
    subject,
    now,
  ).run();
  const row = await c.env.DB.prepare(
    `SELECT route_subject FROM app_reporter_routes
     WHERE app_id = ?1 AND reporter_integration_id = ?2 AND reporter_id = ?3`,
  ).bind(
    auth.principal.appId,
    auth.principal.integrationId,
    auth.principal.reporterId,
  ).first<{ route_subject: string }>();
  if (!row) return c.json({ error: "invalid reporter integration grant" }, 403);
  if (row.route_subject !== subject) {
    return c.json({ error: "route_subject_conflict", changed: false }, 409);
  }
  return c.json(
    { changed: result.meta.changes === 1, subject_version: "v1" },
    result.meta.changes === 1 ? 201 : 200,
  );
}

export async function handleBindReporterWebhook(c: AdminContext) {
  const appId = c.req.param("appId") ?? "";
  const integrationId = c.req.param("integrationId") ?? "";
  const webhookId = c.req.param("webhookId") ?? "";
  const now = Date.now();
  const result = await c.env.DB.prepare(
    `INSERT OR IGNORE INTO app_reporter_webhook_subscriptions
     (app_id, reporter_integration_id, webhook_id, created_at)
     SELECT ?1, ?2, ?3, ?4
     FROM app_reporter_integrations ri
     JOIN apps a ON a.id = ri.app_id
     JOIN webhooks w ON w.id = ?3
     WHERE ri.id = ?2 AND ri.app_id = ?1 AND ri.archived_at IS NULL
       AND w.app_id = ?1 AND w.org_id = a.org_id
       AND w.enabled = 1 AND w.archived_at IS NULL`,
  ).bind(appId, integrationId, webhookId, now).run();
  const exists = await c.env.DB.prepare(
    `SELECT 1 AS ok FROM app_reporter_webhook_subscriptions
     WHERE app_id = ?1 AND reporter_integration_id = ?2 AND webhook_id = ?3`,
  ).bind(appId, integrationId, webhookId).first<{ ok: number }>();
  if (!exists) return c.json({ error: "reporter webhook subscription mismatch" }, 409);
  return c.json({ changed: result.meta.changes === 1 }, result.meta.changes === 1 ? 201 : 200);
}

async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function handleGetReporterRouteMetadata(c: AdminContext) {
  const appId = c.req.param("appId") ?? "";
  const integrationId = c.req.query("reporter_integration_id") ?? "";
  const reporterId = c.req.query("reporter_id") ?? "";
  if (!integrationId || !reporterId) {
    return c.json({ error: "reporter_integration_id and reporter_id are required" }, 400);
  }
  const route = await c.env.DB.prepare(
    `SELECT subject_version, created_at FROM app_reporter_routes
     WHERE app_id = ?1 AND reporter_integration_id = ?2 AND reporter_id = ?3`,
  ).bind(appId, integrationId, reporterId).first<{
    subject_version: string;
    created_at: number;
  }>();
  const subscribers = await c.env.DB.prepare(
    `SELECT COUNT(*) AS count FROM app_reporter_webhook_subscriptions s
     JOIN webhooks w ON w.id = s.webhook_id
     WHERE s.app_id = ?1 AND s.reporter_integration_id = ?2
       AND w.enabled = 1 AND w.archived_at IS NULL`,
  ).bind(appId, integrationId).first<{ count: number }>();
  const { results } = await c.env.DB.prepare(
    `SELECT fe.id AS event_id, fe.event_type, fe.route_outcome, fe.payload_json,
            fe.created_at, wd.id AS delivery_id, wd.status, wd.attempts,
            wd.completed_at
     FROM feedback_events fe
     LEFT JOIN webhook_deliveries wd ON wd.event_id = fe.id
       AND EXISTS (
         SELECT 1 FROM app_reporter_webhook_subscriptions s
         WHERE s.webhook_id = wd.webhook_id AND s.app_id = fe.app_id
           AND s.reporter_integration_id = fe.reporter_integration_id
       )
     WHERE fe.app_id = ?1 AND fe.reporter_integration_id = ?2
       AND fe.reporter_id = ?3
     ORDER BY fe.created_at DESC, fe.id DESC LIMIT 100`,
  ).bind(appId, integrationId, reporterId).all<{
    event_id: string;
    event_type: string;
    route_outcome: string;
    payload_json: string;
    created_at: number;
    delivery_id: string | null;
    status: string | null;
    attempts: number | null;
    completed_at: number | null;
  }>();
  return c.json({
    route: route ? { bound: true, subject_version: route.subject_version, created_at: route.created_at } : { bound: false },
    matching_subscriber_count: subscribers?.count ?? 0,
    events: await Promise.all(results.map(async ({ payload_json, ...event }) => ({
      ...event,
      payload_sha256: await sha256Hex(payload_json),
    }))),
  });
}
