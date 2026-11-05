import { formatRaftNotificationCard, type RaftMessageCard } from "./raft_notification_card";

type Payload = Record<string, unknown>;
type App = { id: string; slug: string | null; name: string | null };

// Each family has its own object identity; unrelated release and build
// observations must not overwrite each other. Other events remain text.
const CARD_EVENTS = new Set([
  "app_store:version_state_changed",
  "testflight:external_state_changed",
  "google_play:release_state_changed",
]);
const LEASE_MS = 30_000;
// Retire slightly before Raft's 14-day update deadline.
const MAX_CARD_AGE_MS = 14 * 24 * 60 * 60_000 - 5 * 60_000;

interface Pending {
  kind: "send" | "update";
  eventHash: string;
  eventMs: number;
  idempotencyKey: string;
  content: string;
  card: RaftMessageCard;
  target: string;
  messageId: string | null;
  expectedRevision: number;
  createsRoot: boolean;
  createdAt: number;
  sendAsText?: boolean;
}

interface CardRow {
  state: "active" | "retired";
  message_id: string | null;
  revision: number;
  message_created_at: number | null;
  last_event_ms: number | null;
  last_event_hash: string | null;
  pending_json: string | null;
  pending_uncertain: number;
}

export interface CardTransport {
  send(request: { target: string; content: string; card?: RaftMessageCard; idempotencyKey: string }): Promise<{ messageId: string; cardRevision?: number }>;
  announce(request: { target: string; previousTarget: string; content: string; eventHash: string }): Promise<{ messageId: string }>;
  reconcile(request: { target: string; idempotencyKey: string }): Promise<{ state: "committed"; messageId: string; cardRevision?: number } | { state: "not_found" }>;
  resolve(messageId: string): Promise<{ kind: "card"; revision: number } | { kind: "text" }>;
  update(request: { messageId: string; content: string; card: RaftMessageCard; expectedRevision: number; idempotencyKey: string }): Promise<{ messageId: string; revision: number }>;
}

export type CardDeliveryResult =
  | { kind: "delivered"; messageId: string; card: boolean }
  | { kind: "skipped" }
  | { kind: "text"; reason?: string }
  | { kind: "retry"; code: string };

export function supportsRaftNotificationCards(event: unknown): boolean {
  return typeof event === "string" && CARD_EVENTS.has(event);
}

function eventTime(body: Payload): number | null {
  const payload = body.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const occurred = (payload as Payload).occurred_at;
  if (typeof occurred !== "string") return null;
  const match = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(?:\.\d{1,9})?(?:Z|[+-]\d\d:\d\d)$/.exec(occurred);
  if (!match) return null;
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number) as [number, number, number, number, number, number];
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > days[month - 1]! || hour > 23 || minute > 59 || second > 59) return null;
  const time = Date.parse(occurred);
  return Number.isFinite(time) ? time : null;
}

function refusal(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;
  const e = error as { status?: unknown; code?: unknown };
  if (e.status === 400 && (e.code === "message_cards_disabled" || e.code === "message_card_unsupported_target" || e.code === "card_invalid")) return e.code;
  if (e.status === 404 && e.code === "message_card_not_found") return e.code;
  return null;
}

/**
 * Serialize one object's events. The durable pending body is replayed before a
 * newer event can proceed. An ambiguous network outcome is never converted to
 * a fresh text send just because a later attempt was refused by a changed flag.
 */
export async function deliverRaftNotificationCard(input: {
  db: D1Database;
  transport: CardTransport;
  subscriptionId: string;
  objectKey: string;
  target: string;
  channelTarget: string;
  createsRoot: boolean;
  eventHash: string;
  body: Payload;
  app: App;
  now?: () => number;
}): Promise<CardDeliveryResult> {
  const { db, subscriptionId, objectKey, transport } = input;
  const now = input.now ?? Date.now;
  const token = crypto.randomUUID();
  await db.prepare(`INSERT OR IGNORE INTO raft_notification_cards
    (subscription_id, object_key, updated_at) VALUES (?1, ?2, ?3)`)
    .bind(subscriptionId, objectKey, now()).run();
  const claimed = await db.prepare(`UPDATE raft_notification_cards SET lease_token=?1, lease_expires_at=?2, updated_at=?3
    WHERE subscription_id=?4 AND object_key=?5 AND (lease_token IS NULL OR lease_expires_at<?3)`)
    .bind(token, now() + LEASE_MS, now(), subscriptionId, objectKey).run();
  if (claimed.meta.changes !== 1) return { kind: "retry", code: "card_delivery_busy" };

  const load = () => db.prepare(`SELECT state,message_id,revision,message_created_at,last_event_ms,last_event_hash,
    pending_json,pending_uncertain FROM raft_notification_cards WHERE subscription_id=?1 AND object_key=?2 AND lease_token=?3`)
    .bind(subscriptionId, objectKey, token).first<CardRow>();
  const ownUpdate = async (sql: string, ...params: unknown[]) => {
    const result = await db.prepare(sql).bind(...params).run();
    return result.meta.changes === 1;
  };
  try {
    let row = await load();
    if (!row) return { kind: "retry", code: "card_delivery_lease_lost" };
    const replay = async (pending: Pending, wasUncertain: boolean): Promise<CardDeliveryResult> => {
      // Mark uncertainty before the network call, so a process death in the
      // middle is indistinguishable from a lost response and remains safe.
      const marked = await ownUpdate(`UPDATE raft_notification_cards SET pending_uncertain=1,lease_expires_at=?1,updated_at=?2
        WHERE subscription_id=?3 AND object_key=?4 AND lease_token=?5 AND pending_json=?6`,
        now() + LEASE_MS, now(), subscriptionId, objectKey, token, JSON.stringify(pending));
      if (!marked) return { kind: "retry", code: "card_delivery_lease_lost" };
      let result: { messageId: string; revision: number };
      let sentAsText = false;
      let mayHaveCommitted = wasUncertain;
      try {
        if (pending.kind === "send" && pending.sendAsText) {
          // A text send competes with the original card send under the *same*
          // Raft key. The sender+key unique constraint lets only one win.
          try {
            const text = await transport.send({ target: pending.target, content: pending.content, idempotencyKey: pending.idempotencyKey });
            result = { messageId: text.messageId, revision: 0 };
            sentAsText = true;
          } catch (error) {
            const conflict = error && typeof error === "object" ? error as { status?: unknown; code?: unknown } : null;
            if (conflict?.status !== 409 || conflict.code !== "idempotency_key_reused") throw error;
            // The card may have won the race. Replay that exact request to
            // identify it; a conflict or missing proof leaves it pending.
            const card = await transport.send(pending);
            let revision = card.cardRevision;
            if (revision === undefined) {
              const readback = await transport.resolve(card.messageId);
              if (readback.kind !== "card") throw error;
              revision = readback.revision;
            }
            if (revision !== 1) return { kind: "retry", code: "card_delivery_unexpected_revision" };
            result = { messageId: card.messageId, revision };
          }
          mayHaveCommitted = true;
        } else if (pending.kind === "send") {
          const found = wasUncertain ? await transport.reconcile(pending) : { state: "not_found" as const };
          // A not_found read is only a point-in-time observation: the old
          // request may still be running. Retry the exact same key and body.
          const sent = found.state === "committed" ? found : await transport.send(pending);
          mayHaveCommitted = true;
          const messageId = sent.messageId;
          // Older servers accept unknown fields and can silently post only the
          // fallback. Newer send receipts identify cards; older ones need a
          // readback. Joint readback can be unavailable, so a committed send
          // may instead replay the exact request to obtain its richer receipt.
          let readback: { kind: "card"; revision: number } | { kind: "text" };
          if (sent.cardRevision !== undefined) readback = { kind: "card", revision: sent.cardRevision };
          else {
            try { readback = await transport.resolve(messageId); }
            catch (error) {
              if (found.state !== "committed") throw error;
              const replayed = await transport.send(pending);
              if (replayed.messageId !== messageId || replayed.cardRevision === undefined) throw error;
              readback = { kind: "card", revision: replayed.cardRevision };
            }
          }
          if (readback.kind === "card" && readback.revision !== 1) {
            return { kind: "retry", code: "card_delivery_unexpected_revision" };
          }
          sentAsText = readback.kind === "text";
          result = { messageId, revision: sentAsText ? 0 : 1 };
        } else {
          if (!pending.messageId) return { kind: "retry", code: "card_delivery_invalid_pending" };
          result = await transport.update({ ...pending, messageId: pending.messageId });
          if (result.messageId !== pending.messageId || result.revision !== pending.expectedRevision + 1) {
            return { kind: "retry", code: "card_delivery_incomplete" };
          }
          mayHaveCommitted = true;
        }
        // Updating a card does not create an unread message. Keep the exact
        // card request pending until a channel notice is confirmed as well;
        // its content and event hash are frozen in pending_json, so a lost
        // notice response can be replayed without another channel message.
        // Pending sends from an older worker may have targeted a thread and
        // similarly need a channel notice after their outcome is known.
        if (pending.kind === "update" || pending.target !== input.channelTarget) {
          const stillOwned = await ownUpdate(`UPDATE raft_notification_cards SET lease_expires_at=?1,updated_at=?2
            WHERE subscription_id=?3 AND object_key=?4 AND lease_token=?5 AND pending_json=?6`,
            now() + LEASE_MS, now(), subscriptionId, objectKey, token, JSON.stringify(pending));
          if (!stillOwned) return { kind: "retry", code: "card_delivery_lease_lost" };
          mayHaveCommitted = true;
          await transport.announce({
            target: input.channelTarget,
            previousTarget: pending.target,
            content: pending.content,
            eventHash: pending.eventHash,
          });
        }
      } catch (error) {
        const code = refusal(error);
        if (code && !mayHaveCommitted) {
          const retired = await ownUpdate(`UPDATE raft_notification_cards SET state='retired',pending_json=NULL,pending_uncertain=0,updated_at=?1
            WHERE subscription_id=?2 AND object_key=?3 AND lease_token=?4 AND pending_json=?5`,
            now(), subscriptionId, objectKey, token, JSON.stringify(pending));
          return retired ? { kind: "text", reason: code } : { kind: "retry", code: "card_delivery_lease_lost" };
        }
        return { kind: "retry", code: code ? "card_delivery_uncertain" : "card_delivery_failed" };
      }
      const saved = await ownUpdate(`UPDATE raft_notification_cards SET message_id=?1,revision=?2,
        message_created_at=CASE WHEN ?3='send' THEN ?4 ELSE message_created_at END,
        last_event_ms=?5,last_event_hash=?6,pending_json=NULL,pending_uncertain=0,updated_at=?7,
        state=CASE WHEN ?12=1 THEN 'retired' ELSE state END
        WHERE subscription_id=?8 AND object_key=?9 AND lease_token=?10 AND pending_json=?11`,
        result.messageId, result.revision, pending.kind, pending.createdAt, pending.eventMs, pending.eventHash,
        now(), subscriptionId, objectKey, token, JSON.stringify(pending), sentAsText ? 1 : 0);
      if (!saved) return { kind: "retry", code: "card_delivery_lease_lost" };
      if (pending.createsRoot) {
        await db.prepare(`UPDATE raft_notification_threads SET parent_message_id=?1,updated_at=?2
          WHERE subscription_id=?3 AND object_key=?4 AND parent_message_id='pending'`)
          .bind(result.messageId, now(), subscriptionId, objectKey).run();
      }
      return { kind: "delivered", messageId: result.messageId, card: !sentAsText };
    };

    if (row.pending_json) {
      let pending: Pending;
      try { pending = JSON.parse(row.pending_json) as Pending; } catch { return { kind: "retry", code: "card_delivery_invalid_pending" }; }
      const settings = await db.prepare(`SELECT card_updates FROM raft_notification_subscriptions
        WHERE id=?1 AND archived_at IS NULL`).bind(subscriptionId).first<{ card_updates: number }>();
      // On an explicit switch to text, a pending initial send can be fenced by
      // competing with its original key. Persist that choice before sending.
      if (pending.kind === "send" && row.pending_uncertain === 1 && !pending.sendAsText && settings?.card_updates === 0) {
        const changed = { ...pending, sendAsText: true };
        const saved = await ownUpdate(`UPDATE raft_notification_cards SET state='retired',pending_json=?1,updated_at=?2
          WHERE subscription_id=?3 AND object_key=?4 AND lease_token=?5 AND pending_json=?6`,
          JSON.stringify(changed), now(), subscriptionId, objectKey, token, JSON.stringify(pending));
        if (!saved) return { kind: "retry", code: "card_delivery_lease_lost" };
        pending = changed;
      }
      let recovered = await replay(pending, row.pending_uncertain === 1);
      if (recovered.kind === "retry" && pending.kind === "send" && !pending.sendAsText && pending.eventHash !== input.eventHash) {
        const changed = { ...pending, sendAsText: true };
        const saved = await ownUpdate(`UPDATE raft_notification_cards SET state='retired',pending_json=?1,updated_at=?2
          WHERE subscription_id=?3 AND object_key=?4 AND lease_token=?5 AND pending_json=?6`,
          JSON.stringify(changed), now(), subscriptionId, objectKey, token, JSON.stringify(pending));
        if (!saved) return { kind: "retry", code: "card_delivery_lease_lost" };
        pending = changed;
        recovered = await replay(pending, true);
      }
      if (recovered.kind === "retry" && pending.eventHash !== input.eventHash) {
        // Do not let one unresolved write silence later events. Retire this
        // object's card but retain the exact uncertain request for recovery;
        // the later event can be posted as text with an outdated-card warning.
        // If the original root is still unknown, do not create another root;
        // its same-key text fence above must first obtain a definite result.
        if (pending.createsRoot && input.createsRoot) return recovered;
        const retired = await ownUpdate(`UPDATE raft_notification_cards SET state='retired',updated_at=?1
          WHERE subscription_id=?2 AND object_key=?3 AND lease_token=?4 AND pending_json=?5`,
          now(), subscriptionId, objectKey, token, JSON.stringify(pending));
        return retired ? { kind: "text", reason: "card_pending" } : { kind: "retry", code: "card_delivery_lease_lost" };
      }
      if (recovered.kind !== "delivered" || pending.eventHash === input.eventHash) return recovered;
      row = await load();
      if (!row) return { kind: "retry", code: "card_delivery_lease_lost" };
    }

    // The card and its thread pointer are saved in separate D1 statements. If
    // execution stopped between them, repair the pointer before acknowledging
    // a duplicate delivery.
    if (input.createsRoot && row.message_id) {
      await db.prepare(`UPDATE raft_notification_threads SET parent_message_id=?1,updated_at=?2
        WHERE subscription_id=?3 AND object_key=?4 AND parent_message_id='pending'`)
        .bind(row.message_id, now(), subscriptionId, objectKey).run();
    }

    // The send may have resolved to a text message under the card's original
    // key. A delivery retry of that same event must not send it a second time
    // under the ordinary text key after the object was retired.
    if (row.last_event_hash === input.eventHash) return { kind: "skipped" };

    // Re-read settings under the object lease. A switch to text may happen
    // while a prior request is in flight; that request is still reconciled.
    const settings = await db.prepare(`SELECT enabled,card_updates FROM raft_notification_subscriptions
      WHERE id=?1 AND archived_at IS NULL`).bind(subscriptionId).first<{ enabled: number; card_updates: number }>();
    if (!settings || settings.enabled !== 1) return { kind: "retry", code: "card_destination_disabled" };
    if (settings.card_updates !== 1) {
      if (row.state !== "retired") {
        const retired = await ownUpdate(`UPDATE raft_notification_cards SET state='retired',updated_at=?1
          WHERE subscription_id=?2 AND object_key=?3 AND lease_token=?4`, now(), subscriptionId, objectKey, token);
        if (!retired) return { kind: "retry", code: "card_delivery_lease_lost" };
      }
      return { kind: "text" };
    }
    if (row.state === "retired") return { kind: "text" };
    const when = eventTime(input.body);
    if (when === null || (row.last_event_ms === when && row.last_event_hash !== input.eventHash)) {
      // A later state cannot safely be ordered against an event whose time is
      // missing or ambiguous. Keep that object on text for its remaining life.
      const retired = await ownUpdate(`UPDATE raft_notification_cards SET state='retired',updated_at=?1
        WHERE subscription_id=?2 AND object_key=?3 AND lease_token=?4`, now(), subscriptionId, objectKey, token);
      if (!retired) return { kind: "retry", code: "card_delivery_lease_lost" };
      return { kind: "text" };
    }
    if (row.last_event_ms !== null && when < row.last_event_ms) return { kind: "skipped" };
    if (row.last_event_ms === when) return { kind: "skipped" };

    const newCard = !row.message_id || !row.message_created_at || now() - row.message_created_at >= MAX_CARD_AGE_MS;
    const rendered = formatRaftNotificationCard(input.body, input.app);
    const pending: Pending = {
      kind: newCard ? "send" : "update", eventHash: input.eventHash, eventMs: when,
      idempotencyKey: `hands-card:${newCard ? "send" : "update"}:${subscriptionId}:${input.eventHash}`.slice(0, 240),
      content: rendered.content, card: rendered.card, target: newCard ? input.channelTarget : input.target,
      messageId: newCard ? null : row.message_id, expectedRevision: row.revision,
      createsRoot: newCard && input.createsRoot, createdAt: now(),
    };
    const reserved = await ownUpdate(`UPDATE raft_notification_cards SET pending_json=?1,pending_uncertain=0,updated_at=?2
      WHERE subscription_id=?3 AND object_key=?4 AND lease_token=?5 AND pending_json IS NULL`,
      JSON.stringify(pending), now(), subscriptionId, objectKey, token);
    if (!reserved) return { kind: "retry", code: "card_delivery_lease_lost" };
    return await replay(pending, false);
  } finally {
    await db.prepare(`UPDATE raft_notification_cards SET lease_token=NULL,lease_expires_at=NULL
      WHERE subscription_id=?1 AND object_key=?2 AND lease_token=?3`).bind(subscriptionId, objectKey, token).run().catch(() => undefined);
  }
}
