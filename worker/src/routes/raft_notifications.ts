/**
 * Hands-managed Raft App Bot notifications.
 *
 * The admin routes let an app administrator connect the app's managed bot and
 * choose Raft channel/event subscriptions.  A subscription owns a hidden
 * generic webhook row, so all existing Hands event producers keep the same
 * D1-backed retry/queue behavior.  The internal callback verifies the generic
 * webhook signature before sending through the bot. Feedback conversations
 * keep one thread per logical object; release text is visible in the channel.
 */

import type { Context } from "hono";
import { currentActorInfo } from "../middleware/auth";
import type { AdminContext } from "../lib/permissions";
import { decryptP8, encryptP8 } from "../lib/asc_credentials";
import { formatExistingFeedbackRoot, formatRaftNotificationMessage } from "../lib/raft_notification_content";
import { deliverRaftNotificationCard, isStandaloneRaftNotificationCard, RAFT_NOTIFICATION_CARD_EVENTS, supportsRaftNotificationCards } from "../lib/raft_notification_card_delivery";
import { formatRaftNotificationCard, withoutPlayConsoleFooter, type RaftMessageCard } from "../lib/raft_notification_card";
import { renderStatusCardAsText } from "../lib/raft_card_text";
import { appGalleryCardObjectKey, isFeedbackThreadEvent, isReleaseChannelEvent, notificationObjectKey, playFailureCardObjectKey, sha256Hex } from "../lib/raft_notification_identity";
import { hmacSha256Hex, WEBHOOK_EVENT_TYPES } from "./webhooks";

type NotificationEvent = (typeof WEBHOOK_EVENT_TYPES)[number];

interface AppContextRow {
  app_id: string;
  org_id: string;
  server_id: string;
}

interface BotInstallationRow {
  id: string;
  server_id: string;
  installation_id: string;
  credential_id: string;
  agent_id: string | null;
  handle: string | null;
  key_ciphertext_b64: string;
  key_iv_b64: string;
  state: string;
  created_at: number;
  updated_at: number;
}

interface NotificationSubscriptionRow {
  id: string;
  app_id: string;
  server_id: string;
  channel_target: string;
  events_json: string;
  enabled: number;
  card_updates: number;
  bot_installation_id: string;
  webhook_id: string;
  created_by: string | null;
  created_at: number;
  updated_at: number;
  archived_at: number | null;
}

interface InternalSubscriptionRow extends NotificationSubscriptionRow {
  webhook_secret: string;
  webhook_enabled: number;
  webhook_archived_at: number | null;
  app_slug: string | null;
  app_name: string | null;
}

class RaftBotApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
    this.name = "RaftBotApiError";
  }
}

const CHANNEL_TARGET_RE = /^#[^\s:#]{1,120}$/;
const SERVER_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Distinct from the old pending marker: an older root send may have an
// uncertain outcome and must not be replaced with a new synthetic root.
const FEEDBACK_ROOT_PENDING = "pending:feedback-root";

function parseOptionalServerId(value: unknown): { serverId: string | null } | { error: string } {
  if (value === undefined || value === null) return { serverId: null };
  if (typeof value !== "string") return { error: "server_id must be a UUID string" };
  const trimmed = value.trim();
  if (!trimmed) return { serverId: null };
  if (!SERVER_ID_RE.test(trimmed)) return { error: "server_id must be a valid UUID" };
  return { serverId: trimmed.toLowerCase() };
}
function safeProviderCode(value: unknown, fallback: string): string {
  return typeof value === "string" && /^[a-z0-9_]{1,80}$/.test(value)
    ? value
    : fallback;
}

function apiOrigin(env: Env): string {
  const origin = env.RAFT_API_ORIGIN ?? env.RAFT_ORIGIN ?? "https://api.raft.build";
  return origin.replace(/\/+$/, "");
}

function botEncryptionSecret(env: Env): string {
  const secret = env.RAFT_BOT_ENC_KEY;
  if (!secret) throw new RaftBotApiError(503, "RAFT_BOT_ENC_KEY_NOT_CONFIGURED");
  return secret;
}

function publicBot(row: BotInstallationRow | null) {
  if (!row) {
    return {
      connected: false,
      state: "not_connected",
      installation_id: null,
      agent_id: null,
      handle: null,
      updated_at: null,
    };
  }
  return {
    connected: row.state === "active",
    state: row.state,
    installation_id: row.installation_id,
    agent_id: row.agent_id,
    handle: row.handle,
    updated_at: row.updated_at,
  };
}

function parseJsonRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function parseEvents(value: unknown): { events: string[] } | { error: string } {
  if (!Array.isArray(value) || value.length === 0) {
    return { error: "events must be a non-empty array" };
  }
  if (!value.every((event) => typeof event === "string")) return { error: "events must contain only event names" };
  const events = [...new Set(value as string[])];
  const known = new Set<string>(WEBHOOK_EVENT_TYPES);
  const unknown = events.filter((event) => !known.has(event));
  if (unknown.length > 0) return { error: `unknown events: ${unknown.join(", ")}` };
  return { events };
}

function parseStoredEvents(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every((item) => typeof item === "string")
      ? parsed
      : [];
  } catch {
    return [];
  }
}

function publicSubscription(row: NotificationSubscriptionRow) {
  return {
    id: row.id,
    app_id: row.app_id,
    server_id: row.server_id,
    channel_target: row.channel_target,
    events: parseStoredEvents(row.events_json),
    enabled: row.enabled === 1,
    card_updates: row.card_updates === 1,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

async function appContext(db: D1Database, appId: string): Promise<AppContextRow | null> {
  return db.prepare(
    `SELECT a.id AS app_id, a.org_id, o.external_id AS server_id
     FROM apps a
     JOIN organizations o ON o.id = a.org_id AND o.external_provider = 'raft'
     WHERE a.id = ?1 AND a.archived = 0
     LIMIT 1`,
  ).bind(appId).first<AppContextRow>();
}

async function botForServer(db: D1Database, serverId: string): Promise<BotInstallationRow | null> {
  return db.prepare(
    `SELECT id, server_id, installation_id, credential_id, agent_id,
            handle, key_ciphertext_b64, key_iv_b64, state, created_at, updated_at
     FROM raft_bot_installations
     WHERE server_id = ?1
     LIMIT 1`,
  ).bind(serverId).first<BotInstallationRow>();
}

function basicAuth(env: Env): string {
  if (!env.RAFT_CLIENT_ID || !env.RAFT_CLIENT_SECRET) {
    throw new RaftBotApiError(503, "RAFT_CLIENT_CREDENTIALS_NOT_CONFIGURED");
  }
  return `Basic ${btoa(`${env.RAFT_CLIENT_ID}:${env.RAFT_CLIENT_SECRET}`)}`;
}

async function raftOAuthRequest(
  env: Env,
  path: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetch(`${apiOrigin(env)}${path}`, {
      method: "POST",
      headers: {
        authorization: basicAuth(env),
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify(body),
    });
  } catch {
    throw new RaftBotApiError(503, "RAFT_BOT_PROVIDER_UNREACHABLE");
  }
  const text = await response.text();
  let parsed: unknown = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
  if (!response.ok) {
    const record = parseJsonRecord(parsed);
    const code = safeProviderCode(
      typeof record.errorCode === "string" ? record.errorCode : record.code,
      response.status === 403
        ? "bot_not_granted"
        : response.status === 404
          ? "installation_not_found"
          : "raft_bot_provider_error",
    );
    throw new RaftBotApiError(response.status, code);
  }
  const record = parseJsonRecord(parsed);
  return record;
}

async function lookupInstallation(env: Env, serverId: string): Promise<string> {
  const response = await raftOAuthRequest(env, "/api/oauth/installations/lookup", {
    server_id: serverId,
  });
  const installationId = response.installation_id ?? response.installationId;
  if (typeof installationId !== "string" || installationId.length === 0) {
    throw new RaftBotApiError(502, "installation_id_missing");
  }
  return installationId;
}

async function mintBotToken(
  env: Env,
  installationId: string,
  rotate: boolean,
): Promise<{ credentialId: string; apiKey: string; agentId: string | null; handle: string | null }> {
  const response = await raftOAuthRequest(
    env,
    `/api/oauth/installations/${encodeURIComponent(installationId)}/bot-token`,
    { rotate },
  );
  const credentialId = response.credentialId ?? response.credential_id;
  const apiKey = response.apiKey ?? response.api_key;
  const agentId = response.agentId ?? response.agent_id;
  if (typeof credentialId !== "string" || typeof apiKey !== "string" || !apiKey.startsWith("sk_agent_")) {
    throw new RaftBotApiError(502, "bot_credential_missing");
  }
  return {
    credentialId,
    apiKey,
    agentId: typeof agentId === "string" ? agentId : null,
    handle: typeof response.handle === "string" ? response.handle : env.RAFT_CLIENT_ID ?? null,
  };
}

function providerErrorResponse(c: Context, error: unknown) {
  if (!(error instanceof RaftBotApiError)) throw error;
  const messages: Record<string, string> = {
    RAFT_CLIENT_CREDENTIALS_NOT_CONFIGURED: "Hands App Bot credentials are not configured.",
    RAFT_BOT_ENC_KEY_NOT_CONFIGURED: "Hands App Bot encryption is not configured.",
    bot_not_granted: "A Raft server owner or admin must grant the Hands app bot first.",
    bot_not_active: "The Hands app bot is disabled on this Raft server; grant it again.",
    installation_not_found: "The Hands app is not installed on this Raft server.",
    credential_exists: "A bot key already exists for this installation; reconnect with rotation.",
    RAFT_BOT_PROVIDER_UNREACHABLE: "Raft could not be reached. Try again later.",
    message_cards_disabled: "Card messages are not enabled on this Raft server.",
    message_card_unsupported_target: "This Raft channel does not support card messages.",
    card_invalid: "The test card could not be accepted by Raft.",
  };
  const status = error.status >= 400 && error.status < 600 ? error.status : 502;
  return c.json({ error: error.code, detail: messages[error.code] ?? "Raft App Bot setup failed." }, status as any);
}

export async function handleGetRaftNotifications(c: AdminContext) {
  const appId = c.req.param("appId") ?? "";
  const app = await appContext(c.env.DB, appId);
  if (!app) return c.json({ error: "app not found" }, 404);
  const bot = await botForServer(c.env.DB, app.server_id);
  const { results } = await c.env.DB.prepare(
    `SELECT id, app_id, server_id, channel_target, events_json, enabled, card_updates,
            bot_installation_id,
            webhook_id, created_by, created_at, updated_at, archived_at
     FROM raft_notification_subscriptions
     WHERE app_id = ?1 AND archived_at IS NULL
     ORDER BY created_at DESC`,
  ).bind(appId).all<NotificationSubscriptionRow>();
  return c.json({
    bot: publicBot(bot),
    events: WEBHOOK_EVENT_TYPES,
    subscriptions: results.map(publicSubscription),
  });
}

// Do not expose the internal webhook URL, signing secret, or event body. The
// newest failed delivery for each exact body is enough to recover an exhausted
// card delivery while retaining its original idempotency key.
export async function handleListRaftNotificationFailures(c: AdminContext) {
  const appId = c.req.param("appId") ?? "";
  const subscriptionId = c.req.param("subscriptionId") ?? "";
  const subscription = await c.env.DB.prepare(
    `SELECT webhook_id FROM raft_notification_subscriptions
     WHERE id=?1 AND app_id=?2 AND archived_at IS NULL`,
  ).bind(subscriptionId, appId).first<{ webhook_id: string }>();
  if (!subscription) return c.json({ error: "notification destination not found" }, 404);
  const { results } = await c.env.DB.prepare(
    `SELECT d.id,d.event_type,d.created_at,d.last_attempt_at,d.last_response_status
     FROM webhook_deliveries d
     WHERE d.webhook_id=?1 AND d.status='failed'
       AND d.event_type IN (${RAFT_NOTIFICATION_CARD_EVENTS.map((_, index) => `?${index + 2}`).join(",")})
       AND NOT EXISTS (SELECT 1 FROM webhook_deliveries newer
         WHERE newer.webhook_id=d.webhook_id AND newer.payload_json=d.payload_json
           AND (newer.created_at>d.created_at OR (newer.created_at=d.created_at AND newer.id>d.id)))
     ORDER BY d.created_at DESC,d.id DESC LIMIT 25`,
  ).bind(subscription.webhook_id, ...RAFT_NOTIFICATION_CARD_EVENTS).all<{
    id: string; event_type: string; created_at: number;
    last_attempt_at: number | null; last_response_status: number | null;
  }>();
  return c.json({ failures: results });
}

export async function handleRetryRaftNotificationFailure(c: AdminContext) {
  const appId = c.req.param("appId") ?? "";
  const subscriptionId = c.req.param("subscriptionId") ?? "";
  const deliveryId = c.req.param("deliveryId") ?? "";
  const subscription = await c.env.DB.prepare(
    `SELECT s.webhook_id,s.enabled,w.enabled AS webhook_enabled,w.archived_at AS webhook_archived_at
     FROM raft_notification_subscriptions s JOIN webhooks w ON w.id=s.webhook_id
     WHERE s.id=?1 AND s.app_id=?2 AND s.archived_at IS NULL`,
  ).bind(subscriptionId, appId).first<{
    webhook_id: string; enabled: number;
    webhook_enabled: number; webhook_archived_at: number | null;
  }>();
  if (!subscription) return c.json({ error: "notification destination not found" }, 404);
  if (subscription.enabled !== 1 || subscription.webhook_enabled !== 1 || subscription.webhook_archived_at !== null) {
    return c.json({ error: "notification destination disabled" }, 409);
  }
  const failed = await c.env.DB.prepare(
    `SELECT event_type FROM webhook_deliveries WHERE id=?1 AND webhook_id=?2 AND status='failed'`,
  ).bind(deliveryId, subscription.webhook_id).first<{ event_type: string }>();
  if (!failed || !supportsRaftNotificationCards(failed.event_type)) return c.json({ error: "failed delivery not found" }, 404);
  // Append a new delivery instead of resetting the old row: an older worker
  // could still be finishing its attempt, and its completion must not mutate
  // the new attempt. The body is copied byte-for-byte, so the internal callback
  // derives the same Raft idempotency key. The current internal signing key is
  // used; neither the key nor the body leaves this route.
  const now = Date.now();
  const retryId = crypto.randomUUID();
  const actor = currentActorInfo(c);
  let inserted: D1Result | undefined;
  try {
    [inserted] = await c.env.DB.batch([c.env.DB.prepare(
    `INSERT INTO webhook_deliveries
       (id,webhook_id,event_type,payload_json,signing_secret,status,attempts,max_attempts,next_attempt_at,created_at,updated_at)
     SELECT ?1,d.webhook_id,d.event_type,d.payload_json,w.secret,'pending',0,3,?2,MAX(?2,d.created_at+1),?2
     FROM webhook_deliveries d
     JOIN raft_notification_subscriptions s ON s.webhook_id=d.webhook_id
     JOIN webhooks w ON w.id=d.webhook_id
     WHERE d.id=?3 AND d.webhook_id=?4 AND d.status='failed'
       AND s.id=?5 AND s.app_id=?6 AND s.enabled=1 AND s.archived_at IS NULL
       AND w.enabled=1 AND w.archived_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM webhook_deliveries newer
         WHERE newer.webhook_id=d.webhook_id AND newer.payload_json=d.payload_json
           AND (newer.created_at>d.created_at OR (newer.created_at=d.created_at AND newer.id>d.id)))
       AND NOT EXISTS (SELECT 1 FROM webhook_deliveries pending
         WHERE pending.webhook_id=d.webhook_id AND pending.payload_json=d.payload_json AND pending.status='pending')`,
  ).bind(retryId, now, deliveryId, subscription.webhook_id, subscriptionId, appId),
  c.env.DB.prepare(
    `INSERT INTO audit_logs (id,app_id,action,actor,actor_id,actor_type,payload,created_at)
     SELECT ?1,?2,'raft_notification.retry',?3,?4,?5,?6,?7
     WHERE EXISTS (SELECT 1 FROM webhook_deliveries WHERE id=?8)`,
  ).bind(crypto.randomUUID(), appId, actor.display_name, actor.id, actor.type,
    JSON.stringify({ subscription_id: subscriptionId, failed_delivery_id: deliveryId, retry_delivery_id: retryId }), now, retryId)]);
  } catch {
    return c.json({ error: "notification retry unavailable" }, 503);
  }
  if (inserted?.meta.changes !== 1) return c.json({ error: "delivery already retried or no longer available" }, 409);
  // The existing scheduled reaper picks up the pending row; no separate
  // provider request is started in this admin handler.
  return c.json({ ok: true, delivery_id: retryId }, 202);
}

async function ensureBotForServer(
  env: Env,
  serverId: string,
  rotate = false,
): Promise<BotInstallationRow> {
  const existing = await botForServer(env.DB, serverId);
  if (existing && existing.state === "active" && !rotate) return existing;

  // Validate the dedicated KEK before minting a one-time provider key. A
  // missing encryption secret must not leave an unrecoverable credential at
  // Raft that Hands cannot persist.
  const encryptionSecret = botEncryptionSecret(env);
  const installationId = await lookupInstallation(env, serverId);
  const token = await mintBotToken(env, installationId, rotate);
  const encrypted = await encryptP8(token.apiKey, encryptionSecret);
  const now = Date.now();
  const id = existing?.id ?? crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO raft_bot_installations
       (id, server_id, installation_id, credential_id, agent_id, handle,
        key_ciphertext_b64, key_iv_b64, state, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'active', ?9, ?9)
     ON CONFLICT(server_id) DO UPDATE SET
       installation_id = excluded.installation_id,
       credential_id = excluded.credential_id,
       agent_id = excluded.agent_id,
       handle = excluded.handle,
       key_ciphertext_b64 = excluded.key_ciphertext_b64,
       key_iv_b64 = excluded.key_iv_b64,
       state = 'active',
       updated_at = excluded.updated_at`,
  ).bind(
    id,
    serverId,
    installationId,
    token.credentialId,
    token.agentId,
    token.handle,
    encrypted.ciphertext_b64,
    encrypted.iv_b64,
    now,
  ).run();
  const saved = await botForServer(env.DB, serverId);
  if (!saved) throw new RaftBotApiError(500, "bot_persist_failed");
  return saved;
}

export async function handleConnectRaftBot(c: AdminContext) {
  const appId = c.req.param("appId") ?? "";
  const app = await appContext(c.env.DB, appId);
  if (!app) return c.json({ error: "app not found" }, 404);
  const body = parseJsonRecord(await c.req.json().catch(() => ({})));
  const rotate = body.rotate === true;
  const parsedServer = parseOptionalServerId(body.server_id);
  if ("error" in parsedServer) return c.json({ error: parsedServer.error }, 400);
  const targetServerId = parsedServer.serverId ?? app.server_id;
  const existing = await botForServer(c.env.DB, targetServerId);
  if (existing && !rotate) return c.json({ bot: publicBot(existing) });

  try {
    const saved = await ensureBotForServer(c.env, targetServerId, rotate);
    return c.json({ bot: publicBot(saved) });
  } catch (error) {
    return providerErrorResponse(c, error);
  }
}

export async function handleCreateRaftNotification(c: AdminContext) {
  const appId = c.req.param("appId") ?? "";
  const app = await appContext(c.env.DB, appId);
  if (!app) return c.json({ error: "app not found" }, 404);
  const body = parseJsonRecord(await c.req.json().catch(() => ({})));
  const parsedServer = parseOptionalServerId(body.server_id);
  if ("error" in parsedServer) return c.json({ error: parsedServer.error }, 400);
  const targetServerId = parsedServer.serverId ?? app.server_id;
  let bot = await botForServer(c.env.DB, targetServerId);
  if ((!bot || bot.state !== "active") && parsedServer.serverId) {
    try {
      bot = await ensureBotForServer(c.env, targetServerId, false);
    } catch (error) {
      return providerErrorResponse(c, error);
    }
  }
  if (!bot || bot.state !== "active") {
    return c.json({ error: "RAFT_BOT_NOT_CONNECTED", detail: "Connect the Hands App Bot before adding a destination." }, 409);
  }
  const channelTarget = body.channel_target;
  if (typeof channelTarget !== "string" || !CHANNEL_TARGET_RE.test(channelTarget)) {
    return c.json({ error: "channel_target must be a Raft channel such as #releases" }, 400);
  }
  const parsed = parseEvents(body.events);
  if ("error" in parsed) return c.json({ error: parsed.error }, 400);
  if (body.card_updates !== undefined && typeof body.card_updates !== "boolean") {
    return c.json({ error: "card_updates must be a boolean" }, 400);
  }

  const id = crypto.randomUUID();
  const webhookSecret = `${crypto.randomUUID()}${crypto.randomUUID()}`;
  const origin = (c.env.BUSINESS_ORIGIN ?? new URL(c.req.url).origin).replace(/\/+$/, "");
  const webhookUrl = `${origin}/api/internal/raft-notifications/${id}`;
  const now = Date.now();
  const actor = currentActorInfo(c);
  try {
    await c.env.DB.batch([
      c.env.DB.prepare(
        `INSERT INTO webhooks
           (id, org_id, app_id, url, secret, events_json, enabled, created_by, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1, ?7, ?8, ?8)`,
      ).bind(id, app.org_id, appId, webhookUrl, webhookSecret, JSON.stringify(parsed.events), actor.id, now),
      c.env.DB.prepare(
        `INSERT INTO raft_notification_subscriptions
           (id, app_id, server_id, channel_target, events_json, enabled, card_updates,
            bot_installation_id, webhook_id, created_by, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, 1, ?6, ?7, ?8, ?9, ?10, ?10)`,
      ).bind(id, appId, targetServerId, channelTarget, JSON.stringify(parsed.events), body.card_updates === true ? 1 : 0, bot.id, id, actor.id, now),
    ]);
  } catch {
    return c.json({ error: "notification destination already exists or could not be created" }, 409);
  }
  const saved = await c.env.DB.prepare(
    `SELECT id, app_id, server_id, channel_target, events_json, enabled, card_updates,
            bot_installation_id,
            webhook_id, created_by, created_at, updated_at, archived_at
     FROM raft_notification_subscriptions WHERE id = ?1`,
  ).bind(id).first<NotificationSubscriptionRow>();
  if (!saved) return c.json({ error: "notification destination was not persisted" }, 500);
  return c.json({ subscription: publicSubscription(saved) }, 201);
}

export async function handleUpdateRaftNotification(c: AdminContext) {
  const appId = c.req.param("appId") ?? "";
  const subscriptionId = c.req.param("subscriptionId") ?? "";
  const body = parseJsonRecord(await c.req.json().catch(() => ({})));
  if (body.card_updates !== undefined && (body.events !== undefined || body.enabled !== undefined || body.server_id !== undefined || body.channel_target !== undefined)) {
    return c.json({ error: "change card_updates separately from other settings" }, 400);
  }
  const updates: string[] = [];
  const binds: (string | number)[] = [];
  if (body.server_id !== undefined) {
    const parsedServer = parseOptionalServerId(body.server_id);
    if ("error" in parsedServer || !parsedServer.serverId) {
      return c.json({ error: "error" in parsedServer ? parsedServer.error : "server_id must be a valid UUID" }, 400);
    }
    let bot = await botForServer(c.env.DB, parsedServer.serverId);
    if (!bot || bot.state !== "active") {
      try {
        bot = await ensureBotForServer(c.env, parsedServer.serverId, false);
      } catch (error) {
        return providerErrorResponse(c, error);
      }
    }
    if (!bot || bot.state !== "active") {
      return c.json({ error: "RAFT_BOT_NOT_CONNECTED", detail: "Connect the Hands App Bot before updating destination server." }, 409);
    }
    updates.push("server_id = ?", "bot_installation_id = ?");
    binds.push(parsedServer.serverId, bot.id);
  }
  if (body.channel_target !== undefined) {
    if (typeof body.channel_target !== "string" || !CHANNEL_TARGET_RE.test(body.channel_target)) {
      return c.json({ error: "channel_target must be a Raft channel such as #releases" }, 400);
    }
    updates.push("channel_target = ?");
    binds.push(body.channel_target);
  }
  if (body.events !== undefined) {
    const parsed = parseEvents(body.events);
    if ("error" in parsed) return c.json({ error: parsed.error }, 400);
    updates.push("events_json = ?"); binds.push(JSON.stringify(parsed.events));
    await c.env.DB.prepare(
      `UPDATE webhooks SET events_json = ?1, updated_at = ?2
       WHERE id = (SELECT webhook_id FROM raft_notification_subscriptions WHERE id = ?3 AND app_id = ?4)`,
    ).bind(JSON.stringify(parsed.events), Date.now(), subscriptionId, appId).run();
  }
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== "boolean") return c.json({ error: "enabled must be a boolean" }, 400);
    updates.push("enabled = ?"); binds.push(body.enabled ? 1 : 0);
    await c.env.DB.prepare(
      `UPDATE webhooks SET enabled = ?1, updated_at = ?2
       WHERE id = (SELECT webhook_id FROM raft_notification_subscriptions WHERE id = ?3 AND app_id = ?4)`,
    ).bind(body.enabled ? 1 : 0, Date.now(), subscriptionId, appId).run();
  }
  if (body.card_updates !== undefined) {
    if (typeof body.card_updates !== "boolean") return c.json({ error: "card_updates must be a boolean" }, 400);
    // Turning cards off is always available; it does not discard in-flight or
    // uncertain writes, which may still complete and must be reconciled. Do
    // not re-enable cards while one of those writes is still outstanding.
    const changed = await c.env.DB.prepare(`UPDATE raft_notification_subscriptions SET card_updates=?1,updated_at=?2
      WHERE id=?3 AND app_id=?4 AND archived_at IS NULL AND (?1=0 OR NOT EXISTS (
        SELECT 1 FROM raft_notification_cards c WHERE c.subscription_id=?3
          AND (c.pending_json IS NOT NULL OR (c.lease_token IS NOT NULL AND c.lease_expires_at>=?2))))`)
      .bind(body.card_updates ? 1 : 0, Date.now(), subscriptionId, appId).run();
    if (changed.meta.changes !== 1) {
      const exists = await c.env.DB.prepare(`SELECT 1 FROM raft_notification_subscriptions
        WHERE id=?1 AND app_id=?2 AND archived_at IS NULL`).bind(subscriptionId, appId).first();
      return exists ? c.json({ error: "card_update_in_progress" }, 409) : c.json({ error: "notification destination not found" }, 404);
    }
    return c.json({ ok: true });
  }
  if (updates.length === 0) return c.json({ error: "nothing to update" }, 400);
  updates.push("updated_at = ?"); binds.push(Date.now(), subscriptionId, appId);
  const result = await c.env.DB.prepare(
    `UPDATE raft_notification_subscriptions SET ${updates.join(", ")}
     WHERE id = ? AND app_id = ? AND archived_at IS NULL`,
  ).bind(...binds).run();
  if (result.meta.changes === 0) return c.json({ error: "notification destination not found" }, 404);
  return c.json({ ok: true });
}

export async function handleDeleteRaftNotification(c: AdminContext) {
  const appId = c.req.param("appId") ?? "";
  const subscriptionId = c.req.param("subscriptionId") ?? "";
  const now = Date.now();
  const result = await c.env.DB.prepare(
    `UPDATE raft_notification_subscriptions
     SET archived_at = ?1, enabled = 0, updated_at = ?1
     WHERE id = ?2 AND app_id = ?3 AND archived_at IS NULL`,
  ).bind(now, subscriptionId, appId).run();
  if (result.meta.changes === 0) return c.json({ error: "notification destination not found" }, 404);
  await c.env.DB.prepare(
    `UPDATE webhooks SET archived_at = ?1, enabled = 0, updated_at = ?1
     WHERE id = (SELECT webhook_id FROM raft_notification_subscriptions WHERE id = ?2)`,
  ).bind(now, subscriptionId).run();
  return c.json({ ok: true });
}

async function readBotKey(env: Env, bot: BotInstallationRow): Promise<string> {
  return decryptP8(bot.key_ciphertext_b64, bot.key_iv_b64, botEncryptionSecret(env));
}

function cardReceiptRevision(record: Record<string, unknown>): number | undefined {
  if (record.messageCard === undefined || record.messageCard === null) return undefined;
  const marker = parseJsonRecord(record.messageCard);
  if (!Number.isSafeInteger(marker.revision) || (marker.revision as number) < 1) {
    throw new RaftBotApiError(503, "bot_card_receipt_incomplete");
  }
  return marker.revision as number;
}

async function sendBotMessage(
  env: Env,
  bot: BotInstallationRow,
  target: string,
  content: string,
  idempotencyKey: string,
  card?: RaftMessageCard,
): Promise<{ messageId: string; cardRevision?: number }> {
  const key = await readBotKey(env, bot);
  let response: Response;
  try {
    response = await fetch(`${apiOrigin(env)}/internal/agent-api/v2/send`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({ target, content, idempotencyKey, ...(card ? { card } : {}) }),
      ...(card ? { signal: AbortSignal.timeout(4_000) } : {}),
    });
  } catch {
    throw new RaftBotApiError(503, "RAFT_BOT_PROVIDER_UNREACHABLE");
  }
  const text = await response.text();
  let parsed: unknown = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
  const record = parseJsonRecord(parsed);
  if (!response.ok) {
    const code = safeProviderCode(
      typeof record.errorCode === "string" ? record.errorCode : record.code,
      "bot_send_failed",
    );
    throw new RaftBotApiError(response.status, code);
  }
  const state = record.state;
  const messageId = record.messageId;
  if ((state !== "sent" && state !== "committed") || typeof messageId !== "string") {
    throw new RaftBotApiError(503, state === "held" ? "bot_send_held" : "bot_send_incomplete");
  }
  const revision = card ? cardReceiptRevision(record) : undefined;
  return { messageId, ...(revision === undefined ? {} : { cardRevision: revision }) };
}

async function sendKnownBotText(env: Env, bot: BotInstallationRow, target: string, contents: string[], key: string) {
  let conflict: unknown;
  for (const candidate of new Set(contents)) {
    try { return await sendBotMessage(env, bot, target, candidate, key); }
    catch (error) {
      if (!(error instanceof RaftBotApiError) || error.status !== 409 || error.code !== "idempotency_key_reused") throw error;
      conflict = error;
    }
  }
  throw conflict;
}

/**
 * A request started before the channel-routing change may already have sent
 * this signed event to its old thread while its response was lost. Raft binds
 * an idempotency key to both content and target: prove that old request by
 * replaying it before using a separate, stable key for the channel copy.
 */
async function sendChannelText(
  env: Env, bot: BotInstallationRow, channel: string, previousTarget: string,
  content: string, previousContents: string[], idempotencyKey: string, channelKey: string,
): Promise<{ messageId: string }> {
  const contents = [content, ...previousContents];
  const sendKnownContent = (target: string, key: string) => sendKnownBotText(env, bot, target, contents, key);
  try {
    return await sendKnownContent(channel, idempotencyKey);
  } catch (error) {
    if (!(error instanceof RaftBotApiError) || error.status !== 409 || error.code !== "idempotency_key_reused") throw error;
    if (previousTarget === channel) throw error;
    await sendKnownContent(previousTarget, idempotencyKey);
    // The channel copy may already have committed with an older warning. A
    // same-key replay of each known variant is safe; never use another key.
    return await sendKnownContent(channel, channelKey);
  }
}

/** Send a channel-visible notification with the existing text key. If cards
 * are disabled or a warning is required, try text first; only replay the card
 * after a conflict proves that this key was already used. This prevents a
 * delayed replay from creating a new card after the switch was turned off. */
async function sendChannelCard(
  env: Env, bot: BotInstallationRow, channel: string, previousTarget: string,
  textContent: string, cardContent: string, card: RaftMessageCard, previousContents: string[],
  idempotencyKey: string, channelKey: string, preferCard: boolean,
): Promise<{ messageId: string }> {
  const contents = [textContent, ...previousContents];
  const conflict = (error: unknown) => error instanceof RaftBotApiError
    && error.status === 409 && error.code === "idempotency_key_reused";
  const cardOrKnownText = async (target: string, key: string) => {
    const cardSend = () => sendBotMessage(env, bot, target, cardContent, key, card);
    const textSend = () => sendKnownBotText(env, bot, target, contents, key);
    if (!preferCard) {
      try { return await textSend(); }
      catch (error) {
        if (!conflict(error)) throw error;
        return cardSend();
      }
    }
    try { return await cardSend(); }
    catch (error) {
      if (!(error instanceof RaftBotApiError)) throw error;
      const refused = error.status === 400 && ["message_cards_disabled", "message_card_unsupported_target", "card_invalid"].includes(error.code);
      if (!conflict(error) && !refused) throw error;
      return textSend();
    }
  };
  try { return await cardOrKnownText(channel, idempotencyKey); }
  catch (error) {
    if (!conflict(error) || previousTarget === channel) throw error;
    // Only a known old threaded text proves that it is safe to use a second
    // stable key for the separate channel notification.
    await sendKnownBotText(env, bot, previousTarget, contents, idempotencyKey);
    return cardOrKnownText(channel, channelKey);
  }
}

/** The event's card written out as text by Raft's card-to-markdown rules; null if no card can be built. */
function cardLayoutText(body: Record<string, unknown>, app: { id: string; slug: string | null; name: string | null },
  options: { rejoinPieces?: boolean } = {}): string | null {
  try {
    return cardLayoutFromCard(formatRaftNotificationCard(body, app).card, options);
  } catch {
    return null;
  }
}

function cardLayoutFromCard(card: RaftMessageCard, options: { rejoinPieces?: boolean } = {}): string | null {
  try {
    const text = renderStatusCardAsText(card, options).trim();
    return text || null;
  } catch {
    return null;
  }
}

/** Earlier Workers sent the layout with a long Text's pieces as separate paragraphs; still accept it on replay. */
function unjoinedLayoutVariants(layout: string | null, unjoined: string | null): string[] {
  return unjoined && unjoined !== layout ? [unjoined, fallbackWarning(unjoined, false), fallbackWarning(unjoined, true)] : [];
}

function fallbackWarning(content: string, thread: boolean): string {
  return content + (thread
    ? "\n⚠️ A previous status card may be out of date; follow this thread for newer updates."
    : "\n⚠️ A previous status card may be out of date; check newer channel messages.");
}

function compatibleCardText(content: string, card?: RaftMessageCard): string[] {
  // The Play Console link was added to card fallbacks after older Workers
  // could have sent a channel notice with the same event key. Prove either
  // exact body before making a separate channel copy.
  const old = withoutPlayConsoleFooter(content);
  // The text path now sends the card's layout as text under the same key.
  const layout = card ? cardLayoutFromCard(card) : null;
  const unjoined = card ? cardLayoutFromCard(card, { rejoinPieces: false }) : null;
  return [content, old, fallbackWarning(content, false), fallbackWarning(old, false),
    fallbackWarning(content, true), fallbackWarning(old, true),
    ...(layout ? [layout, fallbackWarning(layout, false), fallbackWarning(layout, true)] : []),
    ...unjoinedLayoutVariants(layout, unjoined)];
}

// Previous workers did not render these fixed diagnostic lines. Derive the
// old text from the persisted request itself, including when it is recovered
// while another delivery is being handled.
function legacyPlayFailureText(content: string): string {
  return content.split("\n").filter((line) => !line.startsWith("Reason: ")
    && !line.startsWith("Possible reason (inferred): ") && !line.startsWith("Possible reason (source unconfirmed): ")
    && !line.startsWith("Play reason code: ")).join("\n");
}

async function cardRequest(env: Env, bot: BotInstallationRow, path: string, method: "GET" | "POST" | "PUT", body?: Record<string, unknown>) {
  const key = await readBotKey(env, bot);
  let response: Response;
  try {
    response = await fetch(`${apiOrigin(env)}${path}`, {
      method, headers: { authorization: `Bearer ${key}`, "content-type": "application/json", accept: "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(4_000),
    });
  } catch {
    throw new RaftBotApiError(503, "RAFT_BOT_PROVIDER_UNREACHABLE");
  }
  let parsed: unknown = null;
  try { parsed = await response.json(); } catch { /* checked below */ }
  const result = parseJsonRecord(parsed);
  if (!response.ok) {
    throw new RaftBotApiError(response.status, safeProviderCode(result.code ?? result.errorCode, "bot_card_failed"));
  }
  return result;
}

async function reconcileBotMessage(env: Env, bot: BotInstallationRow, target: string, idempotencyKey: string) {
  const result = await cardRequest(env, bot, "/internal/agent-api/v2/send", "POST", { target, idempotencyKey, reconcileOnly: true });
  if (result.state === "committed" && typeof result.messageId === "string") {
    const revision = cardReceiptRevision(result);
    return { state: "committed" as const, messageId: result.messageId, ...(revision === undefined ? {} : { cardRevision: revision }) };
  }
  if (result.state === "not_found") return { state: "not_found" as const };
  throw new RaftBotApiError(503, "bot_reconciliation_incomplete");
}

async function resolveBotMessageCard(env: Env, bot: BotInstallationRow, messageId: string) {
  const result = await cardRequest(env, bot, `/internal/agent-api/messages/${encodeURIComponent(messageId)}/resolve`, "GET");
  const message = parseJsonRecord(result.message);
  if (message.message_id !== messageId) throw new RaftBotApiError(503, "bot_message_readback_incomplete");
  if (message.message_card === undefined || message.message_card === null) return { kind: "text" as const };
  const marker = parseJsonRecord(message.message_card);
  if (!Number.isSafeInteger(marker.revision) || (marker.revision as number) < 1) {
    throw new RaftBotApiError(503, "bot_message_readback_incomplete");
  }
  return { kind: "card" as const, revision: marker.revision as number };
}

async function updateBotCard(env: Env, bot: BotInstallationRow, request: {
  messageId: string; content: string; card: RaftMessageCard; expectedRevision: number; idempotencyKey: string;
}) {
  const result = await cardRequest(env, bot, `/internal/agent-api/messages/${encodeURIComponent(request.messageId)}/card`, "PUT", {
    content: request.content, card: request.card, expectedRevision: request.expectedRevision, idempotencyKey: request.idempotencyKey,
  });
  if (result.ok !== true || typeof result.messageId !== "string" || !Number.isSafeInteger(result.revision)) {
    throw new RaftBotApiError(503, "bot_card_update_incomplete");
  }
  return { messageId: result.messageId, revision: result.revision as number };
}

async function preserveLegacyFeedbackThread(
  db: D1Database,
  subscriptionId: string,
  body: Record<string, unknown>,
  objectKey: string,
): Promise<"ready" | "pending" | "absent"> {
  const payload = parseJsonRecord(body.payload);
  if (!isFeedbackThreadEvent(body.event)
    || typeof payload.ticket_id !== "string" || !payload.ticket_id) return "absent";
  const ticket = payload.ticket_id.slice(0, 160);
  const legacy = await db.prepare(
    `SELECT parent_message_id, updated_at FROM raft_notification_threads
     WHERE subscription_id = ?1 AND object_key IN (?2, ?3)
     ORDER BY CASE WHEN parent_message_id = 'pending' THEN 1 ELSE 0 END, created_at ASC
     LIMIT 1`,
  ).bind(subscriptionId, `feedback:comment_created:${ticket}`, `feedback:status_changed:${ticket}`)
    .first<{ parent_message_id: string; updated_at: number }>();
  if (!legacy) return "absent";
  if (legacy.parent_message_id === "pending") {
    return legacy.updated_at >= Date.now() - 5 * 60_000 ? "pending" : "absent";
  }
  const now = Date.now();
  await db.prepare(
    `INSERT OR IGNORE INTO raft_notification_threads
       (subscription_id, object_key, parent_message_id, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?4)`,
  ).bind(subscriptionId, objectKey, legacy.parent_message_id, now).run();
  return "ready";
}

async function signatureMatches(secret: string, body: string, header: string | undefined): Promise<boolean> {
  if (!header || !/^sha256=[0-9a-f]{64}$/.test(header)) return false;
  const expected = await hmacSha256Hex(secret, body);
  let mismatch = 0;
  for (let i = 0; i < expected.length; i++) mismatch |= expected.charCodeAt(i) ^ header.charCodeAt(i + 7);
  return mismatch === 0;
}

export async function handleTestRaftNotification(c: AdminContext) {
  const appId = c.req.param("appId") ?? "";
  const subscriptionId = c.req.param("subscriptionId") ?? "";
  const row = await c.env.DB.prepare(
    `SELECT s.id, s.app_id, s.server_id, s.channel_target, s.events_json, s.enabled, s.card_updates,
            s.bot_installation_id,
            s.webhook_id, s.created_by, s.created_at, s.updated_at, s.archived_at
     FROM raft_notification_subscriptions s
     WHERE s.id = ?1 AND s.app_id = ?2 AND s.archived_at IS NULL`,
  ).bind(subscriptionId, appId).first<NotificationSubscriptionRow>();
  if (!row) return c.json({ error: "notification destination not found" }, 404);
  if (row.enabled !== 1) return c.json({ error: "notification destination is disabled" }, 409);
  const bot = await botForServer(c.env.DB, row.server_id);
  if (!bot || bot.state !== "active") return c.json({ error: "RAFT_BOT_NOT_CONNECTED" }, 409);
  try {
    const testCard = row.card_updates === 1 ? formatRaftNotificationCard({
      event: "hands:test", payload: { status: "Test notification" }, delivered_at: Date.now(),
    }) : null;
    const sent = await sendBotMessage(
      c.env,
      bot,
      row.channel_target,
      testCard?.content ?? "**Hands test notification**\nThis destination is configured and the App Bot can send here.",
      testCard ? `hands-raft-card-test:${subscriptionId}:${crypto.randomUUID()}` : `hands-raft-test:${subscriptionId}`,
      testCard?.card,
    );
    if (testCard) {
      try {
        const verified = sent.cardRevision === undefined ? await resolveBotMessageCard(c.env, bot, sent.messageId)
          : { kind: "card" as const, revision: sent.cardRevision };
        if (verified.kind !== "card" || verified.revision !== 1) {
          return c.json({ error: "card_not_verified", message_id: sent.messageId,
            detail: "Raft sent a message but did not confirm the test card." }, 409);
        }
      } catch {
        return c.json({ error: "card_readback_unavailable", message_id: sent.messageId,
          detail: "Raft sent a message, but its card could not be verified." }, 503);
      }
    }
    return c.json({ ok: true, message_id: sent.messageId, card: !!testCard });
  } catch (error) {
    return providerErrorResponse(c, error);
  }
}

export async function handleRaftNotificationWebhook(c: Context<{ Bindings: Env }>) {
  const subscriptionId = c.req.param("subscriptionId") ?? "";
  const body = await c.req.text();
  const row = await c.env.DB.prepare(
    `SELECT s.id, s.app_id, s.server_id, s.channel_target, s.events_json, s.enabled, s.card_updates,
            s.bot_installation_id,
            s.webhook_id, s.created_by, s.created_at, s.updated_at, s.archived_at,
            w.secret AS webhook_secret, w.enabled AS webhook_enabled,
            w.archived_at AS webhook_archived_at, a.slug AS app_slug, a.name AS app_name
     FROM raft_notification_subscriptions s
     JOIN webhooks w ON w.id = s.webhook_id
     LEFT JOIN apps a ON a.id = s.app_id
     WHERE s.id = ?1
     LIMIT 1`,
  ).bind(subscriptionId).first<InternalSubscriptionRow>();
  if (!row) return c.json({ error: "not found" }, 404);
  if (!(await signatureMatches(row.webhook_secret, body, c.req.header("X-Hands-Signature")))) {
    return c.json({ error: "invalid signature" }, 401);
  }
  if (row.archived_at !== null || row.enabled !== 1 || row.webhook_enabled !== 1 || row.webhook_archived_at !== null) {
    return c.json({ error: "notification destination disabled" }, 410);
  }
  let parsed: unknown;
  try { parsed = JSON.parse(body); } catch { return c.json({ error: "invalid payload" }, 400); }
  const eventBody = parseJsonRecord(parsed);
  const event = eventBody.event;
  if (typeof event !== "string" || !WEBHOOK_EVENT_TYPES.includes(event as NotificationEvent)) {
    return c.json({ error: "invalid event" }, 400);
  }
  let objectKey = await notificationObjectKey(eventBody);
  const legacyObjectKey = objectKey;
  const eventHash = await sha256Hex(body);
  const standalone = isStandaloneRaftNotificationCard(event);
  let legacyStandaloneTarget: string | undefined;
  if (standalone) {
    const standaloneKey = `${event}:event:${eventHash}`;
    const prior = await c.env.DB.prepare(`SELECT 1 FROM raft_notification_cards
      WHERE subscription_id=?1 AND object_key=?2 LIMIT 1`).bind(subscriptionId, standaloneKey).first();
    if (row.card_updates === 1 || prior) {
      const legacy = await c.env.DB.prepare(`SELECT parent_message_id FROM raft_notification_threads
        WHERE subscription_id=?1 AND object_key=?2 LIMIT 1`).bind(subscriptionId, legacyObjectKey)
        .first<{ parent_message_id: string }>();
      if (legacy?.parent_message_id && legacy.parent_message_id !== "pending") {
        legacyStandaloneTarget = `${row.channel_target}:${legacy.parent_message_id.slice(0, 8)}`;
      }
      objectKey = standaloneKey;
    }
  }
  const failureCardKey = playFailureCardObjectKey(eventBody);
  let legacyFailureTarget: string | undefined;
  if (failureCardKey) {
    const legacy = await c.env.DB.prepare(`SELECT parent_message_id FROM raft_notification_threads
      WHERE subscription_id=?1 AND object_key=?2 LIMIT 1`).bind(subscriptionId, legacyObjectKey)
      .first<{ parent_message_id: string }>();
    if (legacy?.parent_message_id && legacy.parent_message_id !== "pending") {
      legacyFailureTarget = `${row.channel_target}:${legacy.parent_message_id.slice(0, 8)}`;
    }
    // A failure receipt is a distinct attempt even if older failures for this
    // release already used a text thread. Retain its key to reconcile a pending
    // send after cards are switched off.
    const prior = await c.env.DB.prepare(`SELECT 1 FROM raft_notification_threads
      WHERE subscription_id=?1 AND object_key=?2 LIMIT 1`).bind(subscriptionId, failureCardKey).first();
    if (row.card_updates === 1 || prior) objectKey = failureCardKey;
  }
  const specificAgcKey = appGalleryCardObjectKey(eventBody);
  if (specificAgcKey && specificAgcKey !== objectKey) {
    const specific = await c.env.DB.prepare(`SELECT 1 FROM raft_notification_threads
      WHERE subscription_id=?1 AND object_key=?2 LIMIT 1`).bind(subscriptionId, specificAgcKey).first();
    const legacy = specific ? null : await c.env.DB.prepare(`SELECT 1 FROM raft_notification_threads
      WHERE subscription_id=?1 AND object_key=?2 LIMIT 1`).bind(subscriptionId, objectKey).first();
    // Existing build-grouped text retains its thread; new submissions and
    // packages use their own identity so unrelated states cannot overwrite.
    if (specific || !legacy) objectKey = specificAgcKey;
  }
  const events = parseStoredEvents(row.events_json);
  if (events.length > 0 && !events.includes(event) && !events.includes("*")) {
    // An already-started card request still needs reconciliation even if the
    // event was unsubscribed later. Do not deliver any new unsubscribed event.
    const prior = await c.env.DB.prepare(`SELECT pending_json FROM raft_notification_cards
      WHERE subscription_id=?1 AND object_key=?2`).bind(subscriptionId, objectKey).first<{ pending_json: string | null }>();
    let pendingHash: unknown = null;
    try { pendingHash = prior?.pending_json ? parseJsonRecord(JSON.parse(prior.pending_json)).eventHash : null; }
    catch { return c.json({ error: "card_delivery_invalid_pending" }, 503); }
    if (pendingHash !== eventHash) return c.json({ ok: true, skipped: true });
  }
  const bot = await botForServer(c.env.DB, row.server_id);
  if (!bot || bot.state !== "active") return c.json({ error: "bot unavailable" }, 503);

  let thread = await c.env.DB.prepare(
    `SELECT parent_message_id, updated_at FROM raft_notification_threads
     WHERE subscription_id = ?1 AND object_key = ?2 LIMIT 1`,
  ).bind(subscriptionId, objectKey).first<{ parent_message_id: string; updated_at: number }>();
  let ownsParentClaim = false;
  let createdParentClaim = false;
  const feedbackRoot = isFeedbackThreadEvent(event) ? formatExistingFeedbackRoot(eventBody, row.app_id) : null;
  const needsFeedbackRoot = feedbackRoot !== null && event !== "feedback:new";
  if (!thread) {
    const legacy = await preserveLegacyFeedbackThread(c.env.DB, subscriptionId, eventBody, objectKey);
    if (legacy === "pending") return c.json({ error: "notification thread is being created" }, 503);
    if (legacy === "ready") {
      thread = await c.env.DB.prepare(
        `SELECT parent_message_id, updated_at FROM raft_notification_threads
         WHERE subscription_id = ?1 AND object_key = ?2 LIMIT 1`,
      ).bind(subscriptionId, objectKey).first<{ parent_message_id: string; updated_at: number }>();
    }
  }
  if (!thread) {
    const marker = needsFeedbackRoot ? FEEDBACK_ROOT_PENDING : "pending";
    const now = Date.now();
    const claim = await c.env.DB.prepare(
      `INSERT OR IGNORE INTO raft_notification_threads
         (subscription_id, object_key, parent_message_id, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?4)`,
    ).bind(subscriptionId, objectKey, marker, now).run();
    if (claim.meta.changes === 1) {
      ownsParentClaim = true;
      createdParentClaim = true;
      thread = { parent_message_id: marker, updated_at: now };
    } else {
      thread = await c.env.DB.prepare(
        `SELECT parent_message_id, updated_at FROM raft_notification_threads
         WHERE subscription_id = ?1 AND object_key = ?2 LIMIT 1`,
      ).bind(subscriptionId, objectKey).first<{ parent_message_id: string; updated_at: number }>();
    }
  }
  if (!thread) return c.json({ error: "notification thread claim unavailable" }, 503);
  if (thread.parent_message_id === "pending" || thread.parent_message_id === FEEDBACK_ROOT_PENDING) {
    const now = Date.now();
    if (thread.updated_at < now - 5 * 60_000) {
      const takeover = await c.env.DB.prepare(
        `UPDATE raft_notification_threads SET updated_at = ?1
         WHERE subscription_id = ?2 AND object_key = ?3
           AND parent_message_id = ?4 AND updated_at = ?5`,
      ).bind(now, subscriptionId, objectKey, thread.parent_message_id, thread.updated_at).run();
      ownsParentClaim = takeover.meta.changes === 1;
      if (ownsParentClaim) thread = { parent_message_id: thread.parent_message_id, updated_at: now };
    }
    if (!ownsParentClaim) return c.json({ error: "notification thread is being created" }, 503);
  }
  let target = ownsParentClaim
    ? row.channel_target
    : `${row.channel_target}:${thread.parent_message_id.slice(0, 8)}`;
  // The delivery header is metadata outside the signed body and can change on
  // a replay. Derive the provider idempotency key only from the signed payload
  // so the same event cannot be sent again with a substituted delivery id.
  const idempotencyKey = `hands-raft:${subscriptionId}:${eventHash}`.slice(0, 240);
  // A pre-deploy worker can send the same event without its new diagnostic
  // fields. Keep that exact old rendering available for same-key replay.
  const app = { id: row.app_id, slug: row.app_slug, name: row.app_name, dashboardOrigin: c.env.DASHBOARD_ORIGIN ?? null };

  if (ownsParentClaim && thread.parent_message_id === FEEDBACK_ROOT_PENDING) {
    // The marker and root key belong to the ticket, not to this event. Another
    // update can recover an uncertain first send without making a second root.
    if (!feedbackRoot) return c.json({ error: "notification thread claim unavailable" }, 503);
    const rootKey = `hands-raft-feedback-root:${subscriptionId}:${await sha256Hex(objectKey)}`.slice(0, 240);
    try {
      // An old worker may already have sent this event before losing its DB
      // pointer. Replay the exact channel message to prove its target and
      // content; never create a second root if that proof fails.
      const prior = await reconcileBotMessage(c.env, bot, row.channel_target, idempotencyKey);
      const root = prior.state === "committed"
        ? await sendBotMessage(c.env, bot, row.channel_target, formatRaftNotificationMessage(eventBody, app), idempotencyKey)
        : await sendBotMessage(c.env, bot, row.channel_target, feedbackRoot, rootKey);
      const saved = await c.env.DB.prepare(
        `UPDATE raft_notification_threads SET parent_message_id = ?1, updated_at = ?2
         WHERE subscription_id = ?3 AND object_key = ?4 AND parent_message_id = ?5 AND updated_at = ?6`,
      ).bind(root.messageId, Date.now(), subscriptionId, objectKey, FEEDBACK_ROOT_PENDING, thread.updated_at).run();
      if (saved.meta.changes !== 1) return c.json({ error: "notification thread is being created" }, 503);
      if (prior.state === "committed") return c.json({ ok: true, message_id: root.messageId, threaded: false });
      ownsParentClaim = false;
      target = `${row.channel_target}:${root.messageId.slice(0, 8)}`;
    } catch (error) {
      // Keep the claim: the provider may have committed despite a lost reply.
      // The next owner replays the same ticket key and immutable content.
      if (error instanceof RaftBotApiError) {
        return c.json({ error: error.code }, error.status >= 400 && error.status < 600 ? error.status as any : 503);
      }
      return c.json({ error: "bot send failed" }, 503);
    }
  }
  const legacyFailureContent = event === "google_play:submission_failed"
    ? legacyPlayFailureText(formatRaftNotificationMessage(eventBody, app)) : undefined;
  const legacyStandaloneContent = standalone ? formatRaftNotificationMessage(eventBody, app) : undefined;
  let cardFallbackReason: string | undefined;
  let cardTextFallback = false;
  if (supportsRaftNotificationCards(event)) {
    // A previously pending request must be reconciled even if the destination
    // was subsequently switched back to text.
    const priorCard = !!await c.env.DB.prepare(
      `SELECT 1 FROM raft_notification_cards WHERE subscription_id=?1 AND object_key=?2 LIMIT 1`,
    ).bind(subscriptionId, objectKey).first();
    // Existing text threads keep their text history. A newly inserted parent
    // claim may start a card; a reclaimed legacy claim may have an uncertain
    // send in flight, so it cannot safely start another one.
    // An AppGallery event without its submission/package ID cannot safely
    // identify a card: use text instead of grouping unrelated objects.
    const appGalleryEvent = event === "appgallery:invitation_state_changed" || event === "appgallery:package_state_changed";
    const hasCardIdentity = (!appGalleryEvent || specificAgcKey !== null)
      && (event !== "google_play:submission_failed" || failureCardKey !== null);
    if (priorCard || (row.card_updates === 1 && createdParentClaim && hasCardIdentity)) {
      const result = await deliverRaftNotificationCard({
        db: c.env.DB, subscriptionId, objectKey, target, channelTarget: row.channel_target,
        createsRoot: ownsParentClaim, eventHash, body: eventBody,
        app: { id: row.app_id, slug: row.app_slug, name: row.app_name },
        transport: {
          send: (request) => sendBotMessage(c.env, bot, request.target, request.content, request.idempotencyKey, request.card),
          replayCompatibleText: (request) => legacyFailureContent === undefined && legacyStandaloneContent === undefined
            ? sendKnownBotText(c.env, bot, request.target,
              compatibleCardText(request.content, request.card), request.idempotencyKey)
            : sendChannelText(c.env, bot, request.target, legacyFailureTarget ?? legacyStandaloneTarget ?? request.target, request.content,
              [...compatibleCardText(request.content, request.card),
                ...(legacyFailureContent === undefined ? [] : compatibleCardText(legacyPlayFailureText(withoutPlayConsoleFooter(request.content)))),
                ...(legacyStandaloneContent === undefined ? [] : [legacyStandaloneContent])],
              request.idempotencyKey, request.idempotencyKey.replace(/^hands-raft:/, "hands-raft-channel:").slice(0, 240)),
          announce: async (request) => {
            // The destination may have been switched off during an in-flight
            // update; consult the current setting before creating the notice.
            const current = await c.env.DB.prepare(`SELECT enabled, card_updates FROM raft_notification_subscriptions
              WHERE id=?1 AND archived_at IS NULL`).bind(subscriptionId)
              .first<{ enabled: number; card_updates: number }>();
            // A text notice uses the card's layout; the card's own content stays
            // the message body when the notice is sent as a card.
            const noticeText = cardLayoutFromCard(request.card) ?? request.content;
            return sendChannelCard(c.env, bot, request.target, request.previousTarget,
              request.preferWarning ? fallbackWarning(noticeText, false) : noticeText,
              request.content, request.card, compatibleCardText(request.content, request.card),
              `hands-raft:${subscriptionId}:${request.eventHash}`.slice(0, 240),
              `hands-raft-channel:${subscriptionId}:${request.eventHash}`.slice(0, 240),
              !request.preferWarning && current?.enabled === 1 && current.card_updates === 1);
          },
          reconcile: (request) => reconcileBotMessage(c.env, bot, request.target, request.idempotencyKey),
          resolve: (messageId) => resolveBotMessageCard(c.env, bot, messageId),
          update: (request) => updateBotCard(c.env, bot, request),
        },
      });
      if (result.kind === "retry") return c.json({ error: result.code }, 503);
      if (result.kind === "skipped") return c.json({ ok: true, skipped: true });
      if (result.kind === "delivered") return c.json({ ok: true, message_id: result.messageId, card: result.card,
        ...(!result.card ? { card_fallback: "card_not_supported" } : {}) });
      cardFallbackReason = result.reason;
      // Each failure and standalone event is its own immutable receipt, so
      // there is no prior status card to warn about on text fallback.
      cardTextFallback = event !== "google_play:submission_failed" && !standalone;
      // Recovery may have filled the root while processing an earlier event.
      if (ownsParentClaim) {
        const current = await c.env.DB.prepare(`SELECT parent_message_id FROM raft_notification_threads
          WHERE subscription_id=?1 AND object_key=?2`).bind(subscriptionId, objectKey).first<{ parent_message_id: string }>();
        if (current?.parent_message_id && current.parent_message_id !== "pending") {
          ownsParentClaim = false;
          target = `${row.channel_target}:${current.parent_message_id.slice(0, 8)}`;
        }
      }
    }
  }
  try {
    const channelText = isReleaseChannelEvent(event);
    // Events that have a card are sent as text in the card's own layout, as
    // Raft writes a card out as markdown. Workers before this change sent the
    // older text under the same idempotency key; those bodies stay accepted
    // as replays so a retry across a deployment never posts a second message.
    const legacyContent = formatRaftNotificationMessage(eventBody, app);
    const baseContent = supportsRaftNotificationCards(event) ? cardLayoutText(eventBody, app) ?? legacyContent : legacyContent;
    const previousContent = cardTextFallback ? fallbackWarning(baseContent, true) : baseContent;
    const content = channelText && cardTextFallback
      ? fallbackWarning(baseContent, false)
      : previousContent;
    const legacyVariants = legacyContent === baseContent ? [] : [
      cardTextFallback ? fallbackWarning(legacyContent, !channelText) : legacyContent,
      fallbackWarning(legacyContent, true), fallbackWarning(legacyContent, false), legacyContent,
    ];
    if (supportsRaftNotificationCards(event)) {
      legacyVariants.push(...unjoinedLayoutVariants(baseContent, cardLayoutText(eventBody, app, { rejoinPieces: false })));
    }
    let sent: { messageId: string };
    if (channelText) {
      sent = await sendChannelText(c.env, bot, row.channel_target, legacyFailureTarget ?? legacyStandaloneTarget ?? target, content,
        [previousContent, baseContent, ...legacyVariants, ...(legacyFailureContent ? [legacyFailureContent] : [])], idempotencyKey,
        `hands-raft-channel:${subscriptionId}:${eventHash}`.slice(0, 240));
    } else {
      try {
        sent = await sendKnownBotText(c.env, bot, target, [content, ...legacyVariants], idempotencyKey);
      } catch (error) {
        // A replay of the event which created the original feedback root must
        // use its original channel target, not the now-known thread target.
        // Replaying the same key and content proves that root without posting
        // another message; other conflicts remain errors.
        if (!isFeedbackThreadEvent(event) || target === row.channel_target
          || !(error instanceof RaftBotApiError) || error.status !== 409 || error.code !== "idempotency_key_reused") throw error;
        sent = await sendKnownBotText(c.env, bot, row.channel_target, [content, ...legacyVariants], idempotencyKey);
        target = row.channel_target;
      }
    }
    const now = Date.now();
    if (ownsParentClaim) {
      await c.env.DB.prepare(
        `UPDATE raft_notification_threads SET parent_message_id = ?1, updated_at = ?2
         WHERE subscription_id = ?3 AND object_key = ?4 AND parent_message_id = 'pending'`,
      ).bind(sent.messageId, now, subscriptionId, objectKey).run();
    } else {
      await c.env.DB.prepare(
        `UPDATE raft_notification_threads SET updated_at = ?1
         WHERE subscription_id = ?2 AND object_key = ?3`,
      ).bind(now, subscriptionId, objectKey).run();
    }
    return c.json({ ok: true, message_id: sent.messageId, threaded: !channelText && target !== row.channel_target,
      ...(cardFallbackReason ? { card_fallback: cardFallbackReason } : {}) });
  } catch (error) {
    if (ownsParentClaim) {
      await c.env.DB.prepare(
        `DELETE FROM raft_notification_threads
         WHERE subscription_id = ?1 AND object_key = ?2 AND parent_message_id = 'pending'`,
      ).bind(subscriptionId, objectKey).run().catch(() => undefined);
    }
    // A non-2xx response makes the generic delivery state machine retry. Do not
    // include provider response text or any credential in the body/logs.
    if (error instanceof RaftBotApiError) {
      return c.json({ error: error.code }, error.status >= 400 && error.status < 600 ? error.status as any : 503);
    }
    return c.json({ error: "bot send failed" }, 503);
  }
}
