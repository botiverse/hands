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
import { presignR2UploadUrl } from "../lib/r2_presign";
import { generateSignedR2Url } from "./public_v2";
import { dashboardOrigin, requestOrigin } from "../lib/origin";
import { loadDeployToken, resolveDeployTokenPermissions } from "../lib/deploy_tokens";

type AdminContext = Context<AdminEnv & { Bindings: Env }>;

const MAX_ATTACHMENTS = 9;
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024; // inline multipart cap (through the Worker)
const MAX_PRESIGNED_BYTES = 200 * 1024 * 1024; // direct-to-R2 cap
const PRESIGN_TTL_SECONDS = 900;
const MAX_MESSAGE_CHARS = 10_000;
const DIRECT_RATE_LIMIT_PER_HOUR = 10;
const TRUSTED_REPORTER_RATE_LIMIT_PER_HOUR = 100;

const TICKET_STATUSES = ["open", "in_progress", "resolved", "closed"] as const;
const TICKET_KINDS = ["feedback", "bug", "crash"] as const;
const SUBMISSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REPORTER_ID_PATTERN = /^[A-Za-z0-9_-]{16,200}$/;

type FeedbackApp = {
  id: string;
  org_id: string | null;
  slug: string;
  client_key: string | null;
  platform: string | null;
};

/**
 * Presigned direct-to-R2 upload for large feedback attachments. Client-key
 * gated (same as submit). Body: { files: [{ filename, content_type, size }] }.
 * Returns per-file { attachment_id, r2_key, upload_url, expires_at }; the
 * client PUTs bytes to upload_url, then submits the ticket referencing the
 * r2_keys via the `presigned` form field.
 */
export async function handlePresignFeedbackAttachments(c: Context<{ Bindings: Env }>) {
  const slug = c.req.param("slug");
  if (!slug) return c.json({ error: "slug required" }, 400);
  const app = await c.env.DB.prepare(
    "SELECT id, client_key FROM apps WHERE slug = ?1 AND archived = 0",
  )
    .bind(slug)
    .first<{ id: string; client_key: string | null }>();
  if (!app) return c.json({ error: `app '${slug}' not found` }, 404);
  const presented =
    c.req.header("X-Hands-Client-Key") ?? c.req.header("X-Quiver-Client-Key") ?? c.req.query("client_key") ?? "";
  if (!app.client_key || presented !== app.client_key) {
    return c.json({ error: "invalid or missing client key" }, 401);
  }

  let body: { files?: Array<{ filename?: string; content_type?: string; size?: number }> };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "JSON body required" }, 400);
  }
  const files = Array.isArray(body.files) ? body.files : [];
  if (files.length === 0 || files.length > MAX_ATTACHMENTS) {
    return c.json({ error: `files must contain 1-${MAX_ATTACHMENTS} entries` }, 400);
  }

  const now = Date.now();
  const out: Array<{
    attachment_id: string;
    r2_key: string;
    upload_url: string;
    expires_at: number;
  }> = [];
  for (const [index, file] of files.entries()) {
    const size = typeof file.size === "number" ? file.size : 0;
    if (size <= 0 || size > MAX_PRESIGNED_BYTES) {
      return c.json(
        { error: `file ${index} size must be 1-${MAX_PRESIGNED_BYTES} bytes` },
        400,
      );
    }
    const safeName =
      String(file.filename ?? "").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120) ||
      `attachment-${index}`;
    const contentType = String(file.content_type ?? "application/octet-stream").slice(0, 100);
    const attachmentId = crypto.randomUUID();
    const r2Key = `feedback/${app.id}/presigned/${attachmentId}-${safeName}`;
    const uploadUrl = await presignR2UploadUrl(c.env, r2Key, contentType, PRESIGN_TTL_SECONDS);
    if (!uploadUrl) {
      return c.json({ error: "direct upload is not configured on this server" }, 501);
    }
    out.push({
      attachment_id: attachmentId,
      r2_key: r2Key,
      upload_url: uploadUrl,
      expires_at: now + PRESIGN_TTL_SECONDS * 1000,
    });
  }
  return c.json({ uploads: out });
}

export async function handlePublicFeedbackSubmit(c: Context<{ Bindings: Env }>) {
  const slug = c.req.param("slug");
  if (!slug) return c.json({ error: "slug required" }, 400);
  const app = await c.env.DB.prepare(
    "SELECT id, org_id, slug, client_key, platform FROM apps WHERE slug = ?1 AND archived = 0",
  )
    .bind(slug)
    .first<FeedbackApp>();
  if (!app) return c.json({ error: `app '${slug}' not found` }, 404);

  // Client-key gate (Sentry-DSN model): always required. Apps predating the
  // key column have none until an admin generates one — their submissions
  // are rejected rather than silently open.
  const presented =
    c.req.header("X-Hands-Client-Key") ?? c.req.header("X-Quiver-Client-Key") ?? c.req.query("client_key") ?? "";
  if (!app.client_key || presented !== app.client_key) {
    return c.json({ error: "invalid or missing client key" }, 401);
  }

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
  const submissionIdRaw = String(form.get("submission_id") ?? "").trim() || null;
  if (submissionIdRaw && !SUBMISSION_ID_PATTERN.test(submissionIdRaw)) {
    return c.json({ error: "submission_id must be a UUID" }, 400);
  }
  const submissionId = submissionIdRaw?.toLowerCase() ?? null;

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

  // Direct SDK clients are rate-limited by client IP. A trusted server proxy
  // may instead provide a stable pseudonymous reporter id, but only while
  // authenticating with an app-scoped token whose sole effective permission is
  // feedback:write for this app. This
  // prevents public clients from rotating a spoofed forwarded identity to
  // bypass the IP bucket.
  const clientIp =
    (c.req.raw?.cf as { clientIp?: string } | undefined)?.clientIp ??
    c.req.header("cf-connecting-ip") ??
    "unknown";
  const reporterId = (c.req.header("X-Hands-Reporter-Id") ?? "").trim();
  let rateLimitHashInput = `feedback:${app.id}:${clientIp}`;
  let rateLimitPerHour = DIRECT_RATE_LIMIT_PER_HOUR;
  if (reporterId) {
    if (!REPORTER_ID_PATTERN.test(reporterId)) {
      return c.json({ error: "X-Hands-Reporter-Id must be a 16-200 character opaque base64url value" }, 400);
    }
    const authorization = c.req.header("authorization") ?? "";
    const bearerToken = authorization.startsWith("Bearer ")
      ? authorization.slice("Bearer ".length).trim()
      : "";
    const deployToken = await loadDeployToken(c.env, bearerToken);
    const effectivePermissions = deployToken
      ? resolveDeployTokenPermissions(deployToken)
      : new Set();
    if (
      !deployToken
      || deployToken.app_id !== app.id
      || deployToken.app_role !== null
      || effectivePermissions.size !== 1
      || !effectivePermissions.has("feedback:write")
    ) {
      return c.json({ error: "trusted reporter identity requires feedback:write permission for this app" }, 401);
    }
    rateLimitHashInput = `feedback:${app.id}:reporter:${reporterId}`;
    rateLimitPerHour = TRUSTED_REPORTER_RATE_LIMIT_PER_HOUR;
  }
  const clientIpHash = await sha256Hex(rateLimitHashInput);
  const oneHourAgo = Date.now() - 3600_000;
  // A cheap indexed lookup happens before attachment hashing/R2 HEAD work.
  // Only a known idempotency key may bypass the rate-limit count so a lost
  // response remains recoverable; a new key is rejected before expensive
  // attachment processing once the subject is over quota.
  const existingSubmission = submissionId
    ? await findFeedbackSubmission(c.env.DB, app.id, submissionId)
    : null;
  if (existingSubmission && existingSubmission.reporter_id !== (reporterId || null)) {
    return c.json({ error: "submission_id already used by a different reporter" }, 409);
  }
  if (!existingSubmission) {
    const recent = await c.env.DB.prepare(
      `SELECT COUNT(*) AS count, MIN(created_at) AS oldest_created_at FROM feedback_tickets
       WHERE app_id = ?1 AND client_ip_hash = ?2 AND created_at > ?3`,
    )
      .bind(app.id, clientIpHash, oneHourAgo)
      .first<{ count: number; oldest_created_at: number | null }>();
    if ((recent?.count ?? 0) >= rateLimitPerHour) {
      const retryAfter = Math.max(
        1,
        Math.ceil(((recent?.oldest_created_at ?? Date.now()) + 3600_000 - Date.now()) / 1000),
      );
      c.header("Retry-After", String(retryAfter));
      return c.json({ error: "too many feedback submissions; try again later" }, 429);
    }
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

  const attachmentRows: Array<{
    id: string;
    r2Key: string;
    filename: string;
    contentType: string | null;
    sizeBytes: number;
    inlineFile?: File;
    fingerprint: Record<string, unknown>;
  }> = [];
  for (const [index, file] of files.entries()) {
    const safeName = file.name.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120) || `attachment-${index}`;
    attachmentRows.push({
      id: crypto.randomUUID(),
      r2Key: "",
      filename: safeName,
      contentType: file.type || null,
      sizeBytes: file.size,
      inlineFile: file,
      fingerprint: {
        source: "inline",
        index,
        filename: safeName,
        content_type: file.type || null,
        size_bytes: file.size,
        sha256: await sha256BufferHex(await file.arrayBuffer()),
      },
    });
  }

  // Presigned attachments: already PUT directly to R2 by the client. We only
  // record them (namespace-guarded, existence-verified), never re-upload.
  const presignedRaw = form.get("presigned");
  if (typeof presignedRaw === "string" && presignedRaw.trim()) {
    let presigned: Array<{ r2_key?: string; filename?: string; content_type?: string; size?: number }>;
    try {
      const parsed = JSON.parse(presignedRaw);
      presigned = Array.isArray(parsed) ? parsed : [];
    } catch {
      return c.json({ error: "presigned must be a JSON array" }, 400);
    }
    for (const item of presigned) {
      if (attachmentRows.length >= MAX_ATTACHMENTS) {
        return c.json({ error: `too many attachments (max ${MAX_ATTACHMENTS})` }, 400);
      }
      const r2Key = String(item.r2_key ?? "");
      // Namespace guard: only this app's presigned prefix.
      if (!r2Key.startsWith(`feedback/${app.id}/presigned/`)) {
        return c.json({ error: "invalid presigned r2_key" }, 400);
      }
      const head = await c.env.APK_BUCKET.head(r2Key);
      if (!head) {
        return c.json({ error: `presigned upload not found: ${r2Key}` }, 400);
      }
      const filename =
        String(item.filename ?? "").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120) ||
        r2Key.split("/").pop() ||
        "attachment";
      attachmentRows.push({
        id: crypto.randomUUID(),
        r2Key,
        filename,
        contentType: (item.content_type ? String(item.content_type).slice(0, 100) : null),
        sizeBytes: head.size ?? (typeof item.size === "number" ? item.size : 0),
        fingerprint: {
          source: "presigned",
          index: attachmentRows.length,
          r2_key: r2Key,
          filename,
          content_type: item.content_type ? String(item.content_type).slice(0, 100) : null,
          size_bytes: head.size ?? (typeof item.size === "number" ? item.size : 0),
          etag: head.etag,
        },
      });
    }
  }

  const submissionFingerprint = submissionId
    ? await sha256Hex(stableJson({
        message,
        kind,
        contact,
        metadata,
        reporter_id: reporterId || null,
        attachments: attachmentRows.map((attachment) => attachment.fingerprint),
      }))
    : null;

  if (existingSubmission && submissionFingerprint) {
    if (existingSubmission.submission_fingerprint !== submissionFingerprint) {
      return c.json({ error: "submission_id already used with a different payload" }, 409);
    }
    return feedbackSubmitResponse(c, app, existingSubmission.id, 200, true);
  }

  // Crash tickets get a grouping signature from their exception class + top
  // app frame (populated by the SDK). Non-crash tickets have no signature.
  const signature =
    kind === "crash" ? crashSignature(metadata) : null;

  const now = Date.now();
  const ticketId = crypto.randomUUID();

  for (const [index, attachment] of attachmentRows.entries()) {
    if (!attachment.inlineFile) continue;
    attachment.r2Key = `feedback/${app.id}/${ticketId}/${index}-${attachment.filename}`;
    await c.env.APK_BUCKET.put(attachment.r2Key, await attachment.inlineFile.arrayBuffer(), {
      httpMetadata: { contentType: attachment.contentType || "application/octet-stream" },
    });
  }

  const statements = [
    c.env.DB.prepare(
      `INSERT INTO feedback_tickets
       (id, app_id, kind, status, message, contact, version_name, version_code,
        channel, device_id, device_model, os_version, arch, locale,
        metadata_json, client_ip_hash, signature, submission_id,
        submission_fingerprint, reporter_id, created_at, updated_at)
       VALUES (?1, ?2, ?3, 'open', ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21)`,
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
      signature,
      submissionId,
      submissionFingerprint,
      reporterId || null,
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
  const cleanupInlineUploads = () => Promise.allSettled(
    attachmentRows
      .filter((attachment) => attachment.inlineFile)
      .map((attachment) => c.env.APK_BUCKET.delete(attachment.r2Key)),
  );
  try {
    await c.env.DB.batch(statements);
  } catch (error) {
    if (submissionId && submissionFingerprint) {
      const existing = await findFeedbackSubmission(c.env.DB, app.id, submissionId);
      if (existing) {
        await cleanupInlineUploads();
        if (
          existing.reporter_id !== (reporterId || null)
          || existing.submission_fingerprint !== submissionFingerprint
        ) {
          return c.json({ error: "submission_id already used with a different payload" }, 409);
        }
        return feedbackSubmitResponse(c, app, existing.id, 200, true);
      }
    }
    await cleanupInlineUploads();
    throw error;
  }

  // Crash tickets: symbolicate in the background (retrace / native / OHOS / dSYM
  // lanes) and record the result on the ticket's symbolicated_stack /
  // symbolication_status fields. See dispatchSymbolication.
  if (kind === "crash") {
    const logKey = attachmentRows.length > 0 ? attachmentRows[0]!.r2Key : null;
    const run = () =>
      dispatchSymbolication(
        c.env,
        { id: app.id, platform: app.platform },
        ticketId,
        versionCode,
        metadata,
        logKey,
      );
    try {
      c.executionCtx.waitUntil(run());
    } catch {
      run().catch(() => {});
    }
  }

  // Crash alerting: fire webhooks when a signature is first seen or when it
  // spikes (10/50/100 tickets within an hour — fires once per tier as the
  // count crosses it, so no extra state table is needed).
  if (kind === "crash" && signature && app.org_id) {
    const orgId = app.org_id;
    const alert = async () => {
      const prior = await c.env.DB.prepare(
        `SELECT COUNT(*) AS n FROM feedback_tickets
         WHERE app_id = ?1 AND signature = ?2 AND id != ?3`,
      )
        .bind(app.id, signature, ticketId)
        .first<{ n: number }>();
      const base = {
        app_slug: app.slug,
        signature,
        ticket_id: ticketId,
        message: message.slice(0, 300),
        version_name: meta("version_name"),
        version_code: versionCode,
      };
      if ((prior?.n ?? 0) === 0) {
        await emitWebhookEvent(c.env.DB, {
          orgId,
          appId: app.id,
          event: "crash:new_group",
          body: base,
        });
        return;
      }
      const recent = await c.env.DB.prepare(
        `SELECT COUNT(*) AS n FROM feedback_tickets
         WHERE app_id = ?1 AND signature = ?2 AND created_at >= ?3`,
      )
        .bind(app.id, signature, now - 60 * 60 * 1000)
        .first<{ n: number }>();
      const hourCount = recent?.n ?? 0;
      if (hourCount === 10 || hourCount === 50 || hourCount === 100) {
        await emitWebhookEvent(c.env.DB, {
          orgId,
          appId: app.id,
          event: "crash:spike",
          body: { ...base, count_last_hour: hourCount },
        });
      }
    };
    const guarded = alert().catch(() => {
      // alerting must never fail the submission
    });
    try {
      c.executionCtx.waitUntil(guarded);
    } catch {
      await guarded;
    }
  }

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
        reporter_id: reporterId || null,
      },
    }).catch(() => {
      // webhook fan-out must never fail the submission
    });
  }

  return feedbackSubmitResponse(c, app, ticketId, 201, false);
}

async function findFeedbackSubmission(db: D1Database, appId: string, submissionId: string) {
  return db.prepare(
    `SELECT id, submission_fingerprint, reporter_id
     FROM feedback_tickets
     WHERE app_id = ?1 AND submission_id = ?2`,
  )
    .bind(appId, submissionId)
    .first<{
      id: string;
      submission_fingerprint: string | null;
      reporter_id: string | null;
    }>();
}

async function feedbackSubmitResponse(
  c: Context<{ Bindings: Env }>,
  app: FeedbackApp,
  ticketId: string,
  httpStatus: 200 | 201,
  idempotentReplay: boolean,
) {
  const ticket = await c.env.DB.prepare(
    `SELECT status, version_name, version_code
     FROM feedback_tickets
     WHERE app_id = ?1 AND id = ?2`,
  )
    .bind(app.id, ticketId)
    .first<{ status: string; version_name: string | null; version_code: number | null }>();
  if (!ticket) return c.json({ error: "feedback ticket not found" }, 500);

  const attachments = await c.env.DB.prepare(
    `SELECT filename
     FROM feedback_attachments
     WHERE ticket_id = ?1
     ORDER BY created_at, id`,
  )
    .bind(ticketId)
    .all<{ filename: string }>();
  const attachmentNames = attachments.results.map((attachment) => attachment.filename).filter(Boolean);
  const versionLabel = ticket.version_name
    ? ticket.version_code != null
      ? `${ticket.version_name} (${ticket.version_code})`
      : ticket.version_name
    : ticket.version_code != null
      ? String(ticket.version_code)
      : null;
  const referenceLine = [app.slug, versionLabel, `ticket ${ticketId}`]
    .filter(Boolean)
    .join(" · ");
  const reference = attachmentNames.length
    ? `${referenceLine}\nattachments:\n${attachmentNames.join("\n")}`
    : referenceLine;

  return c.json(
    {
      id: ticketId,
      status: ticket.status,
      attachments: attachmentNames.length,
      attachment_names: attachmentNames,
      reference,
      ticket_url: `${dashboardOrigin(c.env)}/apps/${app.id}/feedback/${ticketId}`,
      idempotent_replay: idempotentReplay,
    },
    httpStatus,
  );
}

function stableJson(value: unknown): string {
  const sort = (entry: unknown): unknown => {
    if (Array.isArray(entry)) return entry.map(sort);
    if (!entry || typeof entry !== "object") return entry;
    return Object.fromEntries(
      Object.entries(entry as Record<string, unknown>)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, child]) => [key, sort(child)]),
    );
  };
  return JSON.stringify(sort(value));
}

const MINIDUMP_MAX_BYTES = 64 * 1024 * 1024; // Crashpad dumps are usually < a few MB

/**
 * Electron/Crashpad crash ingest. Electron's built-in crashReporter POSTs a
 * multipart/form-data with the minidump under `upload_file_minidump` plus a
 * flat set of annotation fields (productName, version, and any `extra`/
 * `globalExtra` the SDK set). We store the dump as a crash-ticket attachment,
 * fold every annotation into metadata (product_type=electron), and fire the
 * minidump symbolication lane against the version's breakpad-symbols asset.
 *
 * Client-key gate: the SDK puts it in the submitURL query (`?client_key=`),
 * which Crashpad preserves, or an X-Quiver-Client-Key header.
 */
export async function handlePublicMinidumpSubmit(c: Context<{ Bindings: Env }>) {
  const slug = c.req.param("slug");
  if (!slug) return c.json({ error: "slug required" }, 400);
  const app = await c.env.DB.prepare(
    "SELECT id, org_id, slug, client_key FROM apps WHERE slug = ?1 AND archived = 0",
  )
    .bind(slug)
    .first<{ id: string; org_id: string | null; slug: string; client_key: string | null }>();
  if (!app) return c.json({ error: `app '${slug}' not found` }, 404);

  const presented =
    c.req.header("X-Hands-Client-Key") ?? c.req.header("X-Quiver-Client-Key") ?? c.req.query("client_key") ?? "";
  if (!app.client_key || presented !== app.client_key) {
    return c.json({ error: "invalid or missing client key" }, 401);
  }

  let form: FormData;
  try {
    form = await c.req.formData();
  } catch {
    return c.json({ error: "multipart/form-data body required" }, 400);
  }

  // Crashpad names the dump field `upload_file_minidump`; accept `minidump` too.
  const dumpEntry = form.get("upload_file_minidump") ?? form.get("minidump");
  if (dumpEntry === null || typeof dumpEntry === "string") {
    return c.json({ error: "missing minidump (upload_file_minidump)" }, 400);
  }
  const dump = dumpEntry as File;
  if (dump.size === 0) {
    return c.json({ error: "missing minidump (upload_file_minidump)" }, 400);
  }
  if (dump.size > MINIDUMP_MAX_BYTES) {
    return c.json({ error: `minidump too large (max ${MINIDUMP_MAX_BYTES} bytes)` }, 413);
  }

  // Every other string field is a Crashpad annotation → metadata. Map the
  // Sentry-electron-style well-known keys to ticket columns.
  const annotations: Record<string, string> = {};
  for (const [key, value] of form.entries()) {
    if (typeof value !== "string") continue;
    if (key === "upload_file_minidump" || key === "minidump") continue;
    annotations[key] = value.slice(0, 2000);
  }
  const pick = (...keys: string[]): string | null => {
    for (const k of keys) {
      const v = annotations[k];
      if (v !== undefined && v !== null && v !== "") return v;
    }
    return null;
  };

  const versionName = pick("version", "app_version", "appVersion", "version_name", "release");
  const versionCodeRaw = pick("version_code", "versionCode", "build");
  const versionCode =
    versionCodeRaw && /^\d+$/.test(versionCodeRaw) ? Math.trunc(Number(versionCodeRaw)) : null;
  const processType = pick("process_type", "ptype", "type"); // main / renderer / gpu / utility
  const metadata: Record<string, unknown> = {
    ...annotations,
    product_type: "electron",
    process_type: processType,
    crash_platform: pick("platform", "os") ?? "electron",
  };

  const clientIp =
    (c.req.raw?.cf as { clientIp?: string } | undefined)?.clientIp ??
    c.req.header("cf-connecting-ip") ??
    "unknown";
  const clientIpHash = await sha256Hex(`feedback:${app.id}:${clientIp}`);
  const recent = await c.env.DB.prepare(
    `SELECT COUNT(*) AS count FROM feedback_tickets
     WHERE app_id = ?1 AND client_ip_hash = ?2 AND created_at > ?3`,
  )
    .bind(app.id, clientIpHash, Date.now() - 3600_000)
    .first<{ count: number }>();
  if ((recent?.count ?? 0) >= DIRECT_RATE_LIMIT_PER_HOUR) {
    return c.json({ error: "too many crash reports; try again later" }, 429);
  }

  const now = Date.now();
  const ticketId = crypto.randomUUID();
  const dumpKey = `feedback/${app.id}/${ticketId}/minidump.dmp`;
  await c.env.APK_BUCKET.put(dumpKey, await dump.arrayBuffer(), {
    httpMetadata: { contentType: "application/x-minidump" },
  });

  const reasonBits = [processType, versionName].filter(Boolean).join(" · ");
  const message = `Electron crash${reasonBits ? ` (${reasonBits})` : ""}`;

  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO feedback_tickets
       (id, app_id, kind, status, message, contact, version_name, version_code,
        channel, device_id, device_model, os_version, arch, locale,
        metadata_json, client_ip_hash, signature, created_at, updated_at)
       VALUES (?1, ?2, 'crash', 'open', ?3, NULL, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, NULL, ?14, ?15)`,
    ).bind(
      ticketId,
      app.id,
      message,
      versionName,
      versionCode,
      pick("channel", "environment"),
      pick("device_id", "guid"),
      pick("device_model", "model"),
      pick("os_version", "os_release"),
      pick("arch", "cpu_arch"),
      (pick("locale") ?? "").slice(0, 40) || null,
      JSON.stringify(metadata),
      clientIpHash,
      now,
      now,
    ),
    c.env.DB.prepare(
      `INSERT INTO feedback_attachments
       (id, ticket_id, r2_key, filename, content_type, size_bytes, created_at)
       VALUES (?1, ?2, ?3, 'minidump.dmp', 'application/x-minidump', ?4, ?5)`,
    ).bind(crypto.randomUUID(), ticketId, dumpKey, dump.size, now),
  ]);

  // Symbolicate against the version's breakpad-symbols asset (background).
  const run = () => symbolicateMinidumpCrashTicket(c.env, app.id, ticketId, versionCode, dumpKey);
  try {
    c.executionCtx.waitUntil(run());
  } catch {
    run().catch(() => {});
  }

  if (app.org_id) {
    await emitWebhookEvent(c.env.DB, {
      orgId: app.org_id,
      appId: app.id,
      event: "feedback:new",
      body: {
        ticket_id: ticketId,
        app_slug: app.slug,
        kind: "crash",
        message,
        version_name: versionName,
        version_code: versionCode,
        attachments: 1,
        reporter_id: null,
      },
    }).catch(() => {});
  }

  // Crashpad only checks for a 2xx; a short id body is conventional.
  return c.json({ id: ticketId, status: "open" }, 201);
}

/** Signature = "<ExceptionClass>@<top app frame>", trimmed and bounded. */
function crashSignature(metadata: Record<string, unknown>): string | null {
  const exc = String(metadata["crash_exception_class"] ?? metadata["exception_class"] ?? "").trim();
  const frame = String(metadata["crash_top_frame"] ?? metadata["top_frame"] ?? "").trim();
  if (!exc && !frame) return null;
  // Strip source line numbers from the frame so the same crash groups across
  // builds: "a.b.C.m(File.kt:42)" -> "a.b.C.m".
  const normFrame = frame.replace(/\([^)]*\)/, "").trim();
  return `${exc || "UnknownException"}@${normFrame}`.slice(0, 300);
}

export type SymbolicationStatus =
  | "pending"
  | "symbolicated"
  | "no_symbols"
  | "unsymbolicated"
  | "failed"
  | "not_applicable";

// Higher rank wins when several lanes touch one ticket (e.g. an Android crash
// with both a Java stack and native frames): a real symbolicated stack must
// never be downgraded to "no_symbols".
const SYMBOLICATION_RANK: Record<SymbolicationStatus, number> = {
  pending: 0,
  not_applicable: 1,
  failed: 2,
  unsymbolicated: 3,
  no_symbols: 4,
  symbolicated: 5,
};

/** Clear a ticket's symbolication fields before a fresh run (ingest or re-run). */
export async function resetSymbolication(env: Env, ticketId: string): Promise<void> {
  const now = Date.now();
  await env.DB.prepare(
    `UPDATE feedback_tickets
     SET symbolication_status = 'pending', symbolicated_stack = NULL,
         symbolicated_at = ?1, updated_at = ?2
     WHERE id = ?3`,
  )
    .bind(now, now, ticketId)
    .run();
}

/**
 * Persist one lane's symbolication result on the ticket — the first-class
 * replacement for the old synthetic `quiver-symbolicate` comments (#136).
 * Appends the labeled block to `symbolicated_stack` (lanes run sequentially, so
 * this read-modify-write is race-free) and raises `symbolication_status` to the
 * best result seen so far.
 */
export async function appendSymbolication(
  env: Env,
  ticketId: string,
  label: string,
  status: SymbolicationStatus,
  text: string | null,
): Promise<void> {
  const now = Date.now();
  const row = await env.DB.prepare(
    "SELECT symbolicated_stack, symbolication_status FROM feedback_tickets WHERE id = ?1",
  )
    .bind(ticketId)
    .first<{ symbolicated_stack: string | null; symbolication_status: string | null }>();
  if (!row) return;
  const prev = (row.symbolication_status as SymbolicationStatus | null) ?? "pending";
  const nextStatus = SYMBOLICATION_RANK[status] >= SYMBOLICATION_RANK[prev] ? status : prev;
  let stack = row.symbolicated_stack;
  if (text && text.trim()) {
    const block = `[${label}]\n${text.trim()}`;
    stack = (stack ? `${stack}\n\n${block}` : block).slice(0, 40_000);
  }
  await env.DB.prepare(
    `UPDATE feedback_tickets
     SET symbolication_status = ?1, symbolicated_stack = ?2, symbolicated_at = ?3, updated_at = ?4
     WHERE id = ?5`,
  )
    .bind(nextStatus, stack, now, now, ticketId)
    .run();
}

/**
 * Best-effort deobfuscation: find the proguard-mapping build asset for the
 * crash's version_code, fetch the crash log, run the container retrace tool,
 * and append the result as an internal comment.
 */
export async function retraceCrashTicket(
  env: Env,
  appId: string,
  ticketId: string,
  versionCode: number | null,
  logR2Key: string,
): Promise<void> {
  try {
    if (versionCode === null) return;
    const mapping = await env.DB.prepare(
      `SELECT ba.r2_key FROM build_assets ba
       JOIN builds b ON b.id = ba.build_id
       WHERE b.app_id = ?1 AND b.version_code = ?2
         AND ba.artifact_kind = 'proguard-mapping'
       ORDER BY ba.created_at DESC LIMIT 1`,
    )
      .bind(appId, versionCode)
      .first<{ r2_key: string }>();
    if (!mapping) {
      await appendSymbolication(
        env,
        ticketId,
        "android-r8",
        "no_symbols",
        `No proguard-mapping asset for version_code ${versionCode}. ` +
          "Publish the build with its R8 mapping (hands builds publish-android --mapping).",
      );
      return;
    }

    const [mappingObj, logObj] = await Promise.all([
      env.APK_BUCKET.get(mapping.r2_key),
      env.APK_BUCKET.get(logR2Key),
    ]);
    if (!mappingObj || !logObj) return;
    const [mappingText, logText] = await Promise.all([
      mappingObj.text(),
      logObj.text(),
    ]);

    const { getRandom } = await import("@cloudflare/containers");
    const container = await getRandom(env.APK_PARSER, 1);
    const res = await container.fetch(
      new Request("http://container/retrace", {
        method: "POST",
        body: JSON.stringify({ mapping: mappingText, trace: logText }),
        headers: { "content-type": "application/json" },
      }),
    );
    if (!res.ok) return;
    const { retraced } = (await res.json()) as { retraced?: string };
    if (!retraced || !retraced.trim()) return;

    await appendSymbolication(
      env,
      ticketId,
      "android-r8",
      "symbolicated",
      retraced.trim().slice(0, 20_000),
    );
  } catch (err) {
    console.error(
      `[retrace] failed for ticket ${ticketId}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export interface NativeFrame {
  index: number;
  offset: string;
  soname: string;
  build_id?: string;
}

/**
 * SDK contract (symbolication matrix): metadata.crash_native_frames is a
 * JSON array (or already-parsed array) of
 * { index, offset, soname, build_id? }. Bounded and shape-checked here so a
 * hostile client can't feed junk to the container.
 */
export function parseNativeFrames(raw: unknown): NativeFrame[] {
  let value = raw;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(value)) return [];
  const frames: NativeFrame[] = [];
  for (const entry of value.slice(0, 256)) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const offset = String(e["offset"] ?? "").trim();
    const soname = String(e["soname"] ?? "").trim();
    if (!/^(0x)?[0-9a-fA-F]{1,16}$/.test(offset) || !soname) continue;
    const frame: NativeFrame = {
      index: Number.isFinite(Number(e["index"])) ? Number(e["index"]) : frames.length,
      offset,
      soname: soname.slice(0, 200),
    };
    const buildId = String(e["build_id"] ?? "").trim().toLowerCase();
    if (/^[0-9a-f]{8,64}$/.test(buildId)) frame.build_id = buildId;
    frames.push(frame);
  }
  return frames;
}

/**
 * Resolve native frames against the build's native-symbols archive via the
 * container's llvm-symbolizer endpoint and append the result as an internal
 * comment — same UX as the Java/R8 retrace flow. Missing artifact leaves an
 * operator-actionable comment naming the asset kind (matrix decision #6).
 */
export async function symbolicateNativeCrashTicket(
  env: Env,
  appId: string,
  ticketId: string,
  versionCode: number | null,
  frames: NativeFrame[],
  publishHint: string = "hands builds publish-android --symbols",
): Promise<void> {
  try {
    if (versionCode === null || frames.length === 0) return;

    const symbols = await env.DB.prepare(
      `SELECT ba.r2_key FROM build_assets ba
       JOIN builds b ON b.id = ba.build_id
       WHERE b.app_id = ?1 AND b.version_code = ?2
         AND ba.artifact_kind = 'native-symbols'
       ORDER BY ba.created_at DESC LIMIT 1`,
    )
      .bind(appId, versionCode)
      .first<{ r2_key: string }>();
    if (!symbols) {
      const ids = [...new Set(frames.map((f) => f.build_id).filter(Boolean))].join(", ");
      await appendSymbolication(
        env,
        ticketId,
        "native",
        "no_symbols",
        `No 'native-symbols' build asset for version_code ${versionCode}` +
          `${ids ? ` (crash BuildId: ${ids})` : ""}. ` +
          `Publish the build with its unstripped .so archive (${publishHint}).`,
      );
      return;
    }

    const zipObj = await env.APK_BUCKET.get(symbols.r2_key);
    if (!zipObj) return;
    const zipBytes = await zipObj.arrayBuffer();

    const { getRandom } = await import("@cloudflare/containers");
    const container = await getRandom(env.APK_PARSER, 1);
    const res = await container.fetch(
      new Request("http://container/symbolicate-native", {
        method: "POST",
        body: zipBytes,
        headers: {
          "content-type": "application/zip",
          "X-Quiver-Frames": JSON.stringify(frames),
        },
      }),
    );
    if (!res.ok) return;
    const parsed = (await res.json()) as {
      frames?: Array<{ index: number; resolved?: string; error?: string }>;
    };
    const resolved = parsed.frames ?? [];
    if (resolved.length === 0) return;

    const byIndex = new Map(resolved.map((f) => [f.index, f]));
    const lines = frames.map((f) => {
      const r = byIndex.get(f.index);
      const outcome = r?.resolved ?? (r?.error ? `?? (${r.error})` : "??");
      return `#${String(f.index).padStart(2, "0")} ${f.offset} ${f.soname} — ${outcome}`;
    });
    await appendSymbolication(
      env,
      ticketId,
      "native",
      "symbolicated",
      lines.join("\n").slice(0, 20_000),
    );
  } catch (err) {
    console.error(
      `[symbolicate] failed for ticket ${ticketId}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function ohosBasename(p: string): string {
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] ?? "";
}

/**
 * Parse OHOS/HarmonyOS native crash frames out of the fault log the OHOS SDK
 * (HandsFaultWatcher) uploads. That log embeds the hiAppEvent `exception`,
 * whose native backtrace shows up either as a debuggerd-style text stack
 * (`#00 pc <offset> <path>.so(sym+off)(BuildId: <id>)`) or as structured JSON
 * frames. Both are reduced to { index, offset, soname, build_id } — the exact
 * shape the native-symbols lane feeds llvm-symbolizer — so OHOS reuses the
 * Android native path unchanged (OHOS binaries are ARM64 ELF `.so`). The
 * `.so`-relative program counter (`pc`) is the address llvm-symbolizer needs;
 * a symbol-relative offset, when present, is display-only and ignored.
 */
export function parseOhosNativeFrames(logText: string): NativeFrame[] {
  if (!logText) return [];
  // hiAppEvent stacks often arrive JSON-stringified, so real newlines may be
  // escaped as a literal backslash-n. Normalise so a line scan sees one frame
  // per line and object regexes see clean field boundaries.
  const normalized = logText
    .replace(/\\r\\n|\\n|\\r/g, "\n")
    .replace(/\r\n/g, "\n");

  const frames: NativeFrame[] = [];
  const seen = new Set<number>();

  // Lane A — `#NN pc <off> <path>.so …` text backtrace. Covers both the
  // Kotlin/Native runtime form `… .so (0) [arm64-v8a::<buildid>]` (what our
  // KMP libshared.so emits — validated against the Kuikly/Bugly OHOS format)
  // and the HarmonyOS system cppcrash form `… .so(sym+off)(BuildId: <id>)`.
  const frameRe = /#0*(\d+)\s+pc\s+([0-9a-fA-F]{1,16})\s+(\S+?\.so(?:\.\d+)?)\b/i;
  // Build id appears in one of three forms across HarmonyOS backtrace sources:
  //   `(BuildId: <hex>)`        — labeled (some system cppcrash dumps)
  //   `.so(<hex>)`              — bare hex in parens after the lib (system
  //                               faultlogger fault-log file form)
  //   `[<arch>::<hex>]`         — Kotlin/Native runtime backtrace
  // (a `(symbol+offset)` group is not pure hex, so it never matches these.)
  const buildIdRes = [
    /\bBuildId:\s*([0-9a-fA-F]{8,64})/i,
    /\.so(?:\.\d+)?\(([0-9a-fA-F]{8,64})\)/i,
    /\[[^\]]*::([0-9a-fA-F]{8,64})\]/,
  ];
  for (const rawLine of normalized.split("\n")) {
    if (frames.length >= 256) break;
    const line = rawLine.trim();
    const m = frameRe.exec(line);
    if (!m) continue;
    const index = Number(m[1]);
    if (!Number.isFinite(index) || seen.has(index)) continue;
    const soname = ohosBasename(m[3]!);
    if (!soname) continue;
    const frame: NativeFrame = {
      index,
      offset: `0x${m[2]!.toLowerCase()}`,
      soname: soname.slice(0, 200),
    };
    for (const re of buildIdRes) {
      const bid = re.exec(line);
      if (bid) {
        frame.build_id = bid[1]!.toLowerCase();
        break;
      }
    }
    frames.push(frame);
    seen.add(index);
  }
  if (frames.length > 0) return frames;

  // Lane B — structured JSON frames: `"frames":[{"file":"…​.so","pc":"…"}]`.
  // Map file->soname and the .so-relative pc (falling back to offset) into our
  // shape. Field mapping validated against a real device sample (task #95).
  const objRe = /\{[^{}]*?"file"\s*:\s*"([^"]*?\.so)"[^{}]*?\}/gi;
  let om: RegExpExecArray | null;
  let autoIndex = 0;
  while ((om = objRe.exec(normalized)) !== null) {
    if (frames.length >= 256) break;
    const obj = om[0];
    const soname = ohosBasename(om[1]!);
    if (!soname) continue;
    const pcM = /"pc"\s*:\s*"?(?:0x)?([0-9a-fA-F]{1,16})"?/i.exec(obj);
    const offM = /"offset"\s*:\s*"?(?:0x)?([0-9a-fA-F]{1,16})"?/i.exec(obj);
    const hex = pcM ? pcM[1]! : offM ? offM[1]! : "";
    if (!hex) continue;
    const idxM = /"index"\s*:\s*(\d+)/i.exec(obj);
    const index = idxM ? Number(idxM[1]) : autoIndex;
    const frame: NativeFrame = {
      index,
      offset: `0x${hex.toLowerCase()}`,
      soname: soname.slice(0, 200),
    };
    const bidM = /"[bB]uild[_]?[iI]d"\s*:\s*"([0-9a-fA-F]{8,64})"/.exec(obj);
    if (bidM) frame.build_id = bidM[1]!.toLowerCase();
    frames.push(frame);
    autoIndex++;
  }
  return frames;
}

/**
 * OHOS native crash symbolication (server side, task #95). Reads the uploaded
 * HarmonyOS fault log, extracts native frames, and hands them to the shared
 * native-symbols lane — no OHOS-specific container work, since OHOS binaries
 * are ARM64 ELF `.so` (same tooling as Android native). The `native-symbols`
 * archive is what `publish-ohos --symbols` uploads.
 */
export async function symbolicateOhosCrashTicket(
  env: Env,
  appId: string,
  ticketId: string,
  versionCode: number | null,
  logR2Key: string,
): Promise<void> {
  try {
    if (versionCode === null) return;
    const logObj = await env.APK_BUCKET.get(logR2Key);
    if (!logObj) return;
    const logText = await logObj.text();
    // Only act on OHOS fault logs (HandsFaultWatcher writes this signature on
    // the first line); ignore anything else routed here.
    if (!logText.includes("Hands OHOS fault log")) return;
    const frames = parseOhosNativeFrames(logText);
    if (frames.length === 0) return;
    await symbolicateNativeCrashTicket(
      env,
      appId,
      ticketId,
      versionCode,
      frames,
      "hands builds publish-ohos --symbols",
    );
  } catch (err) {
    console.error(
      `[symbolicate-ohos] failed for ticket ${ticketId}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export interface DsymImage {
  uuid: string;
  load_address: bigint;
  end_address: bigint;
  name: string;
}

export interface DsymFrame {
  index: number;
  address: bigint;
}

function parseHexBig(v: unknown): bigint | null {
  if (typeof v !== "string" && typeof v !== "number") return null;
  const s = String(v).trim();
  if (!s) return null;
  try {
    if (s.startsWith("0x") || s.startsWith("0X")) return BigInt(s);
    if (/^\d+$/.test(s)) return BigInt(s);
    if (/^[0-9a-fA-F]+$/.test(s)) return BigInt("0x" + s);
    return null;
  } catch {
    return null;
  }
}

/**
 * SDK contract (symbolication matrix, iOS lane): metadata.crash_binary_images
 * is a JSON array of { uuid, load_address, base_address, end_address, slide,
 * path, name }. load_address / end_address are RUNTIME addresses (already
 * include the ASLR slide), so a frame address inside [load, end] maps to that
 * image and its file offset is `address - load_address`.
 */
export function parseBinaryImages(raw: unknown): DsymImage[] {
  let value = raw;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(value)) return [];
  const out: DsymImage[] = [];
  for (const entry of value.slice(0, 512)) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const load = parseHexBig(e["load_address"]);
    if (load === null) continue;
    const end = parseHexBig(e["end_address"]) ?? load;
    const pathName =
      typeof e["path"] === "string" ? (e["path"] as string).split("/").pop() ?? "" : "";
    const name = String(e["name"] ?? pathName ?? "").trim();
    if (!name) continue;
    out.push({ uuid: String(e["uuid"] ?? "").trim(), load_address: load, end_address: end, name });
  }
  return out;
}

/**
 * metadata.crash_frames is a JSON array of { index, address } where address is
 * the RUNTIME instruction address (post-slide). Bounded and shape-checked.
 */
export function parseCrashFrames(raw: unknown): DsymFrame[] {
  let value = raw;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(value)) return [];
  const out: DsymFrame[] = [];
  for (const entry of value.slice(0, 256)) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const address = parseHexBig(e["address"]);
    const index = typeof e["index"] === "number" ? e["index"] : Number(e["index"]);
    if (address === null || !Number.isFinite(index)) continue;
    out.push({ index, address });
  }
  return out;
}

/**
 * Resolve iOS crash frames against the build's dSYM asset via the container's
 * llvm-symbolizer endpoint and append the result as an internal comment —
 * mirrors symbolicateNativeCrashTicket. Missing dSYM leaves an
 * operator-actionable comment.
 */
export async function symbolicateDsymCrashTicket(
  env: Env,
  appId: string,
  ticketId: string,
  versionCode: number | null,
  images: DsymImage[],
  frames: DsymFrame[],
): Promise<void> {
  try {
    if (versionCode === null || frames.length === 0 || images.length === 0) return;

    // Map each frame to its containing image → { index, offset(hex), image }.
    const containerFrames: Array<{ index: number; offset: string; image: string }> = [];
    for (const f of frames) {
      const img =
        images.find((i) => f.address >= i.load_address && f.address <= i.end_address) ?? images[0];
      if (!img) continue;
      const offset = f.address - img.load_address;
      if (offset < 0n) continue;
      containerFrames.push({
        index: f.index,
        offset: "0x" + offset.toString(16),
        image: img.name,
      });
    }
    if (containerFrames.length === 0) return;

    const dsym = await env.DB.prepare(
      `SELECT ba.r2_key FROM build_assets ba
       JOIN builds b ON b.id = ba.build_id
       WHERE b.app_id = ?1 AND b.version_code = ?2
         AND ba.artifact_kind = 'dsym'
       ORDER BY ba.created_at DESC LIMIT 1`,
    )
      .bind(appId, versionCode)
      .first<{ r2_key: string }>();
    if (!dsym) {
      const uuids = [...new Set(images.map((i) => i.uuid).filter(Boolean))].slice(0, 6).join(", ");
      await appendSymbolication(
        env,
        ticketId,
        "ios-dsym",
        "no_symbols",
        `No 'dsym' build asset for version_code ${versionCode}` +
          `${uuids ? ` (image UUIDs: ${uuids})` : ""}. ` +
          `Publish the build with its dSYM archive (hands builds publish-ios --dsym).`,
      );
      return;
    }

    const zipObj = await env.APK_BUCKET.get(dsym.r2_key);
    if (!zipObj) return;
    const zipBytes = await zipObj.arrayBuffer();

    const { getRandom } = await import("@cloudflare/containers");
    const container = await getRandom(env.APK_PARSER, 1);
    const res = await container.fetch(
      new Request("http://container/symbolicate-dsym", {
        method: "POST",
        body: zipBytes,
        headers: {
          "content-type": "application/zip",
          "X-Quiver-Frames": JSON.stringify(containerFrames),
        },
      }),
    );
    if (!res.ok) return;
    const parsed = (await res.json()) as {
      frames?: Array<{ index: number; resolved?: string; error?: string }>;
    };
    const resolved = parsed.frames ?? [];
    if (resolved.length === 0) return;

    const byIndex = new Map(resolved.map((f) => [f.index, f]));
    const lines = containerFrames.map((cf) => {
      const r = byIndex.get(cf.index);
      const outcome = r?.resolved ?? (r?.error ? `?? (${r.error})` : "??");
      return `#${String(cf.index).padStart(2, "0")} ${cf.image} ${cf.offset} — ${outcome}`;
    });
    await appendSymbolication(
      env,
      ticketId,
      "ios-dsym",
      "symbolicated",
      lines.join("\n").slice(0, 20_000),
    );
  } catch (err) {
    console.error(
      `[symbolicate-dsym] failed for ticket ${ticketId}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Resolve an Electron/Crashpad minidump against the version's breakpad-symbols
 * asset via the container's minidump-stackwalk lane and append the result as an
 * internal comment — mirrors the native/dSYM symbolication flows. Missing
 * symbols leaves an operator-actionable comment.
 */
export async function symbolicateMinidumpCrashTicket(
  env: Env,
  appId: string,
  ticketId: string,
  versionCode: number | null,
  minidumpR2Key: string,
): Promise<void> {
  try {
    const dumpObj = await env.APK_BUCKET.get(minidumpR2Key);
    if (!dumpObj) return;
    const dumpBytes = await dumpObj.arrayBuffer();

    // breakpad-symbols asset for this version (optional — stackwalk still
    // returns module+offset frames without it, which is worth posting).
    let symBytes: ArrayBuffer | null = null;
    if (versionCode !== null) {
      const sym = await env.DB.prepare(
        `SELECT ba.r2_key FROM build_assets ba
         JOIN builds b ON b.id = ba.build_id
         WHERE b.app_id = ?1 AND b.version_code = ?2
           AND ba.artifact_kind = 'breakpad-symbols'
         ORDER BY ba.created_at DESC LIMIT 1`,
      )
        .bind(appId, versionCode)
        .first<{ r2_key: string }>();
      if (sym) {
        const symObj = await env.APK_BUCKET.get(sym.r2_key);
        if (symObj) symBytes = await symObj.arrayBuffer();
      }
    }

    const form = new FormData();
    form.append("minidump", new Blob([dumpBytes], { type: "application/x-minidump" }), "crash.dmp");
    if (symBytes) {
      form.append("symbols", new Blob([symBytes], { type: "application/zip" }), "symbols.zip");
    }

    const { getRandom } = await import("@cloudflare/containers");
    const container = await getRandom(env.APK_PARSER, 1);
    const res = await container.fetch(
      new Request("http://container/symbolicate-minidump", { method: "POST", body: form }),
    );
    if (!res.ok) return;
    const parsed = (await res.json()) as {
      crash_reason?: string | null;
      crash_address?: string | null;
      symbol_modules?: number;
      stack_text?: string;
      frames?: unknown[];
    };
    const stack = (parsed.stack_text ?? "").trim();
    if (!stack) return;

    const header =
      `Symbolicated Electron crash (minidump-stackwalk` +
      `${symBytes ? "" : ", no breakpad-symbols asset — module+offset only"}):` +
      `${parsed.crash_reason ? `\nReason: ${parsed.crash_reason}${parsed.crash_address ? ` @ ${parsed.crash_address}` : ""}` : ""}`;
    const tip =
      !symBytes && versionCode !== null
        ? `\n\nTip: upload the version's Breakpad symbols (dump_syms → hands builds ` +
          `publish-electron --symbols) for version_code ${versionCode} to get ` +
          `function/file:line resolution instead of raw module+offset.`
        : "";
    await appendSymbolication(
      env,
      ticketId,
      "electron-minidump",
      "symbolicated",
      `${header}\n\n${stack}${tip}`.slice(0, 20_000),
    );
  } catch (err) {
    console.error(
      `[symbolicate-minidump] failed for ticket ${ticketId}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Run every applicable symbolication lane for a crash ticket sequentially and
 * persist the result on the ticket (symbolicated_stack / symbolication_status).
 * Used both on crash ingest and by the on-demand re-run endpoint. Lanes run
 * sequentially so their appends to the single field don't race; status settles
 * to a terminal value so it never stays "pending".
 */
export async function dispatchSymbolication(
  env: Env,
  app: { id: string; platform?: string | null },
  ticketId: string,
  versionCode: number | null,
  metadata: Record<string, unknown>,
  logKey: string | null,
): Promise<void> {
  await resetSymbolication(env, ticketId);
  // Lane applicability is platform-first: content presence alone (a crash log
  // attachment, structured frames) must never select another platform's lane —
  // an iOS crash txt used to satisfy the log-attachment gate and fall into
  // android-r8, reporting a missing ProGuard mapping on an iOS ticket. A null
  // platform (legacy app rows) keeps the content-based behavior.
  const platform = app.platform ?? null;
  let ran = false;

  if (logKey && (platform === null || platform === "android")) {
    ran = true;
    await retraceCrashTicket(env, app.id, ticketId, versionCode, logKey);
  }
  const nativeFrames = parseNativeFrames(metadata["crash_native_frames"]);
  if (
    nativeFrames.length > 0 &&
    (platform === null || platform === "android" || platform === "ohos")
  ) {
    ran = true;
    await symbolicateNativeCrashTicket(env, app.id, ticketId, versionCode, nativeFrames);
  }
  if (platform === "ohos" && logKey) {
    ran = true;
    await symbolicateOhosCrashTicket(env, app.id, ticketId, versionCode, logKey);
  }
  const dsymImages = parseBinaryImages(metadata["crash_binary_images"]);
  const dsymFrames = parseCrashFrames(metadata["crash_frames"]);
  if (
    dsymImages.length > 0 &&
    dsymFrames.length > 0 &&
    (platform === null || platform === "ios")
  ) {
    ran = true;
    await symbolicateDsymCrashTicket(env, app.id, ticketId, versionCode, dsymImages, dsymFrames);
  } else if (platform === "ios" && logKey) {
    // iOS crash without the SDK's structured frame metadata: report the iOS
    // gap instead of settling on a silent not_applicable.
    ran = true;
    await appendSymbolication(
      env,
      ticketId,
      "ios-dsym",
      "no_symbols",
      "Crash report has no structured frame metadata (crash_binary_images / " +
        "crash_frames), so server-side dSYM symbolication cannot run. Update " +
        "the Hands iOS SDK to include them, and publish builds with their " +
        "dSYM archive (hands builds publish-ios --dsym).",
    );
  }

  const row = await env.DB.prepare(
    "SELECT symbolication_status FROM feedback_tickets WHERE id = ?1",
  )
    .bind(ticketId)
    .first<{ symbolication_status: string | null }>();
  if (!row) return;
  if (!ran) {
    await env.DB.prepare(
      "UPDATE feedback_tickets SET symbolication_status = 'not_applicable', symbolicated_at = ?1 WHERE id = ?2",
    )
      .bind(Date.now(), ticketId)
      .run();
  } else if (row.symbolication_status === "pending") {
    await env.DB.prepare(
      "UPDATE feedback_tickets SET symbolication_status = 'unsymbolicated', symbolicated_at = ?1 WHERE id = ?2",
    )
      .bind(Date.now(), ticketId)
      .run();
  }
}

export async function handleListCrashGroups(c: AdminContext) {
  const appId = c.req.param("appId");
  const { results } = await c.env.DB.prepare(
    `SELECT
       COALESCE(signature, '(unsignatured)') AS signature,
       COUNT(*) AS count,
       COUNT(DISTINCT device_id) AS device_count,
       MIN(created_at) AS first_seen,
       MAX(created_at) AS last_seen,
       GROUP_CONCAT(DISTINCT version_name) AS versions,
       SUM(CASE WHEN status IN ('open','in_progress') THEN 1 ELSE 0 END) AS open_count
     FROM feedback_tickets
     WHERE app_id = ?1 AND kind = 'crash'
     GROUP BY COALESCE(signature, '(unsignatured)')
     ORDER BY count DESC, last_seen DESC
     LIMIT 200`,
  )
    .bind(appId)
    .all();
  return c.json({ groups: results });
}

/** Daily ticket counts (30 days, by kind) + crash counts by version. */
export async function handleFeedbackStats(c: AdminContext) {
  const appId = c.req.param("appId");
  const since = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const [daily, byVersion] = await Promise.all([
    c.env.DB.prepare(
      `SELECT strftime('%Y-%m-%d', created_at / 1000, 'unixepoch') AS day,
              kind, COUNT(*) AS n
       FROM feedback_tickets
       WHERE app_id = ?1 AND created_at >= ?2
       GROUP BY day, kind
       ORDER BY day ASC`,
    )
      .bind(appId, since)
      .all<{ day: string; kind: string; n: number }>(),
    c.env.DB.prepare(
      `SELECT COALESCE(version_name, 'unknown') AS version_name,
              version_code, COUNT(*) AS n
       FROM feedback_tickets
       WHERE app_id = ?1 AND kind = 'crash'
       GROUP BY COALESCE(version_name, 'unknown'), version_code
       ORDER BY COALESCE(version_code, 0) DESC
       LIMIT 12`,
    )
      .bind(appId)
      .all<{ version_name: string; version_code: number | null; n: number }>(),
  ]);
  return c.json({ daily: daily.results, crashes_by_version: byVersion.results });
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
  if (kind) {
    const kinds = kind
      .split(",")
      .filter((k) => (TICKET_KINDS as readonly string[]).includes(k));
    if (kinds.length > 0) {
      const inList = kinds
        .map((k) => {
          binds.push(k);
          return `?${binds.length}`;
        })
        .join(", ");
      where += ` AND kind IN (${inList})`;
    }
  }
  const deviceId = c.req.query("device_id");
  if (deviceId) {
    binds.push(deviceId);
    where += ` AND device_id = ?${binds.length}`;
  }
  const versionCodeFilter = c.req.query("version_code");
  if (versionCodeFilter && /^\d+$/.test(versionCodeFilter)) {
    binds.push(Number(versionCodeFilter));
    where += ` AND version_code = ?${binds.length}`;
  }
  const signatureFilter = c.req.query("signature");
  if (signatureFilter) {
    binds.push(signatureFilter);
    where += ` AND signature = ?${binds.length}`;
  }
  const { results } = await c.env.DB.prepare(
    `SELECT t.id, t.kind, t.status, t.assignee, t.message, t.contact, t.version_name,
            t.version_code, t.channel, t.device_id, t.device_model, t.os_version,
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

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

type TicketResolution =
  | { id: string }
  | { error: "not_found" }
  | { error: "ambiguous"; count: number };

/**
 * Resolve a ticket id that may be a full UUID or a short **prefix** (e.g. the
 * 8-char id historically surfaced in references/UI). A full UUID takes the
 * exact-match fast path; anything else is matched as `id LIKE prefix%` within
 * the app and must hit exactly one ticket — 0 ⇒ not found, >1 ⇒ ambiguous.
 * This lets agents query with whatever id they copied without a manual expand.
 */
async function resolveTicketId(
  db: D1Database,
  appId: string | undefined,
  ticketId: string | undefined,
): Promise<TicketResolution> {
  if (!appId) return { error: "not_found" };
  const raw = (ticketId ?? "").trim();
  if (UUID_RE.test(raw)) {
    const row = await db
      .prepare("SELECT id FROM feedback_tickets WHERE app_id = ?1 AND id = ?2")
      .bind(appId, raw.toLowerCase())
      .first<{ id: string }>();
    return row ? { id: row.id } : { error: "not_found" };
  }
  // Prefix mode: require a reasonably specific, id-shaped prefix.
  if (raw.length < 4 || !/^[0-9a-fA-F-]+$/.test(raw)) return { error: "not_found" };
  const { results } = await db
    .prepare("SELECT id FROM feedback_tickets WHERE app_id = ?1 AND id LIKE ?2 ORDER BY id LIMIT 6")
    .bind(appId, raw.toLowerCase() + "%")
    .all<{ id: string }>();
  if (results.length === 0) return { error: "not_found" };
  if (results.length > 1) return { error: "ambiguous", count: results.length };
  return { id: results[0]!.id };
}

/** Map a failed ticket resolution to a JSON response. */
function ticketResolveError(c: AdminContext, r: { error: "not_found" } | { error: "ambiguous"; count: number }) {
  if (r.error === "ambiguous") {
    return c.json(
      { error: `ticket id prefix matches ${r.count} tickets; use the full UUID` },
      409,
    );
  }
  return c.json({ error: "ticket not found" }, 404);
}

export async function handleGetFeedback(c: AdminContext) {
  const appId = c.req.param("appId");
  const resolved = await resolveTicketId(c.env.DB, appId, c.req.param("ticketId"));
  if ("error" in resolved) return ticketResolveError(c, resolved);
  const ticketId = resolved.id;
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

/**
 * On-demand (re-)symbolication of a crash ticket — powers the detail panel's
 * one-click "Symbolicate / Re-run" button (#136). Reconstructs the crash frames
 * from the stored metadata + log attachment and runs dispatchSymbolication
 * synchronously, then returns the fresh symbolication fields.
 */
export async function handleResymbolicateFeedback(c: AdminContext) {
  const appId = c.req.param("appId");
  const resolved = await resolveTicketId(c.env.DB, appId, c.req.param("ticketId"));
  if ("error" in resolved) return ticketResolveError(c, resolved);
  const ticketId = resolved.id;
  const ticket = await c.env.DB.prepare(
    "SELECT id, kind, version_code, metadata_json FROM feedback_tickets WHERE app_id = ?1 AND id = ?2",
  )
    .bind(appId, ticketId)
    .first<{ id: string; kind: string; version_code: number | null; metadata_json: string }>();
  if (!ticket) return c.json({ error: "ticket not found" }, 404);
  if (ticket.kind !== "crash") {
    return c.json({ error: "only crash tickets can be symbolicated" }, 400);
  }
  const app = await c.env.DB.prepare("SELECT id, platform FROM apps WHERE id = ?1")
    .bind(appId)
    .first<{ id: string; platform: string | null }>();
  if (!app) return c.json({ error: "app not found" }, 404);

  let metadata: Record<string, unknown> = {};
  try {
    metadata = JSON.parse(ticket.metadata_json || "{}") as Record<string, unknown>;
  } catch {
    metadata = {};
  }
  const logRow = await c.env.DB.prepare(
    "SELECT r2_key FROM feedback_attachments WHERE ticket_id = ?1 ORDER BY created_at LIMIT 1",
  )
    .bind(ticketId)
    .first<{ r2_key: string }>();

  await dispatchSymbolication(
    c.env,
    { id: app.id, platform: app.platform },
    ticketId,
    ticket.version_code,
    metadata,
    logRow?.r2_key ?? null,
  );

  const updated = await c.env.DB.prepare(
    "SELECT symbolication_status, symbolicated_stack, symbolicated_at FROM feedback_tickets WHERE id = ?1",
  )
    .bind(ticketId)
    .first<{
      symbolication_status: string | null;
      symbolicated_stack: string | null;
      symbolicated_at: number | null;
    }>();
  return c.json({ id: ticketId, ...(updated ?? {}) });
}

export async function handleUpdateFeedback(c: AdminContext) {
  const appId = c.req.param("appId");
  const resolved = await resolveTicketId(c.env.DB, appId, c.req.param("ticketId"));
  if ("error" in resolved) return ticketResolveError(c, resolved);
  const ticketId = resolved.id;
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
  const resolved = await resolveTicketId(c.env.DB, appId, c.req.param("ticketId"));
  if ("error" in resolved) return ticketResolveError(c, resolved);
  const ticketId = resolved.id;
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
  const resolved = await resolveTicketId(c.env.DB, appId, c.req.param("ticketId"));
  if ("error" in resolved) return ticketResolveError(c, resolved);
  const ticketId = resolved.id;
  const attachmentId = c.req.param("attachmentId");
  const row = await c.env.DB.prepare(
    `SELECT fa.r2_key, fa.filename, fa.content_type, fa.size_bytes
     FROM feedback_attachments fa
     JOIN feedback_tickets t ON t.id = fa.ticket_id
     WHERE t.app_id = ?1 AND t.id = ?2 AND fa.id = ?3`,
  )
    .bind(appId, ticketId, attachmentId)
    .first<{ r2_key: string; filename: string; content_type: string | null; size_bytes: number | null }>();
  if (!row) return c.json({ error: "attachment not found" }, 404);
  // ?presign=1 — return a short-lived signed URL instead of streaming bytes.
  // Agent transports (e.g. `raft integration invoke`) UTF-8-decode response
  // bodies and corrupt binaries; a URL survives any JSON channel and the
  // agent downloads the raw bytes itself.
  if (c.req.query("presign") === "1") {
    const ttl = Math.max(
      60,
      Math.min(Number(c.env.R2_PRESIGNED_DOWNLOAD_TTL_SECONDS ?? "3600"), 24 * 3600),
    );
    const downloadUrl = await generateSignedR2Url(
      c.env,
      row.r2_key,
      ttl,
      requestOrigin(c),
    );
    return c.json({
      download_url: downloadUrl,
      expires_in: ttl,
      filename: row.filename,
      content_type: row.content_type ?? "application/octet-stream",
      size_bytes: row.size_bytes,
    });
  }
  const object = await c.env.APK_BUCKET.get(row.r2_key);
  if (!object) return c.json({ error: "attachment blob missing" }, 404);
  const contentType = row.content_type ?? "application/octet-stream";
  // Serve images inline (for the ticket UI's thumbnails/lightbox) when asked;
  // everything else, and the default, downloads as an attachment.
  const inline = c.req.query("inline") === "1" && contentType.startsWith("image/");
  return new Response(object.body, {
    headers: {
      "content-type": contentType,
      "content-disposition": inline
        ? `inline; filename="${row.filename}"`
        : `attachment; filename="${row.filename}"`,
      "cache-control": "private, max-age=300",
    },
  });
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function sha256BufferHex(input: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", input);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
