/**
 * /api/orgs/:orgId/webhooks + /api/orgs/:orgId/webhooks/:webhookId + delivery
 *
 * Implements P2.5.8 webhook dispatch per docs/publish-architecture.md §5
 * + docs/publish-tasks.md P2.5.8.
 *
 * Scope: webhooks are org-wide (events from any app in the org) OR per-app
 * (events only from that app). v1 keeps it simple — only org-wide webhooks.
 *
 * Events emitted (from worker/src/routes/webhook_events.ts):
 *   release:new           - release activated (created active or published)
 *   release:draft_created - draft release created (QA/integration trigger)
 *   release:superseded - release marked superseded by a new one
 *   release:rolled_back - explicit rollback
 *   release:cancelled   - release cancelled
 *   build:succeeded     - build parsing succeeded
 *   build:failed        - build parsing failed
 *
 * Delivery: Worker Cron Trigger (every 5 min) reaps pending deliveries from
 * webhook_deliveries + POSTs to webhook.url with X-Quiver-Signature header.
 */

import type { Context } from "hono";
import { currentActorInfo } from "../middleware/auth";
import type { AdminContext } from "../lib/permissions";

type WebhookEventType =
  | "feedback:new"
  | "feedback:comment_created"
  | "feedback:status_changed"
  | "crash:new_group"
  | "crash:spike"
  | "error:new_group"
  | "error:spike"
  | "release:new"
  | "release:draft_created"
  | "release:superseded"
  | "release:rolled_back"
  | "release:cancelled"
  | "build:succeeded"
  | "build:failed";

interface WebhookRow {
  id: string;
  org_id: string;
  app_id: string | null;
  url: string;
  secret: string;
  events_json: string;
  enabled: number;
  created_by: string | null;
  created_at: number;
  updated_at: number;
  archived_at: number | null;
}

// ============================================================================
// Org webhook CRUD
// ============================================================================

export async function handleListWebhooks(c: AdminContext) {
  const orgId = c.req.param("orgId") ?? "";
  const { results: rows } = await c.env.DB.prepare(
    `SELECT id, org_id, app_id, url, events_json, enabled, created_at, updated_at, archived_at
     FROM webhooks
     WHERE org_id = ?1 AND archived_at IS NULL
     ORDER BY created_at DESC`,
  ).bind(orgId).all<Omit<WebhookRow, "secret">>();
  return c.json({
    webhooks: rows.map((w: Omit<WebhookRow, "secret">) => ({
      ...w,
      secret: undefined, // strip
      secret_set: true,
    })),
  });
}

export async function handleCreateWebhook(c: AdminContext) {
  const orgId = c.req.param("orgId") ?? "";
  const body = (await c.req.json().catch(() => ({}))) as {
    url?: string;
    secret?: string;
    events?: WebhookEventType[];
    app_id?: string | null;
  };
  if (!body.url) return c.json({ error: "url required" }, 400);
  if (!body.secret) return c.json({ error: "secret required" }, 400);
  try {
    new URL(body.url);
  } catch {
    return c.json({ error: "url must be a valid URL" }, 400);
  }
  const events = Array.isArray(body.events) ? body.events : [];
  const id = crypto.randomUUID();
  const now = Date.now();
  const actor = currentActorInfo(c);
  await c.env.DB.prepare(
    `INSERT INTO webhooks
     (id, org_id, app_id, url, secret, events_json, enabled, created_by, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1, ?7, ?8, ?9)`,
  ).bind(
    id,
    orgId,
    body.app_id ?? null,
    body.url,
    body.secret,
    JSON.stringify(events),
    actor.id,
    now,
    now,
  ).run();
  return c.json({
    id,
    url: body.url,
    events,
    secret_set: true,
    created_at: now,
  }, 201);
}

export async function handleDeleteWebhook(c: AdminContext) {
  const orgId = c.req.param("orgId") ?? "";
  const webhookId = c.req.param("webhookId") ?? "";
  // Soft-delete (set archived_at) so the scheduled reaper can identify and
  // terminalize pending deliveries without attempting the retired endpoint.
  await c.env.DB.prepare(
    `UPDATE webhooks SET archived_at = ?1 WHERE id = ?2 AND org_id = ?3`,
  ).bind(Date.now(), webhookId, orgId).run();
  return c.json({ ok: true });
}

export async function handleUpdateWebhook(c: AdminContext) {
  const orgId = c.req.param("orgId") ?? "";
  const webhookId = c.req.param("webhookId") ?? "";
  const body = (await c.req.json().catch(() => ({}))) as {
    url?: string;
    events?: WebhookEventType[];
    enabled?: boolean;
  };
  const updates: string[] = [];
  const binds: (string | number)[] = [];
  if (body.url !== undefined) {
    try {
      new URL(body.url);
    } catch {
      return c.json({ error: "url must be a valid URL" }, 400);
    }
    updates.push("url = ?");
    binds.push(body.url);
  }
  if (body.events !== undefined) {
    updates.push("events_json = ?");
    binds.push(JSON.stringify(body.events));
  }
  if (body.enabled !== undefined) {
    updates.push("enabled = ?");
    binds.push(body.enabled ? 1 : 0);
  }
  if (updates.length === 0) return c.json({ error: "nothing to update" }, 400);
  updates.push("updated_at = ?");
  binds.push(Date.now());
  binds.push(webhookId, orgId);
  await c.env.DB.prepare(
    `UPDATE webhooks SET ${updates.join(", ")} WHERE id = ? AND org_id = ?`,
  ).bind(...binds).run();
  return c.json({ ok: true });
}

// ============================================================================
// Deliveries (read-only history for UI)
// ============================================================================

export async function handleListDeliveries(c: AdminContext) {
  const orgId = c.req.param("orgId") ?? "";
  const webhookId = c.req.param("webhookId") ?? "";
  const { results: deliveries } = await c.env.DB.prepare(
    `SELECT id, webhook_id, event_type, status, attempts, max_attempts,
            last_attempt_at, next_attempt_at, last_response_status,
            last_response_body, last_error, created_at, completed_at
     FROM webhook_deliveries
     WHERE webhook_id = ?1
       AND webhook_id IN (SELECT id FROM webhooks WHERE org_id = ?2)
     ORDER BY created_at DESC
     LIMIT 100`,
  ).bind(webhookId, orgId).all<{
    id: string;
    webhook_id: string;
    event_type: string;
    status: string;
    attempts: number;
    max_attempts: number;
    last_attempt_at: number | null;
    next_attempt_at: number | null;
    last_response_status: number | null;
    last_response_body: string | null;
    last_error: string | null;
    created_at: number;
    completed_at: number | null;
  }>();
  return c.json({ deliveries });
}

// ============================================================================
// Event emission (called from release / build endpoints)
// ============================================================================

export async function emitWebhookEvent(
  env: Pick<Env, "DB"> & Partial<Pick<Env, "WEBHOOK_QUEUE">>,
  payload: {
    orgId: string;
    appId: string | null;
    event: WebhookEventType;
    body: Record<string, unknown>;
  },
): Promise<void> {
  const db = env.DB;
  // Find all enabled, non-archived webhooks in this org that subscribe to
  // this event (org-wide OR per-app matching appId).
  const { results: subs } = await db
    .prepare(
      `SELECT id, url, secret, events_json
       FROM webhooks
       WHERE org_id = ?1
         AND enabled = 1
         AND archived_at IS NULL
         AND (
           app_id IS NULL
           OR app_id = ?2
         )`,
    )
    .bind(payload.orgId, payload.appId ?? null)
    .all<{ id: string; url: string; secret: string; events_json: string }>();

  if (subs.length === 0) return;

  const matchesEvent = (
    eventsJson: string,
    event: WebhookEventType,
  ): boolean => {
    try {
      const events = JSON.parse(eventsJson) as string[];
      return events.length === 0 || events.includes(event) || events.includes("*");
    } catch {
      return false;
    }
  };

  const filtered = subs.filter((s) => matchesEvent(s.events_json, payload.event));
  if (filtered.length === 0) return;

  const now = Date.now();
  const body = JSON.stringify({
    event: payload.event,
    delivered_at: now,
    org_id: payload.orgId,
    app_id: payload.appId,
    payload: payload.body,
  });

  // Batch insert pending deliveries.
  const deliveryIds = filtered.map(() => crypto.randomUUID());
  const stmts = filtered.map((s, i) =>
    db
      .prepare(
        `INSERT INTO webhook_deliveries
         (id, webhook_id, event_type, payload_json, status,
          attempts, max_attempts, last_attempt_at, next_attempt_at,
          created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, 'pending', 0, 3, NULL, ?5, ?6, ?7)`,
      )
      .bind(deliveryIds[i], s.id, payload.event, body, now, now, now),
  );
  await db.batch(stmts);

  // Real-time first attempt: hand the new delivery ids to the queue so a
  // consumer POSTs immediately. The cron reaper stays as the backoff /
  // safety-net lane — enqueue failure here must never fail the event.
  try {
    await enqueueDeliveries(env, deliveryIds);
  } catch {
    // Swallowed: a queue outage only delays the first attempt to the cron.
  }
}

// ============================================================================
// Delivery worker (called from Worker Cron Trigger every 5 min)
// ============================================================================

const BACKOFF_SCHEDULE_MS = [5 * 60_000, 30 * 60_000, 2 * 60 * 60_000]; // 5m, 30m, 2h

const DELIVERY_ATTEMPT_TIMEOUT_MS = 10_000;
const DELIVERY_REAPER_CONCURRENCY = 5;
const DELIVERY_REAPER_BATCH_SIZE = 50;
const DELIVERY_RESPONSE_BODY_LIMIT_BYTES = 500;

interface ReapDeliveriesOptions {
  now?: number;
  scheduledTime?: number | null;
  fetchImpl?: typeof fetch;
  deliveryTimeoutMs?: number;
  concurrency?: number;
}

export interface ReapDeliveriesSummary {
  scheduledTime: number | null;
  selected: number;
  succeeded: number;
  retried: number;
  terminalized: number;
  durationMs: number;
  errorCodes: Record<string, number>;
}

// ============================================================================
// Real-time first attempt (Cloudflare Queue)
// ============================================================================
// webhook_deliveries stays the single source of truth: the queue only carries
// the delivery_id and acts as the *first-attempt* trigger. Retry/backoff and
// terminalization still run through the same D1 state machine used by the cron
// reaper, which remains as the safety net for any delivery whose queue message
// is lost or whose handler throws before the attempt is recorded.

interface EnqueueDeliveriesEnv {
  DB: D1Database;
  WEBHOOK_QUEUE?: Queue<unknown>;
}

/**
 * Hand newly-created pending deliveries to the queue for an immediate first
 * attempt. Non-blocking for correctness — a failure here just means the cron
 * reaper delivers on its next tick.
 */
export async function enqueueDeliveries(
  env: EnqueueDeliveriesEnv,
  deliveryIds: string[],
): Promise<number> {
  if (deliveryIds.length === 0 || !env.WEBHOOK_QUEUE) return 0;
  // Cloudflare Queue sendBatch caps at 100 messages per call.
  const CHUNK = 100;
  let sent = 0;
  for (let i = 0; i < deliveryIds.length; i += CHUNK) {
    const chunk = deliveryIds.slice(i, i + CHUNK);
    await env.WEBHOOK_QUEUE.sendBatch(
      chunk.map((id) => ({ body: { delivery_id: id } })),
    );
    sent += chunk.length;
  }
  return sent;
}

/**
 * After a producer batch commits, sweep the pending deliveries it created
 * (created_at = the batch's `now`) and hand them to the queue for an
 * immediate first attempt. Every webhook_deliveries producer stamps
 * created_at with the request's `now`, so this covers emitWebhookEvent's
 * per-sub insert AND the dedicated reporter INSERT...SELECT paths uniformly
 * — and self-heals: any still-due pending row from an earlier enqueue failure
 * is re-queued too (the consumer's status='pending' guard makes a duplicate
 * queue message a no-op).
 */
export async function enqueueDueDeliveries(
  env: EnqueueDeliveriesEnv,
  createdAt: number,
): Promise<number> {
  if (!env.WEBHOOK_QUEUE) return 0;
  const { results } = await env.DB.prepare(
    `SELECT id FROM webhook_deliveries
     WHERE status = 'pending'
       AND created_at = ?1
       AND (next_attempt_at IS NULL OR next_attempt_at <= ?2)
     ORDER BY created_at ASC, id ASC
     LIMIT 100`,
  )
    .bind(createdAt, Date.now())
    .all<{ id: string }>();
  return enqueueDeliveries(env, results.map((r) => r.id));
}

/**
 * Request-scoped trigger for `enqueueDueDeliveries`: fire-and-forget via
 * `executionCtx.waitUntil` so the response isn't held, with a catch-all so an
 * enqueue outage only delays the first attempt to the cron tick. Falls back to
 * a plain (still awaited-by-nobody) call when executionCtx is absent (tests).
 */
export function triggerDeliveryNow(
  c: { executionCtx?: { waitUntil(p: Promise<unknown>): void } },
  env: EnqueueDeliveriesEnv,
  createdAt: number,
): void {
  const job = enqueueDueDeliveries(env, createdAt).catch(() => {
    // Enqueue failure only delays the first attempt to the cron tick.
  });
  try {
    c.executionCtx?.waitUntil(job);
  } catch {
    void job;
  }
}

/**
 * Resolve + process ONE delivery by id (queue consumer fast path). Loads the
 * delivery with the same LEFT JOIN as the reaper, then runs the identical
 * processDelivery state transitions. Returns a short outcome tag for the
 * consumer's summary; unknown/terminal ids are no-ops (already delivered).
 */
export async function processDeliveryById(
  env: EnqueueDeliveriesEnv,
  deliveryId: string,
  options: { fetchImpl?: typeof fetch; deliveryTimeoutMs?: number } = {},
): Promise<string> {
  const now = Date.now();
  const d = await env.DB.prepare(
    `SELECT d.id, d.webhook_id, d.status,
            COALESCE(d.event_id, d.feedback_submission_event_id) AS event_id,
            d.attempts, d.max_attempts, d.payload_json, d.signing_secret,
            w.id AS resolved_webhook_id, w.url AS webhook_url,
            w.secret AS webhook_secret, w.enabled AS webhook_enabled,
            w.archived_at AS webhook_archived_at
     FROM webhook_deliveries d
     LEFT JOIN webhooks w ON w.id = d.webhook_id
     WHERE d.id = ?1`,
  )
    .bind(deliveryId)
    .first<DueDelivery & { status: string }>();
  if (!d) return "missing";
  // Already delivered/terminalized (e.g. a duplicate queue message or the cron
  // beat the consumer): the D1 row is authoritative — do not attempt again.
  if (d.status !== "pending") return "already_terminal";
  const summary: ReapDeliveriesSummary = {
    scheduledTime: null,
    selected: 1,
    succeeded: 0,
    retried: 0,
    terminalized: 0,
    durationMs: 0,
    errorCodes: {},
  };
  const recordError = (code: string) => {
    summary.errorCodes[code] = (summary.errorCodes[code] ?? 0) + 1;
  };
  await processDeliveryRow(env, d, now, options, summary, recordError);
  if (summary.succeeded) return "succeeded";
  if (summary.terminalized) return "terminalized";
  return "retried";
}

/** Shared single-delivery attempt used by both the cron reaper and the queue
 * consumer. Performs the full pending→{succeeded|failed|pending(retry)}
 * transition against webhook_deliveries. */
async function processDeliveryRow(
  env: Pick<Env, "DB">,
  d: DueDelivery,
  now: number,
  options: { fetchImpl?: typeof fetch; deliveryTimeoutMs?: number },
  summary: ReapDeliveriesSummary,
  recordError: (code: string) => void,
): Promise<void> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const deliveryTimeoutMs = options.deliveryTimeoutMs ?? DELIVERY_ATTEMPT_TIMEOUT_MS;
  const unavailableCode = !d.resolved_webhook_id
    ? "webhook_missing"
    : d.webhook_archived_at !== null
      ? "webhook_archived"
      : d.webhook_enabled !== 1
        ? "webhook_disabled"
        : null;
  if (unavailableCode) {
    await env.DB.prepare(
      `UPDATE webhook_deliveries
       SET status = 'failed', next_attempt_at = NULL, last_error = ?1,
           completed_at = ?2, updated_at = ?2
       WHERE id = ?3 AND status = 'pending'`,
    ).bind(unavailableCode, now, d.id).run();
    summary.terminalized++;
    recordError(unavailableCode);
    return;
  }

  const result = await postOnce(
    d.webhook_url!,
    d.signing_secret ?? d.webhook_secret!,
    d.payload_json,
    d.id,
    d.event_id,
    fetchImpl,
    deliveryTimeoutMs,
  );
  const nextAttempts = d.attempts + 1;
  if (result.ok) {
    await env.DB.prepare(
      `UPDATE webhook_deliveries
       SET status = 'succeeded', attempts = ?1, last_attempt_at = ?2,
           next_attempt_at = NULL, last_response_status = ?3,
           last_response_body = ?4, last_error = NULL,
           completed_at = ?2, updated_at = ?2
       WHERE id = ?5 AND status = 'pending'`,
    ).bind(nextAttempts, now, result.status, result.body ?? null, d.id).run();
    summary.succeeded++;
    return;
  }

  const errorCode = result.errorCode ?? "webhook_http_error";
  recordError(errorCode);
  if (nextAttempts >= d.max_attempts) {
    await env.DB.prepare(
      `UPDATE webhook_deliveries
       SET status = 'failed', attempts = ?1, last_attempt_at = ?2,
           next_attempt_at = NULL, last_response_status = ?3,
           last_response_body = ?4, last_error = ?5,
           completed_at = ?2, updated_at = ?2
       WHERE id = ?6 AND status = 'pending'`,
    ).bind(
      nextAttempts,
      now,
      result.status,
      result.body ?? null,
      errorCode,
      d.id,
    ).run();
    summary.terminalized++;
    return;
  }

  const backoff =
    BACKOFF_SCHEDULE_MS[d.attempts] ??
    BACKOFF_SCHEDULE_MS[BACKOFF_SCHEDULE_MS.length - 1] ??
    60_000;
  await env.DB.prepare(
    `UPDATE webhook_deliveries
     SET attempts = ?1, last_attempt_at = ?2, next_attempt_at = ?3,
         last_response_status = ?4, last_response_body = ?5,
         last_error = ?6, updated_at = ?2
     WHERE id = ?7 AND status = 'pending'`,
  ).bind(
    nextAttempts,
    now,
    now + backoff,
    result.status,
    result.body ?? null,
    errorCode,
    d.id,
  ).run();
  summary.retried++;
}

interface DueDelivery {
  id: string;
  webhook_id: string;
  event_id: string | null;
  attempts: number;
  max_attempts: number;
  payload_json: string;
  signing_secret: string | null;
  resolved_webhook_id: string | null;
  webhook_url: string | null;
  webhook_secret: string | null;
  webhook_enabled: number | null;
  webhook_archived_at: number | null;
}

export async function handleReapDeliveries(c: Context<{ Bindings: Env }>) {
  const summary = await reapWebhookDeliveries(c.env);
  return c.json({
    processed: summary.selected,
    failed: summary.retried + summary.terminalized,
    ...summary,
  });
}

export async function reapWebhookDeliveries(
  env: Pick<Env, "DB">,
  options: ReapDeliveriesOptions = {},
): Promise<ReapDeliveriesSummary> {
  const startedAt = Date.now();
  const now = options.now ?? startedAt;
  const fetchImpl = options.fetchImpl ?? fetch;
  const deliveryTimeoutMs = options.deliveryTimeoutMs ?? DELIVERY_ATTEMPT_TIMEOUT_MS;
  const concurrency = Math.max(1, Math.min(
    options.concurrency ?? DELIVERY_REAPER_CONCURRENCY,
    DELIVERY_REAPER_BATCH_SIZE,
  ));

  // Resolve the webhook in the same bounded query. LEFT JOIN intentionally
  // keeps orphaned deliveries visible so they can be terminalized instead of
  // occupying the oldest slots forever.
  const { results: due } = await env.DB.prepare(
    `SELECT d.id, d.webhook_id,
            COALESCE(d.event_id, d.feedback_submission_event_id) AS event_id,
            d.attempts, d.max_attempts, d.payload_json, d.signing_secret,
            w.id AS resolved_webhook_id, w.url AS webhook_url,
            w.secret AS webhook_secret, w.enabled AS webhook_enabled,
            w.archived_at AS webhook_archived_at
     FROM webhook_deliveries d
     LEFT JOIN webhooks w ON w.id = d.webhook_id
     WHERE d.status = 'pending'
       AND (d.next_attempt_at IS NULL OR d.next_attempt_at <= ?1)
     ORDER BY d.created_at ASC, d.id ASC
     LIMIT ${DELIVERY_REAPER_BATCH_SIZE}`,
  )
    .bind(now)
    .all<DueDelivery>();

  const summary: ReapDeliveriesSummary = {
    scheduledTime: options.scheduledTime ?? null,
    selected: due.length,
    succeeded: 0,
    retried: 0,
    terminalized: 0,
    durationMs: 0,
    errorCodes: {},
  };
  const recordError = (code: string) => {
    summary.errorCodes[code] = (summary.errorCodes[code] ?? 0) + 1;
  };

  const processDelivery = async (d: DueDelivery) => {
    await processDeliveryRow(
      env,
      d,
      now,
      { fetchImpl, deliveryTimeoutMs },
      summary,
      recordError,
    );
  };

  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, due.length) },
    async () => {
      while (true) {
        const index = nextIndex++;
        const delivery = due[index];
        if (!delivery) return;
        try {
          await processDelivery(delivery);
        } catch {
          // A single D1/fetch/runtime failure must not prevent later rows in
          // the bounded batch from making progress. The untouched pending row
          // remains eligible for a future cron invocation.
          summary.retried++;
          recordError("delivery_processing_error");
        }
      }
    },
  );
  await Promise.all(workers);
  summary.durationMs = Math.max(0, Date.now() - startedAt);
  return summary;
}

async function postOnce(
  url: string,
  secret: string,
  body: string,
  deliveryId: string,
  eventId: string | null,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<{ ok: boolean; status: number; body?: string; errorCode?: string }> {
  const controller = new AbortController();
  let timedOut = false;
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  try {
    const deadline = new Promise<never>((_resolve, reject) => {
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        controller.abort();
        reject(new Error("delivery_timeout"));
      }, timeoutMs);
    });
    return await Promise.race([
      (async () => {
        const sig = await hmacSha256Hex(secret, body);
        const event = (() => {
          try { return JSON.parse(body).event ?? ""; } catch { return ""; }
        })();
        const headers: Record<string, string> = {
          "content-type": "application/json",
          // New canonical headers; legacy X-Quiver-* sent too so existing
          // webhook consumers keep verifying without a change.
          "X-Hands-Signature": `sha256=${sig}`,
          "X-Hands-Event": event,
          "X-Hands-Delivery-Id": deliveryId,
          "X-Quiver-Signature": `sha256=${sig}`,
          "X-Quiver-Event": event,
        };
        if (eventId) headers["X-Hands-Event-Id"] = eventId;
        const response = await fetchImpl(url, {
          method: "POST",
          headers,
          body,
          signal: controller.signal,
        });
        const responseBody = await readResponseBodyPrefix(
          response,
          DELIVERY_RESPONSE_BODY_LIMIT_BYTES,
          controller.signal,
        );
        return {
          ok: response.ok,
          status: response.status,
          body: responseBody,
          ...(response.ok ? {} : { errorCode: "webhook_http_error" }),
        };
      })(),
      deadline,
    ]);
  } catch {
    return {
      ok: false,
      status: 0,
      errorCode: timedOut ? "delivery_timeout" : "webhook_fetch_error",
    };
  } finally {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
  }
}

async function readResponseBodyPrefix(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
): Promise<string> {
  if (!response.body || maxBytes <= 0) return "";

  const reader = response.body.getReader();
  const prefix = new Uint8Array(maxBytes);
  let length = 0;
  const cancelForAbort = () => {
    void reader.cancel("delivery_aborted").catch(() => undefined);
  };
  if (signal.aborted) cancelForAbort();
  else signal.addEventListener("abort", cancelForAbort, { once: true });

  try {
    while (length < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      const take = Math.min(value.byteLength, maxBytes - length);
      prefix.set(value.subarray(0, take), length);
      length += take;
      if (length === maxBytes) {
        // Cancellation is advisory cleanup. A hostile stream may return a
        // cancel promise that never settles, so it must not become another
        // head-of-line wait after the bounded prefix is already complete.
        void reader.cancel("response_body_prefix_complete").catch(() => undefined);
        break;
      }
    }
  } finally {
    signal.removeEventListener("abort", cancelForAbort);
    reader.releaseLock();
  }

  return new TextDecoder().decode(prefix.subarray(0, length));
}

async function hmacSha256Hex(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(body),
  );
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ============================================================================
// Queue consumer — real-time first attempt for each enqueued delivery id
// ============================================================================

export interface WebhookQueueMessage {
  delivery_id?: unknown;
}

/**
 * Cloudflare Queue consumer. Each message carries { delivery_id }; the consumer
 * resolves it and runs the same first-attempt path as the cron reaper. The D1
 * row is authoritative, so:
 *  - messages are always acked (never retried at the queue layer): an HTTP
 *    failure is already recorded as a pending row with a backoff
 *    next_attempt_at, and a thrown error leaves the row pending for the cron
 *    safety net. Queue-level redelivery would only double-attempt.
 *  - unknown / non-pending ids are no-ops (already delivered or terminalized).
 */
export async function handleWebhookQueue(
  batch: MessageBatch<WebhookQueueMessage>,
  env: Pick<Env, "DB"> & Partial<Pick<Env, "WEBHOOK_QUEUE">>,
): Promise<void> {
  const outcomes: Record<string, number> = {};
  for (const message of batch.messages) {
    const deliveryId =
      message.body && typeof message.body === "object"
        ? (message.body as WebhookQueueMessage).delivery_id
        : undefined;
    let outcome = "malformed";
    if (typeof deliveryId === "string" && deliveryId.length > 0) {
      try {
        outcome = await processDeliveryById(env, deliveryId);
      } catch {
        // Left pending for the cron reaper; never propagate so the whole batch
        // isn't retried on one bad row.
        outcome = "processing_error";
      }
    }
    outcomes[outcome] = (outcomes[outcome] ?? 0) + 1;
    message.ack();
  }
  console.info(
    "hands_webhook_queue_batch",
    JSON.stringify({
      queue: batch.queue,
      size: batch.messages.length,
      outcomes,
    }),
  );
}
