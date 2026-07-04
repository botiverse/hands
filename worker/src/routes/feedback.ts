/**
 * Feedback tickets (task #66): public SDK-facing submission endpoint plus
 * admin ticket management.
 *
 * Public submit is unauthenticated (like update checks) but rate-limited per
 * app + hashed client IP. Attachments live in R2 under feedback/…; admins
 * download them through an authenticated streaming endpoint (no presign
 * needed).
 */
import type { Context } from "hono";
import { currentActor, type AdminEnv } from "../middleware/auth";
import { emitWebhookEvent } from "./webhooks";

type AdminContext = Context<AdminEnv & { Bindings: Env }>;

const MAX_ATTACHMENTS = 3;
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const MAX_MESSAGE_CHARS = 10_000;
const RATE_LIMIT_PER_HOUR = 10;

const TICKET_STATUSES = ["open", "in_progress", "resolved", "closed"] as const;
const TICKET_KINDS = ["feedback", "bug", "crash"] as const;

export async function handlePublicFeedbackSubmit(c: Context<{ Bindings: Env }>) {
  const slug = c.req.param("slug");
  if (!slug) return c.json({ error: "slug required" }, 400);
  const app = await c.env.DB.prepare(
    "SELECT id, org_id, slug FROM apps WHERE slug = ?1 AND archived = 0",
  )
    .bind(slug)
    .first<{ id: string; org_id: string | null; slug: string }>();
  if (!app) return c.json({ error: `app '${slug}' not found` }, 404);

  let form: FormData;
  try {
    form = await c.req.formData();
  } catch {
    return c.json({ error: "multipart/form-data body required" }, 400);
  }

  const message = String(form.get("message") ?? "").trim();
  if (!message) return c.json({ error: "message is required" }, 400);
  if (message.length > MAX_MESSAGE_CHARS) {
    return c.json({ error: `message too long (max ${MAX_MESSAGE_CHARS} chars)` }, 400);
  }
  const kindRaw = String(form.get("kind") ?? "feedback");
  const kind = (TICKET_KINDS as readonly string[]).includes(kindRaw) ? kindRaw : "feedback";
  const contact = String(form.get("contact") ?? "").trim() || null;

  let metadata: Record<string, unknown> = {};
  const metadataRaw = form.get("metadata");
  if (typeof metadataRaw === "string" && metadataRaw.trim()) {
    try {
      const parsed = JSON.parse(metadataRaw);
      if (parsed && typeof parsed === "object") metadata = parsed as Record<string, unknown>;
    } catch {
      return c.json({ error: "metadata must be valid JSON" }, 400);
    }
  }
  const meta = (key: string, max = 200): string | null => {
    const value = metadata[key];
    if (value === undefined || value === null) return null;
    return String(value).slice(0, max) || null;
  };
  const versionCodeRaw = metadata["version_code"];
  const versionCode =
    typeof versionCodeRaw === "number" && Number.isFinite(versionCodeRaw)
      ? Math.trunc(versionCodeRaw)
      : null;

  // Rate limit per app + hashed client ip.
  const clientIp =
    (c.req.raw?.cf as { clientIp?: string } | undefined)?.clientIp ??
    c.req.header("cf-connecting-ip") ??
    "unknown";
  const clientIpHash = await sha256Hex(`feedback:${app.id}:${clientIp}`);
  const oneHourAgo = Date.now() - 3600_000;
  const recent = await c.env.DB.prepare(
    `SELECT COUNT(*) AS count FROM feedback_tickets
     WHERE app_id = ?1 AND client_ip_hash = ?2 AND created_at > ?3`,
  )
    .bind(app.id, clientIpHash, oneHourAgo)
    .first<{ count: number }>();
  if ((recent?.count ?? 0) >= RATE_LIMIT_PER_HOUR) {
    return c.json({ error: "too many feedback submissions; try again later" }, 429);
  }

  // Collect attachments before writing anything.
  const files: File[] = [];
  for (const entry of form.getAll("attachments")) {
    if (typeof entry === "string") continue;
    const file = entry as File;
    if (file.size === 0) continue;
    if (files.length >= MAX_ATTACHMENTS) {
      return c.json({ error: `too many attachments (max ${MAX_ATTACHMENTS})` }, 400);
    }
    if (file.size > MAX_ATTACHMENT_BYTES) {
      return c.json(
        { error: `attachment '${file.name}' too large (max ${MAX_ATTACHMENT_BYTES} bytes)` },
        400,
      );
    }
    files.push(file);
  }

  const now = Date.now();
  const ticketId = crypto.randomUUID();

  const attachmentRows: Array<{
    id: string;
    r2Key: string;
    filename: string;
    contentType: string | null;
    sizeBytes: number;
  }> = [];
  for (const [index, file] of files.entries()) {
    const safeName = file.name.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120) || `attachment-${index}`;
    const r2Key = `feedback/${app.id}/${ticketId}/${index}-${safeName}`;
    await c.env.APK_BUCKET.put(r2Key, await file.arrayBuffer(), {
      httpMetadata: { contentType: file.type || "application/octet-stream" },
    });
    attachmentRows.push({
      id: crypto.randomUUID(),
      r2Key,
      filename: safeName,
      contentType: file.type || null,
      sizeBytes: file.size,
    });
  }

  const statements = [
    c.env.DB.prepare(
      `INSERT INTO feedback_tickets
       (id, app_id, kind, status, message, contact, version_name, version_code,
        channel, device_id, device_model, os_version, arch, locale,
        metadata_json, client_ip_hash, created_at, updated_at)
       VALUES (?1, ?2, ?3, 'open', ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)`,
    ).bind(
      ticketId,
      app.id,
      kind,
      message,
      contact,
      meta("version_name"),
      versionCode,
      meta("channel"),
      meta("device_id"),
      meta("device_model"),
      meta("os_version"),
      meta("arch"),
      meta("locale", 40),
      JSON.stringify(metadata),
      clientIpHash,
      now,
      now,
    ),
    ...attachmentRows.map((a) =>
      c.env.DB.prepare(
        `INSERT INTO feedback_attachments
         (id, ticket_id, r2_key, filename, content_type, size_bytes, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
      ).bind(a.id, ticketId, a.r2Key, a.filename, a.contentType, a.sizeBytes, now),
    ),
  ];
  await c.env.DB.batch(statements);

  if (app.org_id) {
    await emitWebhookEvent(c.env.DB, {
      orgId: app.org_id,
      appId: app.id,
      event: "feedback:new",
      body: {
        ticket_id: ticketId,
        app_slug: app.slug,
        kind,
        message: message.slice(0, 500),
        version_name: meta("version_name"),
        version_code: versionCode,
        attachments: attachmentRows.length,
      },
    }).catch(() => {
      // webhook fan-out must never fail the submission
    });
  }

  return c.json({ id: ticketId, status: "open", attachments: attachmentRows.length }, 201);
}

export async function handleListFeedback(c: AdminContext) {
  const appId = c.req.param("appId");
  const status = c.req.query("status");
  const kind = c.req.query("kind");
  const binds: unknown[] = [appId];
  let where = "app_id = ?1";
  if (status && (TICKET_STATUSES as readonly string[]).includes(status)) {
    binds.push(status);
    where += ` AND status = ?${binds.length}`;
  }
  if (kind && (TICKET_KINDS as readonly string[]).includes(kind)) {
    binds.push(kind);
    where += ` AND kind = ?${binds.length}`;
  }
  const { results } = await c.env.DB.prepare(
    `SELECT t.id, t.kind, t.status, t.assignee, t.message, t.contact, t.version_name,
            t.version_code, t.channel, t.device_model, t.os_version,
            t.created_at, t.updated_at,
            (SELECT COUNT(*) FROM feedback_attachments fa WHERE fa.ticket_id = t.id) AS attachment_count,
            (SELECT COUNT(*) FROM feedback_comments fc WHERE fc.ticket_id = t.id) AS comment_count
     FROM feedback_tickets t
     WHERE ${where}
     ORDER BY t.created_at DESC
     LIMIT 200`,
  )
    .bind(...binds)
    .all();
  return c.json({ tickets: results });
}

export async function handleGetFeedback(c: AdminContext) {
  const appId = c.req.param("appId");
  const ticketId = c.req.param("ticketId");
  const ticket = await c.env.DB.prepare(
    "SELECT * FROM feedback_tickets WHERE app_id = ?1 AND id = ?2",
  )
    .bind(appId, ticketId)
    .first();
  if (!ticket) return c.json({ error: "ticket not found" }, 404);
  const { results: attachments } = await c.env.DB.prepare(
    `SELECT id, filename, content_type, size_bytes, created_at
     FROM feedback_attachments WHERE ticket_id = ?1 ORDER BY created_at`,
  )
    .bind(ticketId)
    .all();
  const { results: comments } = await c.env.DB.prepare(
    `SELECT id, author_actor, body, internal, created_at
     FROM feedback_comments WHERE ticket_id = ?1 ORDER BY created_at`,
  )
    .bind(ticketId)
    .all();
  return c.json({ ticket, attachments, comments });
}

export async function handleUpdateFeedback(c: AdminContext) {
  const appId = c.req.param("appId");
  const ticketId = c.req.param("ticketId");
  const body = (await c.req.json().catch(() => ({}))) as {
    status?: string;
    assignee?: string | null;
  };
  const sets: string[] = [];
  const binds: unknown[] = [];
  if (body.status !== undefined) {
    if (!(TICKET_STATUSES as readonly string[]).includes(body.status)) {
      return c.json({ error: `status must be one of ${TICKET_STATUSES.join(", ")}` }, 400);
    }
    binds.push(body.status);
    sets.push(`status = ?${binds.length}`);
  }
  if (body.assignee !== undefined) {
    const assignee =
      typeof body.assignee === "string" ? body.assignee.trim().slice(0, 120) : "";
    binds.push(assignee || null);
    sets.push(`assignee = ?${binds.length}`);
  }
  if (sets.length === 0) {
    return c.json({ error: "nothing to update (status or assignee required)" }, 400);
  }
  const exists = await c.env.DB.prepare(
    "SELECT id FROM feedback_tickets WHERE app_id = ?1 AND id = ?2",
  )
    .bind(appId, ticketId)
    .first();
  if (!exists) return c.json({ error: "ticket not found" }, 404);

  const now = Date.now();
  binds.push(now);
  sets.push(`updated_at = ?${binds.length}`);
  binds.push(appId, ticketId);
  await c.env.DB.prepare(
    `UPDATE feedback_tickets SET ${sets.join(", ")}
     WHERE app_id = ?${binds.length - 1} AND id = ?${binds.length}`,
  )
    .bind(...binds)
    .run();
  await c.env.DB.prepare(
    `INSERT INTO audit_logs (id, app_id, action, actor, payload, created_at)
     VALUES (?1, ?2, 'feedback.update', ?3, ?4, ?5)`,
  )
    .bind(
      crypto.randomUUID(),
      appId,
      currentActor(c),
      JSON.stringify({ ticket_id: ticketId, status: body.status ?? null, assignee: body.assignee === undefined ? null : (body.assignee || null) }),
      now,
    )
    .run();
  return c.json({ id: ticketId, status: body.status ?? null, assignee: body.assignee ?? null, updated_at: now });
}

export async function handleAddFeedbackComment(c: AdminContext) {
  const appId = c.req.param("appId");
  const ticketId = c.req.param("ticketId");
  const body = (await c.req.json().catch(() => ({}))) as {
    body?: string;
    internal?: boolean;
  };
  const text = (body.body ?? "").trim();
  if (!text) return c.json({ error: "body is required" }, 400);
  const ticket = await c.env.DB.prepare(
    "SELECT id FROM feedback_tickets WHERE app_id = ?1 AND id = ?2",
  )
    .bind(appId, ticketId)
    .first();
  if (!ticket) return c.json({ error: "ticket not found" }, 404);
  const now = Date.now();
  const id = crypto.randomUUID();
  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO feedback_comments (id, ticket_id, author_actor, body, internal, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
    ).bind(id, ticketId, currentActor(c), text, body.internal ? 1 : 0, now),
    c.env.DB.prepare(
      "UPDATE feedback_tickets SET updated_at = ?1 WHERE id = ?2",
    ).bind(now, ticketId),
  ]);
  return c.json({ id, ticket_id: ticketId, created_at: now }, 201);
}

export async function handleDownloadFeedbackAttachment(c: AdminContext) {
  const appId = c.req.param("appId");
  const ticketId = c.req.param("ticketId");
  const attachmentId = c.req.param("attachmentId");
  const row = await c.env.DB.prepare(
    `SELECT fa.r2_key, fa.filename, fa.content_type
     FROM feedback_attachments fa
     JOIN feedback_tickets t ON t.id = fa.ticket_id
     WHERE t.app_id = ?1 AND t.id = ?2 AND fa.id = ?3`,
  )
    .bind(appId, ticketId, attachmentId)
    .first<{ r2_key: string; filename: string; content_type: string | null }>();
  if (!row) return c.json({ error: "attachment not found" }, 404);
  const object = await c.env.APK_BUCKET.get(row.r2_key);
  if (!object) return c.json({ error: "attachment blob missing" }, 404);
  return new Response(object.body, {
    headers: {
      "content-type": row.content_type ?? "application/octet-stream",
      "content-disposition": `attachment; filename="${row.filename}"`,
    },
  });
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
