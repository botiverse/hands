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

type AdminContext = Context<AdminEnv & { Bindings: Env }>;

const MAX_ATTACHMENTS = 9;
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024; // inline multipart cap (through the Worker)
const MAX_PRESIGNED_BYTES = 200 * 1024 * 1024; // direct-to-R2 cap
const PRESIGN_TTL_SECONDS = 900;
const MAX_MESSAGE_CHARS = 10_000;
const RATE_LIMIT_PER_HOUR = 10;

const TICKET_STATUSES = ["open", "in_progress", "resolved", "closed"] as const;
const TICKET_KINDS = ["feedback", "bug", "crash"] as const;

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
    "SELECT id, org_id, slug, client_key FROM apps WHERE slug = ?1 AND archived = 0",
  )
    .bind(slug)
    .first<{ id: string; org_id: string | null; slug: string; client_key: string | null }>();
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

  // Crash tickets get a grouping signature from their exception class + top
  // app frame (populated by the SDK). Non-crash tickets have no signature.
  const signature =
    kind === "crash" ? crashSignature(metadata) : null;

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
      });
    }
  }

  const statements = [
    c.env.DB.prepare(
      `INSERT INTO feedback_tickets
       (id, app_id, kind, status, message, contact, version_name, version_code,
        channel, device_id, device_model, os_version, arch, locale,
        metadata_json, client_ip_hash, signature, created_at, updated_at)
       VALUES (?1, ?2, ?3, 'open', ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18)`,
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

  // Crash tickets: deobfuscate the stack in the background using the
  // proguard-mapping asset stored for this version_code.
  if (kind === "crash" && attachmentRows.length > 0) {
    const logKey = attachmentRows[0]!.r2Key;
    const run = () => retraceCrashTicket(c.env, app.id, ticketId, versionCode, logKey);
    try {
      c.executionCtx.waitUntil(run());
    } catch {
      run().catch(() => {});
    }
  }

  // Native crashes: symbolicate frames against the native-symbols asset.
  const nativeFrames = parseNativeFrames(metadata["crash_native_frames"]);
  if (kind === "crash" && nativeFrames.length > 0) {
    const run = () =>
      symbolicateNativeCrashTicket(c.env, app.id, ticketId, versionCode, nativeFrames);
    try {
      c.executionCtx.waitUntil(run());
    } catch {
      run().catch(() => {});
    }
  }

  // iOS crashes: symbolicate frames against the dSYM asset.
  const dsymImages = parseBinaryImages(metadata["crash_binary_images"]);
  const dsymFrames = parseCrashFrames(metadata["crash_frames"]);
  if (kind === "crash" && dsymImages.length > 0 && dsymFrames.length > 0) {
    const run = () =>
      symbolicateDsymCrashTicket(c.env, app.id, ticketId, versionCode, dsymImages, dsymFrames);
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
      },
    }).catch(() => {
      // webhook fan-out must never fail the submission
    });
  }

  // A ready-to-copy reference so a pasted ticket can be located by an agent:
  // slug + version + full id, plus a direct admin link. Keep the full UUID
  // here because detail/attachment API routes require it.
  const versionName = meta("version_name");
  const versionLabel = versionName
    ? versionCode != null
      ? `${versionName} (${versionCode})`
      : versionName
    : versionCode != null
      ? String(versionCode)
      : null;
  let ticketUrl: string | null = null;
  try {
    ticketUrl = `${new URL(c.req.url).origin}/apps/${app.id}/feedback/${ticketId}`;
  } catch {
    ticketUrl = null;
  }
  const reference = [app.slug, versionLabel, `ticket ${ticketId}`]
    .filter(Boolean)
    .join(" · ");

  return c.json(
    {
      id: ticketId,
      status: "open",
      attachments: attachmentRows.length,
      reference,
      ticket_url: ticketUrl,
    },
    201,
  );
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
  if ((recent?.count ?? 0) >= RATE_LIMIT_PER_HOUR) {
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
    if (!mapping) return;

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

    const body =
      "Deobfuscated stack trace (auto-retraced from build mapping):\n\n" +
      retraced.trim().slice(0, 20_000);
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO feedback_comments (id, ticket_id, author_actor, body, internal, created_at)
         VALUES (?1, ?2, 'quiver-retrace', ?3, 1, ?4)`,
      ).bind(crypto.randomUUID(), ticketId, body, Date.now()),
      env.DB.prepare("UPDATE feedback_tickets SET updated_at = ?1 WHERE id = ?2").bind(
        Date.now(),
        ticketId,
      ),
    ]);
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
): Promise<void> {
  try {
    if (versionCode === null || frames.length === 0) return;
    const appendComment = async (body: string) => {
      await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO feedback_comments (id, ticket_id, author_actor, body, internal, created_at)
           VALUES (?1, ?2, 'quiver-symbolicate', ?3, 1, ?4)`,
        ).bind(crypto.randomUUID(), ticketId, body, Date.now()),
        env.DB.prepare("UPDATE feedback_tickets SET updated_at = ?1 WHERE id = ?2").bind(
          Date.now(),
          ticketId,
        ),
      ]);
    };

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
      await appendComment(
        `Native crash could not be symbolicated: no 'native-symbols' build asset ` +
          `for version_code ${versionCode}${ids ? ` (crash BuildId: ${ids})` : ""}. ` +
          `Publish the build with its unstripped .so archive (quiver builds publish-android --symbols).`,
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
    await appendComment(
      "Symbolicated native stack (auto-resolved from native-symbols):\n\n" +
        lines.join("\n").slice(0, 20_000),
    );
  } catch (err) {
    console.error(
      `[symbolicate] failed for ticket ${ticketId}: ${err instanceof Error ? err.message : String(err)}`,
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
    const appendComment = async (body: string) => {
      await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO feedback_comments (id, ticket_id, author_actor, body, internal, created_at)
           VALUES (?1, ?2, 'quiver-symbolicate', ?3, 1, ?4)`,
        ).bind(crypto.randomUUID(), ticketId, body, Date.now()),
        env.DB.prepare("UPDATE feedback_tickets SET updated_at = ?1 WHERE id = ?2").bind(
          Date.now(),
          ticketId,
        ),
      ]);
    };

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
      await appendComment(
        `iOS crash could not be symbolicated: no 'dsym' build asset for ` +
          `version_code ${versionCode}${uuids ? ` (image UUIDs: ${uuids})` : ""}. ` +
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
    await appendComment(
      "Symbolicated iOS stack (auto-resolved from dSYM):\n\n" +
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
    const appendComment = async (body: string) => {
      await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO feedback_comments (id, ticket_id, author_actor, body, internal, created_at)
           VALUES (?1, ?2, 'quiver-symbolicate', ?3, 1, ?4)`,
        ).bind(crypto.randomUUID(), ticketId, body, Date.now()),
        env.DB.prepare("UPDATE feedback_tickets SET updated_at = ?1 WHERE id = ?2").bind(
          Date.now(),
          ticketId,
        ),
      ]);
    };

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
    await appendComment(`${header}\n\n${stack}`.slice(0, 20_000));

    if (!symBytes && versionCode !== null) {
      await appendComment(
        `Tip: upload the version's Breakpad symbols (dump_syms → quiver builds ` +
          `publish-electron --symbols) for version_code ${versionCode} to get ` +
          `function/file:line resolution instead of raw module+offset.`,
      );
    }
  } catch (err) {
    console.error(
      `[symbolicate-minidump] failed for ticket ${ticketId}: ${err instanceof Error ? err.message : String(err)}`,
    );
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
