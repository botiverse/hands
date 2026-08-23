import type { Context } from "hono";
import type { AdminContext } from "../lib/permissions";
import { authenticateReporter } from "../lib/reporter_auth";
import { computeReporterAuditHash } from "../lib/reporter_audit";
import { isFeedbackTokenPermission } from "../lib/app_permissions";

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
  const auditKey = c.env.FEEDBACK_AUDIT_HMAC_KEY;
  const auditKeyVersion = c.env.FEEDBACK_AUDIT_KEY_VERSION?.trim();
  const reporterHash = auditKey && auditKeyVersion
    ? await computeReporterAuditHash({
        key: auditKey,
        appId: auth.principal.appId,
        integrationId: auth.principal.integrationId,
        reporterId: auth.principal.reporterId,
      })
    : null;
  if (!reporterHash || !auditKeyVersion) {
    return c.json({ error: "reporter audit is not configured" }, 503);
  }
  const auditPayload = JSON.stringify({
    reporter_integration_id: auth.principal.integrationId,
    reporter_hash: reporterHash,
    audit_key_version: auditKeyVersion,
  });
  const [result] = await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT OR IGNORE INTO app_reporter_routes
       (app_id, reporter_integration_id, reporter_id, route_subject, subject_version, created_at)
       SELECT ?1, ?2, ?3, ?4, 'v1', ?5
       FROM app_reporter_integrations ri
       JOIN apps a ON a.id = ri.app_id
       WHERE ri.id = ?2 AND ri.app_id = ?1 AND ri.archived_at IS NULL
         AND a.archived = 0`,
    ).bind(
      auth.principal.appId,
      auth.principal.integrationId,
      auth.principal.reporterId,
      subject,
      now,
    ),
    c.env.DB.prepare(
      `INSERT INTO audit_logs (id, app_id, action, actor, payload, created_at)
       SELECT ?1, ?2, 'feedback.route_bind', ?3, ?4, ?5
       FROM app_reporter_routes r
       JOIN apps a ON a.id = r.app_id AND a.archived = 0
       JOIN app_reporter_integrations ri
         ON ri.id = r.reporter_integration_id AND ri.app_id = r.app_id
        AND ri.archived_at IS NULL
       WHERE r.app_id = ?2 AND r.reporter_integration_id = ?6
         AND r.reporter_id = ?7 AND r.route_subject = ?8`,
    ).bind(
      crypto.randomUUID(),
      auth.principal.appId,
      `reporter:${reporterHash}`,
      auditPayload,
      now,
      auth.principal.integrationId,
      auth.principal.reporterId,
      subject,
    ),
  ]);
  const row = await c.env.DB.prepare(
    `SELECT r.route_subject FROM app_reporter_routes r
     JOIN apps a ON a.id = r.app_id AND a.archived = 0
     JOIN app_reporter_integrations ri
       ON ri.id = r.reporter_integration_id AND ri.app_id = r.app_id
      AND ri.archived_at IS NULL
     WHERE r.app_id = ?1 AND r.reporter_integration_id = ?2 AND r.reporter_id = ?3`,
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
    { changed: result?.meta.changes === 1, subject_version: "v1" },
    result?.meta.changes === 1 ? 201 : 200,
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
       AND a.archived = 0
       AND w.app_id = ?1 AND w.org_id = a.org_id
       AND w.enabled = 1 AND w.archived_at IS NULL`,
  ).bind(appId, integrationId, webhookId, now).run();
  const exists = await c.env.DB.prepare(
    `SELECT 1 AS ok FROM app_reporter_webhook_subscriptions s
     JOIN apps a ON a.id = s.app_id AND a.archived = 0
     JOIN app_reporter_integrations ri
       ON ri.id = s.reporter_integration_id AND ri.app_id = s.app_id
      AND ri.archived_at IS NULL
     JOIN webhooks w ON w.id = s.webhook_id AND w.app_id = s.app_id
      AND w.org_id = a.org_id AND w.enabled = 1 AND w.archived_at IS NULL
     WHERE s.app_id = ?1 AND s.reporter_integration_id = ?2 AND s.webhook_id = ?3`,
  ).bind(appId, integrationId, webhookId).first<{ ok: number }>();
  if (!exists) return c.json({ error: "reporter webhook subscription mismatch" }, 409);
  return c.json({ changed: result.meta.changes === 1 }, result.meta.changes === 1 ? 201 : 200);
}

async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function hmacSha256Hex(secret: string, value: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function handleGetReporterRouteMetadata(c: AdminContext) {
  const appId = c.req.param("appId") ?? "";
  const integrationId = c.req.query("reporter_integration_id") ?? "";
  const reporterId = c.req.query("reporter_id") ?? "";
  const tokenId = c.req.query("token_id") ?? "";
  if (!integrationId || !reporterId || !tokenId) {
    return c.json({ error: "reporter_integration_id, reporter_id, and token_id are required" }, 400);
  }
  const auditKey = c.env.FEEDBACK_AUDIT_HMAC_KEY;
  const auditKeyVersion = c.env.FEEDBACK_AUDIT_KEY_VERSION?.trim();
  const reporterHash = auditKey && auditKeyVersion
    ? await computeReporterAuditHash({ key: auditKey, appId, integrationId, reporterId })
    : null;
  if (!reporterHash || !auditKeyVersion) {
    return c.json({ error: "reporter audit is not configured" }, 503);
  }
  const token = await c.env.DB.prepare(
    `SELECT dt.id, dt.app_role, dt.scopes_json, dt.reporter_integration_id,
            dt.revoked_at, dt.expires_at, a.archived AS app_archived,
            ri.archived_at AS integration_archived_at
     FROM app_deploy_tokens dt
     JOIN apps a ON a.id = dt.app_id
     LEFT JOIN app_reporter_integrations ri
       ON ri.id = dt.reporter_integration_id AND ri.app_id = dt.app_id
     WHERE dt.id = ?1 AND dt.app_id = ?2`,
  ).bind(tokenId, appId).first<{
    id: string;
    app_role: string | null;
    scopes_json: string | null;
    reporter_integration_id: string | null;
    revoked_at: number | null;
    expires_at: number | null;
    app_archived: number;
    integration_archived_at: number | null;
  }>();
  let scopes: string[] = [];
  try {
    const parsed = token?.scopes_json === null ? null : JSON.parse(token?.scopes_json ?? "null");
    scopes = Array.isArray(parsed) && parsed.every(isFeedbackTokenPermission) ? parsed : [];
  } catch {
    scopes = [];
  }
  const requiredPermissions = ["feedback:write", "feedback:read", "feedback:comment", "feedback:route"];
  const effectivePermissions = [...new Set(scopes)].sort();
  const grantValid = !!token
    && token.app_role === null
    && token.reporter_integration_id === integrationId
    && token.revoked_at === null
    && (token.expires_at === null || token.expires_at > Date.now())
    && token.app_archived === 0
    && token.integration_archived_at === null
    && effectivePermissions.length === requiredPermissions.length
    && requiredPermissions.every((permission) => effectivePermissions.includes(permission));
  const route = await c.env.DB.prepare(
    `SELECT r.subject_version, r.created_at FROM app_reporter_routes r
     JOIN apps a ON a.id = r.app_id AND a.archived = 0
     JOIN app_reporter_integrations ri
       ON ri.id = r.reporter_integration_id AND ri.app_id = r.app_id
      AND ri.archived_at IS NULL
     WHERE r.app_id = ?1 AND r.reporter_integration_id = ?2 AND r.reporter_id = ?3`,
  ).bind(appId, integrationId, reporterId).first<{
    subject_version: string;
    created_at: number;
  }>();
  const subscribers = await c.env.DB.prepare(
    `SELECT COUNT(*) AS count FROM app_reporter_webhook_subscriptions s
     JOIN apps a ON a.id = s.app_id AND a.archived = 0
     JOIN app_reporter_integrations ri
       ON ri.id = s.reporter_integration_id AND ri.app_id = s.app_id
      AND ri.archived_at IS NULL
     JOIN webhooks w ON w.id = s.webhook_id
     WHERE s.app_id = ?1 AND s.reporter_integration_id = ?2
       AND w.app_id = s.app_id AND w.org_id = a.org_id
       AND w.enabled = 1 AND w.archived_at IS NULL`,
  ).bind(appId, integrationId).first<{ count: number }>();
  const { results } = await c.env.DB.prepare(
    `SELECT events.event_id, events.event_type, events.route_outcome,
            events.payload_json, events.created_at, wd.id AS delivery_id,
            wd.status, wd.attempts, wd.completed_at, wd.signing_secret,
            wd.signature_key_version
     FROM (
       SELECT id AS event_id, event_type, app_id, reporter_integration_id,
              reporter_id, route_outcome, payload_json, created_at, 0 AS submission
       FROM feedback_events
       UNION ALL
       SELECT id AS event_id, event_type, app_id, reporter_integration_id,
              reporter_id, route_outcome, payload_json, created_at, 1 AS submission
       FROM feedback_submission_events
     ) events
     LEFT JOIN webhook_deliveries wd
       ON wd.reporter_delivery = 1 AND (
         (events.submission = 0 AND wd.event_id = events.event_id)
         OR (events.submission = 1 AND wd.feedback_submission_event_id = events.event_id)
       )
     WHERE events.app_id = ?1 AND events.reporter_integration_id = ?2
       AND events.reporter_id = ?3
     ORDER BY events.created_at DESC, events.event_id DESC LIMIT 100`,
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
    signing_secret: string | null;
    signature_key_version: string | null;
  }>();
  const audit = await c.env.DB.prepare(
    `SELECT COUNT(*) AS count,
            MAX(json_extract(payload, '$.audit_key_version')) AS audit_key_version
     FROM audit_logs
     WHERE app_id = ?1 AND action = 'feedback.route_bind'
       AND json_extract(payload, '$.reporter_integration_id') = ?2
       AND json_extract(payload, '$.reporter_hash') = ?3`,
  ).bind(appId, integrationId, reporterHash).first<{ count: number; audit_key_version: string | null }>();
  return c.json({
    grant: {
      token_id: tokenId,
      app_role: token?.app_role ?? null,
      scopes,
      grant_valid: grantValid,
      effective_permissions: effectivePermissions,
    },
    route: route ? { bound: true, subject_version: route.subject_version, created_at: route.created_at } : { bound: false },
    matching_subscriber_count: subscribers?.count ?? 0,
    active_exact_subscriber: (subscribers?.count ?? 0) > 0,
    audit: {
      action: "feedback.route_bind",
      count: audit?.count ?? 0,
      key_version: audit?.audit_key_version ?? auditKeyVersion,
    },
    events: await Promise.all(results.map(async ({ payload_json, signing_secret, ...event }) => ({
      ...event,
      payload_sha256: await sha256Hex(payload_json),
      signature_sha256: signing_secret ? await hmacSha256Hex(signing_secret, payload_json) : null,
      retry_stable: signing_secret !== null,
      terminal: event.status === "succeeded" || event.status === "failed",
    }))),
  });
}
