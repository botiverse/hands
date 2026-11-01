/**
 * Hands-managed Raft App Bot notifications.
 *
 * The admin routes let an app administrator connect the app's managed bot and
 * choose Raft channel/event subscriptions.  A subscription owns a hidden
 * generic webhook row, so all existing Hands event producers keep the same
 * D1-backed retry/queue behavior.  The internal callback verifies the generic
 * webhook signature before sending through the bot and keeps one thread per
 * logical object.
 */

import type { Context } from "hono";
import { currentActorInfo } from "../middleware/auth";
import type { AdminContext } from "../lib/permissions";
import { decryptP8, encryptP8 } from "../lib/asc_credentials";
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
const MAX_MESSAGE_LENGTH = 4_000;
const MAX_FIELD_LENGTH = 500;

function safeProviderCode(value: unknown, fallback: string): string {
  return typeof value === "string" && /^[a-z0-9_]{1,80}$/.test(value)
    ? value
    : fallback;
}

const SAFE_PAYLOAD_FIELDS: Array<[string, string]> = [
  ["status", "status"],
  ["state", "state"],
  ["previous state", "previous_state"],
  ["version", "version_string"],
  ["version", "version"],
  ["version name", "version_name"],
  ["build", "build_number"],
  ["version code", "version_code"],
  ["track", "track"],
  ["channel", "channel"],
  ["distribution", "distribution"],
  ["platform", "platform"],
  ["failure code", "failure_code"],
  ["reason code", "reason_code"],
  ["ticket", "ticket_id"],
  ["release", "release_id"],
  ["build id", "build_id"],
  ["package", "package_name"],
  ["source", "source"],
  ["occurred", "occurred_at"],
];

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
    `SELECT id, app_id, server_id, channel_target, events_json, enabled,
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

export async function handleConnectRaftBot(c: AdminContext) {
  const appId = c.req.param("appId") ?? "";
  const app = await appContext(c.env.DB, appId);
  if (!app) return c.json({ error: "app not found" }, 404);
  const body = parseJsonRecord(await c.req.json().catch(() => ({})));
  const rotate = body.rotate === true;
  const existing = await botForServer(c.env.DB, app.server_id);
  if (existing && !rotate) return c.json({ bot: publicBot(existing) });

  try {
    // Validate the dedicated KEK before minting a one-time provider key. A
    // missing encryption secret must not leave an unrecoverable credential at
    // Raft that Hands cannot persist.
    const encryptionSecret = botEncryptionSecret(c.env);
    const installationId = await lookupInstallation(c.env, app.server_id);
    const token = await mintBotToken(c.env, installationId, rotate);
    const encrypted = await encryptP8(token.apiKey, encryptionSecret);
    const now = Date.now();
    const id = existing?.id ?? crypto.randomUUID();
    await c.env.DB.prepare(
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
      app.server_id,
      installationId,
      token.credentialId,
      token.agentId,
      token.handle,
      encrypted.ciphertext_b64,
      encrypted.iv_b64,
      now,
    ).run();
    const saved = await botForServer(c.env.DB, app.server_id);
    return c.json({ bot: publicBot(saved) });
  } catch (error) {
    return providerErrorResponse(c, error);
  }
}

export async function handleCreateRaftNotification(c: AdminContext) {
  const appId = c.req.param("appId") ?? "";
  const app = await appContext(c.env.DB, appId);
  if (!app) return c.json({ error: "app not found" }, 404);
  const bot = await botForServer(c.env.DB, app.server_id);
  if (!bot || bot.state !== "active") {
    return c.json({ error: "RAFT_BOT_NOT_CONNECTED", detail: "Connect the Hands App Bot before adding a destination." }, 409);
  }
  const body = parseJsonRecord(await c.req.json().catch(() => ({})));
  const channelTarget = body.channel_target;
  if (typeof channelTarget !== "string" || !CHANNEL_TARGET_RE.test(channelTarget)) {
    return c.json({ error: "channel_target must be a Raft channel such as #releases" }, 400);
  }
  const parsed = parseEvents(body.events);
  if ("error" in parsed) return c.json({ error: parsed.error }, 400);

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
           (id, app_id, server_id, channel_target, events_json, enabled,
            bot_installation_id, webhook_id, created_by, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, 1, ?6, ?7, ?8, ?9, ?9)`,
      ).bind(id, appId, app.server_id, channelTarget, JSON.stringify(parsed.events), bot.id, id, actor.id, now),
    ]);
  } catch {
    return c.json({ error: "notification destination already exists or could not be created" }, 409);
  }
  const saved = await c.env.DB.prepare(
    `SELECT id, app_id, server_id, channel_target, events_json, enabled,
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
  const updates: string[] = [];
  const binds: (string | number)[] = [];
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

async function sendBotMessage(
  env: Env,
  bot: BotInstallationRow,
  target: string,
  content: string,
  idempotencyKey: string,
): Promise<{ messageId: string }> {
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
      body: JSON.stringify({ target, content, idempotencyKey }),
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
  return { messageId };
}

function safeValue(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") return null;
  const text = String(value).replace(/[\r\n]+/g, " ").trim();
  return text.length > 0 ? text.slice(0, MAX_FIELD_LENGTH) : null;
}

function notificationPayload(body: Record<string, unknown>): Record<string, unknown> {
  return parseJsonRecord(body.payload);
}

export function formatRaftNotificationMessage(body: Record<string, unknown>): string {
  const event = safeValue(body.event) ?? "hands:event";
  const payload = notificationPayload(body);
  const app = parseJsonRecord(payload.app);
  const build = parseJsonRecord(payload.build);
  const lines = [`**Hands · ${event}**`];
  const appName = safeValue(app.name) ?? safeValue(app.slug) ?? safeValue(body.app_id);
  if (appName) lines.push(`App: ${appName}`);
  const seen = new Set<string>();
  for (const [label, key] of SAFE_PAYLOAD_FIELDS) {
    if (seen.has(label)) continue;
    const value = safeValue(payload[key]) ?? safeValue(build[key]);
    if (!value) continue;
    seen.add(label);
    lines.push(`${label}: ${value}`);
  }
  const link = safeValue(payload.app_store_connect_url);
  if (link && /^https:\/\/appstoreconnect\.apple\.com\//.test(link)) lines.push(`Review: ${link}`);
  if (event === "app_store:version_state_changed" && payload.state === "REJECTED") {
    lines.push("Apple's review message is available in App Store Connect.");
  }
  const occurred = safeValue(payload.occurred_at) ?? safeValue(body.delivered_at);
  if (occurred && !seen.has("occurred")) lines.push(`occurred: ${occurred}`);
  return lines.join("\n").slice(0, MAX_MESSAGE_LENGTH);
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function notificationObjectKey(body: Record<string, unknown>): Promise<string> {
  const payload = notificationPayload(body);
  const resource = parseJsonRecord(payload.resource);
  const candidates = [
    payload.ticket_id,
    payload.release_id,
    payload.build_id,
    payload.version_id,
    payload.submission_id,
    payload.app_store_version_id,
    resource.id,
    payload.version_string,
    payload.package_name,
  ];
  const first = candidates.find((value) => typeof value === "string" || typeof value === "number");
  if (first !== undefined) return `${String(body.event ?? "event")}:${String(first).slice(0, 160)}`;
  return `${String(body.event ?? "event")}:${(await sha256Hex(JSON.stringify(payload))).slice(0, 32)}`;
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
    `SELECT s.id, s.app_id, s.server_id, s.channel_target, s.events_json, s.enabled,
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
    const sent = await sendBotMessage(
      c.env,
      bot,
      row.channel_target,
      "**Hands test notification**\nThis destination is configured and the App Bot can send here.",
      `hands-raft-test:${subscriptionId}`,
    );
    return c.json({ ok: true, message_id: sent.messageId });
  } catch (error) {
    return providerErrorResponse(c, error);
  }
}

export async function handleRaftNotificationWebhook(c: Context<{ Bindings: Env }>) {
  const subscriptionId = c.req.param("subscriptionId") ?? "";
  const body = await c.req.text();
  const row = await c.env.DB.prepare(
    `SELECT s.id, s.app_id, s.server_id, s.channel_target, s.events_json, s.enabled,
            s.bot_installation_id,
            s.webhook_id, s.created_by, s.created_at, s.updated_at, s.archived_at,
            w.secret AS webhook_secret, w.enabled AS webhook_enabled,
            w.archived_at AS webhook_archived_at
     FROM raft_notification_subscriptions s
     JOIN webhooks w ON w.id = s.webhook_id
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
  const events = parseStoredEvents(row.events_json);
  if (events.length > 0 && !events.includes(event) && !events.includes("*")) return c.json({ ok: true, skipped: true });
  const bot = await botForServer(c.env.DB, row.server_id);
  if (!bot || bot.state !== "active") return c.json({ error: "bot unavailable" }, 503);

  const objectKey = await notificationObjectKey(eventBody);
  let thread = await c.env.DB.prepare(
    `SELECT parent_message_id, updated_at FROM raft_notification_threads
     WHERE subscription_id = ?1 AND object_key = ?2 LIMIT 1`,
  ).bind(subscriptionId, objectKey).first<{ parent_message_id: string; updated_at: number }>();
  let ownsParentClaim = false;
  if (!thread) {
    const claim = await c.env.DB.prepare(
      `INSERT OR IGNORE INTO raft_notification_threads
         (subscription_id, object_key, parent_message_id, created_at, updated_at)
       VALUES (?1, ?2, 'pending', ?3, ?3)`,
    ).bind(subscriptionId, objectKey, Date.now()).run();
    if (claim.meta.changes === 1) {
      ownsParentClaim = true;
      thread = { parent_message_id: "pending", updated_at: Date.now() };
    } else {
      thread = await c.env.DB.prepare(
        `SELECT parent_message_id, updated_at FROM raft_notification_threads
         WHERE subscription_id = ?1 AND object_key = ?2 LIMIT 1`,
      ).bind(subscriptionId, objectKey).first<{ parent_message_id: string; updated_at: number }>();
    }
  }
  if (!thread) return c.json({ error: "notification thread claim unavailable" }, 503);
  if (thread?.parent_message_id === "pending") {
    const now = Date.now();
    if (thread.updated_at < now - 5 * 60_000) {
      const takeover = await c.env.DB.prepare(
        `UPDATE raft_notification_threads SET updated_at = ?1
         WHERE subscription_id = ?2 AND object_key = ?3
           AND parent_message_id = 'pending' AND updated_at = ?4`,
      ).bind(now, subscriptionId, objectKey, thread.updated_at).run();
      ownsParentClaim = takeover.meta.changes === 1;
      if (ownsParentClaim) thread = { parent_message_id: "pending", updated_at: now };
    }
    if (!ownsParentClaim) return c.json({ error: "notification thread is being created" }, 503);
  }
  const target = ownsParentClaim
    ? row.channel_target
    : thread?.parent_message_id
      ? `${row.channel_target}:${thread.parent_message_id.slice(0, 8)}`
      : row.channel_target;
  // The delivery header is metadata outside the signed body and can change on
  // a replay. Derive the provider idempotency key only from the signed payload
  // so the same event cannot be sent again with a substituted delivery id.
  const idempotencyKey = `hands-raft:${subscriptionId}:${await sha256Hex(body)}`.slice(0, 240);
  try {
    const sent = await sendBotMessage(c.env, bot, target, formatRaftNotificationMessage(eventBody), idempotencyKey);
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
    return c.json({ ok: true, message_id: sent.messageId, threaded: Boolean(thread) });
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
