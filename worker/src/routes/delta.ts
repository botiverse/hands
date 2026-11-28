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
import { generateInternalR2Url } from "./public_v2";
import { requestOrigin } from "../lib/origin";

type AdminContext = Context<AdminEnv & { Bindings: Env }>;

const DEFAULT_KEEP_VERSIONS = 5;
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

/**
 * Each source APK gets one patch per compression. `+gzip` is what every SDK
 * understands; `+xz` is about 30% smaller and is offered only to SDKs that
 * declare it (X-Hands-Delta-Algorithms, see public_v2.ts findDeltaPatch).
 * The variants differ in filetype because build_assets' canonical slot
 * (build, kind, platform, arch, variant, from-version, from-sha256, filetype)
 * must keep them apart; the filetype is also the R2 key and download-name
 * extension.
 */
export const DELTA_PATCH_VARIANTS = [
  { compression: "gzip", algorithm: "archive-patcher-v1+gzip", filetype: "patch" },
  { compression: "xz", algorithm: "archive-patcher-v1+xz", filetype: "patch.xz" },
] as const;

export interface DeltaPatchResult {
  from_version_code: number;
  /** The source APK's sha256 and arch: one version code can have several source APKs. */
  from_sha256?: string;
  from_arch?: string | null;
  algorithm: string;
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
  // Public origin the container uses to fetch source APKs.
  origin: string;
}

// How far back device activity counts when choosing patch sources.
const SOURCE_ACTIVITY_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * A universal APK carries every ABI. Older CLIs stored it with the literal arch
 * `universal`; newer ones store no arch. Both mean the same APK, so patch
 * sources must match either way.
 */
const UNIVERSAL_APK_ARCHES = ["universal", "any", ""];
const APK_ARCH_SQL = `(CASE WHEN ba.arch IN (${UNIVERSAL_APK_ARCHES.map((a) => `'${a}'`).join(", ")}) THEN NULL ELSE ba.arch END)`;
export function normalizeApkArch(arch: string | null | undefined): string | null {
  const trimmed = arch?.trim() ?? "";
  return UNIVERSAL_APK_ARCHES.includes(trimmed) ? null : trimmed;
}

/** Distinct source APKs kept per version code (a version can ship universal and per-ABI APKs). */
export const MAX_SOURCE_APKS_PER_VERSION = 3;

type ReleasedApk = ApkAssetRow & { same_channel: number };

/**
 * Released APKs of earlier version codes that a patch to an APK of `arch` can
 * start from, newest version first. Apps switch between universal and
 * ABI-specific APKs (1.31 ships arm64-v8a only after 1.29/1.30 shipped
 * universal, and the next release may go back), and one version code can ship
 * as both. So:
 *  - an ABI-specific target takes same-ABI and universal sources, never a
 *    different ABI (a device on an x86_64 APK never gets an arm64-v8a one);
 *  - a universal target takes sources of any ABI, since every device can move
 *    to it.
 * Every distinct APK (by file hash) of a chosen version code is kept, up to
 * `perVersion` (at most MAX_SOURCE_APKS_PER_VERSION), exact-ABI first; `limit`
 * counts version codes.
 * `same_channel` is 1 when the version was released on one of `channelsJson`'s
 * channels.
 */
async function releasedApksForArch(
  db: D1Database, appId: string, arch: string | null, before: number, channelsJson: string, limit = 200,
  perVersion = MAX_SOURCE_APKS_PER_VERSION,
): Promise<ReleasedApk[]> {
  return (await releasedApkGroups(db, appId, arch, before, channelsJson, limit, perVersion)).flat();
}

/** releasedApksForArch grouped by version code, newest first. */
async function releasedApkGroups(
  db: D1Database, appId: string, arch: string | null, before: number, channelsJson: string, limit = 200,
  perVersion = MAX_SOURCE_APKS_PER_VERSION,
): Promise<ReleasedApk[][]> {
  const cap = Math.max(1, Math.min(perVersion, MAX_SOURCE_APKS_PER_VERSION));
  const target = normalizeApkArch(arch);
  const rows = (await db.prepare(
    `SELECT ba.build_id, b.version_code, ba.arch, ba.r2_key, ba.file_hash, ba.size_bytes,
            CASE WHEN r.channel_id IN (SELECT value FROM json_each(?4)) THEN 1 ELSE 0 END AS same_channel,
            CASE WHEN ${APK_ARCH_SQL} IS ?2 THEN 1 ELSE 0 END AS exact_arch
     FROM build_assets ba
     JOIN builds b ON b.id = ba.build_id
     JOIN releases r ON r.build_id = b.id
     WHERE b.app_id = ?1 AND ba.artifact_kind = 'installable' AND ba.filetype = 'apk'
       AND (?2 IS NULL OR ${APK_ARCH_SQL} IS ?2 OR ${APK_ARCH_SQL} IS NULL)
       AND b.version_code < ?3
       AND r.status IN ('active', 'superseded')
     ORDER BY b.version_code DESC, exact_arch DESC, ba.id ASC
     LIMIT 2000`,
  ).bind(appId, target, before, channelsJson).all<ReleasedApk & { exact_arch: number }>()).results ?? [];
  const byCode = new Map<number, ReleasedApk[]>();
  for (const row of rows) {
    let group = byCode.get(row.version_code);
    if (!group) {
      if (byCode.size >= limit) break;
      group = [];
      byCode.set(row.version_code, group);
    }
    // One row per release: the same APK appears once per channel it shipped on.
    const seen = group.find((apk) => apk.file_hash === row.file_hash);
    if (row.same_channel === 1) for (const apk of group) apk.same_channel = 1;
    if (seen || group.length >= cap) continue;
    const { exact_arch: _exact, ...asset } = row;
    if (group.some((apk) => apk.same_channel === 1)) asset.same_channel = 1;
    group.push(asset);
  }
  return [...byCode.values()];
}

/**
 * The installed versions worth a patch to `newApk`: those that devices on the
 * new build's release channels ran most in the last 30 days, plus the latest
 * earlier release on those channels; the nearest earlier releases fill any
 * remaining places (and stand in alone when there is no device activity).
 * Each chosen version contributes all its source APKs (see
 * releasedApksForArch); `keep` counts versions.
 *
 * Nearest version codes alone are the wrong sources once a channel has
 * previews: 1.29.0 on main got patches only from 1.29 previews while main's
 * devices ran 1.26–1.28, so none of them could be offered a patch.
 */
export async function selectPatchSources(
  db: D1Database, appId: string, newApk: ApkAssetRow, keep: number, now = Date.now(),
  channelIds?: string[],
  perVersion = MAX_SOURCE_APKS_PER_VERSION,
): Promise<ApkAssetRow[]> {
  // The target channels: given by the caller (CI generates patches before the
  // build has a release), else the channels the new build is released on.
  const channels = channelIds ?? ((await db.prepare(
    `SELECT DISTINCT channel_id FROM releases WHERE build_id = ?1`,
  ).bind(newApk.build_id).all<{ channel_id: string }>()).results ?? []).map((r) => r.channel_id);
  const channelsJson = JSON.stringify(channels);
  const released = await releasedApkGroups(db, appId, newApk.arch, newApk.version_code, channelsJson, 200, perVersion);
  if (released.length === 0) return [];
  const byCode = new Map(released.map((group) => [group[0]!.version_code, group]));
  const active = (await db.prepare(
    `SELECT p.version_code, COUNT(*) AS devices
     FROM device_pings p
     WHERE p.app_id = ?1 AND p.last_seen > ?2 AND p.version_code < ?3
       AND p.channel IN (SELECT c.slug FROM channels c WHERE c.app_id = ?1 AND c.id IN (SELECT value FROM json_each(?4)))
     GROUP BY p.version_code
     ORDER BY devices DESC, p.version_code DESC
     LIMIT 50`,
  ).bind(appId, now - SOURCE_ACTIVITY_WINDOW_MS, newApk.version_code, channelsJson)
    .all<{ version_code: number; devices: number }>()).results ?? [];
  const chosen: ReleasedApk[][] = [];
  const add = (group: ReleasedApk[] | undefined) => {
    if (group && !chosen.includes(group)) chosen.push(group);
  };
  for (const { version_code } of active) {
    if (chosen.length >= keep) break;
    add(byCode.get(version_code));
  }
  // The release a channel's up-to-date devices are on, even before any ping.
  add(released.find((group) => group.some((row) => row.same_channel === 1)));
  for (const group of released) {
    if (chosen.length >= keep + 1) break;
    add(group);
  }
  return chosen.flat().map(({ same_channel: _ignored, ...asset }) => asset);
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

    const priorRows = await selectPatchSources(env.DB, appId, newApk, keep);
    meta = {
      to_version_code: newApk.version_code,
      arch: newApk.arch,
      new_apk_bytes: newApk.size_bytes,
      prior_versions: [...new Set(priorRows.map((p) => p.version_code))],
      prior_sources: priorRows.map((p) => ({ version_code: p.version_code, arch: p.arch, sha256: p.file_hash })),
    };
    await mark(`resolved target vc${newApk.version_code} + ${priorRows.length} priors`, {
      status: "in_progress",
    });

    const { getRandom } = await import("@cloudflare/containers");

    // The container fetches the APKs itself from these signed URLs — we never
    // load APK bytes into Worker memory, and the request to the container stays
    // tiny (two URLs) instead of pushing ~56MB of multipart (which hangs).
    const URL_TTL_SECONDS = 1800;
    const newUrl = await generateInternalR2Url(env, newApk.r2_key, URL_TTL_SECONDS, params.origin);
    await mark(`minted signed URL for new APK`);

    let done = 0;
    for (const prior of priorRows) {
      const fromSha256 = prior.file_hash.toLowerCase();
      const fromArch = normalizeApkArch(prior.arch);
      const sourceLabel = `v${prior.version_code} (${fromArch ?? "universal"} ${fromSha256.slice(0, 12)})`;
      const oldUrl = await generateInternalR2Url(env, prior.r2_key, URL_TTL_SECONDS, params.origin);
      // Every variant is generated and stored on its own: an xz failure keeps
      // the gzip patch old SDKs need, and the reverse.
      let stored = 0;
      for (const variant of DELTA_PATCH_VARIANTS) {
        const label = `${sourceLabel} ${variant.compression}`;
        const base = {
          from_version_code: prior.version_code,
          from_sha256: fromSha256,
          from_arch: fromArch,
          algorithm: variant.algorithm,
        };
        await mark(`${label}: calling container (url mode)`);

        const container = await getRandom(env.APK_PARSER, 1);
        const callStart = Date.now();
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), CONTAINER_TIMEOUT_MS);
        let res: Response;
        try {
          res = await container.fetch(
            new Request("http://container/generate-patch", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ old_url: oldUrl, new_url: newUrl, compression: variant.compression }),
              signal: ac.signal,
            }),
          );
        } catch (err) {
          clearTimeout(timer);
          const ms = Date.now() - callStart;
          const reason = ac.signal.aborted ? `timeout after ${CONTAINER_TIMEOUT_MS}ms` : String(err);
          results.push({ ...base, status: `fail:container-call (${reason})`, ms });
          await mark(`${label}: container call FAILED in ${ms}ms — ${reason}`);
          continue;
        }
        clearTimeout(timer);
        const ms = Date.now() - callStart;

        if (!res.ok) {
          const body = await res.text().catch(() => "");
          results.push({ ...base, status: `fail:container-${res.status}`, ms });
          await mark(`${label}: container ${res.status} in ${ms}ms — ${body.slice(0, 200)}`);
          continue;
        }
        const patchBytes = await res.arrayBuffer();
        const ratio = patchBytes.byteLength / newApk.size_bytes;
        await mark(`${label}: container OK in ${ms}ms, patch ${patchBytes.byteLength}b (ratio ${ratio.toFixed(4)})`);

        if (patchBytes.byteLength >= newApk.size_bytes) {
          results.push({ ...base, status: "skip:not-smaller", ratio, ms });
          continue;
        }

        // The source hash keeps the patches from two APKs of one version code
        // (universal and arm64-v8a, say) apart.
        const patchKey = `delta/${appId}/${newApk.version_code}/from-${prior.version_code}-${fromSha256.slice(0, 16)}-${newApk.arch ?? "any"}.${variant.filetype}`;
        await env.APK_BUCKET.put(patchKey, patchBytes);
        const patchHash = await sha256Hex(patchBytes);

        // Replace only this variant from this source APK: the gzip and xz
        // patches, and the patches from other APKs of the same version code,
        // live side by side. A patch stored before patches recorded their
        // source (no from_sha256) is replaced too: this run makes one from
        // every source APK of that version.
        await env.DB.prepare(
          `DELETE FROM build_assets
           WHERE build_id = ?1 AND artifact_kind = 'delta-patch'
             AND CAST(json_extract(metadata_json, '$.from_version_code') AS INTEGER) = ?2
             AND (arch IS ?3 OR arch = ?3)
             AND json_extract(metadata_json, '$.algorithm') = ?4
             AND (json_extract(metadata_json, '$.from_sha256') IS NULL
                  OR lower(json_extract(metadata_json, '$.from_sha256')) = ?5)`,
        )
          .bind(newApk.build_id, prior.version_code, newApk.arch, variant.algorithm, fromSha256)
          .run();
        await env.DB.prepare(
          `INSERT INTO build_assets
           (id, build_id, artifact_kind, platform, arch, variant, filetype, r2_key, file_hash,
           size_bytes, signing_credential_id, metadata_json, download_count, created_at)
           VALUES (?1, ?2, 'delta-patch', 'android', ?3, NULL, ?9, ?4, ?5, ?6, NULL, ?7, 0, ?8)`,
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
              // Compressed archive-patcher file-by-file bsdiff stream; the
              // applier decompresses before FileByFileV1DeltaApplier.applyDelta.
              algorithm: variant.algorithm,
              target_sha256: newApk.file_hash,
              // The exact APK this patch applies to; the update check offers
              // it only to a device whose installed APK has this hash (or that
              // sends none).
              from_sha256: fromSha256,
              from_arch: fromArch,
            }),
            Date.now(),
            variant.filetype,
          )
          .run();

        stored += 1;
        results.push({ ...base, status: "ok", size_bytes: patchBytes.byteLength, ratio, ms });
        await mark(`${label}: stored delta-patch`);
      }
      if (stored > 0) done += 1;
      await mark(`${sourceLabel}: ${stored}/${DELTA_PATCH_VARIANTS.length} variants stored`, {
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
  const params: DeltaParams = {
    appId,
    buildId,
    actor: currentActor(c),
    keep,
    origin: requestOrigin(c),
  };

  await insertAuditLog(c.env.DB, c, {
    app_id: appId,
    action: "delta.generate",
    payload: { build_id: buildId, keep },
  });
  // Run synchronously within the request: a waitUntil background task is
  // cancelled ~seconds after the response ("waitUntil() tasks did not complete
  // within the allowed time"), which killed the wait on the container before it
  // finished. Container-backed subrequests keep this invocation alive while the
  // patch is generated. (The auto-on-publish path in releases.ts still uses
  // waitUntil and will need a Queue for production — see note there.)
  const op = await createDeltaGenerationOp(c.env, params);
  const outcome = await runDeltaGeneration(c.env, op, params);
  return c.json(outcome, outcome.error && outcome.results.length === 0 ? 500 : 200);
}

/**
 * GET /api/apps/:appId/delta-sources?arch=<abi>&before=<version_code>&limit=<N>[&channel_id=<id>][&per_version=<M>]
 * Returns short-lived signed download URLs for the installable APKs of the last
 * N published version codes (version_code < before): for an ABI-specific arch
 * the same-arch and universal APKs, for no arch (universal) APKs of any arch;
 * up to `per_version` distinct APKs of a version (at most
 * MAX_SOURCE_APKS_PER_VERSION), each with its arch and sha256. `per_version`
 * defaults to 1: CLIs before it existed name their work files and patches by
 * version code alone, so two sources of one version would overwrite each
 * other's files and their second patch would collide with the first in the
 * canonical asset slot, failing the publish. With channel_id, the sources are
 * chosen as in selectPatchSources: the versions that channel's devices run,
 * plus its latest earlier release. Used by the CLI/CI to fetch the
 * source APKs, generate archive-patcher patches, and upload them via
 * publish-android --delta-patch. Keeps patch generation out of the Worker.
 */
export async function handleDeltaSources(c: AdminContext) {
  const appId = c.req.param("appId") ?? "";
  // An empty arch is the same as none: a universal APK registered without an ABI.
  const arch = normalizeApkArch(c.req.query("arch"));
  const before = Number(c.req.query("before"));
  if (!Number.isFinite(before)) {
    return c.json({ error: "before (version_code) must be a number" }, 400);
  }
  const limitRaw = Number(c.req.query("limit"));
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 10) : DEFAULT_KEEP_VERSIONS;
  const perVersionRaw = Number(c.req.query("per_version"));
  const perVersion = Number.isInteger(perVersionRaw) && perVersionRaw > 0
    ? Math.min(perVersionRaw, MAX_SOURCE_APKS_PER_VERSION)
    : 1;

  const channelId = c.req.query("channel_id")?.trim() || null;
  const origin = requestOrigin(c);
  const sign = (rows: ApkAssetRow[]) => Promise.all(
    rows.map(async (p) => ({
      from_version_code: p.version_code,
      arch: p.arch,
      size_bytes: p.size_bytes,
      sha256: p.file_hash,
      url: await generateInternalR2Url(c.env, p.r2_key, 1800, origin),
    })),
  );
  if (channelId) {
    const channel = await c.env.DB.prepare(`SELECT id FROM channels WHERE id = ?1 AND app_id = ?2`)
      .bind(channelId, appId).first<{ id: string }>();
    if (!channel) return c.json({ error: "channel_id is not a channel of this app" }, 404);
    const target: ApkAssetRow = { build_id: "", version_code: before, arch, r2_key: "", file_hash: "", size_bytes: 0 };
    const rows = await selectPatchSources(c.env.DB, appId, target, limit, Date.now(), [channelId], perVersion);
    return c.json({ arch, before, channel_id: channelId, sources: await sign(rows) });
  }

  const priors = await releasedApksForArch(c.env.DB, appId, arch, before, "[]", limit, perVersion);
  const sources = priors.map(({ same_channel: _ignored, ...row }) => row);
  return c.json({ arch, before, sources: await sign(sources) });
}
