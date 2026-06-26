/**
 * /api/upload-apk — admin-only multipart upload endpoint.
 *
 * Receives a multipart/form-data POST with an APK file field. The Worker:
 *   1. Validates auth (via authMiddleware on the admin route).
 *   2. Validates size (≤ MAX_APK_SIZE_MB).
 *   3. Stores the APK bytes in R2 at apps/:appId/pending/:fileHash.apk.
 *   4. Returns { file_hash, r2_key, size_bytes } for the caller to use when
 *      creating the version row.
 *
 * This is simpler than signed-URL pre-signed PUT URLs: clients always go
 * through the Worker, which can validate + audit + rate-limit. R2 access
 * stays private behind the Worker.
 */

import type { Context } from "hono";
import { createHash } from "node:crypto";

export async function handleUploadApk(c: Context<{ Bindings: Env }>) {
  const appId = c.req.param("appId");
  if (!appId) {
    return c.json({ error: "appId required" }, 400);
  }

  // Validate app exists
  const app = await c.env.DB.prepare(
    "SELECT id, slug FROM apps WHERE id = ?",
  )
    .bind(appId)
    .first<{ id: string; slug: string }>();
  if (!app) {
    return c.json({ error: `app ${appId} not found` }, 404);
  }

  // Parse multipart form
  const formData = await c.req.formData();
  const field = formData.get("apk");
  if (!field) {
    return c.json({ error: 'form field "apk" required (multipart file)' }, 400);
  }
  if (typeof field === "string") {
    return c.json({ error: '"apk" must be a file, not a string' }, 400);
  }
  const file: File = field;

  const maxBytes = Number(c.env.MAX_APK_SIZE_MB ?? "200") * 1024 * 1024;
  if (file.size > maxBytes) {
    return c.json({ error: `file too large (${file.size} > ${maxBytes} bytes)` }, 413);
  }

  // Read bytes + compute SHA-256
  const bytes = new Uint8Array(await file.arrayBuffer());
  const fileHash = createHash("sha256").update(bytes).digest("hex");

  // Upload to R2 (path includes the file hash so re-uploads are idempotent
  // and the original filename is preserved as the key suffix).
  const ext = file.name.split(".").pop() || "apk";
  const r2Key = `apps/${appId}/pending/${fileHash}.${ext}`;
  await c.env.APK_BUCKET.put(r2Key, bytes, {
    httpMetadata: {
      contentType: file.type || "application/vnd.android.package-archive",
    },
    customMetadata: {
      "original-filename": file.name,
      "uploaded-by": c.req.header("cf-access-authenticated-user-email") ?? "admin",
    },
  });

  // Audit log
  await c.env.DB.prepare(
    "INSERT INTO audit_logs (id, app_id, action, actor, payload, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
  )
    .bind(
      crypto.randomUUID(),
      appId,
      "apk.upload",
      "admin",
      JSON.stringify({ r2_key: r2Key, size: file.size, sha256: fileHash }),
      Date.now(),
    )
    .run();

  return c.json({
    file_hash: fileHash,
    r2_key: r2Key,
    size_bytes: file.size,
    original_filename: file.name,
  });
}