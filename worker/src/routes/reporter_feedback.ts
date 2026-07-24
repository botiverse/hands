import type { Context } from "hono";
import { authenticateReporter, type ReporterPrincipal } from "../lib/reporter_auth";
import { computeReporterAuditHash } from "../lib/reporter_audit";
import { buildFeedbackCommentEvent } from "../lib/feedback_events";

type ReporterContext = Context<{ Bindings: Env }>;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const COMMENT_MAX_CHARS = 10_000;

type ReporterEnv = Env & {
  FEEDBACK_AUDIT_HMAC_KEY?: string;
  FEEDBACK_AUDIT_KEY_VERSION?: string;
};

type Endpoint = "list" | "detail" | "attachment" | "comment";

const LIMITS: Record<Endpoint, { reporter: number; integration: number; windowMs: number }> = {
  list: { reporter: 60, integration: 600, windowMs: 60_000 },
  detail: { reporter: 120, integration: 1_200, windowMs: 60_000 },
  attachment: { reporter: 120, integration: 1_200, windowMs: 3_600_000 },
  comment: { reporter: 30, integration: 300, windowMs: 3_600_000 },
};

function fullUuid(value: string | undefined): string | null {
  const normalized = (value ?? "").trim().toLowerCase();
  return UUID_RE.test(normalized) ? normalized : null;
}

function safeFilename(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120) || "attachment";
}

function encodeCursor(createdAt: unknown, id: unknown): string {
  return btoa(JSON.stringify([createdAt, id]))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function decodeCursor(value: string | undefined): [number, string] | null {
  if (!value) return [Number.MAX_SAFE_INTEGER, "~"];
  try {
    const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
    const decoded = JSON.parse(atob(padded)) as [number, string];
    if (!Number.isSafeInteger(decoded[0]) || !UUID_RE.test(decoded[1])) return null;
    return [decoded[0], decoded[1].toLowerCase()];
  } catch {
    return null;
  }
}

function decodeAscendingCursor(value: string | undefined): [number, string] | null {
  if (!value) return [-1, ""];
  return decodeCursor(value);
}

async function reporterHash(c: ReporterContext, principal: ReporterPrincipal) {
  const env = c.env as ReporterEnv;
  const key = env.FEEDBACK_AUDIT_HMAC_KEY;
  const version = env.FEEDBACK_AUDIT_KEY_VERSION?.trim();
  if (!key || !version) return null;
  const hash = await computeReporterAuditHash({
    key,
    appId: principal.appId,
    integrationId: principal.integrationId,
    reporterId: principal.reporterId,
  });
  if (!hash) return null;
  return { hash, version };
}

async function authorize(
  c: ReporterContext,
  permission: "feedback:read" | "feedback:comment",
  endpoint: Endpoint,
) {
  const auth = await authenticateReporter(c, permission);
  if (!auth.ok) return auth;
  const pseudonym = await reporterHash(c, auth.principal);
  if (!pseudonym) {
    return { ok: false as const, response: c.json({ error: "reporter audit is not configured" }, 503) };
  }
  const rate = await consumeRateLimit(c, auth.principal, pseudonym, endpoint);
  if (!rate.ok) return rate;
  return { ok: true as const, principal: auth.principal, pseudonym };
}

async function consumeRateLimit(
  c: ReporterContext,
  principal: ReporterPrincipal,
  pseudonym: { hash: string; version: string },
  endpoint: Endpoint,
) {
  const limit = LIMITS[endpoint];
  const now = Date.now();
  const windowStartedAt = Math.floor(now / limit.windowMs) * limit.windowMs;
  const upsert = (subject: string) => c.env.DB.prepare(
    `INSERT INTO feedback_reporter_rate_windows
     (app_id, reporter_integration_id, reporter_hash, audit_key_version,
      endpoint, window_started_at, request_count, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1, ?7)
     ON CONFLICT(app_id, reporter_integration_id, reporter_hash,
                 audit_key_version, endpoint, window_started_at)
     DO UPDATE SET request_count = request_count + 1, updated_at = excluded.updated_at`,
  ).bind(
    principal.appId,
    principal.integrationId,
    subject,
    pseudonym.version,
    endpoint,
    windowStartedAt,
    now,
  );
  await c.env.DB.batch([upsert(pseudonym.hash), upsert("integration-total")]);
  const { results } = await c.env.DB.prepare(
    `SELECT reporter_hash, request_count
     FROM feedback_reporter_rate_windows
     WHERE app_id = ?1 AND reporter_integration_id = ?2
       AND reporter_hash IN (?3, 'integration-total')
       AND audit_key_version = ?4 AND endpoint = ?5 AND window_started_at = ?6`,
  ).bind(
    principal.appId,
    principal.integrationId,
    pseudonym.hash,
    pseudonym.version,
    endpoint,
    windowStartedAt,
  ).all<{ reporter_hash: string; request_count: number }>();
  const reporterCount = results.find((row) => row.reporter_hash === pseudonym.hash)?.request_count ?? 0;
  const integrationCount = results.find((row) => row.reporter_hash === "integration-total")?.request_count ?? 0;
  if (reporterCount > limit.reporter || integrationCount > limit.integration) {
    c.header("Retry-After", String(Math.max(1, Math.ceil((windowStartedAt + limit.windowMs - now) / 1000))));
    return { ok: false as const, response: c.json({ error: "reporter rate limit exceeded" }, 429) };
  }
  return { ok: true as const };
}

async function auditRead(
  c: ReporterContext,
  principal: ReporterPrincipal,
  pseudonym: { hash: string; version: string },
  endpoint: Endpoint,
  input?: { ticketId?: string; attachmentId?: string; everyTime?: boolean },
) {
  const now = Date.now();
  const id = crypto.randomUUID();
  if (input?.everyTime) {
    await c.env.DB.prepare(
      `INSERT INTO feedback_reporter_access_audits
       (id, app_id, reporter_integration_id, reporter_hash, audit_key_version,
        endpoint, ticket_id, attachment_id, throttle_window_started_at, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, NULL, ?9)`,
    ).bind(
      id,
      principal.appId,
      principal.integrationId,
      pseudonym.hash,
      pseudonym.version,
      endpoint,
      input.ticketId ?? null,
      input.attachmentId ?? null,
      now,
    ).run();
    return;
  }
  const throttleWindow = Math.floor(now / (10 * 60_000)) * (10 * 60_000);
  await c.env.DB.prepare(
    `INSERT OR IGNORE INTO feedback_reporter_access_audits
     (id, app_id, reporter_integration_id, reporter_hash, audit_key_version,
      endpoint, ticket_id, attachment_id, throttle_window_started_at, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
  ).bind(
    id,
    principal.appId,
    principal.integrationId,
    pseudonym.hash,
    pseudonym.version,
    endpoint,
    input?.ticketId ?? null,
    input?.attachmentId ?? null,
    throttleWindow,
    now,
  ).run();
}

function ticketNotFound(c: ReporterContext) {
  return c.json({ error: "feedback ticket not found" }, 404);
}

function ticketDto(row: Record<string, unknown>) {
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    message: row.message,
    version_name: row.version_name,
    version_code: row.version_code,
    channel: row.channel,
    created_at: row.created_at,
    updated_at: row.updated_at,
    attachment_count: row.attachment_count,
    comment_count: row.comment_count,
    latest_comment_at: row.latest_comment_at,
  };
}

export async function handleListReporterFeedback(c: ReporterContext) {
  const authorized = await authorize(c, "feedback:read", "list");
  if (!authorized.ok) return authorized.response;
  const limit = Math.min(50, Math.max(1, Number(c.req.query("limit") ?? "20") || 20));
  const decodedCursor = decodeCursor(c.req.query("cursor"));
  if (!decodedCursor) return c.json({ error: "invalid cursor" }, 400);
  const [cursorCreatedAt, cursorId] = decodedCursor;
  const { results } = await c.env.DB.prepare(
    `SELECT t.id, t.kind, t.status, t.message, t.version_name, t.version_code,
            t.channel, t.created_at, t.updated_at,
            (SELECT COUNT(*) FROM feedback_attachments fa
             WHERE fa.ticket_id = t.id AND fa.origin = 'submission'
               AND fa.visibility = 'reporter') AS attachment_count,
            (SELECT COUNT(*) FROM feedback_comments fc
             WHERE fc.ticket_id = t.id AND fc.internal = 0) AS comment_count,
            (SELECT MAX(fc.created_at) FROM feedback_comments fc
             WHERE fc.ticket_id = t.id AND fc.internal = 0) AS latest_comment_at
     FROM feedback_tickets t
     WHERE t.app_id = ?1 AND t.reporter_integration_id = ?2 AND t.reporter_id = ?3
       AND (t.created_at < ?4 OR (t.created_at = ?4 AND t.id < ?5))
     ORDER BY t.created_at DESC, t.id DESC LIMIT ?6`,
  ).bind(
    authorized.principal.appId,
    authorized.principal.integrationId,
    authorized.principal.reporterId,
    cursorCreatedAt,
    cursorId,
    limit + 1,
  ).all<Record<string, unknown>>();
  const page = results.slice(0, limit);
  const last = page.at(-1);
  const nextCursor = results.length > limit && last
    ? encodeCursor(last.created_at, last.id)
    : null;
  await auditRead(c, authorized.principal, authorized.pseudonym, "list");
  return c.json({ tickets: page.map(ticketDto), next_cursor: nextCursor });
}

async function ownedTicket(c: ReporterContext, principal: ReporterPrincipal, ticketId: string) {
  return c.env.DB.prepare(
    `SELECT t.id, t.kind, t.status, t.message, t.version_name, t.version_code,
            t.channel, t.created_at, t.updated_at, a.org_id,
            (SELECT COUNT(*) FROM feedback_attachments fa
             WHERE fa.ticket_id = t.id AND fa.origin = 'submission'
               AND fa.visibility = 'reporter') AS attachment_count,
            (SELECT COUNT(*) FROM feedback_comments fc
             WHERE fc.ticket_id = t.id AND fc.internal = 0) AS comment_count,
            (SELECT MAX(fc.created_at) FROM feedback_comments fc
             WHERE fc.ticket_id = t.id AND fc.internal = 0) AS latest_comment_at
     FROM feedback_tickets t JOIN apps a ON a.id = t.app_id
     WHERE t.id = ?1 AND t.app_id = ?2
       AND t.reporter_integration_id = ?3 AND t.reporter_id = ?4`,
  ).bind(ticketId, principal.appId, principal.integrationId, principal.reporterId)
    .first<Record<string, unknown> & { org_id: string | null }>();
}

export async function handleGetReporterFeedback(c: ReporterContext) {
  const authorized = await authorize(c, "feedback:read", "detail");
  if (!authorized.ok) return authorized.response;
  const ticketId = fullUuid(c.req.param("ticketId"));
  if (!ticketId) return ticketNotFound(c);
  const ticket = await ownedTicket(c, authorized.principal, ticketId);
  if (!ticket) return ticketNotFound(c);
  const commentLimit = Math.min(100, Math.max(1, Number(c.req.query("comment_limit") ?? "50") || 50));
  const decodedCommentCursor = decodeAscendingCursor(c.req.query("comment_cursor"));
  if (!decodedCommentCursor) return c.json({ error: "invalid comment cursor" }, 400);
  const [commentCursorCreatedAt, commentCursorId] = decodedCommentCursor;
  const [{ results: comments }, { results: attachments }] = await Promise.all([
    c.env.DB.prepare(
      `SELECT id, author_type, body, created_at
       FROM feedback_comments
       WHERE ticket_id = ?1 AND internal = 0
         AND (created_at > ?2 OR (created_at = ?2 AND id > ?3))
       ORDER BY created_at ASC, id ASC LIMIT ?4`,
    ).bind(ticketId, commentCursorCreatedAt, commentCursorId, commentLimit + 1).all<Record<string, unknown>>(),
    c.env.DB.prepare(
      `SELECT id, filename, content_type, size_bytes, created_at
       FROM feedback_attachments
       WHERE ticket_id = ?1 AND origin = 'submission' AND visibility = 'reporter'
       ORDER BY created_at, id`,
    ).bind(ticketId).all(),
  ]);
  await auditRead(c, authorized.principal, authorized.pseudonym, "detail", { ticketId });
  const { org_id: _orgId, ...safeTicket } = ticket;
  const commentPage = comments.slice(0, commentLimit);
  const lastComment = commentPage.at(-1);
  const nextCommentCursor = comments.length > commentLimit && lastComment
    ? encodeCursor(lastComment.created_at, lastComment.id)
    : null;
  return c.json({
    ticket: ticketDto(safeTicket),
    comments: commentPage,
    next_comment_cursor: nextCommentCursor,
    attachments,
  });
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function handleAddReporterComment(c: ReporterContext) {
  const authorized = await authorize(c, "feedback:comment", "comment");
  if (!authorized.ok) return authorized.response;
  const ticketId = fullUuid(c.req.param("ticketId"));
  if (!ticketId) return ticketNotFound(c);
  const ticket = await ownedTicket(c, authorized.principal, ticketId);
  if (!ticket) return ticketNotFound(c);
  const body = (await c.req.json().catch(() => ({}))) as { body?: unknown; submission_id?: unknown };
  const text = typeof body.body === "string" ? body.body.trim() : "";
  const submissionId = fullUuid(typeof body.submission_id === "string" ? body.submission_id : undefined);
  if (!text) return c.json({ error: "body is required" }, 400);
  if ([...text].length > COMMENT_MAX_CHARS) return c.json({ error: `body too long (max ${COMMENT_MAX_CHARS} chars)` }, 400);
  if (!submissionId) return c.json({ error: "submission_id must be a UUID" }, 400);
  const fingerprint = await sha256Hex(text);
  const existingComment = async () => c.env.DB.prepare(
    `SELECT id, submission_fingerprint, created_at FROM feedback_comments
     WHERE ticket_id = ?1 AND reporter_integration_id = ?2
       AND reporter_id = ?3 AND submission_id = ?4`,
  ).bind(ticketId, authorized.principal.integrationId, authorized.principal.reporterId, submissionId)
    .first<{ id: string; submission_fingerprint: string; created_at: number }>();
  const prior = await existingComment();
  if (prior) {
    if (prior.submission_fingerprint !== fingerprint) {
      return c.json({ error: "submission_id already used with a different body" }, 409);
    }
    return c.json({ id: prior.id, ticket_id: ticketId, created_at: prior.created_at, idempotent_replay: true });
  }

  const now = Date.now();
  const commentId = crypto.randomUUID();
  const eventId = crypto.randomUUID();
  const eventBody = buildFeedbackCommentEvent({
    eventId,
    eventType: "feedback:comment_created",
    createdAt: now,
    orgId: ticket.org_id!,
    appId: authorized.principal.appId,
    ticketId,
    reporterIntegrationId: authorized.principal.integrationId,
    reporterId: authorized.principal.reporterId,
    comment: { id: commentId, author_type: "reporter", body: text, created_at: now },
  });
  const auditPayload = JSON.stringify({
    ticket_id: ticketId,
    comment_id: commentId,
    reporter_hash: authorized.pseudonym.hash,
    audit_key_version: authorized.pseudonym.version,
  });
  try {
    await c.env.DB.batch([
      c.env.DB.prepare(
        `INSERT INTO feedback_comments
         (id, ticket_id, author_actor, author_type, body, internal,
          reporter_integration_id, reporter_id, submission_id,
          submission_fingerprint, created_at)
         VALUES (?1, ?2, ?3, 'reporter', ?4, 0, ?5, ?6, ?7, ?8, ?9)`,
      ).bind(
        commentId,
        ticketId,
        `reporter:${authorized.pseudonym.hash}`,
        text,
        authorized.principal.integrationId,
        authorized.principal.reporterId,
        submissionId,
        fingerprint,
        now,
      ),
      c.env.DB.prepare("UPDATE feedback_tickets SET updated_at = ?1 WHERE id = ?2").bind(now, ticketId),
      c.env.DB.prepare(
        `INSERT INTO audit_logs (id, app_id, action, actor, payload, created_at)
         VALUES (?1, ?2, 'feedback.reporter_comment', ?3, ?4, ?5)`,
      ).bind(crypto.randomUUID(), authorized.principal.appId, `reporter:${authorized.pseudonym.hash}`, auditPayload, now),
      c.env.DB.prepare(
        `INSERT INTO feedback_events
         (id, event_type, app_id, ticket_id, reporter_integration_id,
          reporter_id, payload_json, route_outcome, route_subject, created_at)
         SELECT ?1, 'feedback:comment_created', ?2, ?3, ?4, ?5,
                CASE WHEN r.route_subject IS NULL
                  THEN json_set(?6, '$.payload.route_outcome', 'route_unbound')
                  ELSE json_set(?6, '$.payload.route_outcome', 'route_bound',
                                     '$.payload.route_subject', r.route_subject)
                END,
                CASE WHEN r.route_subject IS NULL THEN 'route_unbound' ELSE 'route_bound' END,
                r.route_subject, ?7
         FROM feedback_tickets t
         LEFT JOIN app_reporter_routes r
           ON r.app_id = t.app_id AND r.reporter_integration_id = t.reporter_integration_id
          AND r.reporter_id = t.reporter_id
         WHERE t.id = ?3 AND t.app_id = ?2
           AND t.reporter_integration_id = ?4 AND t.reporter_id = ?5`,
      ).bind(
        eventId,
        authorized.principal.appId,
        ticketId,
        authorized.principal.integrationId,
        authorized.principal.reporterId,
        eventBody,
        now,
      ),
      c.env.DB.prepare(
        `INSERT INTO webhook_deliveries
         (id, webhook_id, event_type, event_id, payload_json, status,
          attempts, max_attempts, next_attempt_at, created_at, updated_at)
         SELECT ?1 || ':' || w.id, w.id, 'feedback:comment_created', ?1, ?2,
                'pending', 0, 3, ?3, ?3, ?3
         FROM feedback_events fe
         JOIN webhooks w ON w.org_id = ?4
         WHERE fe.id = ?1 AND w.enabled = 1 AND w.archived_at IS NULL
           AND (w.app_id IS NULL OR w.app_id = ?5)
           AND CASE WHEN json_valid(w.events_json) THEN (
             json_array_length(w.events_json) = 0
             OR EXISTS (SELECT 1 FROM json_each(w.events_json) e
                        WHERE e.value IN ('feedback:comment_created', '*'))
           ) ELSE 0 END
           AND NOT EXISTS (
             SELECT 1 FROM app_reporter_webhook_subscriptions s
             WHERE s.webhook_id = w.id AND s.app_id = fe.app_id
               AND s.reporter_integration_id = fe.reporter_integration_id
           )
         ON CONFLICT(webhook_id, event_id) WHERE event_id IS NOT NULL DO NOTHING`,
      ).bind(eventId, eventBody, now, ticket.org_id, authorized.principal.appId),
      c.env.DB.prepare(
        `INSERT INTO webhook_deliveries
         (id, webhook_id, event_type, event_id, payload_json, status,
          attempts, max_attempts, next_attempt_at, created_at, updated_at)
         SELECT ?1 || ':' || w.id, w.id, 'feedback:comment_created', ?1,
                fe.payload_json, 'pending', 0, 3, ?2, ?2, ?2
         FROM feedback_events fe
         JOIN app_reporter_webhook_subscriptions s
           ON s.app_id = fe.app_id
          AND s.reporter_integration_id = fe.reporter_integration_id
         JOIN webhooks w ON w.id = s.webhook_id
         JOIN app_reporter_integrations ri
           ON ri.id = s.reporter_integration_id AND ri.app_id = s.app_id
         WHERE fe.id = ?1 AND fe.route_outcome = 'route_bound'
           AND fe.route_subject IS NOT NULL
           AND w.app_id = fe.app_id AND w.org_id = ?3
           AND w.enabled = 1 AND w.archived_at IS NULL
           AND ri.archived_at IS NULL
           AND CASE WHEN json_valid(w.events_json) THEN (
             json_array_length(w.events_json) = 0
             OR EXISTS (SELECT 1 FROM json_each(w.events_json) e
                        WHERE e.value IN ('feedback:comment_created', '*'))
           ) ELSE 0 END
         ON CONFLICT(webhook_id, event_id) WHERE event_id IS NOT NULL DO NOTHING`,
      ).bind(eventId, now, ticket.org_id),
    ]);
  } catch (error) {
    const concurrent = await existingComment();
    if (concurrent) {
      if (concurrent.submission_fingerprint !== fingerprint) {
        return c.json({ error: "submission_id already used with a different body" }, 409);
      }
      return c.json({ id: concurrent.id, ticket_id: ticketId, created_at: concurrent.created_at, idempotent_replay: true });
    }
    throw error;
  }
  return c.json({ id: commentId, ticket_id: ticketId, created_at: now, idempotent_replay: false }, 201);
}

export async function handleDownloadReporterAttachment(c: ReporterContext) {
  const authorized = await authorize(c, "feedback:read", "attachment");
  if (!authorized.ok) return authorized.response;
  const ticketId = fullUuid(c.req.param("ticketId"));
  const attachmentId = fullUuid(c.req.param("attachmentId"));
  if (!ticketId || !attachmentId) return ticketNotFound(c);
  const row = await c.env.DB.prepare(
    `SELECT fa.r2_key, fa.filename, fa.content_type
     FROM feedback_attachments fa
     JOIN feedback_tickets t ON t.id = fa.ticket_id
     WHERE t.id = ?1 AND t.app_id = ?2
       AND t.reporter_integration_id = ?3 AND t.reporter_id = ?4
       AND fa.id = ?5 AND fa.origin = 'submission' AND fa.visibility = 'reporter'`,
  ).bind(
    ticketId,
    authorized.principal.appId,
    authorized.principal.integrationId,
    authorized.principal.reporterId,
    attachmentId,
  ).first<{ r2_key: string; filename: string; content_type: string | null }>();
  if (!row) return ticketNotFound(c);
  await auditRead(c, authorized.principal, authorized.pseudonym, "attachment", {
    ticketId,
    attachmentId,
    everyTime: true,
  });
  const object = await c.env.APK_BUCKET.get(row.r2_key);
  if (!object) return ticketNotFound(c);
  const filename = safeFilename(row.filename);
  return new Response(object.body, {
    headers: {
      "content-type": row.content_type ?? "application/octet-stream",
      "content-disposition": `attachment; filename="${filename}"`,
      "x-content-type-options": "nosniff",
      "cache-control": "private, no-store",
    },
  });
}

export async function cleanupReporterFeedbackData(env: Env, now = Date.now()) {
  await env.DB.batch([
    env.DB.prepare(
      "DELETE FROM feedback_reporter_rate_windows WHERE updated_at < ?1",
    ).bind(now - 24 * 60 * 60_000),
    env.DB.prepare(
      "DELETE FROM feedback_reporter_access_audits WHERE created_at < ?1",
    ).bind(now - 30 * 24 * 60 * 60_000),
  ]);
}
