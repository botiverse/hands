// Screenshots of a feedback event, forwarded to the ticket's Raft thread.
//
// A new ticket's submission images and a new comment's images are sent as one
// reply in the ticket's thread, carrying them as Raft attachments, so the team
// sees them without opening Hands. Only common image types are forwarded, at
// most MAX_FORWARDED of at most MAX_FORWARDED_BYTES each and MAX_TOTAL_BYTES in
// all; the reply counts the other files and links to the ticket. Diagnostics an
// app attaches on its own (a diagnostics zip, a crash's minidump) are left out:
// an event with only those gets no reply; so do the logs an SDK files with a
// crash or error report. Any other file a reporter attached (a recording, a
// log) is counted and linked even when there is no image.
//
// The work survives a delivery attempt that is cut off: each upload's Raft id
// is saved as soon as it exists, and the reply (text and ids) is fixed once,
// first writer wins, so every later attempt sends exactly the same message
// under the same idempotency key.

export const MAX_FORWARDED = 6;
export const MAX_FORWARDED_BYTES = 5 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 15 * 1024 * 1024;
/** No new upload starts this long after forwarding began: the delivery attempt
 * has a deadline, and the next attempt resumes from the saved uploads. */
export const UPLOAD_BUDGET_MS = 5_000;
const MACHINE_KINDS = new Set(["crash", "error"]);
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/jpg", "image/gif", "image/webp", "image/heic", "image/heif"]);

export type FeedbackAttachmentRow = {
  id: string;
  filename: string;
  content_type: string | null;
  size_bytes: number;
  r2_key: string;
};

type Record_ = Record<string, unknown>;
const rec = (value: unknown): Record_ => value && typeof value === "object" && !Array.isArray(value) ? value as Record_ : {};

/** The reporter-visible attachments a feedback:new (the submission's) or feedback:comment_created (that comment's) event brought. */
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
  // A query failure must not block the notification itself: it goes without images.
  try {
    const { results } = await db.prepare(
      `SELECT a.id, a.filename, a.content_type, a.size_bytes, a.r2_key, t.kind AS ticket_kind
       FROM feedback_attachments a JOIN feedback_tickets t ON t.id = a.ticket_id
       WHERE a.ticket_id = ?1 AND t.app_id = ?2 AND a.visibility = 'reporter' AND ${where}
       ORDER BY a.created_at, a.id`,
    ).bind(...binds).all<FeedbackAttachmentRow & { ticket_kind: string | null }>();
    // A crash or error report's own files (crash log, ANR trace, native record)
    // come from the SDK, not the reporter: only its images are of interest.
    return (results ?? [])
      .filter((row) => !(event === "feedback:new" && MACHINE_KINDS.has(row.ticket_kind ?? "") && !isForwardableImage(row)))
      .map(({ ticket_kind: _kind, ...row }) => row);
  } catch (error) {
    console.warn(JSON.stringify({ hands: "raft_feedback_attachments_query_failed", why: String((error as Error)?.message ?? error).slice(0, 200) }));
    return [];
  }
}

export function isForwardableImage(row: FeedbackAttachmentRow): boolean {
  return IMAGE_TYPES.has((row.content_type ?? "").toLowerCase());
}

/** A diagnostics bundle or minidump the app attached on its own, such as
 * raft-feedback-diagnostics-<id>.zip or a crash's diagnostics-<ts>.zip. */
export function isDiagnosticsBundle(row: FeedbackAttachmentRow): boolean {
  const name = row.filename.toLowerCase();
  const type = (row.content_type ?? "").toLowerCase();
  if (type === "application/x-minidump" || name.endsWith(".dmp")) return true;
  return /(^|[-_])diagnostics([-_.][^/\\]*)?\.zip$/.test(name);
}

/** Which attachments go to Raft, and how many are only mentioned. Diagnostics
 * bundles are neither sent nor counted. */
export function planForward(rows: FeedbackAttachmentRow[]): { send: FeedbackAttachmentRow[]; other: number } {
  rows = rows.filter((row) => !isDiagnosticsBundle(row));
  const send: FeedbackAttachmentRow[] = [];
  let total = 0;
  for (const row of rows) {
    if (send.length >= MAX_FORWARDED) break;
    if (!isForwardableImage(row) || row.size_bytes <= 0 || row.size_bytes > MAX_FORWARDED_BYTES) continue;
    if (total + row.size_bytes > MAX_TOTAL_BYTES) continue;
    total += row.size_bytes;
    send.push(row);
  }
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

export class AttachmentSendRefused extends Error {
  constructor(readonly kind: "duplicate" | "refused") { super(kind); }
}

export class AttachmentsDeferred extends Error {
  constructor() { super("attachments_deferred"); }
}

export type AttachmentTransport = {
  /** Whether the bot may upload to the channel at all; false leaves every file to the link. Throws to retry. */
  canUpload(): Promise<boolean>;
  /** Uploads one file as a Raft attachment; null if this file cannot go to Raft (refused, not permitted). Throws to retry. */
  upload(file: { bytes: ArrayBuffer; filename: string; contentType: string }): Promise<string | null>;
  /** Throws AttachmentSendRefused when Raft says the key was used for other content, or refuses the message. */
  send(request: { target: string; content: string; attachmentIds: string[]; idempotencyKey: string }): Promise<{ messageId: string }>;
  readObject(key: string, maxBytes: number): Promise<ArrayBuffer | null>;
};

type Reply = { content: string; ids: string[]; files: number };

function parseReply(value: string | null | undefined): Reply | null {
  if (!value) return null;
  try {
    const parsed = rec(JSON.parse(value));
    if (typeof parsed.content === "string" && Array.isArray(parsed.ids) && parsed.ids.every((id) => typeof id === "string")) {
      const files = typeof parsed.files === "number" ? parsed.files : (parsed.ids as string[]).length;
      return { content: parsed.content, ids: parsed.ids as string[], files };
    }
  } catch { /* unusable: rebuilt below */ }
  return null;
}

function parseProgress(value: string | null | undefined): Record<string, string | null> {
  try {
    const parsed = rec(JSON.parse(value || "{}"));
    const out: Record<string, string | null> = {};
    for (const [k, v] of Object.entries(parsed)) if (typeof v === "string" || v === null) out[k] = v;
    return out;
  } catch {
    return {};
  }
}

/**
 * Sends the event's attachments reply once (see the file comment). Throws on a
 * retryable failure; the caller retries the delivery.
 */
export async function forwardFeedbackAttachments(options: {
  db: D1Database;
  subscriptionId: string;
  eventHash: string;
  threadTarget: string;
  rows: FeedbackAttachmentRow[];
  link: string | null;
  transport: AttachmentTransport;
  now?: () => number;
}): Promise<{ messageId: string; attached: number } | null> {
  const { db, subscriptionId, eventHash, threadTarget, link, transport } = options;
  const rows = options.rows.filter((row) => !isDiagnosticsBundle(row));
  const clock = options.now ?? Date.now;
  const started = clock();
  const plan = planForward(rows);
  if (plan.send.length === 0 && plan.other === 0) return null;
  const now = Date.now();
  await db.prepare(
    `INSERT INTO raft_notification_attachment_sends
       (subscription_id, event_hash, attachment_ids_json, reply_json, message_id, created_at, updated_at)
     VALUES (?1, ?2, '{}', NULL, NULL, ?3, ?3)
     ON CONFLICT (subscription_id, event_hash) DO NOTHING`,
  ).bind(subscriptionId, eventHash, now).run();
  const read = () => db.prepare(
    `SELECT attachment_ids_json, reply_json, message_id FROM raft_notification_attachment_sends
     WHERE subscription_id = ?1 AND event_hash = ?2`,
  ).bind(subscriptionId, eventHash).first<{ attachment_ids_json: string | null; reply_json: string | null; message_id: string | null }>();
  let state = await read();
  if (state?.message_id) return null;
  let reply = parseReply(state?.reply_json);
  if (!reply) {
    // Upload what is not uploaded yet, saving each id at once (null: not sent to Raft).
    const progress = parseProgress(state?.attachment_ids_json);
    const pending = plan.send.filter((row) => !(row.id in progress));
    const allowed = pending.length === 0 || await transport.canUpload();
    let uploadedNow = 0;
    for (const row of pending) {
      // At least one file per attempt, so a slow upload still makes progress.
      if (uploadedNow > 0 && clock() - started > UPLOAD_BUDGET_MS) throw new AttachmentsDeferred();
      uploadedNow += 1;
      const bytes = allowed ? await transport.readObject(row.r2_key, MAX_FORWARDED_BYTES) : null;
      progress[row.id] = bytes
        ? await transport.upload({ bytes, filename: row.filename, contentType: row.content_type ?? "application/octet-stream" })
        : null;
      await db.prepare(
        `UPDATE raft_notification_attachment_sends SET attachment_ids_json = ?1, updated_at = ?2
         WHERE subscription_id = ?3 AND event_hash = ?4 AND reply_json IS NULL`,
      ).bind(JSON.stringify(progress), Date.now(), subscriptionId, eventHash).run();
    }
    const ids = plan.send.map((row) => progress[row.id]).filter((id): id is string => !!id);
    const built: Reply = { content: attachmentsReplyText(ids.length, rows.length - ids.length, link), ids, files: rows.length };
    // Fixed once: a concurrent attempt that got here first decides the reply.
    await db.prepare(
      `UPDATE raft_notification_attachment_sends SET reply_json = ?1, updated_at = ?2
       WHERE subscription_id = ?3 AND event_hash = ?4 AND reply_json IS NULL`,
    ).bind(JSON.stringify(built), Date.now(), subscriptionId, eventHash).run();
    state = await read();
    if (state?.message_id) return null;
    reply = parseReply(state?.reply_json) ?? built;
  }
  if (!reply.content) return null;
  const key = `hands-raft-attachments:${subscriptionId}:${eventHash}`.slice(0, 240);
  const done = (messageId: string) => db.prepare(
    `UPDATE raft_notification_attachment_sends SET message_id = ?1, updated_at = ?2
     WHERE subscription_id = ?3 AND event_hash = ?4`,
  ).bind(messageId, Date.now(), subscriptionId, eventHash).run();
  try {
    const sent = await transport.send({ target: threadTarget, content: reply.content, attachmentIds: reply.ids, idempotencyKey: key });
    await done(sent.messageId);
    return { messageId: sent.messageId, attached: reply.ids.length };
  } catch (error) {
    if (!(error instanceof AttachmentSendRefused)) throw error;
    if (error.kind === "duplicate") {
      // This key already carried a reply for the event: it was sent.
      await done("sent:unknown");
      return null;
    }
    // Raft refused the message with these attachments: say so in text, once.
    if (reply.ids.length > 0) {
      try {
        const text = attachmentsReplyText(0, reply.files, link);
        const sent = await transport.send({ target: threadTarget, content: text, attachmentIds: [], idempotencyKey: `${key}:text`.slice(0, 240) });
        await done(sent.messageId);
        return { messageId: sent.messageId, attached: 0 };
      } catch (fallback) {
        if (!(fallback instanceof AttachmentSendRefused)) throw fallback;
      }
    }
    await done(`refused:${error.kind}`);
    return null;
  }
}
