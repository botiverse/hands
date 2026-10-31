import type { Context } from "hono";
import type { AdminContext } from "../lib/permissions";
import { getAscCredentials, encryptP8, decryptP8 } from "../lib/asc_credentials";
import { ascRequest, AscApiError, getBetaCrashLogText, getBetaFeedbackCrashSubmission, listAssignedBetaGroupNames, type AscApiCredentials } from "../lib/asc_api";
import { insertAuditLog } from "../lib/permissions";
import { businessOrigin } from "../lib/origin";
import { triggerDeliveryNow } from "./webhooks";

const LIMIT = 64 * 1024;
/**
 * Which Apple resource each forwarded event points at, and which attribute
 * pairs carry the state transition. The event's resource is also what the
 * optional build-identity lookup keys off (see BUILD_LOOKUP): Apple's webhook
 * envelope carries no version or build number of its own, so naming the
 * affected build means following that resource's relationship explicitly.
 */
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
  betaFeedbackCrashSubmissionCreated: [
    "testflight:crash_submission_created",
    "betaFeedbackCrashSubmissions",
    "createdDate",
    // A creation event has no previous state. The timestamp still goes through
    // the same required-string validation as the state-transition events.
    "",
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
/**
 * Event types whose resource can be resolved to a `builds` resource. Kept
 * separate from EVENT_MAP so the tuple stays a flat, indexable shape.
 */
/** Budget for the two extra round trips that resolve beta group names. */
const GROUPS_TIMEOUT_MS = 4000;

const BUILD_LOOKUP: Partial<Record<string, string>> = {
  buildBetaDetailExternalBuildStateUpdated: "/build",
  betaFeedbackCrashSubmissionCreated: "/build",
  // Unlike buildBetaDetails, a buildUploads resource carries the version strings on
  // itself, so no relationship has to be followed: the empty path means "read this
  // resource's own attributes".
  buildUploadStateUpdated: "",
};

/**
 * Version identity resolved from an Apple event's resource. `null` when the
 * lookup is unavailable, fails, or Apple returns an unexpected shape — the
 * notification is still delivered in that case (see resolveBuildIdentity).
 */
export interface BuildIdentity {
  /** Marketing version, e.g. "1.14.0" (ASC `preReleaseVersion.version`). */
  version: string | null;
  /** Build number, e.g. "11400009" (ASC `builds.version`). */
  version_code: string | null;
  /**
   * Groups this build is ASSIGNED to, for display. Absent (never empty) when the
   * groups could not be read -- an empty array would claim "assigned to nothing",
   * which is a different and possibly false statement.
   */
  beta_groups?: Array<{ name: string; is_internal: boolean }>;
}

/**
 * Resolve the version identity behind an Apple event.
 *
 * Best-effort by design: the webhook is already verified and its delivery is
 * already durably queued. A failed or malformed ASC lookup must not turn a real
 * TestFlight state change into a lost notification, so every failure path
 * returns null identity and the caller forwards the event without version.
 *
 * Field mapping is not guesswork — App Store Connect splits the two numbers
 * across resources, and `resolveAscBuild` in `lib/asc_api.ts` encodes the same
 * split (`filter[version]` = build number, `filter[preReleaseVersion.version]`
 * = marketing version):
 *   - `builds.version`               = the BUILD NUMBER ("11400009")
 *   - `preReleaseVersion.version`    = the MARKETING VERSION ("1.14.0")
 * Reading `buildNumber` off the builds resource silently yields undefined,
 * which is why the marketing version needs its own `include`.
 */
async function resolveBuildIdentity(
  creds: AscApiCredentials | null,
  resourceType: string,
  resourceId: string,
  lookupPath: string | undefined,
): Promise<BuildIdentity | null> {
  // buildUploads is accepted alongside buildBetaDetails because its attributes
  // already hold cfBundleShortVersionString / cfBundleVersion. Reading the wrong
  // resource shape must still fail closed, which is why the types stay an explicit
  // allowlist rather than "anything goes".
  const supportedResource =
    resourceType === "buildBetaDetails" || resourceType === "buildUploads" || resourceType === "betaFeedbackCrashSubmissions";
  if (!creds || lookupPath === undefined || !supportedResource)
    return null;
  try {
    const res = await ascRequest<{
      data?: {
        attributes?: {
          version?: unknown;
          cfBundleVersion?: unknown;
          cfBundleShortVersionString?: unknown;
        };
        relationships?: {
          preReleaseVersion?: { data?: { id?: unknown } };
        };
      };
      included?: Array<{
        type?: unknown;
        id?: unknown;
        attributes?: { version?: unknown };
      }>;
    }>(
      creds,
      "GET",
      // buildUploads has no preReleaseVersion relationship to include; asking for it
      // would be a request Apple may reject, so the include is only added for the
      // resource that actually has one.
      `/v1/${resourceType}/${encodeURIComponent(resourceId)}${lookupPath}` +
        (resourceType === "buildBetaDetails" || resourceType === "betaFeedbackCrashSubmissions" ? "?include=preReleaseVersion" : ""),
      undefined,
      AbortSignal.timeout(5000),
    );
    // buildUploads names the same two values directly; buildBetaDetails calls the
    // build number "version" and needs the included preReleaseVersion for the
    // marketing string.
    const attributes = res?.data?.attributes;
    const buildNumberRaw =
      resourceType === "buildUploads" ? attributes?.cfBundleVersion : attributes?.version;
    const buildNumber =
      typeof buildNumberRaw === "string" && text(buildNumberRaw, 64)
        ? buildNumberRaw
        : null;
    if (resourceType === "buildUploads") {
      const marketing = attributes?.cfBundleShortVersionString;
      const version = typeof marketing === "string" && text(marketing, 64) ? marketing : null;
      // An upload event can fire before Apple has filled these in. Returning null is
      // the honest answer then: the notification still goes out with no build
      // identity, rather than naming a version that is not established yet.
      if (version === null && buildNumber === null) return null;
      return { version, version_code: buildNumber };
    }
    // Prefer the included preReleaseVersion whose id matches the build's own
    // relationship, so a differently-typed `included` entry cannot supply the
    // wrong version string.
    const wantedId = res?.data?.relationships?.preReleaseVersion?.data?.id;
    const candidates = Array.isArray(res?.included) ? res.included : [];
    const match = candidates.find(
      (item) =>
        item?.type === "preReleaseVersions" &&
        (typeof wantedId !== "string" || item?.id === wantedId),
    );
    const versionRaw = match?.attributes?.version;
    const version =
      typeof versionRaw === "string" && text(versionRaw, 64)
        ? versionRaw
        : null;
    if (version === null && buildNumber === null) return null;
    return { version, version_code: buildNumber };
  } catch {
    // Swallowed here as well as in the caller: a lookup failure must never
    // propagate. Kept in both places deliberately — the caller also guards
    // credential decryption, which happens before this function is reached.
    return null;
  }
}

/**
 * Single entry point for enriching an event with its build identity.
 *
 * Contract: NEVER throws and NEVER returns a partial object. Every failure —
 * no credentials row, a decryption error, a timeout, a non-2xx from Apple, an
 * unexpected payload shape — collapses to `null`, so the caller can queue the
 * notification unconditionally. This is the ONE place the "a version lookup
 * must not cost a real state-change event" guarantee lives.
 */
async function resolveBuildIdentityForEvent(
  env: Env,
  encKey: string,
  appId: string,
  ascAppId: string,
  eventType: string,
  resourceType: string,
  resourceId: string,
): Promise<BuildIdentity | null> {
  const candidatePath = Object.hasOwn(BUILD_LOOKUP, eventType)
    ? BUILD_LOOKUP[eventType]
    : undefined;
  // An empty path is a real entry meaning "read this resource's own attributes", so
  // the guard must test for absence, not falsiness. `!candidatePath` rejected the
  // buildUploads entry before the resolver ever saw it.
  if (candidatePath === undefined) return null;
  // Bind after the guard: the closure below would otherwise widen it back to
  // `string | undefined`.
  const lookupPath: string = candidatePath;
  try {
    const creds = await getAscCredentials(env.DB, encKey, appId);
    const identity = await resolveBuildIdentity(creds, resourceType, resourceId, lookupPath);
    if (!identity) return identity;
    // Groups are only meaningful for the external-state event, and only a build id
    // can be queried. Two extra round trips fit in their own budget rather than
    // borrowing the single-hop one the identity lookup was designed around.
    if (resourceType === "buildBetaDetails" && creds) {
      try {
        // ascAppId, NOT appId: listBetaGroups queries /v1/apps/{ascAppId}/betaGroups,
        // and Hands' internal app id is a different identifier entirely.
        const groups = await listAssignedBetaGroupNames(creds, ascAppId, resourceId, GROUPS_TIMEOUT_MS);
        if (groups.length > 0) {
          identity.beta_groups = groups.map((g) => ({ name: g.name, is_internal: g.isInternal }));
        }
      } catch {
        // Groups are decoration on a notification that must still be delivered.
      }
    }
    return identity;
  } catch {
    return null;
  }
}

/**
 * Marketing version string of the appStoreVersions resource behind a
 * version-state event. Apple's envelope names only the resource id, so a consumer
 * could not tell which version moved to IN_REVIEW without opening App Store
 * Connect.
 *
 * Same contract as the build lookup: best effort, never throws, never blocks
 * delivery. Returns null (keys omitted) for other events; for version events
 * always returns both keys, with `version_lookup: "failed"` and a null string
 * when credentials are missing or Apple errors, times out, or answers oddly.
 */
async function resolveVersionStringForEvent(
  env: Env,
  encKey: string,
  appId: string,
  resourceType: string,
  resourceId: string,
): Promise<{ version_string: string | null; version_lookup: "ok" | "failed" } | null> {
  if (resourceType !== "appStoreVersions") return null;
  const failed = { version_string: null, version_lookup: "failed" as const };
  try {
    const creds = await getAscCredentials(env.DB, encKey, appId);
    if (!creds) return failed;
    const res = await ascRequest<{ data?: { id?: unknown; attributes?: { versionString?: unknown } } }>(
      creds,
      "GET",
      `/v1/appStoreVersions/${encodeURIComponent(resourceId)}?fields[appStoreVersions]=versionString`,
      undefined,
      AbortSignal.timeout(5000),
    );
    const value = res?.data?.attributes?.versionString;
    if (res?.data?.id !== resourceId || !text(value, 64)) return failed;
    return { version_string: value, version_lookup: "ok" };
  } catch {
    return failed;
  }
}

interface TestflightCrashIngest {
  ticketId: string;
  statements: ReturnType<Env["DB"]["prepare"]>[];
}

/** Persist a tester-shared crash for the same feedback/crash triage surface used
 * by app-reported crashes. The Apple event id is the idempotency boundary; the
 * deterministic ticket and attachment ids make provider retries harmless too.
 */
async function prepareTestflightCrashIngest(
  env: Env,
  config: Config,
  resourceId: string,
  buildIdentity: BuildIdentity | null,
  now: number,
): Promise<TestflightCrashIngest | null> {
  try {
    if (!env.ASC_CRED_ENC_KEY) return null;
    const creds = await getAscCredentials(env.DB, env.ASC_CRED_ENC_KEY, config.app_id);
    if (!creds) return null;
    const submission = await getBetaFeedbackCrashSubmission(creds, resourceId);
    const attributes = submission.attributes ?? {};
    const ticketId = `testflight-crash:${config.app_id}:${resourceId}`;
    const metadata = {
      source: "testflight",
      submission_id: resourceId,
      build: buildIdentity,
      app_uptime_ms: attributes.appUptimeInMilliseconds ?? null,
      connection_type: attributes.connectionType ?? null,
      battery_percentage: attributes.batteryPercentage ?? null,
    };
    const comment = typeof attributes.comment === "string" ? attributes.comment.trim() : "";
    const statements = [env.DB.prepare(
      `INSERT OR IGNORE INTO feedback_tickets
       (id, app_id, kind, status, message, contact, version_name, version_code,
        channel, device_id, device_model, os_version, arch, locale,
        metadata_json, client_ip_hash, signature, submission_id,
        submission_fingerprint, reporter_id, reporter_integration_id, created_at, updated_at)
       VALUES (?1, ?2, 'crash', 'open', ?3, NULL, ?4, ?5, 'testflight', NULL, ?6, ?7, ?8, ?9,
               ?10, NULL, NULL, ?11, NULL, NULL, NULL, ?12, ?12)`,
    ).bind(
      ticketId,
      config.app_id,
      (comment || "TestFlight crash submission").slice(0, 500),
      buildIdentity?.version ?? null,
      buildIdentity?.version_code ?? null,
      attributes.deviceModel ?? null,
      attributes.osVersion ?? null,
      attributes.architecture ?? null,
      attributes.locale ?? null,
      JSON.stringify(metadata),
      resourceId,
      now,
    )];
    const logText = await getBetaCrashLogText(creds, resourceId);
    if (logText) {
      const bytes = new TextEncoder().encode(logText);
      if (bytes.byteLength <= 2 * 1024 * 1024) {
        const r2Key = `feedback/${config.app_id}/testflight/${resourceId}.ips`;
        await env.APK_BUCKET.put(r2Key, bytes, { httpMetadata: { contentType: "text/plain" } });
        statements.push(env.DB.prepare(
          `INSERT OR IGNORE INTO feedback_attachments
           (id, ticket_id, r2_key, filename, content_type, size_bytes, origin, visibility, created_at)
           VALUES (?1, ?2, ?3, ?4, 'text/plain', ?5, 'system', 'internal', ?6)`,
        ).bind(
          `testflight-crash-log:${config.app_id}:${resourceId}`,
          ticketId,
          r2Key,
          `testflight-crash-${resourceId}.ips`,
          bytes.byteLength,
          now,
        ));
      }
    }
    return { ticketId, statements };
  } catch {
    // A notification is still useful when detail/log enrichment is unavailable.
    // Never include Apple's response or the crash-log body in this warning.
    console.warn("testflight_crash_ingest_failed", JSON.stringify({ submission_id: resourceId }));
    return null;
  }
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
        "BETA_FEEDBACK_CRASH_SUBMISSION_CREATED",
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
  // Narrowed explicitly: `text(...)` inside the compound condition above does
  // not narrow these afterwards, so re-assert the two fields we forward.
  if (typeof instance.type !== "string" || typeof instance.id !== "string") {
    return c.json({ error: "Invalid event" }, 400);
  }
  const resourceType: string = instance.type;
  const resourceId: string = instance.id;
  const digest = hex(await crypto.subtle.digest("SHA-256", raw));
  const nonce = crypto.randomUUID();
  const now = Date.now();
  const eventId = `apple:${config.app_id}:${d.id}`;
  // Enrich with the version this event is about. Resolved BEFORE the delivery
  // payload is built, but its failure is swallowed: `build` is then null and
  // every pre-existing field is unchanged. Note the payload always carries the
  // `build` key, so a consumer must treat null as "version unknown" rather
  // than as an absent field (match the previous shape if you compare payloads).
  const buildIdentity = await resolveBuildIdentityForEvent(
    c.env,
    c.env.ASC_CRED_ENC_KEY,
    config.app_id,
    config.apple_app_id,
    d.type,
    resourceType,
    resourceId,
  );
  const versionLookup = await resolveVersionStringForEvent(
    c.env,
    c.env.ASC_CRED_ENC_KEY,
    config.app_id,
    resourceType,
    resourceId,
  );
  const crashIngest = d.type === "betaFeedbackCrashSubmissionCreated"
    ? await prepareTestflightCrashIngest(c.env, config, resourceId, buildIdentity, now)
    : null;
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
      resource: { type: resourceType, id: resourceId },
      previous_state: attrs[spec[3]] ?? null,
      state: attrs[spec[2]],
      occurred_at: attrs.timestamp ?? attrs.createdDate ?? null,
      app_store_connect_url: `https://appstoreconnect.apple.com/apps/${config.apple_app_id}`,
      ticket_id: crashIngest?.ticketId ?? null,
      /** Version this event is about, or null when it could not be resolved. */
      build: buildIdentity,
      // version_state_changed only: the marketing version of the resource, or null
      // with version_lookup "failed". Absent on other events.
      ...(versionLookup ?? {}),
      // The same rendering shape the internal-beta operation event already emits, so a
      // downstream template reads one field for every TestFlight notification.
      // Omitted entirely when the groups were not resolved: an empty string would
      // read as "assigned to no groups", which is a claim, not an absence.
      ...(buildIdentity?.beta_groups?.length
        ? {
            // Same prefix as the internal-beta notification (`测试组：`) so one
            // concept reads the same way in both places; the parenthetical is added
            // only here, where internal and external groups can appear together.
            groups_display: `测试组：${buildIdentity.beta_groups
              .map((g) => `${g.name}（${g.is_internal ? "内部" : "外部"}）`)
              .join("、")}`,
          }
        : {}),
    },
  });
  // One atomic batch: concurrent/replayed requests cannot insert additional deliveries,
  // and a crash cannot commit a receipt without its outbound messages.
  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT OR IGNORE INTO apple_webhook_events (app_id,event_id,event_type,body_sha256,receipt_nonce,received_at)
      SELECT ?1,?2,?3,?4,?5,?6 WHERE EXISTS(SELECT 1 FROM apple_webhook_configs WHERE id=?7 AND enabled=1)`,
    ).bind(config.app_id, d.id, d.type, digest, nonce, now, config.id),
    ...(crashIngest?.statements ?? []),
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


const APPLE_EVENT_TYPES = [
  "APP_STORE_VERSION_APP_VERSION_STATE_UPDATED",
  "BUILD_BETA_DETAIL_EXTERNAL_BUILD_STATE_UPDATED",
  "BUILD_UPLOAD_STATE_UPDATED",
  "BETA_FEEDBACK_CRASH_SUBMISSION_CREATED",
];
type AppleWebhookResource = {
  id: string;
  type: string;
  attributes: { url: string; enabled: boolean; eventTypes: string[] };
};

/** Register the existing ingress using the app's stored ASC credentials.
 * No caller-provided URL, app ID, secret, or credential is accepted here.
 * Read-before-create permits recovery after an ambiguous provider response;
 * a matching URL is updated rather than generating another subscription.
 */
export async function handleRegisterAppleWebhook(c: AdminContext) {
  c.header("Cache-Control", "no-store");
  const encKey = c.env.ASC_CRED_ENC_KEY;
  if (!encKey) return c.json({ error: "Apple credential encryption is not configured" }, 503);
  const appId = c.req.param("appId")!;
  const config = await c.env.DB.prepare(
    `SELECT w.* FROM apple_webhook_configs w JOIN apps a ON a.id=w.app_id
     WHERE w.app_id=?1 AND w.enabled=1 AND a.platform='ios' AND a.archived_at IS NULL`,
  ).bind(appId).first<Config>();
  if (!config) return c.json({ error: "Create an enabled Apple webhook configuration first" }, 409);
  const creds = await getAscCredentials(c.env.DB, encKey, appId);
  if (!creds) return c.json({ error: "App Store Connect credentials are not configured" }, 409);
  const url = `${businessOrigin(c.env)}/api/apple/webhooks/${config.id}`;
  const collectionPath = `/v1/apps/${encodeURIComponent(config.apple_app_id)}/webhooks`;
  let stage = "list_webhooks";
  try {
    const matches: AppleWebhookResource[] = [];
    let path: string | null = `${collectionPath}?limit=200`;
    for (let pages = 0; path && pages < 10; pages++) {
      const page: { data: AppleWebhookResource[]; links?: { next?: string | null } } = await ascRequest(
        creds, "GET", path, undefined, AbortSignal.timeout(30000),
      );
      if (!Array.isArray(page?.data)) throw new Error("Malformed Apple response");
      matches.push(...page.data.filter((r) => r.type === "webhooks" && r.attributes?.url === url));
      const next: string | null | undefined = page.links?.next;
      if (!next) { path = null; break; }
      const parsed = new URL(next, "https://api.appstoreconnect.apple.com");
      if (parsed.origin !== "https://api.appstoreconnect.apple.com" || parsed.pathname !== collectionPath)
        throw new Error("Unexpected Apple pagination URL");
      path = parsed.pathname + parsed.search;
    }
    if (path) return c.json({ error: "Apple webhook list exceeded the safety limit", stage }, 502);
    if (matches.length > 1) return c.json({ error: "Multiple Apple subscriptions match this ingress; resolve duplicates before registering" }, 409);
    // Do not register an ingress removed while Apple listing was in flight.
    const stillEnabled = await c.env.DB.prepare("SELECT id FROM apple_webhook_configs WHERE app_id=?1 AND id=?2 AND enabled=1")
      .bind(appId, config.id).first();
    if (!stillEnabled) return c.json({ error: "Apple ingress configuration changed; retry from current configuration" }, 409);
    const secret = await decryptP8(config.secret_ciphertext_b64, config.secret_iv_b64, encKey);
    const existing = matches[0];
    stage = existing ? "update_webhook" : "create_webhook";
    const attributes = { name: `Hands ${appId}`, url, secret, enabled: true, eventTypes: APPLE_EVENT_TYPES };
    const registered = await ascRequest<{ data: AppleWebhookResource }>(
      creds, existing ? "PATCH" : "POST",
      existing ? `/v1/webhooks/${encodeURIComponent(existing.id)}` : "/v1/webhooks",
      { data: { type: "webhooks", ...(existing ? { id: existing.id } : {}), attributes,
        ...(!existing ? { relationships: { app: { data: { type: "apps", id: config.apple_app_id } } } } : {}),
      } }, AbortSignal.timeout(30000),
    );
    stage = "readback_webhook";
    const readback = await ascRequest<{ data: AppleWebhookResource }>(
      creds, "GET", `/v1/webhooks/${encodeURIComponent(registered.data.id)}`, undefined, AbortSignal.timeout(30000),
    );
    const result = readback.data;
    if (result.type !== "webhooks" || result.attributes?.url !== url || result.attributes.enabled !== true
      || !Array.isArray(result.attributes.eventTypes) || !APPLE_EVENT_TYPES.every((e) => result.attributes.eventTypes.includes(e)))
      return c.json({ error: "Apple subscription readback did not match the requested configuration", stage }, 502);
    // The provider operation has succeeded. Audit failure must not encourage
    // blind repeat creation; subsequent calls discover the existing URL.
    try {
      await insertAuditLog(c.env.DB, c, { app_id: appId, action: "apple_webhook.register",
        payload: { configuration_id: config.id, apple_webhook_id: result.id, apple_app_id: config.apple_app_id }, created_at: Date.now() });
    } catch { console.error("apple_webhook_registration_audit_failed"); }
    return c.json({ registered: true, apple_webhook_id: result.id, apple_app_id: config.apple_app_id,
      payload_url: url, event_types: APPLE_EVENT_TYPES, reused: !!existing });
  } catch (error) {
    return c.json({ error: "App Store Connect webhook registration failed", stage,
      upstream_status: error instanceof AscApiError ? error.status : null }, 502);
  }
}
