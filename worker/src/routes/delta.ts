/**
 * Delta/differential update patch generation (task #246, P1b — server side).
 *
 * The primary path is automatic: when a release is published AND the app has
 * `delta_updates_enabled`, `generateDeltaPatchesForBuild` runs in the background
 * (see releases.ts) and stores archive-patcher file-by-file patches from the
 * last N published versions to the new one. The update-check endpoint then
 * offers a patch when one applies and beats the full-APK size.
 *
 * The admin endpoint below is a manual backfill/retry tool (e.g. right after
 * the toggle is switched on, to generate patches for existing history).
 * Idempotent: existing patches for a from-version are replaced.
 */
import type { Context } from "hono";
import { getRandom } from "@cloudflare/containers";
import type { AdminEnv } from "../middleware/auth";
import { currentActor } from "../middleware/auth";
import { createOperation, updateOperation } from "./operations";
import { insertAuditLog } from "../lib/permissions";

type AdminContext = Context<AdminEnv & { Bindings: Env }>;

const DEFAULT_KEEP_VERSIONS = 3;

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

interface ApkAssetRow {
  build_id: string;
  version_code: number;
  arch: string | null;
  r2_key: string;
  file_hash: string;
  size_bytes: number;
}

export interface DeltaPatchResult {
  from_version_code: number;
  status: string;
  size_bytes?: number;
  ratio?: number;
}

export interface GenerateDeltaOutcome {
  operation_id: string;
  to_version_code: number | null;
  arch: string | null;
  results: DeltaPatchResult[];
  error?: string;
}

/**
 * Context-free core: generate + store delta patches for a build's installable
 * APK from the last `keep` published versions (same arch). Safe to call from a
 * background `waitUntil` (auto path) or from the admin endpoint. Never throws —
 * failures are recorded on the operation and returned in the outcome.
 */
export async function generateDeltaPatchesForBuild(
  env: Env,
  params: { appId: string; buildId: string; actor: string; keep?: number | undefined },
): Promise<GenerateDeltaOutcome> {
  const { appId, buildId, actor } = params;
  const keep =
    params.keep && params.keep > 0 ? Math.min(params.keep, 10) : DEFAULT_KEEP_VERSIONS;

  const target = await env.DB.prepare(
    `SELECT ba.build_id, b.version_code, ba.arch, ba.r2_key, ba.file_hash, ba.size_bytes
     FROM build_assets ba
     JOIN builds b ON b.id = ba.build_id
     WHERE b.app_id = ?1 AND ba.build_id LIKE ?2 || '%'
       AND ba.artifact_kind = 'installable' AND ba.filetype = 'apk'
     LIMIT 2`,
  )
    .bind(appId, buildId)
    .all<ApkAssetRow>();

  const op = await createOperation(env.DB, {
    app_id: appId,
    kind: "delta-generate",
    actor,
    input: JSON.stringify({ build_id: buildId, keep }),
  });

  if (!target.results || target.results.length !== 1) {
    const error = "target build not found or ambiguous, or has no installable APK";
    await updateOperation(env.DB, op.id, {
      status: "failed",
      error,
      completed_at: Date.now(),
    });
    return { operation_id: op.id, to_version_code: null, arch: null, results: [], error };
  }
  const newApk = target.results[0]!;

  // Prior published versions with an installable APK for the same arch,
  // strictly older than the target, most recent first.
  const priors = await env.DB.prepare(
    `SELECT ba.build_id, b.version_code, ba.arch, ba.r2_key, ba.file_hash, ba.size_bytes
     FROM build_assets ba
     JOIN builds b ON b.id = ba.build_id
     JOIN releases r ON r.build_id = b.id
     WHERE b.app_id = ?1 AND ba.artifact_kind = 'installable' AND ba.filetype = 'apk'
       AND (ba.arch IS ?2 OR ba.arch = ?2)
       AND b.version_code < ?3
       AND r.status IN ('active', 'superseded')
     GROUP BY b.version_code
     ORDER BY b.version_code DESC
     LIMIT ?4`,
  )
    .bind(appId, newApk.arch, newApk.version_code, keep)
    .all<ApkAssetRow>();

  await updateOperation(env.DB, op.id, {
    status: "in_progress",
    output: JSON.stringify({
      to_version_code: newApk.version_code,
      arch: newApk.arch,
      prior_versions: (priors.results ?? []).map((p) => p.version_code),
    }),
  });

  const results: DeltaPatchResult[] = [];
  try {
    const newObj = await env.APK_BUCKET.get(newApk.r2_key);
    if (!newObj) throw new Error(`new APK missing from storage (${newApk.r2_key})`);
    const newBytes = await newObj.arrayBuffer();

    let done = 0;
    for (const prior of priors.results ?? []) {
      const oldObj = await env.APK_BUCKET.get(prior.r2_key);
      if (!oldObj) {
        results.push({ from_version_code: prior.version_code, status: "skip:old-apk-missing" });
        continue;
      }
      const oldBytes = await oldObj.arrayBuffer();

      const form = new FormData();
      form.append("old", new Blob([oldBytes]), "old.apk");
      form.append("new", new Blob([newBytes]), "new.apk");
      const container = await getRandom(env.APK_PARSER, 1);
      const res = await container.fetch(
        new Request("http://container/generate-patch", { method: "POST", body: form }),
      );
      if (!res.ok) {
        results.push({ from_version_code: prior.version_code, status: `fail:container-${res.status}` });
        continue;
      }
      const patchBytes = await res.arrayBuffer();
      const ratio = patchBytes.byteLength / newApk.size_bytes;
      // Patch is a gzipped bsdiff stream; the update-check threshold decides
      // whether to offer it, but skip patches that don't even beat the full APK.
      if (patchBytes.byteLength >= newApk.size_bytes) {
        results.push({ from_version_code: prior.version_code, status: "skip:not-smaller", ratio });
        continue;
      }

      const patchKey = `delta/${appId}/${newApk.version_code}/from-${prior.version_code}-${newApk.arch ?? "any"}.patch`;
      await env.APK_BUCKET.put(patchKey, patchBytes);
      const patchHash = await sha256Hex(patchBytes);

      // Replace any existing patch for this (build, from-version, arch).
      await env.DB.prepare(
        `DELETE FROM build_assets
         WHERE build_id = ?1 AND artifact_kind = 'delta-patch'
           AND CAST(json_extract(metadata_json, '$.from_version_code') AS INTEGER) = ?2
           AND (arch IS ?3 OR arch = ?3)`,
      )
        .bind(newApk.build_id, prior.version_code, newApk.arch)
        .run();
      await env.DB.prepare(
        `INSERT INTO build_assets
         (id, build_id, artifact_kind, platform, arch, variant, filetype, r2_key, file_hash,
          size_bytes, signature, signing_credential_id, metadata_json, download_count, created_at)
         VALUES (?1, ?2, 'delta-patch', 'android', ?3, NULL, 'patch', ?4, ?5, ?6, NULL, NULL, ?7, 0, ?8)`,
      )
        .bind(
          crypto.randomUUID(),
          newApk.build_id,
          newApk.arch,
          patchKey,
          patchHash,
          patchBytes.byteLength,
          JSON.stringify({
            from_version_code: prior.version_code,
            to_version_code: newApk.version_code,
            // Patch is a gzipped archive-patcher file-by-file bsdiff stream; the
            // applier must gunzip before FileByFileV1DeltaApplier.applyDelta.
            algorithm: "archive-patcher-v1+gzip",
            target_sha256: newApk.file_hash,
          }),
          Date.now(),
        )
        .run();

      done += 1;
      results.push({ from_version_code: prior.version_code, status: "ok", size_bytes: patchBytes.byteLength, ratio });
      await updateOperation(env.DB, op.id, {
        status: "in_progress",
        progress: done / Math.max(1, (priors.results ?? []).length),
        output: JSON.stringify({ to_version_code: newApk.version_code, arch: newApk.arch, results }),
      });
    }

    await updateOperation(env.DB, op.id, {
      status: "success",
      progress: 1,
      output: JSON.stringify({ to_version_code: newApk.version_code, arch: newApk.arch, results }),
      completed_at: Date.now(),
    });
    return { operation_id: op.id, to_version_code: newApk.version_code, arch: newApk.arch, results };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    await updateOperation(env.DB, op.id, { status: "failed", error, completed_at: Date.now() });
    return { operation_id: op.id, to_version_code: newApk.version_code, arch: newApk.arch, results, error };
  }
}

/**
 * POST /api/apps/:appId/builds/:buildId/generate-delta-patches — admin backfill/
 * retry. The primary path is automatic on publish (see releases.ts); use this to
 * (re)generate patches on demand, e.g. just after enabling the app toggle.
 */
export async function handleGenerateDeltaPatches(c: AdminContext) {
  const appId = c.req.param("appId") ?? "";
  const buildId = c.req.param("buildId") ?? "";
  const keepRaw = Number(c.req.query("versions"));
  const keep = Number.isFinite(keepRaw) && keepRaw > 0 ? keepRaw : undefined;

  await insertAuditLog(c.env.DB, c, {
    app_id: appId,
    action: "delta.generate",
    payload: { build_id: buildId, keep },
  });
  const outcome = await generateDeltaPatchesForBuild(c.env, {
    appId,
    buildId,
    actor: currentActor(c),
    keep,
  });
  return c.json(outcome, outcome.error && outcome.results.length === 0 ? 500 : 200);
}
