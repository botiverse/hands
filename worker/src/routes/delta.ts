/**
 * Delta/differential update patch generation (task #246, P1b — server side).
 *
 * The primary path is automatic: when a release is published AND the app has
 * `delta_updates_enabled`, generation runs in the background (see releases.ts)
 * and stores archive-patcher file-by-file patches from the last N published
 * versions to the new one. The update-check endpoint then offers a patch when
 * one applies and beats the full-APK size.
 *
 * Generation is ASYNC: the caller creates an operation, kicks the work off in
 * the background (waitUntil), and returns the operation id immediately. Progress
 * — including per-substep breadcrumbs and timings — is written to the operation
 * so it doubles as a diagnostic log channel (we can't `wrangler tail` from every
 * environment). Each container call is bounded by a timeout so a stuck call
 * fails fast with a diagnostic instead of hanging the whole run.
 *
 * The admin endpoint below is a manual backfill/retry tool.
 */
import type { Context } from "hono";
import type { AdminEnv } from "../middleware/auth";
import { currentActor } from "../middleware/auth";
import { createOperation, updateOperation, type OperationLog } from "./operations";
import { insertAuditLog } from "../lib/permissions";

type AdminContext = Context<AdminEnv & { Bindings: Env }>;

const DEFAULT_KEEP_VERSIONS = 3;
// A single container generate-patch call must return within this budget;
// includes container cold-start (Cloudflare containers cold-start ~1-2 min).
const CONTAINER_TIMEOUT_MS = 180_000;

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
  ms?: number;
}

export interface GenerateDeltaOutcome {
  operation_id: string;
  to_version_code: number | null;
  arch: string | null;
  results: DeltaPatchResult[];
  error?: string;
}

export interface DeltaParams {
  appId: string;
  buildId: string;
  actor: string;
  keep?: number | undefined;
}

/** Create the delta-generate operation row (pending). Returns it so callers can
 * surface the id immediately and run the work in the background. */
export async function createDeltaGenerationOp(
  env: Env,
  params: DeltaParams,
): Promise<OperationLog> {
  const keep =
    params.keep && params.keep > 0 ? Math.min(params.keep, 10) : DEFAULT_KEEP_VERSIONS;
  return createOperation(env.DB, {
    app_id: params.appId,
    kind: "delta-generate",
    actor: params.actor,
    input: JSON.stringify({ build_id: params.buildId, keep }),
  });
}

/**
 * Run the generation for an already-created operation. Never throws — records
 * outcome + step breadcrumbs on the operation. Safe to call from waitUntil.
 */
export async function runDeltaGeneration(
  env: Env,
  op: OperationLog,
  params: DeltaParams,
): Promise<GenerateDeltaOutcome> {
  const { appId, buildId } = params;
  const keep =
    params.keep && params.keep > 0 ? Math.min(params.keep, 10) : DEFAULT_KEEP_VERSIONS;

  const t0 = Date.now();
  const steps: string[] = [];
  const results: DeltaPatchResult[] = [];
  let meta: Record<string, unknown> = {};
  // Push a timestamped breadcrumb and persist it so the operation is a live log.
  const mark = async (
    step: string,
    patch?: Partial<Pick<OperationLog, "status" | "progress">>,
  ) => {
    steps.push(`+${Date.now() - t0}ms ${step}`);
    await updateOperation(env.DB, op.id, {
      ...(patch ?? {}),
      output: JSON.stringify({ ...meta, steps, results }),
    }).catch(() => {});
  };

  try {
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
    if (!target.results || target.results.length !== 1) {
      const error = "target build not found or ambiguous, or has no installable APK";
      await updateOperation(env.DB, op.id, { status: "failed", error, completed_at: Date.now() });
      return { operation_id: op.id, to_version_code: null, arch: null, results: [], error };
    }
    const newApk = target.results[0]!;

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
    const priorRows = priors.results ?? [];
    meta = {
      to_version_code: newApk.version_code,
      arch: newApk.arch,
      new_apk_bytes: newApk.size_bytes,
      prior_versions: priorRows.map((p) => p.version_code),
    };
    await mark(`resolved target vc${newApk.version_code} + ${priorRows.length} priors`, {
      status: "in_progress",
    });

    const { getRandom } = await import("@cloudflare/containers");

    const newObj = await env.APK_BUCKET.get(newApk.r2_key);
    if (!newObj) throw new Error(`new APK missing from storage (${newApk.r2_key})`);
    const newBytes = await newObj.arrayBuffer();
    await mark(`fetched new APK ${newBytes.byteLength}b from R2`);

    let done = 0;
    for (const prior of priorRows) {
      const oldObj = await env.APK_BUCKET.get(prior.r2_key);
      if (!oldObj) {
        results.push({ from_version_code: prior.version_code, status: "skip:old-apk-missing" });
        await mark(`v${prior.version_code}: old APK missing`);
        continue;
      }
      const oldBytes = await oldObj.arrayBuffer();
      await mark(`v${prior.version_code}: fetched old APK ${oldBytes.byteLength}b; calling container`);

      const form = new FormData();
      form.append("old", new Blob([oldBytes]), "old.apk");
      form.append("new", new Blob([newBytes]), "new.apk");
      const container = await getRandom(env.APK_PARSER, 1);

      const callStart = Date.now();
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), CONTAINER_TIMEOUT_MS);
      let res: Response;
      try {
        res = await container.fetch(
          new Request("http://container/generate-patch", {
            method: "POST",
            body: form,
            signal: ac.signal,
          }),
        );
      } catch (err) {
        clearTimeout(timer);
        const ms = Date.now() - callStart;
        const reason = ac.signal.aborted ? `timeout after ${CONTAINER_TIMEOUT_MS}ms` : String(err);
        results.push({ from_version_code: prior.version_code, status: `fail:container-call (${reason})`, ms });
        await mark(`v${prior.version_code}: container call FAILED in ${ms}ms — ${reason}`);
        continue;
      }
      clearTimeout(timer);
      const ms = Date.now() - callStart;

      if (!res.ok) {
        const body = await res.text().catch(() => "");
        results.push({ from_version_code: prior.version_code, status: `fail:container-${res.status}`, ms });
        await mark(`v${prior.version_code}: container ${res.status} in ${ms}ms — ${body.slice(0, 200)}`);
        continue;
      }
      const patchBytes = await res.arrayBuffer();
      const ratio = patchBytes.byteLength / newApk.size_bytes;
      await mark(`v${prior.version_code}: container OK in ${ms}ms, patch ${patchBytes.byteLength}b (ratio ${ratio.toFixed(4)})`);

      if (patchBytes.byteLength >= newApk.size_bytes) {
        results.push({ from_version_code: prior.version_code, status: "skip:not-smaller", ratio, ms });
        continue;
      }

      const patchKey = `delta/${appId}/${newApk.version_code}/from-${prior.version_code}-${newApk.arch ?? "any"}.patch`;
      await env.APK_BUCKET.put(patchKey, patchBytes);
      const patchHash = await sha256Hex(patchBytes);

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
            // Gzipped archive-patcher file-by-file bsdiff stream; the applier
            // must gunzip before FileByFileV1DeltaApplier.applyDelta.
            algorithm: "archive-patcher-v1+gzip",
            target_sha256: newApk.file_hash,
          }),
          Date.now(),
        )
        .run();

      done += 1;
      results.push({ from_version_code: prior.version_code, status: "ok", size_bytes: patchBytes.byteLength, ratio, ms });
      await mark(`v${prior.version_code}: stored delta-patch`, {
        progress: done / Math.max(1, priorRows.length),
      });
    }

    await updateOperation(env.DB, op.id, {
      status: "success",
      progress: 1,
      output: JSON.stringify({ ...meta, steps, results, total_ms: Date.now() - t0 }),
      completed_at: Date.now(),
    });
    return { operation_id: op.id, to_version_code: newApk.version_code, arch: newApk.arch, results };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    await updateOperation(env.DB, op.id, {
      status: "failed",
      error,
      output: JSON.stringify({ ...meta, steps, results, total_ms: Date.now() - t0 }),
      completed_at: Date.now(),
    });
    return { operation_id: op.id, to_version_code: null, arch: null, results, error };
  }
}

/**
 * Create the op and run generation to completion. Callers (e.g. the auto path in
 * releases.ts) invoke this inside waitUntil and ignore the return value.
 */
export async function generateDeltaPatchesForBuild(
  env: Env,
  params: DeltaParams,
): Promise<GenerateDeltaOutcome> {
  const op = await createDeltaGenerationOp(env, params);
  return runDeltaGeneration(env, op, params);
}

/**
 * POST /api/apps/:appId/builds/:buildId/generate-delta-patches — admin backfill/
 * retry. Async: creates the operation, runs generation in the background, and
 * returns the operation id immediately (poll GET .../operations to watch it).
 */
export async function handleGenerateDeltaPatches(c: AdminContext) {
  const appId = c.req.param("appId") ?? "";
  const buildId = c.req.param("buildId") ?? "";
  const keepRaw = Number(c.req.query("versions"));
  const keep = Number.isFinite(keepRaw) && keepRaw > 0 ? keepRaw : undefined;
  const params: DeltaParams = { appId, buildId, actor: currentActor(c), keep };

  await insertAuditLog(c.env.DB, c, {
    app_id: appId,
    action: "delta.generate",
    payload: { build_id: buildId, keep },
  });
  const op = await createDeltaGenerationOp(c.env, params);
  const run = runDeltaGeneration(c.env, op, params);
  if (c.executionCtx?.waitUntil) {
    c.executionCtx.waitUntil(run);
  } else {
    // No execution context (e.g. tests) — run inline so behaviour is defined.
    await run;
  }
  return c.json({ operation_id: op.id, status: "started" }, 202);
}
