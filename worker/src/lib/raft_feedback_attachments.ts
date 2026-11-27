// Screenshots of a feedback event, forwarded to the ticket's Raft thread.
//
// A new ticket's submission images and a new comment's images are sent as one
// reply in the ticket's thread, carrying them as Raft attachments, so the team
// sees them without opening Hands. Only images are forwarded (minidumps, logs
// and other files are counted and linked, and an event with no image gets no
// reply); at most MAX_FORWARDED images of at
// most MAX_FORWARDED_BYTES each, the rest counted and linked.

export const MAX_FORWARDED = 6;
export const MAX_FORWARDED_BYTES = 10 * 1024 * 1024;

export type FeedbackAttachmentRow = {
  id: string;
  filename: string;
  content_type: string | null;
  size_bytes: number;
  r2_key: string;
};

type Record_ = Record<string, unknown>;
const rec = (value: unknown): Record_ => value && typeof value === "object" && !Array.isArray(value) ? value as Record_ : {};

/** The attachments a feedback:new (the submission's) or feedback:comment_created (that comment's) event brought. */
export async function feedbackEventAttachments(
  db: D1Database, appId: string, event: string, payload: Record_,
): Promise<FeedbackAttachmentRow[]> {
  const ticketId = typeof payload.ticket_id === "string" ? payload.ticket_id : "";
  if (!ticketId) return [];
  const commentId = rec(payload.comment).id;
  let where: string;
  const binds: unknown[] = [ticketId, appId];
  if (event === "feedback:new") {
    where = "a.comment_id IS NULL AND a.origin = 'submission'";
  } else if (event === "feedback:comment_created" && typeof commentId === "string" && commentId) {
    where = "a.comment_id = ?3";
    binds.push(commentId);
  } else {
    return [];
  }
  try {
    const { results } = await db.prepare(
      `SELECT a.id, a.filename, a.content_type, a.size_bytes, a.r2_key
       FROM feedback_attachments a JOIN feedback_tickets t ON t.id = a.ticket_id
       WHERE a.ticket_id = ?1 AND t.app_id = ?2 AND ${where}
       ORDER BY a.created_at, a.id`,
    ).bind(...binds).all<FeedbackAttachmentRow>();
    return results ?? [];
  } catch {
    return [];
  }
}

export function isForwardableImage(row: FeedbackAttachmentRow): boolean {
  return (row.content_type ?? "").toLowerCase().startsWith("image/");
}

/** Which attachments go to Raft, and how many are only mentioned. An event
 * without any image (a crash's minidump, a log) gets no reply. */
export function planForward(rows: FeedbackAttachmentRow[]): { send: FeedbackAttachmentRow[]; other: number } {
  if (!rows.some(isForwardableImage)) return { send: [], other: 0 };
  const send = rows.filter((r) => isForwardableImage(r) && r.size_bytes > 0 && r.size_bytes <= MAX_FORWARDED_BYTES)
    .slice(0, MAX_FORWARDED);
  return { send, other: rows.length - send.length };
}

/** The reply's text: how many images it carries, and the rest with a link to the ticket. */
export function attachmentsReplyText(sent: number, other: number, link: string | null): string {
  const lines: string[] = [];
  if (sent > 0) lines.push(`📎 **${sent} ${sent === 1 ? "attachment" : "attachments"}** from this report`);
  if (other > 0) {
    const what = `${other} ${other === 1 ? "file" : "files"}`;
    const more = sent > 0 ? `${what} more not attached here` : `📎 ${what} attached in Hands`;
    lines.push(link ? `${more} · [View feedback](${link})` : more);
  }
  return lines.join("\n");
}

export type AttachmentTransport = {
  /** Uploads one file as a Raft attachment for the channel; null if Raft refuses this file (too large, type). */
  upload(file: { bytes: ArrayBuffer; filename: string; contentType: string }): Promise<string | null>;
  send(request: { target: string; content: string; attachmentIds: string[]; idempotencyKey: string }): Promise<{ messageId: string }>;
  readObject(key: string): Promise<ArrayBuffer | null>;
};

/**
 * Sends the event's attachments reply once. Uploaded ids are saved before the
 * send, so a retry after a lost reply resends the same message under the same
 * key rather than uploading again. Throws on a retryable failure.
 */
export async function forwardFeedbackAttachments(options: {
  db: D1Database;
  subscriptionId: string;
  eventHash: string;
  threadTarget: string;
  rows: FeedbackAttachmentRow[];
  link: string | null;
  transport: AttachmentTransport;
}): Promise<{ messageId: string; attached: number } | null> {
  const { db, subscriptionId, eventHash, threadTarget, rows, link, transport } = options;
  const plan = planForward(rows);
  if (plan.send.length === 0 && plan.other === 0) return null;
  const prior = await db.prepare(
    `SELECT attachment_ids_json, message_id FROM raft_notification_attachment_sends
     WHERE subscription_id = ?1 AND event_hash = ?2`,
  ).bind(subscriptionId, eventHash).first<{ attachment_ids_json: string | null; message_id: string | null }>();
  if (prior?.message_id) return null;
  let ids: string[] | null = null;
  if (prior?.attachment_ids_json) {
    try {
      const parsed = JSON.parse(prior.attachment_ids_json);
      if (Array.isArray(parsed) && parsed.every((id) => typeof id === "string")) ids = parsed;
    } catch { ids = null; }
  }
  if (!ids) {
    ids = [];
    for (const row of plan.send) {
      const bytes = await transport.readObject(row.r2_key);
      if (!bytes) continue;
      const id = await transport.upload({ bytes, filename: row.filename, contentType: row.content_type ?? "application/octet-stream" });
      if (id) ids.push(id);
    }
    const now = Date.now();
    await db.prepare(
      `INSERT INTO raft_notification_attachment_sends
         (subscription_id, event_hash, attachment_ids_json, message_id, created_at, updated_at)
       VALUES (?1, ?2, ?3, NULL, ?4, ?4)
       ON CONFLICT (subscription_id, event_hash) DO UPDATE SET attachment_ids_json = ?3, updated_at = ?4`,
    ).bind(subscriptionId, eventHash, JSON.stringify(ids), now).run();
  }
  const content = attachmentsReplyText(ids.length, rows.length - ids.length, link);
  if (!content) return null;
  const key = `hands-raft-attachments:${subscriptionId}:${eventHash}`.slice(0, 240);
  const sent = await transport.send({ target: threadTarget, content, attachmentIds: ids, idempotencyKey: key });
  await db.prepare(
    `UPDATE raft_notification_attachment_sends SET message_id = ?1, updated_at = ?2
     WHERE subscription_id = ?3 AND event_hash = ?4`,
  ).bind(sent.messageId, Date.now(), subscriptionId, eventHash).run();
  return { messageId: sent.messageId, attached: ids.length };
}

/** Forgets saved upload ids (Raft refused them on send), so the next attempt uploads again. */
export async function resetForwardedUploads(db: D1Database, subscriptionId: string, eventHash: string): Promise<void> {
  await db.prepare(
    `UPDATE raft_notification_attachment_sends SET attachment_ids_json = NULL, updated_at = ?1
     WHERE subscription_id = ?2 AND event_hash = ?3 AND message_id IS NULL`,
  ).bind(Date.now(), subscriptionId, eventHash).run();
}
