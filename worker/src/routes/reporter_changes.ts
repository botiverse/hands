import type { Context } from "hono";
import { isTransientD1LookupError } from "../lib/d1_lookup_recovery";
import { loadDeployToken } from "../lib/deploy_tokens";
import { computeReporterAuditHash, MIN_REPORTER_AUDIT_KEY_BYTES } from "../lib/reporter_audit";
import { isFeedbackOnlyToken, reporterBearerValue } from "../lib/reporter_auth";
import { setReporterFailureStage } from "../lib/reporter_failure";

type ReporterChangesContext = Context<{ Bindings: Env }>;

const CURSOR_PREFIX = "rc1.";
const CURSOR_NONCE_BYTES = 12;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const WINDOW_MS = 60_000;
const INTEGRATION_LIMIT = 60;
// The existing rate/audit tables have a fixed endpoint CHECK. Use a distinct
// reserved subject in their existing list category rather than a migration or
// a reporter-supplied identity; it cannot collide with a hex HMAC pseudonym.
const RATE_SUBJECT = "integration-changes-v1";

function encodeBytes(bytes: Uint8Array): string {
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function decodeBytes(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(text) || text.length > 512) return null;
  try {
    const value = text.replaceAll("-", "+").replaceAll("_", "/");
    const decoded = atob(value.padEnd(Math.ceil(value.length / 4) * 4, "="));
    return Uint8Array.from(decoded, (char) => char.charCodeAt(0));
  } catch {
    return null;
  }
}

// The underlying material sequence is app-wide. Never expose it as a merely
// base64-encoded value: gaps would disclose activity of other integrations.
// Derive an authenticated-encryption key per app/integration from the existing
// server-only audit key; a cursor cannot be forged or moved to another scope.
async function cursorKey(secret: string, appId: string, integrationId: string): Promise<CryptoKey> {
  const hmac = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const derived = await crypto.subtle.sign(
    "HMAC", hmac, new TextEncoder().encode(`hands-reporter-changes-cursor-v1\0${appId}\0${integrationId}`),
  );
  return crypto.subtle.importKey("raw", derived, "AES-GCM", false, ["encrypt", "decrypt"]);
}

async function encodeCursor(key: CryptoKey, sequence: number): Promise<string> {
  const nonce = crypto.getRandomValues(new Uint8Array(CURSOR_NONCE_BYTES));
  // Fixed-length plaintext also prevents ciphertext length from leaking the
  // order of magnitude of the app-wide sequence.
  const plaintext = new Uint8Array(8);
  new DataView(plaintext.buffer).setBigUint64(0, BigInt(sequence));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce }, key, plaintext,
  ));
  const result = new Uint8Array(nonce.length + ciphertext.length);
  result.set(nonce);
  result.set(ciphertext, nonce.length);
  return CURSOR_PREFIX + encodeBytes(result);
}

async function decodeCursor(key: CryptoKey, value: string): Promise<number | null> {
  if (!value.startsWith(CURSOR_PREFIX)) return null;
  const bytes = decodeBytes(value.slice(CURSOR_PREFIX.length));
  if (!bytes || bytes.length <= CURSOR_NONCE_BYTES + 16) return null;
  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: bytes.slice(0, CURSOR_NONCE_BYTES) }, key, bytes.slice(CURSOR_NONCE_BYTES),
    );
    if (plaintext.byteLength !== 8) return null;
    const decoded = new DataView(plaintext).getBigUint64(0);
    if (decoded > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    return Number(decoded);
  } catch {
    return null;
  }
}

export async function handleReporterChanges(c: ReporterChangesContext) {
  c.header("Cache-Control", "private, no-store");
  const appId = c.req.param("appId") ?? "";
  const bearer = reporterBearerValue(c);
  if (!bearer) return c.json({ error: "invalid or missing bearer token" }, 401);
  setReporterFailureStage(c, "token_lookup");
  let token;
  try {
    // Unlike per-reporter endpoints, only a long-lived integration deploy token
    // can enumerate integration-wide tickets. A per-reporter session cannot.
    token = await loadDeployToken(c.env, bearer, true);
  } catch (error) {
    if (!isTransientD1LookupError(error)) throw error;
    if (error instanceof Error) c.error = error;
    c.header("Retry-After", "1");
    return c.json({ error: "reporter backend temporarily unavailable", code: "REPORTER_BACKEND_UNAVAILABLE" }, 503);
  }
  if (!token) return c.json({ error: "invalid or missing bearer token" }, 401);
  if (!isFeedbackOnlyToken(token, appId, "feedback:read")) {
    return c.json({ error: "invalid reporter integration grant" }, 403);
  }
  const integrationId = token.reporter_integration_id!;
  const secret = c.env.FEEDBACK_AUDIT_HMAC_KEY;
  const auditVersion = c.env.FEEDBACK_AUDIT_KEY_VERSION?.trim();
  if (!secret || new TextEncoder().encode(secret).byteLength < MIN_REPORTER_AUDIT_KEY_BYTES || !auditVersion) {
    return c.json({ error: "reporter audit is not configured" }, 503);
  }
  const key = await cursorKey(secret, appId, integrationId);
  const rawCursor = c.req.query("cursor");
  const sequence = rawCursor === undefined ? null : await decodeCursor(key, rawCursor);
  if (rawCursor !== undefined && sequence === null) return c.json({ error: "invalid cursor" }, 400);
  const rawLimit = c.req.query("limit");
  const limit = rawLimit === undefined ? DEFAULT_LIMIT : Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    return c.json({ error: `limit must be an integer between 1 and ${MAX_LIMIT}` }, 400);
  }

  // One integration-wide bucket; never retry an ambiguous quota write. This is
  // separate from the per-reporter list buckets despite sharing their schema.
  const now = Date.now();
  const windowStart = Math.floor(now / WINDOW_MS) * WINDOW_MS;
  setReporterFailureStage(c, "rate_limit");
  let rate: D1Result;
  try {
    rate = await c.env.DB.prepare(
      `INSERT INTO feedback_reporter_rate_windows
       (app_id, reporter_integration_id, reporter_hash, audit_key_version,
        endpoint, window_started_at, request_count, updated_at)
       VALUES (?1, ?2, ?3, ?4, 'list', ?5, 1, ?6)
       ON CONFLICT(app_id, reporter_integration_id, reporter_hash,
                   audit_key_version, endpoint, window_started_at)
       DO UPDATE SET request_count = request_count + 1, updated_at = excluded.updated_at
       RETURNING request_count`,
    ).bind(appId, integrationId, RATE_SUBJECT, auditVersion, windowStart, now).all();
  } catch (error) {
    if (!isTransientD1LookupError(error)) throw error;
    if (error instanceof Error) c.error = error;
    c.header("Retry-After", "1");
    return c.json({ error: "reporter backend temporarily unavailable", code: "REPORTER_BACKEND_UNAVAILABLE" }, 503);
  }
  const count = (rate.results?.[0] as { request_count?: number } | undefined)?.request_count;
  if (!Number.isSafeInteger(count) || count! < 1) return c.json({ error: "reporter rate limit unavailable" }, 503);
  if (count! > INTEGRATION_LIMIT) {
    c.header("Retry-After", String(Math.max(1, Math.ceil((windowStart + WINDOW_MS - now) / 1000))));
    return c.json({ error: "reporter rate limit exceeded" }, 429);
  }

  const auditHash = await computeReporterAuditHash({
    key: secret, appId, integrationId, reporterId: `integration-changes:${token.id}`,
  });
  if (!auditHash) return c.json({ error: "reporter audit is not configured" }, 503);
  const throttle = Math.floor(now / (10 * WINDOW_MS)) * (10 * WINDOW_MS);
  const stateStatement = c.env.DB.prepare(
    `SELECT COALESCE(s.high_water, 0) AS high_water
     FROM apps a
     JOIN app_reporter_integrations ri
       ON ri.app_id = a.id AND ri.id = ?2 AND ri.archived_at IS NULL
     LEFT JOIN feedback_material_sequence_state s ON s.app_id = a.id
     WHERE a.id = ?1 AND a.archived = 0`,
  ).bind(appId, integrationId);
  const pageStatement = c.env.DB.prepare(
    `SELECT t.id AS ticket_id, r.route_subject, t.reporter_id,
            (SELECT fc.id FROM feedback_comments fc
             WHERE fc.ticket_id = t.id AND fc.internal = 0
               AND fc.author_type IN ('staff', 'system')
             ORDER BY fc.reporter_sequence DESC LIMIT 1) AS comment_id,
            t.material_sequence AS sequence
     FROM feedback_tickets t
     JOIN apps a ON a.id = t.app_id AND a.archived = 0
     JOIN app_reporter_integrations ri
       ON ri.id = t.reporter_integration_id AND ri.app_id = t.app_id AND ri.archived_at IS NULL
     LEFT JOIN app_reporter_routes r
       ON r.app_id = t.app_id AND r.reporter_integration_id = t.reporter_integration_id
      AND r.reporter_id = t.reporter_id
     WHERE t.app_id = ?1 AND t.reporter_integration_id = ?2
       AND t.reporter_id IS NOT NULL AND t.material_sequence > ?3
     ORDER BY t.material_sequence ASC LIMIT ?4`,
  ).bind(appId, integrationId, sequence ?? Number.MAX_SAFE_INTEGER, limit + 1);
  const auditStatement = c.env.DB.prepare(
    `INSERT OR IGNORE INTO feedback_reporter_access_audits
     (id, app_id, reporter_integration_id, reporter_hash, audit_key_version,
      endpoint, ticket_id, attachment_id, throttle_window_started_at, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, 'list', NULL, NULL, ?6, ?7)`,
  ).bind(crypto.randomUUID(), appId, integrationId, auditHash, auditVersion, throttle, now);
  setReporterFailureStage(c, "list_query");
  // Atomic batch gives the high-water and page a single consistent snapshot.
  // On bootstrap use the high-water only; no history is replayed.
  const [stateResult, pageResult] = await c.env.DB.batch([stateStatement, pageStatement, auditStatement]);
  const state = stateResult?.results[0] as { high_water?: number } | undefined;
  if (!state) return c.json({ error: "invalid reporter integration grant" }, 403);
  const highWater = state.high_water;
  if (!Number.isSafeInteger(highWater) || highWater! < 0) {
    return c.json({ error: "invalid material sequence state" }, 500);
  }
  if (sequence !== null && sequence > highWater!) {
    return c.json({ error: "cursor is ahead of current feedback state" }, 409);
  }
  const results = (pageResult?.results ?? []) as {
    ticket_id: string; route_subject: string | null; reporter_id: string; comment_id: string | null; sequence: number;
  }[];
  const hasMore = results.length > limit;
  const page = results.slice(0, limit);
  const next = hasMore ? page.at(-1)?.sequence : highWater;
  if (!Number.isSafeInteger(next) || next! < 0) return c.json({ error: "invalid material sequence state" }, 500);
  return c.json({
    changes: page.map(({ ticket_id, route_subject, reporter_id, comment_id }) => ({ ticket_id, route_subject, reporter_id, comment_id })),
    next_cursor: await encodeCursor(key, next!),
    has_more: hasMore,
  });
}
