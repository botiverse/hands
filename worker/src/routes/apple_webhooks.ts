import type { Context } from "hono";
import type { AdminContext } from "../lib/permissions";
import { encryptP8, decryptP8 } from "../lib/asc_credentials";
import { businessOrigin } from "../lib/origin";
import { triggerDeliveryNow } from "./webhooks";

const LIMIT = 64 * 1024;
const EVENT_MAP = {
  appStoreVersionAppVersionStateUpdated: [
    "app_store:version_state_changed",
    "appStoreVersions",
    "newValue",
    "oldValue",
  ],
  buildBetaDetailExternalBuildStateUpdated: [
    "testflight:external_state_changed",
    "buildBetaDetails",
    "newExternalBuildState",
    "oldExternalBuildState",
  ],
  buildUploadStateUpdated: [
    "app_store:build_upload_state_changed",
    "buildUploads",
    "newState",
    "oldState",
  ],
} as const;

interface Config {
  id: string;
  app_id: string;
  apple_app_id: string;
  enabled: number;
  secret_ciphertext_b64: string;
  secret_iv_b64: string;
  org_id: string;
  slug: string;
  name: string;
}
const text = (v: unknown, max = 256): v is string =>
  typeof v === "string" &&
  v.length > 0 &&
  v.length <= max &&
  !/[\x00-\x1f\x7f]/.test(v);
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const hex = (b: ArrayBuffer) =>
  [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");

export async function verifyAppleSignature(
  secret: string,
  body: Uint8Array,
  header: string | undefined,
): Promise<boolean> {
  if (!header || !/^hmacsha256=[a-fA-F0-9]{64}$/.test(header)) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const signature = Uint8Array.from(header.slice(11).match(/../g)!, (s) =>
    parseInt(s, 16),
  );
  return crypto.subtle.verify("HMAC", key, signature, body);
}

export async function handleCreateAppleWebhook(c: AdminContext) {
  if (!c.env.ASC_CRED_ENC_KEY)
    return c.json(
      { error: "Apple credential encryption is not configured" },
      503,
    );
  const body: unknown = await c.req.json().catch(() => null);
  if (
    !object(body) ||
    !text(body.apple_app_id, 64) ||
    !/^\d+$/.test(body.apple_app_id)
  )
    return c.json(
      { error: "apple_app_id must be the numeric App Store Connect app ID" },
      400,
    );
  const appId = c.req.param("appId")!;
  const app = await c.env.DB.prepare(
    "SELECT platform FROM apps WHERE id=?1 AND archived_at IS NULL",
  )
    .bind(appId)
    .first<{ platform: string }>();
  if (!app || app.platform !== "ios")
    return c.json({ error: "An active iOS app is required" }, 400);
  const secret = hex(crypto.getRandomValues(new Uint8Array(32)).buffer);
  const encrypted = await encryptP8(secret, c.env.ASC_CRED_ENC_KEY);
  const id = crypto.randomUUID();
  const now = Date.now();
  const result = await c.env.DB.prepare(
    `INSERT OR IGNORE INTO apple_webhook_configs
    (id,app_id,apple_app_id,secret_ciphertext_b64,secret_iv_b64,enabled,created_at,updated_at)
    VALUES (?1,?2,?3,?4,?5,1,?6,?6)`,
  )
    .bind(
      id,
      appId,
      body.apple_app_id,
      encrypted.ciphertext_b64,
      encrypted.iv_b64,
      now,
    )
    .run();
  if (!result.meta.changes)
    return c.json(
      {
        error:
          "Apple webhook already configured; disable and remove it before creating a replacement",
      },
      409,
    );
  c.header("Cache-Control", "no-store");
  return c.json(
    {
      id,
      apple_app_id: body.apple_app_id,
      payload_url: `${businessOrigin(c.env)}/api/apple/webhooks/${id}`,
      secret,
      event_types: [
        "APP_STORE_VERSION_APP_VERSION_STATE_UPDATED",
        "BUILD_BETA_DETAIL_EXTERNAL_BUILD_STATE_UPDATED",
        "BUILD_UPLOAD_STATE_UPDATED",
      ],
    },
    201,
  );
}
export async function handleGetAppleWebhook(c: AdminContext) {
  const row = await c.env.DB.prepare(
    `SELECT id,apple_app_id,enabled,created_at,updated_at FROM apple_webhook_configs WHERE app_id=?1`,
  )
    .bind(c.req.param("appId")!)
    .first();
  c.header("Cache-Control", "no-store");
  return c.json({ webhook: row });
}
export async function handleDeleteAppleWebhook(c: AdminContext) {
  // Deleting invalidates the old URL immediately. Receipts survive rotation.
  await c.env.DB.prepare("DELETE FROM apple_webhook_configs WHERE app_id=?1")
    .bind(c.req.param("appId")!)
    .run();
  return c.json({ ok: true });
}

export async function handleAppleWebhook(c: Context<{ Bindings: Env }>) {
  const config = await c.env.DB.prepare(
    `SELECT w.*,a.org_id,a.slug,a.name FROM apple_webhook_configs w JOIN apps a ON a.id=w.app_id
    WHERE w.id=?1 AND w.enabled=1 AND a.archived_at IS NULL`,
  )
    .bind(c.req.param("configId")!)
    .first<Config>();
  if (!config) return c.json({ error: "Not found" }, 404);
  if (!c.env.ASC_CRED_ENC_KEY)
    return c.json({ error: "Webhook unavailable" }, 503);
  const reader = c.req.raw.body?.getReader();
  if (!reader) return c.json({ error: "Empty body" }, 400);
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const r = await reader.read();
    if (r.done) break;
    length += r.value.byteLength;
    if (length > LIMIT) {
      await reader.cancel();
      return c.json({ error: "Body too large" }, 413);
    }
    chunks.push(r.value);
  }
  const raw = new Uint8Array(length);
  let offset = 0;
  for (const b of chunks) {
    raw.set(b, offset);
    offset += b.length;
  }
  const secret = await decryptP8(
    config.secret_ciphertext_b64,
    config.secret_iv_b64,
    c.env.ASC_CRED_ENC_KEY,
  );
  if (
    !(await verifyAppleSignature(
      secret,
      raw,
      c.req.header("x-apple-signature"),
    ))
  )
    return c.json({ error: "Invalid signature" }, 401);
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }
  if (!object(parsed)) return c.json({ error: "Invalid event" }, 400);
  const d = parsed.data;
  // Apple can evolve ping and event envelopes; a verified unknown envelope
  // is acknowledged but cannot create a notification.
  if (!object(d) || !text(d.type))
    return c.json({ received: true, ignored: true });
  const spec = Object.hasOwn(EVENT_MAP, d.type)
    ? EVENT_MAP[d.type as keyof typeof EVENT_MAP]
    : undefined;
  if (!spec) return c.json({ received: true, ignored: true });
  if (!text(d.id)) return c.json({ error: "Invalid event" }, 400);
  const attrs = d.attributes;
  const rels = d.relationships;
  const instance =
    object(rels) && object(rels.instance) ? rels.instance.data : null;
  if (
    d.version !== 1 ||
    !object(attrs) ||
    !object(instance) ||
    instance.type !== spec[1] ||
    !text(instance.id) ||
    !text(attrs[spec[2]], 128) ||
    (attrs[spec[3]] !== undefined && !text(attrs[spec[3]], 128)) ||
    (attrs.timestamp !== undefined &&
      (!text(attrs.timestamp, 64) ||
        !Number.isFinite(Date.parse(attrs.timestamp))))
  )
    return c.json({ error: "Invalid event" }, 400);
  const digest = hex(await crypto.subtle.digest("SHA-256", raw));
  const nonce = crypto.randomUUID();
  const now = Date.now();
  const eventId = `apple:${config.app_id}:${d.id}`;
  const payload = JSON.stringify({
    event: spec[0],
    event_id: eventId,
    delivered_at: now,
    org_id: config.org_id,
    app_id: config.app_id,
    payload: {
      apple_event_id: d.id,
      apple_app_id: config.apple_app_id,
      app: { id: config.app_id, slug: config.slug, name: config.name },
      resource: { type: instance.type, id: instance.id },
      previous_state: attrs[spec[3]] ?? null,
      state: attrs[spec[2]],
      occurred_at: attrs.timestamp ?? null,
      app_store_connect_url: `https://appstoreconnect.apple.com/apps/${config.apple_app_id}`,
    },
  });
  // One atomic batch: concurrent/replayed requests cannot insert additional deliveries,
  // and a crash cannot commit a receipt without its outbound messages.
  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT OR IGNORE INTO apple_webhook_events (app_id,event_id,event_type,body_sha256,receipt_nonce,received_at)
      SELECT ?1,?2,?3,?4,?5,?6 WHERE EXISTS(SELECT 1 FROM apple_webhook_configs WHERE id=?7 AND enabled=1)`,
    ).bind(config.app_id, d.id, d.type, digest, nonce, now, config.id),
    c.env.DB.prepare(
      `INSERT INTO webhook_deliveries (id,webhook_id,event_type,external_event_id,payload_json,signing_secret,status,attempts,max_attempts,next_attempt_at,created_at,updated_at)
      SELECT lower(hex(randomblob(16))),w.id,?1,?2,?3,w.secret,'pending',0,3,?4,?4,?4 FROM webhooks w
      WHERE w.org_id=?5 AND (w.app_id IS NULL OR w.app_id=?6) AND w.enabled=1 AND w.archived_at IS NULL
      AND json_valid(w.events_json) AND json_type(CASE WHEN json_valid(w.events_json) THEN w.events_json ELSE '[]' END)='array' AND (json_array_length(CASE WHEN json_valid(w.events_json) THEN w.events_json ELSE '[null]' END)=0 OR EXISTS(SELECT 1 FROM json_each(CASE WHEN json_valid(w.events_json) THEN w.events_json ELSE '[]' END) WHERE value IN (?1,'*')))
      AND EXISTS(SELECT 1 FROM apple_webhook_events WHERE app_id=?6 AND event_id=?7 AND receipt_nonce=?8)`,
    ).bind(
      spec[0],
      eventId,
      payload,
      now,
      config.org_id,
      config.app_id,
      d.id,
      nonce,
    ),
  ]);
  const receipt = await c.env.DB.prepare(
    "SELECT body_sha256,receipt_nonce FROM apple_webhook_events WHERE app_id=?1 AND event_id=?2",
  )
    .bind(config.app_id, d.id)
    .first<{ body_sha256: string; receipt_nonce: string }>();
  if (!receipt) return c.json({ error: "Webhook configuration changed" }, 409);
  if (receipt.body_sha256 !== digest)
    return c.json({ error: "Event ID reused with a different payload" }, 409);
  triggerDeliveryNow(c, c.env, now);
  return c.json({ received: true, duplicate: receipt.receipt_nonce !== nonce });
}
