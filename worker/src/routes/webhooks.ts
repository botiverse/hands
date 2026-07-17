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
  | "crash:new_group"
  | "crash:spike"
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
  // Soft-delete (set archived_at) so deliveries-in-flight still have a
  // valid webhook row to reference.
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
  db: D1Database,
  payload: {
    orgId: string;
    appId: string | null;
    event: WebhookEventType;
    body: Record<string, unknown>;
  },
): Promise<void> {
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
  const stmts = filtered.map((s) =>
    db
      .prepare(
        `INSERT INTO webhook_deliveries
         (id, webhook_id, event_type, payload_json, status,
          attempts, max_attempts, last_attempt_at, next_attempt_at,
          created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, 'pending', 0, 3, NULL, ?5, ?6, ?7)`,
      )
      .bind(crypto.randomUUID(), s.id, payload.event, body, now, now, now),
  );
  await db.batch(stmts);
}

// ============================================================================
// Delivery worker (called from Worker Cron Trigger every 5 min)
// ============================================================================

const BACKOFF_SCHEDULE_MS = [5 * 60_000, 30 * 60_000, 2 * 60 * 60_000]; // 5m, 30m, 2h

export async function handleReapDeliveries(c: Context<{ Bindings: Env }>) {
  const now = Date.now();
  // Find all deliveries ready to attempt
  const { results: due } = await c.env.DB.prepare(
    `SELECT id, webhook_id, attempts, max_attempts, payload_json
     FROM webhook_deliveries
     WHERE status = 'pending'
       AND (next_attempt_at IS NULL OR next_attempt_at <= ?1)
     ORDER BY created_at ASC
     LIMIT 50`,
  )
    .bind(now)
    .all<{
      id: string;
      webhook_id: string;
      attempts: number;
      max_attempts: number;
      payload_json: string;
    }>();

  let succeeded = 0;
  let failed = 0;
  for (const d of due) {
    const wh = await c.env.DB.prepare(
      `SELECT url, secret FROM webhooks WHERE id = ?1`,
    )
      .bind(d.webhook_id)
      .first<{ url: string; secret: string }>();
    if (!wh) continue;

    const result = await postOnce(wh.url, wh.secret, d.payload_json);
    const nextAttempts = d.attempts + 1;
    if (result.ok) {
      await c.env.DB.prepare(
        `UPDATE webhook_deliveries
         SET status = 'succeeded', attempts = ?1, last_attempt_at = ?2,
             last_response_status = ?3, last_response_body = ?4,
             completed_at = ?2, updated_at = ?2
         WHERE id = ?5`,
      ).bind(nextAttempts, now, result.status, result.body?.slice(0, 500), d.id).run();
      succeeded++;
    } else {
      if (nextAttempts >= d.max_attempts) {
        await c.env.DB.prepare(
          `UPDATE webhook_deliveries
           SET status = 'failed', attempts = ?1, last_attempt_at = ?2,
               last_response_status = ?3, last_response_body = ?4,
               last_error = ?5, completed_at = ?2, updated_at = ?2
           WHERE id = ?6`,
        ).bind(
          nextAttempts,
          now,
          result.status,
          result.body?.slice(0, 500),
          result.error,
          d.id,
        ).run();
      } else {
        const backoff =
          BACKOFF_SCHEDULE_MS[d.attempts] ??
          BACKOFF_SCHEDULE_MS[BACKOFF_SCHEDULE_MS.length - 1] ??
          60_000;
        await c.env.DB.prepare(
          `UPDATE webhook_deliveries
           SET attempts = ?1, last_attempt_at = ?2, next_attempt_at = ?3,
               last_response_status = ?4, last_response_body = ?5,
               last_error = ?6, updated_at = ?2
           WHERE id = ?7`,
        ).bind(
          nextAttempts,
          now,
          now + backoff,
          result.status,
          result.body?.slice(0, 500),
          result.error,
          d.id,
        ).run();
      }
      failed++;
    }
  }

  return c.json({ processed: due.length, succeeded, failed });
}

async function postOnce(
  url: string,
  secret: string,
  body: string,
): Promise<{ ok: boolean; status: number; body?: string; error?: string }> {
  try {
    const sig = await hmacSha256Hex(secret, body);
    const event = (() => {
      try { return JSON.parse(body).event ?? ""; } catch { return ""; }
    })();
    const r = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        // New canonical headers; legacy X-Quiver-* sent too so existing
        // webhook consumers keep verifying without a change.
        "X-Hands-Signature": `sha256=${sig}`,
        "X-Hands-Event": event,
        "X-Quiver-Signature": `sha256=${sig}`,
        "X-Quiver-Event": event,
      },
      body,
    });
    const text = await r.text().catch(() => "");
    return {
      ok: r.ok,
      status: r.status,
      body: text,
    };
  } catch (e) {
    return {
      ok: false,
      status: 0,
      error: (e as Error).message,
    };
  }
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