import type { Context } from "hono";
import { authenticateReporter, type ReporterPrincipal } from "../lib/reporter_auth";
import { computeReporterAuditHash } from "../lib/reporter_audit";
import { buildFeedbackCommentEvent } from "../lib/feedback_events";
import { feedbackReporterEventStatements } from "./feedback";

type ReporterContext = Context<{ Bindings: Env }>;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const COMMENT_MAX_CHARS = 10_000;
const COMMENT_MAX_ATTACHMENTS = 3;
const COMMENT_MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const COMMENT_UPLOAD_LEASE_MS = 15 * 60_000;
const COMMENT_ATTACHMENT_TYPES = new Set([
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

type ReporterEnv = Env & {
  FEEDBACK_AUDIT_HMAC_KEY?: string;
  FEEDBACK_AUDIT_KEY_VERSION?: string;
};

type Endpoint = "list" | "detail" | "attachment" | "comment" | "close";

function timingDuration(start: number, end: number): string {
  return Math.max(0, end - start).toFixed(1);
}

function sessionVerifyTiming(principal: ReporterPrincipal): string[] {
  return principal.sessionVerifyDurationMs === null
    ? []
    : [`hands_session_verify;dur=${principal.sessionVerifyDurationMs.toFixed(1)}`];
}

const LIMITS: Record<Endpoint, { reporter: number; integration: number; windowMs: number }> = {
  list: { reporter: 60, integration: 600, windowMs: 60_000 },
  detail: { reporter: 120, integration: 1_200, windowMs: 60_000 },
  attachment: { reporter: 120, integration: 1_200, windowMs: 3_600_000 },
  comment: { reporter: 30, integration: 300, windowMs: 3_600_000 },
  close: { reporter: 30, integration: 300, windowMs: 3_600_000 },
};

function fullUuid(value: string | undefined): string | null {
  const normalized = (value ?? "").trim().toLowerCase();
  return UUID_RE.test(normalized) ? normalized : null;
}

function safeFilename(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120) || "attachment";
}

function encodeCursorValue(value: unknown): string {
  return btoa(JSON.stringify(value))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function decodeCursorValue(value: string): unknown {
  try {
    const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
    return JSON.parse(atob(padded));
  } catch {
    return null;
  }
}

function encodeCursor(createdAt: unknown, id: unknown): string {
  return encodeCursorValue([createdAt, id]);
}

function decodeCursor(value: string | undefined): [number, string] | null {
  if (!value) return [Number.MAX_SAFE_INTEGER, "~"];
  try {
    const decoded = decodeCursorValue(value) as [number, string];
    if (!Number.isSafeInteger(decoded[0]) || !UUID_RE.test(decoded[1])) return null;
    return [decoded[0], decoded[1].toLowerCase()];
  } catch {
    return null;
  }
}

type CommentCursor =
  | { mode: "sequence"; sequence: number; id: string }
  | { mode: "legacy"; createdAt: number; id: string };

function decodeCommentCursor(value: string | undefined): CommentCursor | null {
  if (!value) return { mode: "sequence", sequence: 0, id: "" };
  const decoded = decodeCursorValue(value);
  if (
    Array.isArray(decoded)
    && decoded.length === 3
    && decoded[0] === "sequence-v1"
    && Number.isSafeInteger(decoded[1])
    && decoded[1] >= 0
    && typeof decoded[2] === "string"
    && UUID_RE.test(decoded[2])
  ) {
    return { mode: "sequence", sequence: decoded[1], id: decoded[2].toLowerCase() };
  }
  if (
    Array.isArray(decoded)
    && decoded.length === 2
    && Number.isSafeInteger(decoded[0])
    && typeof decoded[1] === "string"
    && UUID_RE.test(decoded[1])
  ) {
    return { mode: "legacy", createdAt: decoded[0], id: decoded[1].toLowerCase() };
  }
  return null;
}

function encodeCommentSequenceCursor(sequence: unknown, id: unknown): string {
  return encodeCursorValue(["sequence-v1", sequence, id]);
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
     DO UPDATE SET request_count = request_count + 1, updated_at = excluded.updated_at
     RETURNING request_count`,
  ).bind(
    principal.appId,
    principal.integrationId,
    subject,
    pseudonym.version,
    endpoint,
    windowStartedAt,
    now,
  );
  // RETURNING makes the atomic increment its own authoritative limit read;
  // a separate SELECT would add latency and create another observable race.
  const [reporterResult, integrationResult] = await c.env.DB.batch([
    upsert(pseudonym.hash),
    upsert("integration-total"),
  ]);
  const reporterCount = (reporterResult?.results[0] as { request_count?: number } | undefined)
    ?.request_count ?? 0;
  const integrationCount = (integrationResult?.results[0] as { request_count?: number } | undefined)
    ?.request_count ?? 0;
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
  await auditReadStatement(c, principal, pseudonym, endpoint, input).run();
}

function auditReadStatement(
  c: ReporterContext,
  principal: ReporterPrincipal,
  pseudonym: { hash: string; version: string },
  endpoint: Endpoint,
  input?: { ticketId?: string; attachmentId?: string; everyTime?: boolean },
) {
  const now = Date.now();
  const id = crypto.randomUUID();
  if (input?.everyTime) {
    return c.env.DB.prepare(
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
    );
  }
  const throttleWindow = Math.floor(now / (10 * 60_000)) * (10 * 60_000);
  return c.env.DB.prepare(
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
  );
}

function ticketNotFound(c: ReporterContext) {
  return c.json({ error: "feedback ticket not found" }, 404);
}

function ticketDto(row: Record<string, unknown>) {
  const unreadCount = typeof row.unread_count === "number"
    ? Math.max(0, row.unread_count)
    : 0;
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    closure_reason: row.closure_reason ?? null,
    // A team may deduplicate across reporters. The original ticket id is an
    // admin/audit fact, not reporter-visible routing data.
    duplicate_of_ticket_id: null,
    message: row.message,
    version_name: row.version_name,
    version_code: row.version_code,
    channel: row.channel,
    created_at: row.created_at,
    updated_at: row.updated_at,
    attachment_count: row.attachment_count,
    comment_count: row.comment_count,
    latest_comment_at: row.latest_comment_at,
    unread: unreadCount > 0,
    unread_count: unreadCount,
  };
}

const unreadCountSql = `(SELECT COUNT(*) FROM feedback_comments unread_comment
  WHERE unread_comment.ticket_id = t.id
    AND unread_comment.internal = 0
    AND unread_comment.author_type IN ('staff', 'system')
    AND (
      rr.ticket_id IS NULL
      OR unread_comment.reporter_sequence > rr.read_through_sequence
    ))`;

function unreadTotalStatement(
  c: ReporterContext,
  principal: ReporterPrincipal,
) {
  return c.env.DB.prepare(
    `SELECT COUNT(*) AS unread_total FROM feedback_tickets t
     LEFT JOIN feedback_reporter_ticket_reads rr
       ON rr.app_id = t.app_id
      AND rr.reporter_integration_id = t.reporter_integration_id
      AND rr.reporter_id = t.reporter_id
      AND rr.ticket_id = t.id
     WHERE t.app_id = ?1 AND t.reporter_integration_id = ?2
       AND t.reporter_id = ?3 AND ${unreadCountSql} > 0`,
  ).bind(principal.appId, principal.integrationId, principal.reporterId);
}

async function unreadTotal(
  c: ReporterContext,
  principal: ReporterPrincipal,
): Promise<number> {
  const row = await unreadTotalStatement(c, principal)
    .first<{ unread_total: number }>();
  return Math.max(0, row?.unread_total ?? 0);
}

export async function handleListReporterFeedback(c: ReporterContext) {
  const startedAt = performance.now();
  const authorized = await authorize(c, "feedback:read", "list");
  if (!authorized.ok) return authorized.response;
  const authorizedAt = performance.now();
  const limit = Math.min(50, Math.max(1, Number(c.req.query("limit") ?? "20") || 20));
  const decodedCursor = decodeCursor(c.req.query("cursor"));
  if (!decodedCursor) return c.json({ error: "invalid cursor" }, 400);
  const [cursorCreatedAt, cursorId] = decodedCursor;
  const ticketStatement = c.env.DB.prepare(
    `SELECT t.id, t.kind, t.status, t.closure_reason, t.duplicate_of_ticket_id,
            t.message, t.version_name, t.version_code,
            t.channel, t.created_at, t.updated_at,
            (SELECT COUNT(*) FROM feedback_attachments fa
             WHERE fa.ticket_id = t.id AND fa.origin IN ('submission', 'reporter')
               AND fa.visibility = 'reporter') AS attachment_count,
            (SELECT COUNT(*) FROM feedback_comments fc
             WHERE fc.ticket_id = t.id AND fc.internal = 0) AS comment_count,
            (SELECT MAX(fc.created_at) FROM feedback_comments fc
             WHERE fc.ticket_id = t.id AND fc.internal = 0) AS latest_comment_at,
            ${unreadCountSql} AS unread_count
     FROM feedback_tickets t
     LEFT JOIN feedback_reporter_ticket_reads rr
       ON rr.app_id = t.app_id
      AND rr.reporter_integration_id = t.reporter_integration_id
      AND rr.reporter_id = t.reporter_id
      AND rr.ticket_id = t.id
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
  );
  const [ticketResult, unreadResult] = await c.env.DB.batch([
    ticketStatement,
    unreadTotalStatement(c, authorized.principal),
    auditReadStatement(c, authorized.principal, authorized.pseudonym, "list"),
  ]);
  const results = (ticketResult?.results ?? []) as Record<string, unknown>[];
  const unreadRow = unreadResult?.results[0] as { unread_total?: number } | undefined;
  const totalUnread = Math.max(0, unreadRow?.unread_total ?? 0);
  const queriedAt = performance.now();
  const page = results.slice(0, limit);
  const last = page.at(-1);
  const nextCursor = results.length > limit && last
    ? encodeCursor(last.created_at, last.id)
    : null;
  c.header("Server-Timing", [
    ...sessionVerifyTiming(authorized.principal),
    `hands_auth;dur=${timingDuration(startedAt, authorizedAt)}`,
    `hands_list;dur=${timingDuration(authorizedAt, queriedAt)}`,
  ].join(", "));
  return c.json({
    tickets: page.map(ticketDto),
    next_cursor: nextCursor,
    unread_total: totalUnread,
  });
}

function ownedTicketStatement(
  c: ReporterContext,
  principal: ReporterPrincipal,
  ticketId: string,
) {
  return c.env.DB.prepare(
    `SELECT t.id, t.kind, t.status, t.closure_reason, t.duplicate_of_ticket_id,
            t.message, t.version_name, t.version_code,
            t.channel, t.created_at, t.updated_at, a.org_id,
            (SELECT COUNT(*) FROM feedback_attachments fa
             WHERE fa.ticket_id = t.id AND fa.origin IN ('submission', 'reporter')
               AND fa.visibility = 'reporter') AS attachment_count,
            (SELECT COUNT(*) FROM feedback_comments fc
             WHERE fc.ticket_id = t.id AND fc.internal = 0) AS comment_count,
            (SELECT MAX(fc.created_at) FROM feedback_comments fc
             WHERE fc.ticket_id = t.id AND fc.internal = 0) AS latest_comment_at,
            ${unreadCountSql} AS unread_count
     FROM feedback_tickets t JOIN apps a ON a.id = t.app_id
     LEFT JOIN feedback_reporter_ticket_reads rr
       ON rr.app_id = t.app_id
      AND rr.reporter_integration_id = t.reporter_integration_id
      AND rr.reporter_id = t.reporter_id
      AND rr.ticket_id = t.id
     WHERE t.id = ?1 AND t.app_id = ?2
       AND t.reporter_integration_id = ?3 AND t.reporter_id = ?4`,
  ).bind(ticketId, principal.appId, principal.integrationId, principal.reporterId);
}

async function ownedTicket(c: ReporterContext, principal: ReporterPrincipal, ticketId: string) {
  return ownedTicketStatement(c, principal, ticketId)
    .first<Record<string, unknown> & { org_id: string | null }>();
}

function markTicketReadStatement(
  c: ReporterContext,
  principal: ReporterPrincipal,
  ticketId: string,
  latest: { id: string; reporter_sequence: number },
) {
  const now = Date.now();
  return c.env.DB.prepare(
    `INSERT INTO feedback_reporter_ticket_reads
     (app_id, reporter_integration_id, reporter_id, ticket_id,
      read_through_sequence, read_through_comment_id, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
     ON CONFLICT(app_id, reporter_integration_id, reporter_id, ticket_id)
     DO UPDATE SET
       read_through_sequence = CASE
         WHEN excluded.read_through_sequence > read_through_sequence
         THEN excluded.read_through_sequence ELSE read_through_sequence END,
       read_through_comment_id = CASE
         WHEN excluded.read_through_sequence > read_through_sequence
         THEN excluded.read_through_comment_id ELSE read_through_comment_id END,
       updated_at = excluded.updated_at`,
  ).bind(
    principal.appId,
    principal.integrationId,
    principal.reporterId,
    ticketId,
    latest.reporter_sequence,
    latest.id,
    now,
  );
}

export async function handleGetReporterFeedback(c: ReporterContext) {
  const startedAt = performance.now();
  const authorized = await authorize(c, "feedback:read", "detail");
  if (!authorized.ok) return authorized.response;
  const authorizedAt = performance.now();
  const ticketId = fullUuid(c.req.param("ticketId"));
  if (!ticketId) return ticketNotFound(c);
  const commentLimit = Math.min(100, Math.max(1, Number(c.req.query("comment_limit") ?? "50") || 50));
  const commentCursor = decodeCommentCursor(c.req.query("comment_cursor"));
  if (!commentCursor) return c.json({ error: "invalid comment cursor" }, 400);
  const commentStatement = commentCursor.mode === "sequence"
    ? c.env.DB.prepare(
        `SELECT fc.id, fc.author_type, fc.body, fc.created_at, fc.reporter_sequence
         FROM feedback_comments fc
         JOIN feedback_tickets t ON t.id = fc.ticket_id
         WHERE fc.ticket_id = ?1 AND t.app_id = ?2
           AND t.reporter_integration_id = ?3 AND t.reporter_id = ?4
           AND fc.internal = 0 AND fc.reporter_sequence > ?5
         ORDER BY fc.reporter_sequence ASC LIMIT ?6`,
      ).bind(
        ticketId,
        authorized.principal.appId,
        authorized.principal.integrationId,
        authorized.principal.reporterId,
        commentCursor.sequence,
        commentLimit + 1,
      )
    : c.env.DB.prepare(
        `SELECT fc.id, fc.author_type, fc.body, fc.created_at, fc.reporter_sequence
         FROM feedback_comments fc
         JOIN feedback_tickets t ON t.id = fc.ticket_id
         WHERE fc.ticket_id = ?1 AND t.app_id = ?2
           AND t.reporter_integration_id = ?3 AND t.reporter_id = ?4
           AND fc.internal = 0
           AND (fc.created_at > ?5 OR (fc.created_at = ?5 AND fc.id > ?6))
         ORDER BY fc.created_at ASC, fc.id ASC LIMIT ?7`,
      ).bind(
        ticketId,
        authorized.principal.appId,
        authorized.principal.integrationId,
        authorized.principal.reporterId,
        commentCursor.createdAt,
        commentCursor.id,
        commentLimit + 1,
      );
  const attachmentStatement =
    c.env.DB.prepare(
      `SELECT fa.id, fa.filename, fa.content_type, fa.size_bytes, fa.created_at
       FROM feedback_attachments fa
       JOIN feedback_tickets t ON t.id = fa.ticket_id
       WHERE fa.ticket_id = ?1 AND t.app_id = ?2
         AND t.reporter_integration_id = ?3 AND t.reporter_id = ?4
         AND fa.origin IN ('submission', 'reporter') AND fa.visibility = 'reporter'
       ORDER BY fa.created_at, fa.id`,
    ).bind(
      ticketId,
      authorized.principal.appId,
      authorized.principal.integrationId,
      authorized.principal.reporterId,
    );
  // One consistent, owner-constrained read phase. Comments and attachments
  // repeat the principal predicates so even the internal batch never reads a
  // different reporter's payload while establishing ticket ownership.
  const [ticketResult, commentResult, attachmentResult] = await c.env.DB.batch([
    ownedTicketStatement(c, authorized.principal, ticketId),
    commentStatement,
    attachmentStatement,
  ]);
  const ticket = ticketResult?.results[0] as
    | (Record<string, unknown> & { org_id: string | null })
    | undefined;
  if (!ticket) return ticketNotFound(c);
  const comments = (commentResult?.results ?? []) as Record<string, unknown>[];
  const attachments = (attachmentResult?.results ?? []) as Record<string, unknown>[];
  const readAt = performance.now();
  const commentPage = comments.slice(0, commentLimit);
  // A legacy (created_at, id)-ordered page is not necessarily contiguous in
  // reporter_sequence, so a single high-water receipt cannot represent it
  // without false-reading unseen rows. Legacy sessions paginate only; the next
  // fresh sequence session advances the authoritative receipt.
  const readWatermark = commentCursor.mode === "sequence"
    ? [...commentPage].reverse().find((comment) =>
        (comment.author_type === "staff" || comment.author_type === "system")
        && typeof comment.reporter_sequence === "number"
        && typeof comment.id === "string"
      ) as { id: string; reporter_sequence: number } | undefined
    : undefined;
  const receiptStatements = [
    auditReadStatement(c, authorized.principal, authorized.pseudonym, "detail", { ticketId }),
    ...(readWatermark
      ? [markTicketReadStatement(c, authorized.principal, ticketId, readWatermark)]
      : []),
    unreadTotalStatement(c, authorized.principal),
    ownedTicketStatement(c, authorized.principal, ticketId),
  ];
  // D1 batch ordering makes the receipt visible to the unread/refreshed-ticket
  // reads in the same round trip. A comment committed after the page snapshot
  // remains unread and is deliberately not advanced by this receipt.
  const receiptResults = await c.env.DB.batch(receiptStatements);
  const unreadIndex = readWatermark ? 2 : 1;
  const unreadRow = receiptResults[unreadIndex]?.results[0] as
    | { unread_total?: number }
    | undefined;
  const totalUnread = Math.max(0, unreadRow?.unread_total ?? 0);
  const refreshedTicket = receiptResults[unreadIndex + 1]?.results[0] as
    | (Record<string, unknown> & { org_id: string | null })
    | undefined;
  const committedAt = performance.now();
  const { org_id: _orgId, ...safeTicket } = refreshedTicket ?? ticket;
  const lastComment = commentPage.at(-1);
  const nextCommentCursor = comments.length > commentLimit && lastComment
    ? commentCursor.mode === "legacy"
      ? encodeCursor(lastComment.created_at, lastComment.id)
      : encodeCommentSequenceCursor(lastComment.reporter_sequence, lastComment.id)
    : null;
  const respondedAt = performance.now();
  c.header("Server-Timing", [
    ...sessionVerifyTiming(authorized.principal),
    `hands_auth;dur=${timingDuration(startedAt, authorizedAt)}`,
    `hands_preflight;dur=${timingDuration(authorizedAt, readAt)}`,
    `hands_commit;dur=${timingDuration(readAt, committedAt)}`,
    `hands_postcommit;dur=${timingDuration(committedAt, respondedAt)}`,
  ].join(", "));
  return c.json({
    ticket: ticketDto(safeTicket),
    comments: commentPage.map(({ reporter_sequence: _sequence, ...comment }) => comment),
    next_comment_cursor: nextCommentCursor,
    attachments,
    unread_total: totalUnread,
  });
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

type ReporterCommentAttachment = {
  bytes: ArrayBuffer;
  fingerprintFilename: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  digest: string;
};

async function parseReporterCommentInput(c: ReporterContext): Promise<{
  text: string;
  submissionId: string | null;
  attachments: ReporterCommentAttachment[];
} | null> {
  const contentType = c.req.header("content-type") ?? "";
  let rawText: unknown;
  let rawSubmissionId: unknown;
  let files: File[] = [];
  if (contentType.toLowerCase().startsWith("multipart/form-data")) {
    let form: FormData;
    try {
      form = await c.req.formData();
    } catch {
      return null;
    }
    rawText = form.get("body");
    rawSubmissionId = form.get("submission_id");
    for (const value of form.getAll("attachments")) {
      if (typeof value !== "string") files.push(value as File);
    }
  } else {
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) return null;
    rawText = body.body;
    rawSubmissionId = body.submission_id;
  }
  const text = typeof rawText === "string" ? rawText.trim() : "";
  const submissionId = fullUuid(typeof rawSubmissionId === "string" ? rawSubmissionId : undefined);
  if (!text || [...text].length > COMMENT_MAX_CHARS || !submissionId) return null;
  if (files.length > COMMENT_MAX_ATTACHMENTS) return null;
  const attachments: ReporterCommentAttachment[] = [];
  for (const file of files) {
    if (
      file.size > COMMENT_MAX_ATTACHMENT_BYTES
      || !COMMENT_ATTACHMENT_TYPES.has(file.type.toLowerCase())
    ) return null;
    const bytes = await file.arrayBuffer();
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    attachments.push({
      bytes,
      fingerprintFilename: file.name,
      filename: safeFilename(file.name),
      contentType: file.type.toLowerCase(),
      sizeBytes: file.size,
      digest: Array.from(new Uint8Array(digest))
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join(""),
    });
  }
  return { text, submissionId, attachments };
}

async function reconcileReporterR2Keys(env: Env, keys: string[], now: number) {
  for (const key of keys) {
    let referenced: { found: number } | null;
    try {
      referenced = await env.DB.prepare(
        "SELECT 1 AS found FROM feedback_attachments WHERE r2_key = ?1 LIMIT 1",
      ).bind(key).first<{ found: number }>();
    } catch {
      // The durable uploading intent remains. A later scheduled pass will
      // reconcile it after the writer lease expires.
      continue;
    }
    if (referenced) {
      await env.DB.prepare(
        "DELETE FROM feedback_reporter_r2_cleanup WHERE r2_key = ?1",
      ).bind(key).run().catch(() => undefined);
      continue;
    }
    await env.DB.prepare(
      `UPDATE feedback_reporter_r2_cleanup
       SET state = 'cleanup_claimed', next_attempt_at = ?2, updated_at = ?2
       WHERE r2_key = ?1`,
    ).bind(key, now).run().catch(() => undefined);
    try {
      await env.APK_BUCKET.delete(key);
      await env.DB.prepare(
        "DELETE FROM feedback_reporter_r2_cleanup WHERE r2_key = ?1",
      ).bind(key).run().catch(() => undefined);
    } catch {
      await env.DB.prepare(
        `UPDATE feedback_reporter_r2_cleanup
         SET state = 'cleanup_claimed', attempts = attempts + 1,
             last_error = 'r2 delete failed', next_attempt_at = ?2,
             updated_at = ?3
         WHERE r2_key = ?1`,
      ).bind(key, now + 60_000, Date.now()).run().catch(() => undefined);
    }
  }
}

export async function handleAddReporterComment(c: ReporterContext) {
  const startedAt = performance.now();
  const authorized = await authorize(c, "feedback:comment", "comment");
  if (!authorized.ok) return authorized.response;
  const authorizedAt = performance.now();
  const ticketId = fullUuid(c.req.param("ticketId"));
  if (!ticketId) return ticketNotFound(c);
  const [ticketResult] = await c.env.DB.batch([
    ownedTicketStatement(c, authorized.principal, ticketId),
  ]);
  const ticket = ticketResult?.results[0] as
    | (Record<string, unknown> & { org_id: string | null })
    | undefined;
  if (!ticket) return ticketNotFound(c);
  const input = await parseReporterCommentInput(c);
  if (!input) return c.json({ error: "invalid reporter comment" }, 400);
  const { text, submissionId, attachments } = input;
  const fingerprint = attachments.length === 0
    ? await sha256Hex(text)
    : await sha256Hex(JSON.stringify([
        "reporter-comment-v2",
        text,
        ...attachments.map((attachment) => [
          attachment.fingerprintFilename,
          attachment.contentType,
          attachment.sizeBytes,
          attachment.digest,
        ]),
      ]));
  const existingComment = async () => c.env.DB.prepare(
    `SELECT id, submission_fingerprint, created_at FROM feedback_comments
     WHERE ticket_id = ?1 AND reporter_integration_id = ?2
       AND reporter_id = ?3 AND submission_id = ?4`,
  ).bind(ticketId, authorized.principal.integrationId, authorized.principal.reporterId, submissionId)
    .first<{ id: string; submission_fingerprint: string; created_at: number }>();
  const now = Date.now();
  const commentId = crypto.randomUUID();
  const eventId = crypto.randomUUID();
  const attachmentRows = attachments.map((attachment, index) => ({
    ...attachment,
    id: crypto.randomUUID(),
    r2Key: `feedback/${authorized.principal.appId}/${ticketId}/comments/${commentId}/${index}-${attachment.filename}`,
  }));
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
  const uploadedKeys: string[] = [];
  const preflightAt = performance.now();
  const setCommentTiming = (committedAt: number) => {
    const respondedAt = performance.now();
    c.header("Server-Timing", [
      ...sessionVerifyTiming(authorized.principal),
      `hands_auth;dur=${timingDuration(startedAt, authorizedAt)}`,
      `hands_preflight;dur=${timingDuration(authorizedAt, preflightAt)}`,
      `hands_commit;dur=${timingDuration(preflightAt, committedAt)}`,
      `hands_postcommit;dur=${timingDuration(committedAt, respondedAt)}`,
    ].join(", "));
  };
  try {
    if (attachmentRows.length > 0) {
      await c.env.DB.batch(attachmentRows.map((attachment) => c.env.DB.prepare(
        `INSERT INTO feedback_reporter_r2_cleanup
         (r2_key, state, lease_expires_at, created_at, updated_at,
          attempts, next_attempt_at)
         VALUES (?1, 'uploading', ?3, ?2, ?2, 0, ?3)`,
      ).bind(attachment.r2Key, now, now + COMMENT_UPLOAD_LEASE_MS)));
    }
    for (const attachment of attachmentRows) {
      uploadedKeys.push(attachment.r2Key);
      await c.env.APK_BUCKET.put(attachment.r2Key, attachment.bytes, {
        httpMetadata: { contentType: attachment.contentType },
      });
    }
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
      ...attachmentRows.map((attachment) => c.env.DB.prepare(
        `INSERT INTO feedback_attachments
         (id, ticket_id, comment_id, r2_key, filename, content_type,
          size_bytes, origin, visibility, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'reporter', 'reporter', ?8)`,
      ).bind(
        attachment.id,
        ticketId,
        commentId,
        attachment.r2Key,
        attachment.filename,
        attachment.contentType,
        attachment.sizeBytes,
        now,
      )),
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
         JOIN apps a ON a.id = t.app_id AND a.archived = 0
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
         (id, webhook_id, event_type, event_id, payload_json,
          signing_secret, signature_key_version, reporter_delivery, status,
          attempts, max_attempts, next_attempt_at, created_at, updated_at)
         SELECT ?1 || ':' || w.id, w.id, 'feedback:comment_created', ?1, ?2,
                w.secret, w.signature_key_version, 0, 'pending', 0, 3, ?3, ?3, ?3
         FROM feedback_events fe
         JOIN apps a ON a.id = fe.app_id AND a.archived = 0
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
         (id, webhook_id, event_type, event_id, payload_json,
          signing_secret, signature_key_version, reporter_delivery, status,
          attempts, max_attempts, next_attempt_at, created_at, updated_at)
         SELECT ?1 || ':' || w.id, w.id, 'feedback:comment_created', ?1,
                fe.payload_json, w.secret, w.signature_key_version,
                1, 'pending', 0, 3, ?2, ?2, ?2
         FROM feedback_events fe
         JOIN app_reporter_webhook_subscriptions s
           ON s.app_id = fe.app_id
          AND s.reporter_integration_id = fe.reporter_integration_id
         JOIN webhooks w ON w.id = s.webhook_id
         JOIN app_reporter_integrations ri
           ON ri.id = s.reporter_integration_id AND ri.app_id = s.app_id
         JOIN apps a ON a.id = s.app_id AND a.archived = 0
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
      ...attachmentRows.map((attachment) => c.env.DB.prepare(
        "DELETE FROM feedback_reporter_r2_cleanup WHERE r2_key = ?1 AND state = 'uploading'",
      ).bind(attachment.r2Key)),
    ]);
  } catch (error) {
    const concurrent = await existingComment();
    await reconcileReporterR2Keys(c.env, uploadedKeys, now);
    if (concurrent) {
      const committedAt = performance.now();
      setCommentTiming(committedAt);
      if (concurrent.submission_fingerprint !== fingerprint) {
        return c.json({ error: "submission_id already used with a different body" }, 409);
      }
      return c.json({ id: concurrent.id, ticket_id: ticketId, created_at: concurrent.created_at, idempotent_replay: true });
    }
    throw error;
  }
  const committedAt = performance.now();
  setCommentTiming(committedAt);
  return c.json({ id: commentId, ticket_id: ticketId, created_at: now, idempotent_replay: false }, 201);
}

/**
 * Close one ticket owned by the authenticated reporter.
 *
 * This deliberately reuses feedback:comment: both operations are bounded
 * mutations of the same reporter-owned conversation. The route cannot set an
 * arbitrary status, change the assignee, reopen a ticket, or address another
 * reporter's ticket.
 */
export async function handleCloseReporterFeedback(c: ReporterContext) {
  const authorized = await authorize(c, "feedback:comment", "close");
  if (!authorized.ok) return authorized.response;
  const ticketId = fullUuid(c.req.param("ticketId"));
  if (!ticketId) return ticketNotFound(c);
  const body = (await c.req.json().catch(() => null)) as { reason?: unknown } | null;
  const reason = body?.reason;
  if (reason !== "completed" && reason !== "no_longer_needed") {
    return c.json({ error: "reason must be completed or no_longer_needed" }, 400);
  }

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const ticket = await c.env.DB.prepare(
      `SELECT t.status, t.closure_reason, a.org_id
       FROM feedback_tickets t
       JOIN apps a ON a.id = t.app_id
       WHERE t.id = ?1 AND t.app_id = ?2
         AND t.reporter_integration_id = ?3 AND t.reporter_id = ?4`,
    ).bind(
      ticketId,
      authorized.principal.appId,
      authorized.principal.integrationId,
      authorized.principal.reporterId,
    ).first<{ status: string; closure_reason: string | null; org_id: string | null }>();
    if (!ticket) return ticketNotFound(c);
    if (ticket.status === "closed") {
      if (ticket.closure_reason !== reason) {
        return c.json({ error: "ticket is already closed with a different reason" }, 409);
      }
      return c.json({
        id: ticketId,
        status: "closed",
        closure_reason: reason,
        duplicate_of_ticket_id: null,
        updated_at: null,
        changed: false,
      });
    }

    const now = Date.now();
    const auditId = crypto.randomUUID();
    const auditPayload = JSON.stringify({
      ticket_id: ticketId,
      previous_status: ticket.status,
      status: "closed",
      closure_reason: reason,
      reporter_hash: authorized.pseudonym.hash,
      audit_key_version: authorized.pseudonym.version,
    });
    const statements: D1PreparedStatement[] = [
      c.env.DB.prepare(
        `INSERT INTO audit_logs (id, app_id, action, actor, payload, created_at)
         SELECT ?1, ?2, 'feedback.reporter_close', ?3, ?4, ?5
         FROM feedback_tickets
         WHERE id = ?6 AND app_id = ?2 AND reporter_integration_id = ?7
           AND reporter_id = ?8 AND status = ?9 AND closure_reason IS NULL`,
      ).bind(
        auditId,
        authorized.principal.appId,
        `reporter:${authorized.pseudonym.hash}`,
        auditPayload,
        now,
        ticketId,
        authorized.principal.integrationId,
        authorized.principal.reporterId,
        ticket.status,
      ),
      c.env.DB.prepare(
        `UPDATE feedback_tickets
         SET status = 'closed', closure_reason = ?1,
             duplicate_of_ticket_id = NULL, updated_at = ?2
         WHERE id = ?3 AND app_id = ?4 AND reporter_integration_id = ?5
           AND reporter_id = ?6 AND status = ?7 AND closure_reason IS NULL
           AND EXISTS (SELECT 1 FROM audit_logs WHERE id = ?8)`,
      ).bind(
        reason,
        now,
        ticketId,
        authorized.principal.appId,
        authorized.principal.integrationId,
        authorized.principal.reporterId,
        ticket.status,
        auditId,
      ),
    ];
    if (ticket.org_id) {
      statements.push(...feedbackReporterEventStatements(c.env.DB, {
        eventType: "feedback:status_changed",
        orgId: ticket.org_id,
        appId: authorized.principal.appId,
        ticketId,
        reporterIntegrationId: authorized.principal.integrationId,
        reporterId: authorized.principal.reporterId,
        createdAt: now,
        previousStatus: ticket.status,
        status: "closed",
        closureReason: reason,
        duplicateOfTicketId: null,
        claimAuditId: auditId,
      }));
    }
    await c.env.DB.batch(statements);
    const won = await c.env.DB.prepare("SELECT id FROM audit_logs WHERE id = ?1")
      .bind(auditId)
      .first();
    if (won) {
      return c.json({
        id: ticketId,
        status: "closed",
        closure_reason: reason,
        duplicate_of_ticket_id: null,
        updated_at: now,
        changed: true,
      });
    }
  }
  return c.json({ error: "feedback ticket changed concurrently; retry" }, 409);
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
       AND fa.id = ?5 AND fa.origin IN ('submission', 'reporter') AND fa.visibility = 'reporter'`,
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
  const headers = new Headers({
    "content-type": row.content_type ?? "application/octet-stream",
    "content-disposition": `attachment; filename="${filename}"`,
    "x-content-type-options": "nosniff",
    "cache-control": "private, no-store",
  });
  const verifyTiming = sessionVerifyTiming(authorized.principal)[0];
  if (verifyTiming) headers.set("Server-Timing", verifyTiming);
  return new Response(object.body, {
    headers,
  });
}

export async function cleanupReporterFeedbackData(env: Env, now = Date.now()) {
  const { results: cleanupRows } = await env.DB.prepare(
    `SELECT r2_key FROM feedback_reporter_r2_cleanup
     WHERE next_attempt_at <= ?1
       AND (state = 'cleanup_claimed'
            OR (state = 'uploading' AND lease_expires_at <= ?1))
     ORDER BY next_attempt_at, r2_key LIMIT 100`,
  ).bind(now).all<{ r2_key: string }>();
  for (const row of cleanupRows) {
    const referenced = await env.DB.prepare(
      "SELECT 1 AS found FROM feedback_attachments WHERE r2_key = ?1 LIMIT 1",
    ).bind(row.r2_key).first<{ found: number }>();
    if (referenced) {
      await env.DB.prepare(
        "DELETE FROM feedback_reporter_r2_cleanup WHERE r2_key = ?1",
      ).bind(row.r2_key).run();
      continue;
    }
    await env.DB.prepare(
      `UPDATE feedback_reporter_r2_cleanup
       SET state = 'cleanup_claimed', updated_at = ?2
       WHERE r2_key = ?1 AND NOT EXISTS (
         SELECT 1 FROM feedback_attachments WHERE r2_key = ?1
       ) AND (state = 'cleanup_claimed'
              OR (state = 'uploading' AND lease_expires_at <= ?2))`,
    ).bind(row.r2_key, now).run();
    const claimed = await env.DB.prepare(
      "SELECT 1 AS claimed FROM feedback_reporter_r2_cleanup WHERE r2_key = ?1 AND state = 'cleanup_claimed'",
    ).bind(row.r2_key).first<{ claimed: number }>();
    if (claimed) await reconcileReporterR2Keys(env, [row.r2_key], now);
  }
  await env.DB.batch([
    env.DB.prepare(
      "DELETE FROM feedback_reporter_rate_windows WHERE updated_at < ?1",
    ).bind(now - 24 * 60 * 60_000),
    env.DB.prepare(
      "DELETE FROM feedback_reporter_session_mint_rate_windows WHERE updated_at < ?1",
    ).bind(now - 24 * 60 * 60_000),
    env.DB.prepare(
      "DELETE FROM feedback_reporter_access_audits WHERE created_at < ?1",
    ).bind(now - 30 * 24 * 60 * 60_000),
  ]);
}
