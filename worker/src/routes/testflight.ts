/**
 * TestFlight upload lane (sdk-parity / TestFlight-on-Hands Part 2b).
 *
 * POST /api/apps/:appId/builds/:buildId/testflight-upload
 *   Streams the build's installable IPA from R2 straight to Apple using the
 *   official Build Upload API: create buildUpload → register the file →
 *   PUT each part per Apple's uploadOperations → commit → first state poll.
 *   Synchronous by design — the work is IO-bound (a 40MB IPA is a handful of
 *   part PUTs) and the caller gets the final commit state in one response.
 *   Progress is mirrored into the operations stream for the admin UI.
 *
 * GET /api/apps/:appId/testflight-uploads/:buildUploadId
 *   Polls Apple for the processing state (AWAITING_UPLOAD → PROCESSING →
 *   COMPLETE | FAILED).
 */
import type { Context } from "hono";
import type { AdminEnv } from "../middleware/auth";
import { currentActor } from "../middleware/auth";
import { getAscCredentials } from "../lib/asc_credentials";
import {
  AscApiError,
  commitBuildUploadFile,
  createBuildUpload,
  createBuildUploadFile,
  getBuildUpload,
  resolveAscAppId,
  type AscApiCredentials,
} from "../lib/asc_api";
import { createOperation, updateOperation } from "./operations";
import { insertAuditLog } from "../lib/permissions";

type AdminContext = Context<AdminEnv & { Bindings: Env }>;

export async function handleTestflightUpload(c: AdminContext) {
  const appId = c.req.param("appId") ?? "";
  const buildIdParam = c.req.param("buildId") ?? "";
  const encKey = c.env.ASC_CRED_ENC_KEY;
  if (!encKey) return c.json({ error: "server is missing ASC_CRED_ENC_KEY" }, 500);

  const creds = await getAscCredentials(c.env.DB, encKey, appId);
  if (!creds) {
    return c.json(
      { error: "no ASC credentials configured — add them in Settings → TestFlight first" },
      400,
    );
  }

  const build = await c.env.DB.prepare(
    `SELECT id, version_name, version_code FROM builds
     WHERE app_id = ?1 AND id LIKE ?2 || '%' LIMIT 2`,
  )
    .bind(appId, buildIdParam)
    .all<{ id: string; version_name: string; version_code: number }>();
  if (!build.results || build.results.length !== 1) {
    return c.json({ error: "build not found (or ambiguous short id)" }, 404);
  }
  const b = build.results[0]!;

  const asset = await c.env.DB.prepare(
    `SELECT r2_key, size_bytes, file_hash FROM build_assets
     WHERE build_id = ?1 AND artifact_kind = 'installable' AND filetype = 'ipa'
     LIMIT 1`,
  )
    .bind(b.id)
    .first<{ r2_key: string; size_bytes: number; file_hash: string | null }>();
  if (!asset) return c.json({ error: "build has no installable IPA asset" }, 404);

  // Bundle id: request body wins; otherwise read the build's metadata-file
  // asset (build-metadata.json carries bundle_id since mobile#485).
  const body = (await c.req.json().catch(() => ({}))) as { bundle_id?: unknown };
  let bundleId = typeof body.bundle_id === "string" ? body.bundle_id.trim() : "";
  if (!bundleId) {
    const metaAsset = await c.env.DB.prepare(
      `SELECT r2_key FROM build_assets
       WHERE build_id = ?1 AND artifact_kind = 'metadata-file' LIMIT 1`,
    )
      .bind(b.id)
      .first<{ r2_key: string }>();
    if (metaAsset) {
      const obj = await c.env.APK_BUCKET.get(metaAsset.r2_key);
      if (obj) {
        try {
          const meta = (await obj.json()) as { bundle_id?: string };
          bundleId = (meta.bundle_id ?? "").trim();
        } catch {
          // fall through to the error below
        }
      }
    }
  }
  if (!bundleId) {
    return c.json(
      { error: "bundle_id not found in build metadata; pass {\"bundle_id\": …} in the body" },
      400,
    );
  }

  const op = await createOperation(c.env.DB, {
    app_id: appId,
    kind: "testflight-upload",
    actor: currentActor(c),
    input: JSON.stringify({
      build_id: b.id,
      version_name: b.version_name,
      version_code: b.version_code,
      bundle_id: bundleId,
      size_bytes: asset.size_bytes,
    }),
  });
  await insertAuditLog(c.env.DB, c, {
    app_id: appId,
    action: "testflight.upload",
    payload: { build_id: b.id, version: b.version_name, version_code: b.version_code },
  });

  const fileName = `${bundleId}-${b.version_name}-${b.version_code}.ipa`;
  try {
    const result = await runUpload(c.env, creds, {
      bundleId,
      version: b.version_name,
      buildNumber: String(b.version_code),
      r2Key: asset.r2_key,
      fileSize: asset.size_bytes,
      fileName,
      onProgress: async (progress, note) => {
        await updateOperation(c.env.DB, op.id, {
          status: "in_progress",
          progress,
          output: JSON.stringify({ note }),
        });
      },
    });
    await updateOperation(c.env.DB, op.id, {
      status: "success",
      progress: 100,
      output: JSON.stringify(result),
      completed_at: Date.now(),
    });
    return c.json({ operation_id: op.id, ...result });
  } catch (e) {
    const detail =
      e instanceof AscApiError
        ? { status: e.status, error: e.message, detail: e.detail }
        : { error: e instanceof Error ? e.message : String(e) };
    await updateOperation(c.env.DB, op.id, {
      status: "failed",
      error: JSON.stringify(detail),
      completed_at: Date.now(),
    });
    return c.json({ operation_id: op.id, ok: false, ...detail }, 502);
  }
}

async function runUpload(
  env: Env,
  creds: AscApiCredentials,
  args: {
    bundleId: string;
    version: string;
    buildNumber: string;
    r2Key: string;
    fileSize: number;
    fileName: string;
    onProgress: (progress: number, note: string) => Promise<void>;
  },
): Promise<{
  ok: boolean;
  asc_app_id: string;
  build_upload_id: string;
  parts_uploaded: number;
  state: string | null;
}> {
  const ascAppId = await resolveAscAppId(creds, args.bundleId);
  if (!ascAppId) {
    throw new Error(
      `no App Store Connect app record for bundle id ${args.bundleId} — create it under My Apps`,
    );
  }
  await args.onProgress(10, `resolved ASC app ${ascAppId}`);

  const buildUpload = await createBuildUpload(creds, {
    ascAppId,
    version: args.version,
    buildNumber: args.buildNumber,
  });
  await args.onProgress(20, `created buildUpload ${buildUpload.id}`);

  const file = await createBuildUploadFile(creds, {
    buildUploadId: buildUpload.id,
    fileName: args.fileName,
    fileSize: args.fileSize,
  });
  const operations = file.attributes.uploadOperations ?? [];
  if (operations.length === 0) {
    throw new Error("Apple returned no uploadOperations for the file");
  }
  await args.onProgress(25, `Apple wants ${operations.length} part(s)`);

  let done = 0;
  for (const part of operations) {
    const object = await env.APK_BUCKET.get(args.r2Key, {
      range: { offset: part.offset, length: part.length },
    });
    if (!object) throw new Error(`IPA object missing from storage (${args.r2Key})`);
    const bytes = await object.arrayBuffer();
    const headers: Record<string, string> = {};
    for (const h of part.requestHeaders ?? []) headers[h.name] = h.value;
    const res = await fetch(part.url, { method: part.method || "PUT", headers, body: bytes });
    if (!res.ok) {
      throw new Error(`part upload failed: HTTP ${res.status} at offset ${part.offset}`);
    }
    done += 1;
    await args.onProgress(
      25 + Math.round((done / operations.length) * 60),
      `uploaded part ${done}/${operations.length}`,
    );
  }

  // Checksum omitted: Apple's validator rejected our SHA_256 shape (409
  // 'not a valid value for sourceFileChecksums') and the field is optional.
  await commitBuildUploadFile(creds, { fileId: file.id });
  await args.onProgress(90, "committed — Apple is processing");

  // One immediate state read; the status endpoint keeps polling afterwards.
  const state = (await getBuildUpload(creds, buildUpload.id)).attributes.state ?? null;
  return {
    ok: true,
    asc_app_id: ascAppId,
    build_upload_id: buildUpload.id,
    parts_uploaded: done,
    state,
  };
}

export async function handleTestflightUploadStatus(c: AdminContext) {
  const appId = c.req.param("appId") ?? "";
  const buildUploadId = c.req.param("buildUploadId") ?? "";
  const encKey = c.env.ASC_CRED_ENC_KEY;
  if (!encKey) return c.json({ error: "server is missing ASC_CRED_ENC_KEY" }, 500);
  const creds = await getAscCredentials(c.env.DB, encKey, appId);
  if (!creds) return c.json({ error: "no ASC credentials configured" }, 400);
  try {
    const bu = await getBuildUpload(creds, buildUploadId);
    return c.json({
      build_upload_id: bu.id,
      state: bu.attributes.state,
      version: bu.attributes.cfBundleShortVersionString,
      build_number: bu.attributes.cfBundleVersion,
      uploaded_at: bu.attributes.uploadedDate,
    });
  } catch (e) {
    if (e instanceof AscApiError) {
      return c.json({ error: e.message, detail: e.detail, status: e.status }, 502);
    }
    throw e;
  }
}
