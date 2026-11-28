/**
 * `quiver builds` — list / inspect builds inside an app.
 *
 * Wires GET /api/apps/:appId/builds + GET /api/apps/:appId/builds/:buildId.
 */

import type { Command } from "commander";
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { availableParallelism, freemem, tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { execFile, spawn } from "node:child_process";
import { Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { createGunzip } from "node:zlib";
import { apiRequest, apiUploadFile, QuiverApiError } from "../lib/api.js";
import { assertActiveReleaseAllowed } from "../lib/release_preflight.js";
import { createHash } from "node:crypto";
import { jsonRequested } from "../lib/json_output.js";
import { recoveryGuidance, type RecoveryPart } from "../lib/recovery_guidance.js";
import { registerBuildInventoryCommands } from "./build_inventory.js";
import { registerPublishDesktopCommand } from "./publish_desktop.js";

const execFileAsync = promisify(execFile);

/**
 * Digest and byte length of a local file, streamed so a multi-hundred-megabyte
 * binary does not have to be held in memory. Used to check that what the server
 * recorded for an upload matches the bytes it was given.
 */
async function sha256File(path: string): Promise<{ sha256: string; sizeBytes: number }> {
  const hash = createHash("sha256");
  let sizeBytes = 0;
  await pipeline(
    createReadStream(path),
    new Writable({
      write(chunk: Buffer, _encoding, callback) {
        sizeBytes += chunk.length;
        hash.update(chunk);
        callback();
      },
    }),
  );
  return { sha256: hash.digest("hex"), sizeBytes };
}

interface BuildRow {
  id: string;
  app_id: string;
  channel_id: string | null;
  product_type: string;
  release_type: string;
  version_name: string;
  version_code: number;
  status: string;
  changelog: string | null;
  should_force_update: number;
  created_at: number;
  completed_at: number | null;
}

interface UploadResponse {
  file_hash: string;
  r2_key: string;
  size_bytes: number;
  original_filename: string;
}

interface ChannelRow {
  id: string;
  slug: string;
  name: string;
}

interface ReleaseVersionRow {
  id: string;
  build_id: string;
  status: string;
  version_name: string;
  version_code: number;
}

interface ReleaseVersionConflictBody {
  code: "RELEASE_VERSION_ALREADY_EXISTS";
  release_id?: string;
  build_id?: string;
  release_status?: string;
  version_name?: string;
  version_code?: number;
}

interface TestflightGroup {
  id: string;
  name: string | null;
  is_internal: boolean | null;
  has_access_to_all_builds: boolean | null;
  public_link_enabled: boolean | null;
}

interface TestflightPublishStatus {
  hands_build_id: string;
  bundle_id: string;
  asc_app_id: string;
  asc_build_id: string | null;
  version: string;
  build_number: string;
  state: string;
  distribution: "internal" | "external" | null;
  processing_state?: string | null;
  expired?: boolean | null;
  assigned_groups?: TestflightGroup[];
  beta_review?: {
    id: string;
    state: string | null;
    submitted_at: string | null;
  } | null;
  beta_detail?: {
    auto_notify_enabled: boolean | null;
    internal_build_state: string | null;
    external_build_state: string | null;
  } | null;
  notification?: string;
  operation_id?: string;
}

function collect(value: string, previous: string[] = []): string[] {
  return previous.concat(value);
}

/**
 * The ABI an Android APK is registered under. `universal` (or `any`, or an empty
 * string) means no ABI: Hands serves such an asset to a device of any ABI, after
 * any exact-ABI asset of the same release.
 */
export function normalizeAndroidArch(value: string | undefined): string | null {
  const trimmed = (value ?? "").trim();
  if (trimmed === "" || trimmed === "universal" || trimmed === "any") return null;
  return trimmed;
}

export const ANDROID_DELTA_PATCH_ALGORITHM = "archive-patcher-v1+gzip";
/** Same patch, xz-compressed: about 30% smaller; applied by Android SDK 0.15.0+. */
export const ANDROID_DELTA_PATCH_XZ_ALGORITHM = "archive-patcher-v1+xz";
/**
 * Same container with a Zucchini delta instead of bsdiff, xz-compressed: about
 * 40% smaller than the xz patch for a typical update; applied by Android SDK
 * 0.16.0+.
 */
export const ANDROID_DELTA_PATCH_ZUCCHINI_ALGORITHM = "archive-patcher-zucchini-v1+xz";
/**
 * xz settings shared with the server's patch generator: single-threaded so the
 * output is deterministic, and a 16 MiB dictionary so the SDK decodes it in
 * about 17 MiB (its limit is 20 MiB).
 */
export const ANDROID_DELTA_PATCH_XZ_ARGS = ["--threads=1", "--lzma2=preset=9e,dict=16MiB", "-c"];
const ANDROID_DELTA_PATCH_MAGIC = Buffer.from("GFbFv1_0", "ascii");

interface AndroidDeltaPatchSpec {
  fromVersionCode: number;
  /** The source APK's sha256 (`<vc>@<sha256>=<path>`), lower-case; absent when not given. */
  fromSha256?: string;
  patchPath: string;
}

const SHA256_HEX = /^[0-9a-f]{64}$/iu;

/**
 * Patch metadata. `fromSha256`/`fromArch` name the exact source APK: one version
 * code can ship as several APKs (universal and per-ABI), and the server offers a
 * patch only to a device whose installed APK it was made from. `fromArch` is
 * recorded only alongside a known `fromSha256` (null = universal).
 */
export function androidDeltaPatchMetadata(args: {
  fromVersionCode: number;
  toVersionCode: number;
  targetSha256: string;
  algorithm?: string;
  fromSha256?: string | null | undefined;
  fromArch?: string | null | undefined;
}): Record<string, unknown> {
  const fromSha256 = args.fromSha256 && SHA256_HEX.test(args.fromSha256) ? args.fromSha256.toLowerCase() : null;
  return {
    from_version_code: args.fromVersionCode,
    to_version_code: args.toVersionCode,
    algorithm: args.algorithm ?? ANDROID_DELTA_PATCH_ALGORITHM,
    target_sha256: args.targetSha256,
    ...(fromSha256 ? { from_sha256: fromSha256 } : {}),
    ...(fromSha256 && args.fromArch !== undefined ? { from_arch: normalizeAndroidArch(args.fromArch ?? undefined) } : {}),
  };
}

/**
 * Work-file stem for a delta source. Two APKs of one version code (universal
 * and arm64-v8a) are two sources, so the version code alone would make them
 * overwrite each other's downloaded APK and patches; the position in the
 * source list keeps every stem distinct, the hash prefix keeps it readable.
 */
export function deltaSourceWorkName(source: { from_version_code: number; sha256?: string | null }, index: number): string {
  const sha = source.sha256 && SHA256_HEX.test(source.sha256) ? `-${source.sha256.toLowerCase().slice(0, 12)}` : "";
  return `from-${source.from_version_code}${sha}-${index}`;
}

/** Log label for a delta source: version code, plus arch when it says which APK. */
function deltaSourceLabel(source: { from_version_code: number; arch: string | null }): string {
  return `v${source.from_version_code} (${normalizeAndroidArch(source.arch ?? undefined) ?? "universal"})`;
}

export async function assertGzipAndroidDeltaPatch(filePath: string): Promise<void> {
  let prefix = Buffer.alloc(0);
  try {
    await pipeline(
      createReadStream(filePath),
      createGunzip(),
      new Writable({
        write(chunk: Buffer, _encoding, callback) {
          if (prefix.length < ANDROID_DELTA_PATCH_MAGIC.length) {
            prefix = Buffer.concat([prefix, chunk]).subarray(
              0,
              ANDROID_DELTA_PATCH_MAGIC.length,
            );
          }
          callback();
        },
      }),
    );
  } catch {
    throw new Error(
      `--delta-patch must be a complete gzip-compressed official PatchGen output (.patch.gz): ${filePath}`,
    );
  }
  if (!prefix.equals(ANDROID_DELTA_PATCH_MAGIC)) {
    throw new Error(
      `--delta-patch does not contain an archive-patcher v1 stream: ${filePath}`,
    );
  }
}

/**
 * Asset slots declared when an Android build is created.
 *
 * ONLY the ProGuard mapping is declared, and only when --mapping is given.
 *
 * Why not every asset: the server refuses to move a protocol-v1 build to
 * `succeeded` until every declared slot has a verified asset, so declaring more
 * than necessary adds failure modes without adding capability. Two concrete ones
 * that a "mirror everything" version hit during review:
 *   - the slot key is kind/platform/arch/variant/filetype, which cannot express
 *     fromVersionCode, so two --delta-patch flags produced two identical keys and
 *     the build was rejected with "duplicate slot" (builds.ts:457);
 *   - --generate-deltas uploads patches through the legacy path that never touched
 *     the declared slots, so "declare every uploaded asset" was not actually true.
 *
 * The mapping is the one asset that NEEDS this: an R8 mapping is routinely hundreds
 * of megabytes, which exceeds the 200 MB cap on POST /upload and was the whole
 * reason for this change. Every other asset stays on the legacy registration path,
 * which is already exercised in production.
 */
function androidRequiredAssetSlots(args: { mapping?: string }): Array<{
  artifact_kind: string;
  platform: string;
  arch: string | null;
  variant: string | null;
  filetype: string;
}> {
  if (!args.mapping) return [];
  return [
    { artifact_kind: "proguard-mapping", platform: "android", arch: null, variant: null, filetype: "mapping.txt" },
  ];
}

export async function preflightAndroidDeltaPatches(
  specs: string[] = [],
): Promise<AndroidDeltaPatchSpec[]> {
  const parsed = specs.map((spec) => {
    const eq = spec.indexOf("=");
    if (eq <= 0) {
      throw new Error(`--delta-patch must be <from_version_code>[@<source_sha256>]=<path>, got: ${spec}`);
    }
    const parts = spec.slice(0, eq).trim().split("@");
    if (parts.length > 2) {
      throw new Error(`--delta-patch must be <from_version_code>[@<source_sha256>]=<path>, got: ${spec}`);
    }
    const [codePart, shaPart] = parts as [string, string | undefined];
    const fromVersionCode = codePart.trim() === "" ? Number.NaN : Number(codePart.trim());
    const patchPath = spec.slice(eq + 1).trim();
    if (!Number.isFinite(fromVersionCode)) {
      throw new Error(`bad from_version_code in --delta-patch: ${spec}`);
    }
    if (shaPart !== undefined && !SHA256_HEX.test(shaPart.trim())) {
      throw new Error(`bad source sha256 in --delta-patch (64 hex characters): ${spec}`);
    }
    if (!existsSync(patchPath)) throw new Error(`missing delta patch file: ${patchPath}`);
    return { fromVersionCode, patchPath, ...(shaPart ? { fromSha256: shaPart.trim().toLowerCase() } : {}) };
  });
  // Two patches from the same source would fill the same asset slot; the server
  // would reject the second only after the build and the first were uploaded.
  const sources = new Set<string>();
  for (const patch of parsed) {
    const key = `${patch.fromVersionCode}@${patch.fromSha256 ?? ""}`;
    if (sources.has(key)) {
      throw new Error(`--delta-patch given twice for ${patch.fromVersionCode}${patch.fromSha256 ? `@${patch.fromSha256}` : ""}; add @<source_sha256> to tell two source APKs apart`);
    }
    sources.add(key);
  }
  for (const patch of parsed) {
    await assertGzipAndroidDeltaPatch(patch.patchPath);
  }
  return parsed;
}

export async function assertReleaseVersionAvailable(args: {
  appId: string;
  channelId: string;
  productType: string;
  releaseType: string;
  versionName: string;
  versionCode: number;
}): Promise<void> {
  const { releases } = await apiRequest<{ releases: ReleaseVersionRow[] }>(
    `/api/apps/${args.appId}/releases`,
    {
      query: {
        channel: args.channelId,
        product_type: args.productType,
        release_type: args.releaseType,
        version_code: args.versionCode,
      },
    },
  );
  const conflict = releases.find(
    (release) =>
      release.version_code === args.versionCode &&
      release.status !== "cancelled",
  );
  if (!conflict) return;
  const recovery = conflict.status === "draft"
    ? "cancel that never-published draft before uploading this version again, or choose a higher version code"
    : "choose a higher version code; cancelling a published or superseded release cannot make installed clients update to different bits with the same version code";
  throw new Error(
    `release version ${args.versionName} (${args.versionCode}) is already owned by ` +
      `${conflict.status} release ${conflict.id} (build ${conflict.build_id}); ` +
      recovery,
  );
}

export async function createAdmittedPublishBuild(args: {
  appId: string;
  channelId: string;
  productType: string;
  releaseType: string;
  versionName: string;
  versionCode: number;
  buildBody: Record<string, unknown>;
}): Promise<{ id: string }> {
  await assertReleaseVersionAvailable({
    appId: args.appId,
    channelId: args.channelId,
    productType: args.productType,
    releaseType: args.releaseType,
    versionName: args.versionName,
    versionCode: args.versionCode,
  });
  return apiRequest<{ id: string }>(`/api/apps/${args.appId}/builds`, {
    method: "POST",
    body: {
      ...args.buildBody,
      channel_id: args.channelId,
      product_type: args.productType,
      release_type: args.releaseType,
      version_name: args.versionName,
      version_code: args.versionCode,
    },
  });
}

function releaseVersionConflict(error: unknown): ReleaseVersionConflictBody | null {
  if (!(error instanceof QuiverApiError) || error.status !== 409) return null;
  if (!error.body || typeof error.body !== "object" || Array.isArray(error.body)) return null;
  const body = error.body as Partial<ReleaseVersionConflictBody>;
  return body.code === "RELEASE_VERSION_ALREADY_EXISTS"
    ? body as ReleaseVersionConflictBody
    : null;
}

export async function createReleaseOrTerminalizeVersionConflict(args: {
  appId: string;
  buildId: string;
  releaseBody: Record<string, unknown>;
  provenance: Record<string, unknown>;
}): Promise<{ id: string }> {
  try {
    return await apiRequest<{ id: string }>(`/api/apps/${args.appId}/releases`, {
      method: "POST",
      body: args.releaseBody,
    });
  } catch (error) {
    const conflict = releaseVersionConflict(error);
    if (!conflict) {
      throw new Error(
        `release creation did not complete for build ${args.buildId}; inspect that build before retrying: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error },
      );
    }

    const terminal = {
      state: "failed",
      reason: "release_version_conflict",
      at: new Date().toISOString(),
      conflicting_release_id: conflict.release_id ?? null,
      conflicting_build_id: conflict.build_id ?? null,
      conflicting_release_status: conflict.release_status ?? null,
      version_name: conflict.version_name ?? null,
      version_code: conflict.version_code ?? null,
    };
    try {
      await apiRequest(`/api/apps/${args.appId}/builds/${args.buildId}`, {
        method: "PATCH",
        body: {
          status: "failed",
          provenance_json: {
            ...args.provenance,
            hands_cli_terminal: terminal,
          },
        },
      });
    } catch (terminalError) {
      throw new Error(
        `release version conflict left build ${args.buildId} requiring manual inspection; ` +
          `automatic failed-terminal write did not complete: ${
            terminalError instanceof Error ? terminalError.message : String(terminalError)
          }`,
        { cause: error },
      );
    }

    throw new Error(
      `release version conflict; new build ${args.buildId} was terminalized as failed and remains ` +
        `auditable (existing release ${conflict.release_id ?? "unknown"}, ` +
        `build ${conflict.build_id ?? "unknown"}, status ${conflict.release_status ?? "unknown"})`,
      { cause: error },
    );
  }
}

export function shouldOutputJson(program: Command, localJson?: boolean): boolean {
  return Boolean(localJson || program.opts<{ json?: boolean }>().json);
}

export function parseChangelogOptions(opts: {
  changelog?: string | string[];
  changelogFile?: string | string[];
}): string | null {
  const langAliases: Record<string, string> = { zh: "zh-CN", cn: "zh-CN" };
  const byLang: Record<string, string> = {};
  let plain: string | undefined;
  const values = (value?: string | string[]): string[] => {
    if (value === undefined) return [];
    return Array.isArray(value) ? value : [value];
  };
  const consume = (entry: string, fromFile: boolean) => {
    const eq = entry.indexOf("=");
    if (eq > 0 && eq <= 10) {
      const langRaw = entry.slice(0, eq).trim().toLowerCase();
      const lang = langAliases[langRaw] ?? langRaw;
      const value = entry.slice(eq + 1);
      byLang[lang] = (fromFile ? readFileSync(value, "utf8") : value).trim();
    } else {
      plain = (fromFile ? readFileSync(entry, "utf8") : entry).trim();
    }
  };
  for (const entry of values(opts.changelog)) consume(entry, false);
  for (const entry of values(opts.changelogFile)) consume(entry, true);

  const langs = Object.keys(byLang);
  if (langs.length > 0) {
    if (plain !== undefined) {
      throw new Error("mix of plain and lang= changelog entries; pick one style");
    }
    return JSON.stringify(byLang);
  }
  return plain ?? null;
}

export function parseWhatToTestOptions(opts: {
  whatToTest?: string | string[];
  whatToTestFile?: string | string[];
}): Record<string, string> {
  const result: Record<string, string> = {};
  const values = (value?: string | string[]): string[] => {
    if (value === undefined) return [];
    return Array.isArray(value) ? value : [value];
  };
  const consume = (entry: string, fromFile: boolean) => {
    const eq = entry.indexOf("=");
    if (eq <= 0) {
      throw new Error(
        `${fromFile ? "--what-to-test-file" : "--what-to-test"} must use locale=${fromFile ? "path" : "text"}`,
      );
    }
    const locale = entry.slice(0, eq).trim();
    const value = entry.slice(eq + 1);
    const text = (
      fromFile ? readFileSync(value.trim(), "utf8") : value
    ).trim();
    if (!locale || !text) {
      throw new Error("What to Test locale and text must be non-empty");
    }
    if (Object.prototype.hasOwnProperty.call(result, locale)) {
      throw new Error(`duplicate What to Test locale: ${locale}`);
    }
    result[locale] = text;
  };
  for (const entry of values(opts.whatToTest)) consume(entry, false);
  for (const entry of values(opts.whatToTestFile)) consume(entry, true);
  return result;
}

function positiveSeconds(value: string, option: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${option} must be a positive number`);
  }
  return parsed;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function withTimeoutMessage<T>(
  message: string,
  request: () => Promise<T>,
): Promise<T> {
  try {
    return await request();
  } catch (error) {
    if (
      error instanceof Error &&
      (error.name === "TimeoutError" || error.name === "AbortError")
    ) {
      throw new Error(message);
    }
    throw error;
  }
}

/**
 * The exact confirmation body for POST .../testflight-expire, taken from a
 * fresh status read. `expectedAscBuildId` pins the ASC build the caller
 * previewed; a different build refuses before anything is sent to Apple.
 */
export function testflightExpireRequest(
  status: Pick<TestflightPublishStatus, "asc_build_id" | "version" | "build_number">,
  options: { expectedAscBuildId?: string; bundleId?: string } = {},
): { asc_build_id: string; confirm_version: string; confirm_build_number: string; bundle_id?: string } {
  if (!status.asc_build_id) {
    throw new Error("App Store Connect has no build for this Hands build yet; nothing to expire");
  }
  if (options.expectedAscBuildId && options.expectedAscBuildId !== status.asc_build_id) {
    throw new Error(
      `--asc-build-id ${options.expectedAscBuildId} does not match the App Store Connect build ${status.asc_build_id} for this Hands build`,
    );
  }
  return {
    asc_build_id: status.asc_build_id,
    confirm_version: status.version,
    confirm_build_number: status.build_number,
    ...(options.bundleId ? { bundle_id: options.bundleId } : {}),
  };
}

async function getTestflightPublishStatus(
  appId: string,
  buildId: string,
  options: {
    distribution?: string;
    bundleId?: string;
    signal?: AbortSignal;
  },
): Promise<TestflightPublishStatus> {
  return apiRequest<TestflightPublishStatus>(
    `/api/apps/${appId}/builds/${buildId}/testflight-publish`,
    {
      query: {
        distribution: options.distribution,
        bundle_id: options.bundleId,
      },
      ...(options.signal ? { signal: options.signal } : {}),
    },
  );
}

function assertTestflightStatusHealthy(status: TestflightPublishStatus): void {
  // `not_uploaded` means Apple has no record of this build AND no upload ever
  // succeeded. Polling cannot resolve it — only an upload can — so it must stop
  // the wait loop instead of looking like one more slow round.
  if (status.state === "not_uploaded") {
    throw new Error(
      "TestFlight build was never uploaded to Apple — run `hands builds testflight-upload` first; "
        + "waiting will not change this",
    );
  }
  if (
    status.state === "processing_failed" ||
    status.state === "expired" ||
    status.state === "rejected" ||
    status.state === "blocked_export_compliance" ||
    status.state === "not_applicable"
  ) {
    const appleState =
      status.distribution === "external"
        ? status.beta_review?.state ??
          status.beta_detail?.external_build_state ??
          status.processing_state
        : status.beta_detail?.internal_build_state ?? status.processing_state;
    throw new Error(
      `TestFlight reached terminal state ${status.state}${appleState ? ` (Apple: ${appleState})` : ""}`,
    );
  }
}

async function waitForAscBuild(
  appId: string,
  buildId: string,
  options: {
    distribution: "internal" | "external";
    bundleId?: string;
    intervalSeconds: number;
    timeoutSeconds: number;
    quiet: boolean;
  },
): Promise<TestflightPublishStatus> {
  const deadline = Date.now() + options.timeoutSeconds * 1000;
  const timeoutMessage =
    `timed out after ${options.timeoutSeconds}s waiting for ` +
    "App Store Connect processing";
  while (true) {
    const remainingMilliseconds = deadline - Date.now();
    if (remainingMilliseconds <= 0) {
      throw new Error(timeoutMessage);
    }
    const status = await withTimeoutMessage(timeoutMessage, () =>
      getTestflightPublishStatus(appId, buildId, {
        ...options,
        signal: AbortSignal.timeout(
          Math.max(1, Math.ceil(remainingMilliseconds)),
        ),
      }),
    );
    assertTestflightStatusHealthy(status);
    if (status.asc_build_id && status.processing_state === "VALID") return status;
    if (Date.now() >= deadline) {
      throw new Error(timeoutMessage);
    }
    if (!options.quiet) {
      console.error(
        `TestFlight ${status.version} (${status.build_number}): ` +
          `${status.state}; polling again in ${options.intervalSeconds}s`,
      );
    }
    await sleep(
      Math.min(
        options.intervalSeconds * 1000,
        Math.max(0, deadline - Date.now()),
      ),
    );
  }
}

async function waitForTestflightDistribution(
  appId: string,
  buildId: string,
  options: {
    distribution: "internal" | "external";
    notifyTesters: boolean;
    bundleId?: string;
    intervalSeconds: number;
    timeoutSeconds: number;
    quiet: boolean;
  },
): Promise<TestflightPublishStatus> {
  const deadline = Date.now() + options.timeoutSeconds * 1000;
  const timeoutMessage =
    `timed out after ${options.timeoutSeconds}s waiting for ` +
    `TestFlight ${options.distribution} distribution`;
  while (true) {
    const remainingMilliseconds = deadline - Date.now();
    if (remainingMilliseconds <= 0) {
      throw new Error(timeoutMessage);
    }
    const status = await withTimeoutMessage(timeoutMessage, () =>
      getTestflightPublishStatus(appId, buildId, {
        ...options,
        signal: AbortSignal.timeout(
          Math.max(1, Math.ceil(remainingMilliseconds)),
        ),
      }),
    );
    assertTestflightStatusHealthy(status);
    const complete =
      options.distribution === "internal"
        ? status.state === "testing"
        : options.notifyTesters
          ? status.state === "testing"
          : status.state === "approved_not_notified" ||
            status.state === "approved" ||
            status.state === "testing";
    if (complete) return status;
    if (Date.now() >= deadline) {
      throw new Error(timeoutMessage);
    }
    if (!options.quiet) {
      const review = status.beta_review?.state
        ? ` review=${status.beta_review.state}`
        : "";
      console.error(
        `TestFlight ${status.version} (${status.build_number}): ` +
          `${status.state}${review}; polling again in ${options.intervalSeconds}s`,
      );
    }
    await sleep(
      Math.min(
        options.intervalSeconds * 1000,
        Math.max(0, deadline - Date.now()),
      ),
    );
  }
}

export function registerBuildCommands(program: Command): void {
  const builds = program
    .command("builds")
    .description("Inspect builds inside an app.");

  builds
    .command("list <appIdOrSlug>")
    .alias("ls")
    .description("List builds for an app.")
    .option("--limit <n>", "Max rows (default 50)", "50")
    .option("--json", "Output JSON.", false)
    .action(
      async (
        appIdOrSlug: string,
        opts: { limit?: string; json?: boolean },
      ) => {
        const id = await resolveAppId(appIdOrSlug);
        const res = await apiRequest<{ builds: BuildRow[] }>(
          `/api/apps/${id}/builds`,
          { query: { limit: opts.limit } },
        );
        if (shouldOutputJson(program, jsonRequested(program, opts.json))) {
          console.log(JSON.stringify(res, null, 2));
          return;
        }
        if (res.builds.length === 0) {
          console.log("No builds yet.");
          return;
        }
        for (const b of res.builds) {
          const flag = b.should_force_update ? "  [force]" : "";
          console.log(
            `${b.version_name} (${b.version_code})  ${b.product_type}/${b.release_type}  status=${b.status}${flag}  id=${b.id}`,
          );
        }
      },
    );

  builds
    .command("get <appIdOrSlug> <buildId>")
    .description("Show details for a single build.")
    .option("--json", "Output JSON.", false)
    .action(
      async (
        appIdOrSlug: string,
        buildId: string,
        opts: { json?: boolean },
      ) => {
        const id = await resolveAppId(appIdOrSlug);
        const build = await apiRequest<BuildRow>(`/api/apps/${id}/builds/${buildId}`);
        if (shouldOutputJson(program, jsonRequested(program, opts.json))) {
          console.log(JSON.stringify(build, null, 2));
          return;
        }
        console.log(`${build.version_name} (${build.version_code})`);
        console.log(`  product_type: ${build.product_type}`);
        console.log(`  release_type: ${build.release_type}`);
        console.log(`  status: ${build.status}`);
        console.log(`  should_force_update: ${build.should_force_update ? "yes" : "no"}`);
        console.log(`  created_at: ${new Date(build.created_at).toISOString()}`);
        if (build.completed_at) {
          console.log(
            `  completed_at: ${new Date(build.completed_at).toISOString()}`,
          );
        }
        if (build.changelog) {
          console.log(`\n  changelog:\n${build.changelog.split("\n").map((l) => "    " + l).join("\n")}`);
        }
      },
    );

  registerBuildInventoryCommands(builds, program, resolveAppId);
  registerPublishDesktopCommand(builds, program);

  builds
    .command("presign-asset <appIdOrSlug> <buildId> <assetId>")
    .description(
      "Return a short-lived direct download URL for an authenticated build asset. " +
        "Fetch it outside the CLI transport for binary verification.",
    )
    .option("--json", "Output JSON.", false)
    .action(
      async (
        appIdOrSlug: string,
        buildId: string,
        assetId: string,
        opts: { json?: boolean },
      ) => {
        const id = await resolveAppId(appIdOrSlug);
        const result = await apiRequest<Record<string, unknown>>(
          `/api/apps/${id}/builds/${buildId}/assets/${assetId}/download?presign=1`,
        );
        if (shouldOutputJson(program, jsonRequested(program, opts.json))) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }
        const url = typeof result.url === "string" ? result.url : undefined;
        console.log(url ?? JSON.stringify(result));
      },
    );

  builds
    .command("delete-asset <appIdOrSlug> <buildId> <assetId>")
    .description(
      "Delete one non-installable build-asset metadata row; the R2 object is preserved. " +
        "Requires app admin and fails closed on installable assets or mismatched objects.",
    )
    .option("--json", "Output JSON.", false)
    .action(
      async (
        appIdOrSlug: string,
        buildId: string,
        assetId: string,
        opts: { json?: boolean },
      ) => {
        const id = await resolveAppId(appIdOrSlug);
        const result = await apiRequest<Record<string, unknown>>(
          `/api/apps/${id}/builds/${buildId}/assets/${assetId}`,
          { method: "DELETE" },
        );
        if (shouldOutputJson(program, jsonRequested(program, opts.json))) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }
        console.log(`Deleted asset ${assetId} from build ${buildId}.`);
      },
    );

  /**
   * GET /builds/:buildId returns the build object directly. Some Hands surfaces
   * wrap it as { build: {...} }, so accept both: an assumed wrapper silently
   * yields a report of nulls, which reads as a successful empty result rather
   * than an error -- the failure mode this helper exists to prevent.
   */
  async function readBuild(appId: string, buildId: string): Promise<Record<string, unknown>> {
    const detail = await apiRequest<Record<string, unknown>>(
      `/api/apps/${appId}/builds/${buildId}`,
    );
    const unwrapped = (detail as { build?: unknown }).build;
    if (unwrapped && typeof unwrapped === "object") {
      return unwrapped as Record<string, unknown>;
    }
    return detail;
  }

  /**
   * What is about to be deleted, recorded before the delete rather than after:
   * once the row is gone the success message is the only trace, and "it had no
   * releases and no assets" says nothing about which build disappeared.
   */
  function describeBuild(buildId: string, build: Record<string, unknown>) {
    const assets = Array.isArray(build.assets) ? build.assets : [];
    return {
      build_id: buildId,
      status: build.status ?? null,
      version_name: build.version_name ?? null,
      version_code: build.version_code ?? null,
      asset_count: Number(build.asset_count ?? assets.length),
      asset_sha256: assets
        .map((asset) => (asset as { sha256?: unknown }).sha256)
        .filter((value): value is string => typeof value === "string"),
      checked: "server enforces: no releases referencing this build, no assets attached",
    };
  }

  function formatBuildRecord(build: {
    build_id: string;
    status: unknown;
    version_name: unknown;
    version_code: unknown;
    asset_count?: number;
    asset_sha256?: string[];
  }): string {
    const lines = [
      `Build ${build.build_id}:`,
      `  status=${String(build.status)}`,
      `  version=${String(build.version_name)} (${String(build.version_code)})`,
    ];
    if (typeof build.asset_count === "number") {
      lines.push(`  assets=${build.asset_count}`);
    }
    for (const sha of build.asset_sha256 ?? []) lines.push(`  asset sha256=${sha}`);
    return lines.join("\n");
  }

  builds
    .command("delete <appIdOrSlug> <buildId>")
    .description(
      "Delete a build that has never been released and has no assets. " +
        "Requires app admin. Hands refuses (409) while any release references the build " +
        "or any asset is attached, so this can only remove a build that never shipped -- " +
        "a test leftover, not a release record.",
    )
    .option("--json", "Output JSON.", false)
    .option("--dry-run", "Check whether the build can be deleted without deleting it.", false)
    .action(
      async (
        appIdOrSlug: string,
        buildId: string,
        opts: { json?: boolean; dryRun?: boolean },
      ) => {
        const id = await resolveAppId(appIdOrSlug);
        const asJson = shouldOutputJson(program, jsonRequested(program, opts.json));

        if (opts.dryRun) {
          // Read the build so the refusal reasons can be reported before anyone
          // commits to the delete: a 409 later is far less useful than knowing
          // up front which condition blocks it.
          const build = await readBuild(id, buildId);
          const report = describeBuild(buildId, build);
          if (asJson) {
            console.log(JSON.stringify(report, null, 2));
            return;
          }
          console.log(formatBuildRecord(report));
          console.log("A delete would be refused if any release references it or any asset is attached.");
          return;
        }

        // Record what is being removed BEFORE removing it: afterwards this
        // message is the only evidence of which build disappeared.
        const before = describeBuild(buildId, await readBuild(id, buildId));
        const result = await apiRequest<Record<string, unknown>>(
          `/api/apps/${id}/builds/${buildId}`,
          { method: "DELETE" },
        );
        if (asJson) {
          console.log(JSON.stringify({ deleted: before, result }, null, 2));
          return;
        }
        console.log(`Deleting build of ${appIdOrSlug}:`);
        console.log(formatBuildRecord(before));
        console.log(
          `Deleted build ${buildId}. It had no releases and no assets, so no release record referenced it.`,
        );
      },
    );

  builds
    .command("publish-version <appIdOrSlug>")
    .description("Register an immutable externally hosted Node/CLI build target.")
    .requiredOption("--version-name <version>", "Release version name.")
    .option(
      "--version-code <code>",
      "Hands ordering code. Defaults to a numeric dotted-version encoding.",
    )
    .requiredOption(
      "--target <target>",
      "Artifact target, for example darwin-arm64 or linux-x64.",
    )
    .requiredOption("--source-url <url>", "Authoritative external HTTPS artifact URL.")
    .requiredOption("--raw-sha256 <sha256>", "SHA-256 of the uncompressed artifact bytes.")
    .requiredOption("--raw-size <bytes>", "Uncompressed artifact size in bytes.")
    .option("--gzip-sha256 <sha256>", "SHA-256 of the gzip transport bytes.")
    .option("--gzip-size <bytes>", "Gzip transport size in bytes.")
    .option("--node-version <version>", "Node runtime version embedded in the artifact.")
    .option("--channel <slug>", "Hands channel slug.", "main")
    .option("--product-type <type>", "Hands product type.", "cli-binary")
    .option("--release-type <type>", "Hands release type.", "stable")
    .option("--source-commit <sha>", "Source commit SHA.")
    .option("--ci-provider <name>", "CI provider name.")
    .option("--ci-run-id <id>", "CI run id.")
    .option("--ci-url <url>", "CI run URL.")
    .option("--json", "Output JSON.", false)
    .action(
      async (
        appIdOrSlug: string,
        opts: {
          versionName: string;
          versionCode?: string;
          target: string;
          sourceUrl: string;
          rawSha256: string;
          rawSize: string;
          gzipSha256?: string;
          gzipSize?: string;
          nodeVersion?: string;
          channel: string;
          productType: string;
          releaseType: string;
          sourceCommit?: string;
          ciProvider?: string;
          ciRunId?: string;
          ciUrl?: string;
          json?: boolean;
        },
      ) => {
        splitBuildTarget(opts.target);
        const versionCode = opts.versionCode
          ? parseNonNegativeInteger(opts.versionCode, "--version-code")
          : versionCodeFromVersion(opts.versionName);
        const rawSize = parseNonNegativeInteger(opts.rawSize, "--raw-size");
        const hasGzipHash = opts.gzipSha256 !== undefined;
        const hasGzipSize = opts.gzipSize !== undefined;
        if (hasGzipHash !== hasGzipSize) {
          throw new Error("--gzip-sha256 and --gzip-size must be provided together");
        }

        const appId = await resolveAppId(appIdOrSlug);
        const channelId = await resolveChannelId(appId, opts.channel);
        const result = await apiRequest<{
          app_id: string;
          build_id: string;
          target_id: string;
          version: string;
          target: string;
          platform: string;
          arch: string;
          replayed: boolean;
        }>(`/api/apps/${appId}/builds/publish-version`, {
          method: "POST",
          body: {
            channel_id: channelId,
            version_name: opts.versionName,
            version_code: versionCode,
            target: opts.target,
            source_url: opts.sourceUrl,
            raw_sha256: opts.rawSha256,
            raw_size_bytes: rawSize,
            gzip_sha256: opts.gzipSha256 ?? null,
            gzip_size_bytes: hasGzipSize
              ? parseNonNegativeInteger(opts.gzipSize as string, "--gzip-size")
              : null,
            node_version: opts.nodeVersion ?? null,
            product_type: opts.productType,
            release_type: opts.releaseType,
            provenance_json: {
              source_commit: opts.sourceCommit ?? null,
              ci_provider: opts.ciProvider ?? null,
              ci_run_id: opts.ciRunId ?? null,
              ci_url: opts.ciUrl ?? null,
            },
          },
        });

        if (shouldOutputJson(program, jsonRequested(program, opts.json))) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }
        console.log(
          `${result.replayed ? "Verified" : "Registered"} ${result.version} ${result.target}`,
        );
        console.log(`  build:  ${result.build_id}`);
        console.log(`  target: ${result.target_id}`);
        console.log(`  source: ${opts.sourceUrl}`);
      },
    );

  builds
    .command("publish-cli-binary <appIdOrSlug>")
    .description(
      "Host a Node/CLI build on Hands: upload one or more targets' binaries " +
        "(each with optional runner sidecar / SHA256SUMS), then create ONE release. " +
        "Unlike publish-version, the bytes live in the Hands bucket, so the " +
        "publisher needs no external object-store credentials.\n\n" +
        "One invocation = one build for one (app, version) carrying every target's " +
        "assets. --binary/--runner/--sha256sums are repeated once per --target and " +
        "paired positionally, so a 5-target release is a single call rather than five.",
    )
    .requiredOption(
      "--binary <path>",
      "Primary CLI binary. Repeat once per --target, in the same order.",
      collectRepeatable,
      [] as string[],
    )
    .requiredOption("--version-name <version>", "Release version name, e.g. 1.0.33-channel.1.")
    .requiredOption(
      "--target <target>",
      "Artifact target, for example darwin-arm64 or linux-x64. Repeatable; " +
        "every target in one call belongs to the same build and release.",
      collectRepeatable,
      [] as string[],
    )
    .option("--version-code <code>", "Hands ordering code. Defaults to the numeric dotted-version encoding.")
    .option("--channel <slug>", "Hands channel slug.", "main")
    .option("--release-type <type>", "Hands release type.", "stable")
    .option(
      "--runner <path>",
      "Runner sidecar binary (served as ?kind=runner). Repeat once per --target.",
      collectRepeatable,
      [] as string[],
    )
    .option(
      "--sha256sums <path>",
      "SHA256SUMS listing (served as ?kind=sha256sums). Repeat once per --target.",
      collectRepeatable,
      [] as string[],
    )
    .option("--changelog <text>", "Release changelog.")
    .option("--draft", "Create the release as a draft instead of activating it.", false)
    .option("--source-commit <sha>", "Source commit SHA.")
    .option("--ci-provider <name>", "CI provider name.")
    .option("--ci-run-id <id>", "CI run id.")
    .option("--ci-url <url>", "CI run URL.")
    .option("--json", "Output JSON.", false)
    .action(
      async (
        appIdOrSlug: string,
        opts: {
          // Repeated options: commander's collector always yields an array, so
          // these are arrays even for the single-target case (length 1).
          binary: string[];
          versionName: string;
          target: string[];
          versionCode?: string;
          channel: string;
          releaseType: string;
          runner: string[];
          sha256sums: string[];
          changelog?: string;
          draft?: boolean;
          sourceCommit?: string;
          ciProvider?: string;
          ciRunId?: string;
          ciUrl?: string;
          json?: boolean;
        },
      ) => {
        // Before any upload: a non-human caller cannot create an active release.
        await assertActiveReleaseAllowed(opts.draft);
        // One call = one build for one (app, version). `--target` is repeatable and
        // each target carries its own binary (and optional runner / SHA256SUMS),
        // paired positionally. A second build row for the same (app, version) is
        // rejected by 0072's unique index, so splitting one release across several
        // invocations cannot work - hence the repeatable form.
        const targets = opts.target;
        if (targets.length === 0) {
          throw new Error("--target is required");
        }
        if (opts.binary.length !== targets.length) {
          throw new Error(
            `--binary must be given once per --target: ${targets.length} target(s) but ${opts.binary.length} --binary value(s)`,
          );
        }
        if (opts.runner.length !== 0 && opts.runner.length !== targets.length) {
          throw new Error(
            `--runner must be given once per --target when used: ${targets.length} target(s) but ${opts.runner.length} --runner value(s)`,
          );
        }
        if (opts.sha256sums.length !== 0 && opts.sha256sums.length !== targets.length) {
          throw new Error(
            `--sha256sums must be given once per --target when used: ${targets.length} target(s) but ${opts.sha256sums.length} --sha256sums value(s)`,
          );
        }
        const seenTargets = new Set<string>();
        for (const target of targets) {
          if (seenTargets.has(target)) {
            throw new Error(`--target ${target} was given more than once`);
          }
          seenTargets.add(target);
        }

        const versionCode = opts.versionCode
          ? parseNonNegativeInteger(opts.versionCode, "--version-code")
          : versionCodeFromVersion(opts.versionName);
        const appId = await resolveAppId(appIdOrSlug);
        const channelId = await resolveChannelId(appId, opts.channel);
        const provenance = {
          source_commit: opts.sourceCommit ?? null,
          ci_provider: opts.ciProvider ?? null,
          ci_run_id: opts.ciRunId ?? null,
          ci_url: opts.ciUrl ?? null,
        };

        // Every file of every target is uploaded and its recorded digest/size checked
        // against the local bytes BEFORE the release is created. A release that became
        // active while one of its assets was still missing would be
        // downloadable-but-incomplete, which is worse than a publish that simply failed.
        const planned: Array<{
          path: string;
          artifact_kind: string;
          filetype: string;
          variant: string | null;
          platform: string;
          arch: string;
          target: string;
        }> = [];
        targets.forEach((target, index) => {
          const { platform, arch } = splitBuildTarget(target);
          planned.push({
            path: opts.binary[index]!,
            artifact_kind: "installable",
            filetype: "binary",
            variant: null,
            platform,
            arch,
            target,
          });
          const runner = opts.runner[index];
          if (runner !== undefined) {
            planned.push({
              path: runner,
              artifact_kind: "runner",
              filetype: "binary",
              variant: "runner",
              platform,
              arch,
              target,
            });
          }
          const sha256sums = opts.sha256sums[index];
          if (sha256sums !== undefined) {
            planned.push({
              path: sha256sums,
              artifact_kind: "checksums",
              filetype: "sha256sums",
              variant: null,
              platform,
              arch,
              target,
            });
          }
        });

        // Preflight the local files (and their digests) before any remote write,
        // so a typo in a path cannot leave a half-published build behind.
        for (const entry of planned) {
          if (!existsSync(entry.path)) {
            throw new Error(
              `--${entry.variant ?? entry.filetype} path not found for target ${entry.target}: ${entry.path}`,
            );
          }
          await sha256File(entry.path);
        }

        const build = await apiRequest<{ id: string }>(`/api/apps/${appId}/builds`, {
          method: "POST",
          body: {
            channel_id: channelId,
            product_type: "cli-binary",
            release_type: opts.releaseType,
            version_name: opts.versionName,
            version_code: versionCode,
            // `source` keeps its original meaning here: how the build was
            // produced (web/cli/ci). Whether Hands hosts the bytes is decided
            // by the presence of build_assets rows, not by this label.
            source: "cli",
            status: "pending",
            asset_ingest_protocol_version: 1,
            required_asset_slots_json: planned.map((entry) => ({
              artifact_kind: entry.artifact_kind,
              platform: entry.platform,
              arch: entry.arch,
              variant: entry.variant,
              filetype: entry.filetype,
            })),
            build_metadata_json: { hosted: true },
            provenance_json: provenance,
          },
        });

        const assets = [];
        for (const entry of planned) {
          const local = await sha256File(entry.path);
          const asset = await uploadDirectBuildAsset(appId, build.id, entry.path, {
            artifact_kind: entry.artifact_kind,
            platform: entry.platform,
            arch: entry.arch,
            filetype: entry.filetype,
            variant: entry.variant,
            metadata_json: { filename: basename(entry.path), target: entry.target },
          });
          if (asset.file_hash !== local.sha256) {
            throw new Error(
              `uploaded ${basename(entry.path)} digest ${asset.file_hash} does not match local bytes ${local.sha256}; ` +
                "build left unpublished for inspection",
            );
          }
          if (asset.size_bytes !== local.sizeBytes) {
            throw new Error(
              `uploaded ${basename(entry.path)} size ${asset.size_bytes} does not match local bytes ${local.sizeBytes}; ` +
                "build left unpublished for inspection",
            );
          }
          assets.push(asset);
        }

        await apiRequest(`/api/apps/${appId}/builds/${build.id}`, {
          method: "PATCH",
          body: { status: "succeeded" },
        });

        const release = await createReleaseOrTerminalizeVersionConflict({
          appId,
          buildId: build.id,
          provenance,
          releaseBody: {
            build_id: build.id,
            channel_id: channelId,
            product_type: "cli-binary",
            release_type: opts.releaseType,
            status: opts.draft ? "draft" : "active",
            changelog: opts.changelog ?? null,
            provenance_json: provenance,
            scopes: [{ scope_type: "full", scope_value: "all" }],
          },
        });

        const result = {
          app_id: appId,
          build_id: build.id,
          release_id: release.id,
          version: opts.versionName,
          target: opts.target,
          channel: opts.channel,
          status: opts.draft ? "draft" : "active",
          assets: assets.map((asset) => ({
            artifact_kind: asset.artifact_kind,
            filetype: asset.filetype,
            file_hash: asset.file_hash,
            size_bytes: asset.size_bytes,
          })),
        };
        if (shouldOutputJson(program, jsonRequested(program, opts.json))) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }
        console.log(`Hosted ${opts.versionName} ${opts.target} on channel ${opts.channel}`);
        console.log(`  build:   ${build.id}`);
        console.log(`  release: ${release.id} (${result.status})`);
        for (const asset of result.assets) {
          console.log(`  asset:   ${asset.filetype}/${asset.artifact_kind} ${asset.size_bytes} bytes`);
        }
      },
    );

  builds
    .command("publish-android <appIdOrSlug>")
    .description("Create an Android build/release and upload APK plus support artifacts.")
    .requiredOption("--apk <path>", "Installable APK path.")
    .requiredOption("--version-name <name>", "Android versionName.")
    .requiredOption("--version-code <code>", "Android versionCode.")
    .option("--channel <slug>", "Hands release channel slug.", "main")
    .option(
      "--arch <abi>",
      "APK ABI (e.g. arm64-v8a, x86_64). Use `universal` for an APK that carries every ABI: Hands then serves it to every device.",
      "arm64-v8a",
    )
    .option("--release-type <type>", "Release type metadata.", "stable")
    .option("--product-type <type>", "Product type metadata.", "android-apk")
    .option("--mapping <path>", "R8/ProGuard mapping.txt support artifact.")
    .option("--symbols <path>", "Native symbols archive support artifact.")
    .option("--dsym <path>", "iOS dSYM archive (dSYM.zip) support artifact.")
    .option("--metadata <path>", "Build metadata JSON support artifact.")
    .option(
      "--delta-patch <spec>",
      "Complete gzipped delta patch as <from_version_code>=<path> (official PatchGen .patch.gz output), or <from_version_code>@<source_apk_sha256>=<path> to name the exact source APK when that version shipped as more than one APK. Repeatable — clients on that version get offered this patch instead of the full APK.",
      collect,
      [],
    )
    .option(
      "--generate-deltas <N>",
      "After uploading, generate + upload archive-patcher delta patches from the last N published versions — one per source APK when a version shipped as several (universal and per-ABI; an ABI-specific APK patches from the same ABI or universal, a universal APK from any) — (needs a JDK on PATH — CI has one). Each patch is uploaded gzip-compressed and, when `xz` is on PATH, also xz-compressed (about 30% smaller, used by Android SDK 0.15.0+) and as a Zucchini patch (about 40% smaller again for a typical update, used by Android SDK 0.16.0+; only from versions built with SDK 0.16.0+; one to six minutes and about 1 GB of memory per version, run in parallel when the machine allows). Clients on those versions download the small patch instead of the full APK.",
    )
    .option(
      "--no-zucchini-deltas",
      "With --generate-deltas, skip the Zucchini patches (gzip and xz patches only).",
    )
    .option(
      "--changelog <text>",
      "Inline changelog. Repeatable with lang=text for multiple languages.",
      collect,
      [],
    )
    .option(
      "--changelog-file <path>",
      "Read changelog from file. Repeatable with lang=path, e.g. --changelog-file zh=zh.md --changelog-file en=en.md.",
      collect,
      [],
    )
    .option("--source-commit <sha>", "Source commit SHA.")
    .option("--source-branch <branch>", "Source branch.")
    .option("--build-time <iso>", "Build time. Defaults to now.")
    .option("--ci-provider <name>", "CI provider name.")
    .option("--ci-run-id <id>", "CI run id.")
    .option("--ci-url <url>", "CI run URL.")
    .option("--force-update", "Mark release as force update.", false)
    .option("--draft", "Create draft release instead of active.", false)
    .option("--json", "Output JSON.", false)
    .action(
      async (
        appIdOrSlug: string,
        opts: {
          apk: string;
          versionName: string;
          versionCode: string;
          channel: string;
          arch: string;
          releaseType: string;
          productType: string;
          mapping?: string;
          symbols?: string;
          dsym?: string;
          metadata?: string;
          deltaPatch?: string[];
          generateDeltas?: string;
          zucchiniDeltas?: boolean;
          changelog?: string[];
          changelogFile?: string[];
          sourceCommit?: string;
          sourceBranch?: string;
          buildTime?: string;
          ciProvider?: string;
          ciRunId?: string;
          ciUrl?: string;
          forceUpdate?: boolean;
          draft?: boolean;
          json?: boolean;
        },
      ) => {
        // Before any upload: a non-human caller cannot create an active release.
        await assertActiveReleaseAllowed(opts.draft);
        const versionCode = Number(opts.versionCode);
        if (!Number.isFinite(versionCode) || versionCode < 0) {
          throw new Error("--version-code must be a non-negative number");
        }
        const androidArch = normalizeAndroidArch(opts.arch);
        for (const file of [opts.apk, opts.mapping, opts.symbols, opts.dsym, opts.metadata].filter(Boolean) as string[]) {
          if (!existsSync(file)) throw new Error(`missing file: ${file}`);
        }
        const changelog = parseChangelogOptions(opts);
        const metadataJson = opts.metadata
          ? JSON.parse(readFileSync(opts.metadata, "utf8"))
          : {};
        const deltaPatches = await preflightAndroidDeltaPatches(opts.deltaPatch);
        const provenance = {
          source_commit: opts.sourceCommit ?? null,
          source_branch: opts.sourceBranch ?? null,
          build_time: opts.buildTime ?? new Date().toISOString(),
          ci_provider: opts.ciProvider ?? null,
          ci_run_id: opts.ciRunId ?? null,
          ci_url: opts.ciUrl ?? null,
        };
        const appId = await resolveAppId(appIdOrSlug);
        const channelId = await resolveChannelId(appId, opts.channel);
        const build = await createAdmittedPublishBuild({
          appId,
          channelId,
          productType: opts.productType,
          releaseType: opts.releaseType,
          versionName: opts.versionName,
          versionCode,
          buildBody: {
            channel_id: channelId,
            product_type: opts.productType,
            release_type: opts.releaseType,
            version_name: opts.versionName,
            version_code: versionCode,
            changelog,
            source: "cli",
            // With --mapping the build is created pending so the mapping can stream to
            // R2 through the direct-upload path (POST /upload would cap the body at
            // 200 MB and buffer the whole file in memory). Without --mapping there is
            // nothing to stream, so the build is created succeeded exactly as before
            // and no protocol fields are sent at all.
            ...(opts.mapping
              ? {
                  status: "pending",
                  asset_ingest_protocol_version: 1,
                  required_asset_slots_json: androidRequiredAssetSlots(opts),
                }
              : { status: "succeeded" }),
            build_metadata_json: metadataJson,
            provenance_json: provenance,
            should_force_update: Boolean(opts.forceUpdate),
          },
        });

        const assets = [];
        const installable = await uploadAndRegisterAsset(appId, build.id, opts.apk, {
          artifact_kind: "installable",
          platform: "android",
          arch: androidArch,
          filetype: "apk",
        });
        assets.push(installable);
        // Delta inputs were fully preflighted before any remote mutation.
        // target_sha256 is the new APK's hash so the client can verify the
        // reconstructed file. The server offers a patch only when it beats
        // the full APK size.
        for (const { fromVersionCode, fromSha256, patchPath } of deltaPatches) {
          assets.push(
            await uploadAndRegisterAsset(appId, build.id, patchPath, {
              artifact_kind: "delta-patch",
              platform: "android",
              arch: androidArch,
              filetype: "patch",
              metadata_json: androidDeltaPatchMetadata({
                fromVersionCode,
                toVersionCode: versionCode,
                targetSha256: installable.file_hash,
                fromSha256,
              }),
            }),
          );
        }
        // Auto-generate deltas from the last N published versions (CI does the
        // heavy archive-patcher work; the Worker just serves the source APKs +
        // stores the patches). Needs a JDK on PATH.
        if (opts.generateDeltas) {
          const n = Number(opts.generateDeltas);
          if (!Number.isFinite(n) || n <= 0) throw new Error(`--generate-deltas must be a positive number, got: ${opts.generateDeltas}`);
          const generated = await generateAndUploadAndroidDeltas({
            appId,
            buildId: build.id,
            channelId,
            newApkPath: opts.apk,
            arch: androidArch,
            toVersionCode: versionCode,
            targetSha256: installable.file_hash,
            newApkSize: installable.size_bytes,
            versions: n,
            zucchini: opts.zucchiniDeltas !== false,
          });
          assets.push(...generated);
        }
        if (opts.mapping) {
          // Direct streaming upload, not POST /upload: an R8 mapping is routinely
          // hundreds of MB, which exceeds that route's 200 MB body cap and would also
          // be buffered entirely in memory before hashing.
          assets.push(
            await uploadDirectBuildAsset(appId, build.id, opts.mapping, {
              artifact_kind: "proguard-mapping",
              platform: "android",
              arch: null,
              filetype: "mapping.txt",
            }),
          );
        }
        if (opts.symbols) {
          assets.push(
            await uploadAndRegisterAsset(appId, build.id, opts.symbols, {
              artifact_kind: "native-symbols",
              platform: "android",
              arch: null,
              filetype: "symbols.zip",
            }),
          );
        }
        if (opts.dsym) {
          assets.push(
            await uploadAndRegisterAsset(appId, build.id, opts.dsym, {
              artifact_kind: "dsym",
              platform: "ios",
              arch: null,
              filetype: inferIosFiletype(opts.dsym),
              metadata_json: { filename: basename(opts.dsym) },
            }),
          );
        }
        if (opts.metadata) {
          assets.push(
            await uploadAndRegisterAsset(appId, build.id, opts.metadata, {
              artifact_kind: "metadata-file",
              platform: "android",
              arch: null,
              filetype: inferIosFiletype(opts.metadata),
              metadata_json: { filename: basename(opts.metadata) },
            }),
          );
        }

        // Only a build created pending needs activating; when there is no --mapping it
        // was already created succeeded above.
        if (opts.mapping) {
          // Every declared slot is uploaded and verified now. The server re-checks
          // each one and returns REQUIRED_ASSETS_INCOMPLETE if any is missing, so a
          // failure here is a real signal rather than a formality.
          await apiRequest(`/api/apps/${appId}/builds/${build.id}`, {
            method: "PATCH",
            body: { status: "succeeded" },
          });
        }

        const release = await createReleaseOrTerminalizeVersionConflict({
          appId,
          buildId: build.id,
          provenance,
          releaseBody: {
            build_id: build.id,
            channel_id: channelId,
            product_type: opts.productType,
            release_type: opts.releaseType,
            status: opts.draft ? "draft" : "active",
            changelog,
            should_force_update: Boolean(opts.forceUpdate),
            provenance_json: provenance,
            scopes: [{ scope_type: "full", scope_value: "all" }],
          },
        });

        const result = {
          app_id: appId,
          build_id: build.id,
          release_id: release.id,
          channel: opts.channel,
          version_name: opts.versionName,
          version_code: versionCode,
          assets,
        };
        if (shouldOutputJson(program, jsonRequested(program, opts.json))) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }
        console.log(`Published Android release ${opts.versionName} (${versionCode})`);
        console.log(`  build:   ${build.id}`);
        console.log(`  release: ${release.id}`);
        console.log(`  channel: ${opts.channel}`);
        console.log(`  assets:  ${assets.map((a) => `${a.artifact_kind}:${a.filetype}`).join(", ")}`);
      },
    );

  builds
    .command("publish-ios <appIdOrSlug>")
    .description(
      "Register an iOS build/release and upload the signed .ipa plus its dSYM archive for crash symbolication. Hands stores and associates the build; it does not sign (macOS CI produces the signed .ipa).",
    )
    .requiredOption("--ipa <path>", "Signed .ipa installable artifact.")
    .requiredOption("--version-name <name>", "iOS CFBundleShortVersionString.")
    .requiredOption(
      "--version-code <code>",
      "iOS CFBundleVersion — must match what the app reports so crashes symbolicate against the right dSYM.",
    )
    .option("--channel <slug>", "Hands channel slug.", "main")
    .option("--release-type <type>", "Release type metadata.", "stable")
    .option("--product-type <type>", "Product type metadata.", "ios-ipa")
    .option("--dsym <path>", "dSYM archive (dSYM.zip) for crash symbolication (strongly recommended).")
    .option("--metadata <path>", "Build metadata JSON support artifact.")
    .option(
      "--changelog <text>",
      "Inline changelog. Repeatable with lang=text for multiple languages.",
      collect,
      [],
    )
    .option(
      "--changelog-file <path>",
      "Read changelog from file. Repeatable with lang=path, e.g. --changelog-file zh=zh.md --changelog-file en=en.md.",
      collect,
      [],
    )
    .option("--source-commit <sha>", "Source commit SHA.")
    .option("--source-branch <branch>", "Source branch.")
    .option("--build-time <iso>", "Build time. Defaults to now.")
    .option("--ci-provider <name>", "CI provider name.")
    .option("--ci-run-id <id>", "CI run id.")
    .option("--ci-url <url>", "CI run URL.")
    .option("--export-method <method>", "Xcode export method (app-store, ad-hoc, development, enterprise).")
    .option("--appstore-build-number <n>", "App Store Connect build number.")
    .option("--testflight-status <status>", "TestFlight processing status.")
    .option("--force-update", "Mark release as force update.", false)
    .option("--draft", "Create draft release instead of active.", false)
    .option("--json", "Output JSON.", false)
    .action(
      async (
        appIdOrSlug: string,
        opts: {
          ipa: string;
          versionName: string;
          versionCode: string;
          channel: string;
          releaseType: string;
          productType: string;
          dsym?: string;
          metadata?: string;
          changelog?: string[];
          changelogFile?: string[];
          sourceCommit?: string;
          sourceBranch?: string;
          buildTime?: string;
          ciProvider?: string;
          ciRunId?: string;
          ciUrl?: string;
          exportMethod?: string;
          appstoreBuildNumber?: string;
          testflightStatus?: string;
          forceUpdate?: boolean;
          draft?: boolean;
          json?: boolean;
        },
      ) => {
        // Before any upload: a non-human caller cannot create an active release.
        await assertActiveReleaseAllowed(opts.draft);
        const appId = await resolveAppId(appIdOrSlug);
        const channelId = await resolveChannelId(appId, opts.channel);
        const versionCode = Number(opts.versionCode);
        if (!Number.isFinite(versionCode) || versionCode < 0) {
          throw new Error("--version-code must be a non-negative number");
        }
        for (const file of [opts.ipa, opts.dsym, opts.metadata].filter(Boolean) as string[]) {
          if (!existsSync(file)) throw new Error(`missing file: ${file}`);
        }
        const ipaName = basename(opts.ipa);
        const changelog = parseChangelogOptions(opts);
        const metadataJson = opts.metadata
          ? JSON.parse(readFileSync(opts.metadata, "utf8"))
          : {};
        const buildMetadata = {
          ...metadataJson,
          ios: {
            ipa: ipaName,
            dsym: opts.dsym ? basename(opts.dsym) : null,
            signed: true,
            signing_owner: "ci",
            export_method: opts.exportMethod ?? null,
            appstore_build_number: opts.appstoreBuildNumber ?? null,
            testflight_status: opts.testflightStatus ?? null,
          },
        };
        const provenance = {
          source_commit: opts.sourceCommit ?? null,
          source_branch: opts.sourceBranch ?? null,
          build_time: opts.buildTime ?? new Date().toISOString(),
          ci_provider: opts.ciProvider ?? null,
          ci_run_id: opts.ciRunId ?? null,
          ci_url: opts.ciUrl ?? null,
        };
        // Files go straight to R2 through presigned PUTs (direct asset ingest
        // protocol v1), not through the Worker: a signed .ipa can exceed the
        // 100 MiB request body limit in front of /api/apps/:id/upload. The build
        // stays pending until every declared slot is verified by sha256 and size.
        const planned: Array<{
          path: string;
          artifact_kind: string;
          filetype: string;
          metadata_json: Record<string, unknown>;
        }> = [
          {
            path: opts.ipa,
            artifact_kind: "installable",
            filetype: inferIosFiletype(opts.ipa),
            metadata_json: { filename: ipaName, signed: true, distribution: "testflight" },
          },
        ];
        if (opts.dsym) {
          planned.push({
            path: opts.dsym,
            artifact_kind: "dsym",
            filetype: inferIosFiletype(opts.dsym),
            metadata_json: { filename: basename(opts.dsym) },
          });
        }
        if (opts.metadata) {
          planned.push({
            path: opts.metadata,
            artifact_kind: "metadata-file",
            filetype: inferIosFiletype(opts.metadata),
            metadata_json: { filename: basename(opts.metadata) },
          });
        }
        const localDigests = new Map<string, { sha256: string; sizeBytes: number }>();
        for (const entry of planned) localDigests.set(entry.path, await sha256File(entry.path));

        const build = await createAdmittedPublishBuild({
          appId,
          channelId,
          productType: opts.productType,
          releaseType: opts.releaseType,
          versionName: opts.versionName,
          versionCode,
          buildBody: {
            channel_id: channelId,
            product_type: opts.productType,
            release_type: opts.releaseType,
            version_name: opts.versionName,
            version_code: versionCode,
            changelog,
            source: "cli",
            status: "pending",
            asset_ingest_protocol_version: 1,
            required_asset_slots_json: planned.map((entry) => ({
              artifact_kind: entry.artifact_kind,
              platform: "ios",
              arch: null,
              variant: null,
              filetype: entry.filetype,
            })),
            build_metadata_json: buildMetadata,
            provenance_json: provenance,
            should_force_update: Boolean(opts.forceUpdate),
          },
        });

        const assets = [];
        for (const entry of planned) {
          const local = localDigests.get(entry.path)!;
          const asset = await uploadDirectBuildAsset(appId, build.id, entry.path, {
            artifact_kind: entry.artifact_kind,
            platform: "ios",
            arch: null,
            filetype: entry.filetype,
            metadata_json: entry.metadata_json,
          });
          if (asset.file_hash !== local.sha256 || asset.size_bytes !== local.sizeBytes) {
            throw new Error(
              `uploaded ${basename(entry.path)} (${asset.file_hash}, ${asset.size_bytes} bytes) does not match local bytes ` +
                `(${local.sha256}, ${local.sizeBytes} bytes); build ${build.id} left pending for inspection`,
            );
          }
          assets.push(asset);
        }

        await apiRequest(`/api/apps/${appId}/builds/${build.id}`, {
          method: "PATCH",
          body: { status: "succeeded" },
        });

        const release = await createReleaseOrTerminalizeVersionConflict({
          appId,
          buildId: build.id,
          provenance,
          releaseBody: {
            build_id: build.id,
            channel_id: channelId,
            product_type: opts.productType,
            release_type: opts.releaseType,
            status: opts.draft ? "draft" : "active",
            changelog,
            should_force_update: Boolean(opts.forceUpdate),
            provenance_json: provenance,
            scopes: [{ scope_type: "full", scope_value: "all" }],
          },
        });

        const result = {
          app_id: appId,
          build_id: build.id,
          release_id: release.id,
          channel: opts.channel,
          version_name: opts.versionName,
          version_code: versionCode,
          assets,
        };
        if (shouldOutputJson(program, jsonRequested(program, opts.json))) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }
        console.log(`Published iOS release ${opts.versionName} (${versionCode})`);
        console.log(`  build:   ${build.id}`);
        console.log(`  release: ${release.id}`);
        console.log(`  channel: ${opts.channel}`);
        console.log(`  assets:  ${assets.map((a) => `${a.artifact_kind}:${a.filetype}`).join(", ")}`);
        if (!opts.dsym) {
          console.error(
            "warning: no --dsym uploaded; iOS crashes for this version_code won't symbolicate.",
          );
        }
        console.log(
          "  note:    upload this Hands build with the server-side upload-testflight-build action.",
        );
      },
    );

  builds
    .command("attach-symbols <appIdOrSlug> <buildId> <file>")
    .description(
      "Attach a debug-symbol file (ProGuard mapping, native symbols or dSYM) to an existing build, " +
        "including one that has already published. Add-only: an existing asset for the same slot is not replaced.",
    )
    .option(
      "--kind <kind>",
      "proguard-mapping | native-symbols | dsym. Inferred from the filename when omitted.",
    )
    .option("--platform <platform>", "Platform for native symbols when the build type does not identify one.")
    .option("--json", "Output JSON.", false)
    .action(
      async (
        appIdOrSlug: string,
        buildId: string,
        filePath: string,
        opts: { kind?: string; platform?: string; json?: boolean },
      ) => {
        if (!existsSync(filePath)) throw new Error(`missing file: ${filePath}`);
        const kind = opts.kind ?? inferSymbolKind(filePath);
        if (!SYMBOL_KINDS.has(kind)) {
          throw new Error(
            `--kind must be one of ${[...SYMBOL_KINDS].join(", ")}; got ${kind}. ` +
              "Only debug symbols can be attached to an existing build.",
          );
        }
        if (opts.platform && kind !== "native-symbols") throw new Error("--platform is only valid for native-symbols");
        if (opts.platform && !/^[a-z0-9][a-z0-9-]{0,99}$/.test(opts.platform)) throw new Error("--platform must contain lowercase letters, numbers or hyphens");
        const appId = await resolveAppId(appIdOrSlug);
        const platform = opts.platform ?? await symbolPlatform(appId, buildId, kind);
        const asset = await uploadDirectBuildAsset(appId, buildId, filePath, {
          artifact_kind: kind,
          platform,
          arch: null,
          filetype: SYMBOL_FILETYPE[kind] ?? "mapping.txt",
        });
        if (shouldOutputJson(program, jsonRequested(program, opts.json))) {
          console.log(JSON.stringify(asset, null, 2));
          return;
        }
        console.log(`Attached ${kind} to build ${buildId} (sha256 ${asset.file_hash}).`);
      },
    );

  builds
    .command("testflight-groups <appIdOrSlug> <buildId>")
    .description(
      "List App Store Connect internal/external beta groups for an existing Hands iOS build.",
    )
    .option(
      "--bundle-id <id>",
      "Bundle-id assertion; must match immutable build metadata, or acts as fallback when metadata is absent.",
    )
    .option("--json", "Output JSON.", false)
    .action(
      async (
        appIdOrSlug: string,
        buildId: string,
        opts: { bundleId?: string; json?: boolean },
      ) => {
        const appId = await resolveAppId(appIdOrSlug);
        const result = await apiRequest<{
          hands_build_id: string;
          bundle_id: string;
          asc_app_id: string;
          groups: TestflightGroup[];
        }>(`/api/apps/${appId}/builds/${buildId}/testflight-groups`, {
          query: { bundle_id: opts.bundleId },
        });
        if (shouldOutputJson(program, jsonRequested(program, opts.json))) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }
        if (result.groups.length === 0) {
          console.log("No TestFlight beta groups found.");
          return;
        }
        for (const group of result.groups) {
          const kind = group.is_internal ? "internal" : "external";
          const automatic = group.has_access_to_all_builds ? " auto-all-builds" : "";
          console.log(`${group.id}  ${kind.padEnd(8)}  ${group.name ?? "(unnamed)"}${automatic}`);
        }
      },
    );

  builds
    .command("testflight-upload <appIdOrSlug> <buildId>")
    .description(
      "Upload the build's signed .ipa (already stored in Hands by publish-ios) to App Store Connect. " +
      "Hands streams it to Apple with the app's App Store Connect key; follow processing with testflight-status.",
    )
    .option(
      "--bundle-id <id>",
      "Bundle-id assertion; must match immutable build metadata, or acts as fallback when metadata is absent.",
    )
    .option("--json", "Output JSON.", false)
    .action(async (appIdOrSlug: string, buildId: string, opts: { bundleId?: string; json?: boolean }) => {
      const appId = await resolveAppId(appIdOrSlug);
      const res = await apiRequest<{
        operation_id: string;
        ok: boolean;
        asc_app_id?: string;
        build_upload_id?: string;
        parts_uploaded?: number;
        state?: { state?: string | null } | string | null;
        error?: string;
      }>(`/api/apps/${appId}/builds/${encodeURIComponent(buildId)}/testflight-upload`, {
        method: "POST",
        retryOnUnauthorized: false,
        body: opts.bundleId ? { bundle_id: opts.bundleId } : {},
      });
      if (shouldOutputJson(program, jsonRequested(program, opts.json))) {
        console.log(JSON.stringify(res, null, 2));
        if (!res.ok) process.exitCode = 1;
        return;
      }
      if (!res.ok) throw new Error(`TestFlight upload failed: ${res.error ?? "Apple refused the upload"}`);
      const state = typeof res.state === "string" ? res.state : res.state?.state ?? "unknown";
      console.log(`Uploaded to App Store Connect (build upload ${res.build_upload_id}, ${res.parts_uploaded} parts, state ${state}). Next: hands builds testflight-status ${appIdOrSlug} ${buildId}`);
    });

  builds
    .command("testflight-status <appIdOrSlug> <buildId>")
    .description(
      "Refresh live TestFlight processing, group assignment, beta review, auto-notify, and expiry state.",
    )
    .option("--distribution <mode>", "Project state for internal or external distribution.")
    .option(
      "--bundle-id <id>",
      "Bundle-id assertion; must match immutable build metadata, or acts as fallback when metadata is absent.",
    )
    .option("--json", "Output JSON.", false)
    .action(
      async (
        appIdOrSlug: string,
        buildId: string,
        opts: { distribution?: string; bundleId?: string; json?: boolean },
      ) => {
        if (
          opts.distribution !== undefined &&
          opts.distribution !== "internal" &&
          opts.distribution !== "external"
        ) {
          throw new Error("--distribution must be internal or external");
        }
        const appId = await resolveAppId(appIdOrSlug);
        const status = await getTestflightPublishStatus(appId, buildId, opts);
        if (shouldOutputJson(program, jsonRequested(program, opts.json))) {
          console.log(JSON.stringify(status, null, 2));
          return;
        }
        console.log(
          `TestFlight ${status.version} (${status.build_number}): ${status.state}`,
        );
        console.log(`  ASC app:   ${status.asc_app_id}`);
        console.log(`  ASC build: ${status.asc_build_id ?? "not available yet"}`);
        if (status.processing_state) {
          console.log(`  processing: ${status.processing_state}`);
        }
        if (status.beta_review?.state) {
          console.log(`  beta review: ${status.beta_review.state}`);
        }
        if (status.assigned_groups && status.assigned_groups.length > 0) {
          console.log(
            `  groups: ${status.assigned_groups.map((group) => `${group.name ?? group.id} (${group.id})`).join(", ")}`,
          );
        }
      },
    );

  builds
    .command("testflight-expire <appIdOrSlug> <buildId>")
    .description(
      "Expire a TestFlight build in App Store Connect so testers can no longer install it (for example to free the review slot held by a build stuck in Beta App Review). Previews by default; --commit expires. Needs app admin. Apple keeps the build record; this never touches the App Store or a Hands release.",
    )
    .option("--commit", "Expire the build. Without it, only show what would be expired.", false)
    .option(
      "--asc-build-id <id>",
      "Refuse unless App Store Connect resolves this exact build id (the one shown by the preview).",
    )
    .option(
      "--bundle-id <id>",
      "Bundle-id assertion; must match immutable build metadata, or acts as fallback when metadata is absent.",
    )
    .option("--json", "Output JSON.", false)
    .action(
      async (
        appIdOrSlug: string,
        buildId: string,
        opts: { commit?: boolean; ascBuildId?: string; bundleId?: string; json?: boolean },
      ) => {
        const appId = await resolveAppId(appIdOrSlug);
        const json = shouldOutputJson(program, jsonRequested(program, opts.json));
        const status = await getTestflightPublishStatus(appId, buildId, {
          ...(opts.bundleId ? { bundleId: opts.bundleId } : {}),
        });
        const body = testflightExpireRequest(status, {
          ...(opts.ascBuildId ? { expectedAscBuildId: opts.ascBuildId } : {}),
          ...(opts.bundleId ? { bundleId: opts.bundleId } : {}),
        });
        if (!opts.commit) {
          if (json) {
            console.log(JSON.stringify({ preview: true, request: body, status }, null, 2));
            return;
          }
          console.log(`Would expire TestFlight ${status.version} (${status.build_number}):`);
          console.log(`  ASC build: ${status.asc_build_id}`);
          console.log(`  state:     ${status.state}${status.expired ? " (already expired)" : ""}`);
          if (status.beta_review?.state) console.log(`  beta review: ${status.beta_review.state}`);
          if (status.assigned_groups && status.assigned_groups.length > 0) {
            console.log(
              `  groups: ${status.assigned_groups.map((group) => `${group.name ?? group.id} (${group.id})`).join(", ")}`,
            );
          }
          console.log(
            `Nothing changed. To expire: hands builds testflight-expire ${appIdOrSlug} ${buildId} --asc-build-id ${status.asc_build_id} --commit`,
          );
          return;
        }
        const result = await apiRequest<TestflightPublishStatus & { changed?: boolean }>(
          `/api/apps/${appId}/builds/${buildId}/testflight-expire`,
          { method: "POST", body },
        );
        if (json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }
        console.log(
          result.changed === false
            ? `TestFlight ${result.version} (${result.build_number}) was already expired; nothing changed.`
            : `Expired TestFlight ${result.version} (${result.build_number}), ASC build ${result.asc_build_id}.`,
        );
        if (result.operation_id) console.log(`  operation: ${result.operation_id}`);
      },
    );

  builds
    .command("testflight-publish <appIdOrSlug> <buildId>")
    .description(
      "Distribute an already-processed App Store Connect build to TestFlight beta groups. This never publishes to the App Store or activates a Hands release.",
    )
    .requiredOption("--distribution <mode>", "internal or external.")
    .requiredOption(
      "--group-id <id>",
      "Stable beta group id from testflight-groups. Repeat for multiple groups.",
      collect,
    )
    .option(
      "--what-to-test <locale=text>",
      "Localized What to Test text. Repeat for multiple locales.",
      collect,
      [],
    )
    .option(
      "--what-to-test-file <locale=path>",
      "Read localized What to Test text from a file. Repeat for multiple locales.",
      collect,
      [],
    )
    .option(
      "--notify-testers",
      "External only: enable auto-notify before review, or notify an already-approved build when no auto-notify is pending.",
      false,
    )
    .option(
      "--bundle-id <id>",
      "Bundle-id assertion; must match immutable build metadata, or acts as fallback when metadata is absent.",
    )
    .option(
      "--wait",
      "Wait for Apple processing and the requested TestFlight terminal state.",
      false,
    )
    .option("--poll-interval-seconds <n>", "Polling interval while --wait is active.", "15")
    .option("--timeout-seconds <n>", "Maximum --wait duration.", "3600")
    .option("--json", "Output JSON.", false)
    .action(
      async (
        appIdOrSlug: string,
        buildId: string,
        opts: {
          distribution: string;
          groupId: string[];
          whatToTest?: string[];
          whatToTestFile?: string[];
          notifyTesters?: boolean;
          bundleId?: string;
          wait?: boolean;
          pollIntervalSeconds: string;
          timeoutSeconds: string;
          json?: boolean;
        },
      ) => {
        if (opts.distribution !== "internal" && opts.distribution !== "external") {
          throw new Error("--distribution must be internal or external");
        }
        if (opts.distribution === "internal" && opts.notifyTesters) {
          throw new Error("--notify-testers applies only to external distribution");
        }
        const appId = await resolveAppId(appIdOrSlug);
        const intervalSeconds = positiveSeconds(
          opts.pollIntervalSeconds,
          "--poll-interval-seconds",
        );
        const timeoutSeconds = positiveSeconds(
          opts.timeoutSeconds,
          "--timeout-seconds",
        );
        const quiet = shouldOutputJson(program, jsonRequested(program, opts.json));
        const distribution = opts.distribution;
        const statusParts: RecoveryPart[] = ["--distribution", { field: "distribution", value: distribution }];
        if (opts.bundleId) statusParts.push("--bundle-id", { field: "bundleId", value: opts.bundleId });
        statusParts.push("--", { field: "appId", value: appId }, { field: "buildId", value: buildId });
        const statusCommand = recoveryGuidance("builds testflight-status", statusParts);
        const waitStartedAt = Date.now();
        if (opts.wait) {
          await waitForAscBuild(appId, buildId, {
            distribution,
            ...(opts.bundleId ? { bundleId: opts.bundleId } : {}),
            intervalSeconds,
            timeoutSeconds,
            quiet,
          });
        }

        const remainingBeforePublishMilliseconds =
          timeoutSeconds * 1000 - (Date.now() - waitStartedAt);
        if (opts.wait && remainingBeforePublishMilliseconds <= 0) {
          throw new Error(
            `timed out after ${timeoutSeconds}s before TestFlight publish began`,
          );
        }
        const publishRequest = () =>
          apiRequest<TestflightPublishStatus>(
            `/api/apps/${appId}/builds/${buildId}/testflight-publish`,
            {
              method: "POST",
              retryOnUnauthorized: false,
              body: {
                distribution,
                group_ids: opts.groupId,
                what_to_test: parseWhatToTestOptions(opts),
                notify_testers: Boolean(opts.notifyTesters),
                ...(opts.bundleId ? { bundle_id: opts.bundleId } : {}),
              },
              ...(opts.wait
                ? {
                    signal: AbortSignal.timeout(
                      Math.max(
                        1,
                        Math.ceil(remainingBeforePublishMilliseconds),
                      ),
                    ),
                  }
                : {}),
            },
          );
        let result: TestflightPublishStatus;
        try {
          result = opts.wait
            ? await withTimeoutMessage(
                `timed out after ${timeoutSeconds}s while submitting the TestFlight publish request`,
                publishRequest,
              )
            : await publishRequest();
        } catch (error) {
          console.error(
            `TestFlight publish did not return a confirmed result. The outcome may be unknown; inspect the build with ${statusCommand} before retrying publish.`,
          );
          throw error;
        }
        const elapsedSeconds = (Date.now() - waitStartedAt) / 1000;
        const remainingTimeoutSeconds = Math.max(
          0,
          timeoutSeconds - elapsedSeconds,
        );
        let finalStatus = result;
        if (opts.wait) {
          try {
            if (remainingTimeoutSeconds === 0) {
              throw new Error(
                `timed out after ${timeoutSeconds}s before TestFlight distribution polling began`,
              );
            }
            finalStatus = await waitForTestflightDistribution(appId, buildId, {
              distribution,
              notifyTesters: Boolean(opts.notifyTesters),
              ...(opts.bundleId ? { bundleId: opts.bundleId } : {}),
              intervalSeconds,
              timeoutSeconds: remainingTimeoutSeconds,
              quiet,
            });
          } catch (error) {
            console.error(
              `TestFlight publish returned, but waiting for distribution did not complete successfully. Inspect the build with ${statusCommand} before retrying publish.`,
            );
            throw error;
          }
        }

        if (quiet) {
          console.log(JSON.stringify(finalStatus, null, 2));
          return;
        }
        console.log(
          `TestFlight ${distribution} publish: ${finalStatus.state}`,
        );
        console.log(`  Hands build: ${finalStatus.hands_build_id}`);
        console.log(`  ASC build:   ${finalStatus.asc_build_id}`);
        console.log(`  groups:      ${opts.groupId.join(", ")}`);
        if (finalStatus.beta_review?.state) {
          console.log(`  beta review: ${finalStatus.beta_review.state}`);
        }
        if (finalStatus.notification) {
          console.log(`  notification: ${finalStatus.notification}`);
        }
      },
    );

  builds
    .command("publish-ohos <appIdOrSlug>")
    .description(
      "Create an OHOS build/release and upload the signed AppGallery .app plus a standalone signed .hap for sideloading.",
    )
    .requiredOption("--app <path>", "Signed App Pack (.app) for AppGallery submission.")
    .requiredOption("--hap <path>", "Standalone signed HAP (.hap) for user sideloading.")
    .requiredOption("--version-name <name>", "OHOS versionName.")
    .requiredOption("--version-code <code>", "OHOS versionCode.")
    .option("--channel <slug>", "Hands channel slug.", "main")
    .option("--release-type <type>", "Release type metadata.", "stable")
    .option("--product-type <type>", "Product type metadata.", "ohos-app")
    .option("--symbols <path>", "Native symbols/source maps archive.")
    .option("--metadata <path>", "OHOS release metadata JSON support artifact.")
    .option(
      "--changelog <text>",
      "Inline changelog. Repeatable with lang=text for multiple languages.",
      collect,
      [],
    )
    .option(
      "--changelog-file <path>",
      "Read changelog from file. Repeatable with lang=path, e.g. --changelog-file zh=zh.md --changelog-file en=en.md.",
      collect,
      [],
    )
    .option("--source-commit <sha>", "Source commit SHA.")
    .option("--source-branch <branch>", "Source branch.")
    .option("--build-time <iso>", "Build time. Defaults to now.")
    .option("--ci-provider <name>", "CI provider name.")
    .option("--ci-run-id <id>", "CI run id.")
    .option("--ci-url <url>", "CI run URL.")
    .option("--force-update", "Mark release as force update.", false)
    .option("--draft", "Create draft release instead of active.", false)
    .option("--json", "Output JSON.", false)
    .action(
      async (
        appIdOrSlug: string,
        opts: {
          app: string;
          hap: string;
          versionName: string;
          versionCode: string;
          channel: string;
          releaseType: string;
          productType: string;
          symbols?: string;
          metadata?: string;
          changelog?: string[];
          changelogFile?: string[];
          sourceCommit?: string;
          sourceBranch?: string;
          buildTime?: string;
          ciProvider?: string;
          ciRunId?: string;
          ciUrl?: string;
          forceUpdate?: boolean;
          draft?: boolean;
          json?: boolean;
        },
      ) => {
        // Before any upload: a non-human caller cannot create an active release.
        await assertActiveReleaseAllowed(opts.draft);
        const appId = await resolveAppId(appIdOrSlug);
        const channelId = await resolveChannelId(appId, opts.channel);
        const versionCode = Number(opts.versionCode);
        if (!Number.isFinite(versionCode) || versionCode < 0) {
          throw new Error("--version-code must be a non-negative number");
        }
        for (const file of [opts.app, opts.hap, opts.symbols, opts.metadata].filter(Boolean) as string[]) {
          if (!existsSync(file)) throw new Error(`missing file: ${file}`);
        }
        if (inferOhosFiletype(opts.app) !== "app") {
          throw new Error("--app must point to an .app file");
        }
        if (inferOhosFiletype(opts.hap) !== "hap") {
          throw new Error("--hap must point to a .hap file");
        }

        const changelog = parseChangelogOptions(opts);
        const metadataJson = opts.metadata
          ? JSON.parse(readFileSync(opts.metadata, "utf8"))
          : {};
        const provenance = {
          source_commit: opts.sourceCommit ?? null,
          source_branch: opts.sourceBranch ?? null,
          build_time: opts.buildTime ?? new Date().toISOString(),
          ci_provider: opts.ciProvider ?? null,
          ci_run_id: opts.ciRunId ?? null,
          ci_url: opts.ciUrl ?? null,
        };
        const build = await createAdmittedPublishBuild({
          appId,
          channelId,
          productType: opts.productType,
          releaseType: opts.releaseType,
          versionName: opts.versionName,
          versionCode,
          buildBody: {
            channel_id: channelId,
            product_type: opts.productType,
            release_type: opts.releaseType,
            version_name: opts.versionName,
            version_code: versionCode,
            changelog,
            source: "cli",
            status: "succeeded",
            build_metadata_json: {
              ...metadataJson,
              ohos: {
                app: basename(opts.app),
                hap: basename(opts.hap),
                signed: true,
                signing_owner: "ci",
              },
            },
            provenance_json: provenance,
            should_force_update: Boolean(opts.forceUpdate),
          },
        });

        const assets = [];
        assets.push(
          await uploadAndRegisterAsset(appId, build.id, opts.app, {
            artifact_kind: "installable",
            platform: "ohos",
            arch: null,
            variant: "appgallery",
            filetype: "app",
            metadata_json: {
              filename: basename(opts.app),
              signed: true,
              distribution: "appgallery",
            },
          }),
        );
        assets.push(
          await uploadAndRegisterAsset(appId, build.id, opts.hap, {
            artifact_kind: "installable",
            platform: "ohos",
            arch: null,
            variant: "sideload",
            filetype: "hap",
            metadata_json: {
              filename: basename(opts.hap),
              signed: true,
              distribution: "sideload",
            },
          }),
        );
        if (opts.symbols) {
          assets.push(
            await uploadAndRegisterAsset(appId, build.id, opts.symbols, {
              artifact_kind: "native-symbols",
              platform: "ohos",
              arch: null,
              filetype: inferOhosFiletype(opts.symbols),
              metadata_json: { filename: basename(opts.symbols) },
            }),
          );
        }
        if (opts.metadata) {
          assets.push(
            await uploadAndRegisterAsset(appId, build.id, opts.metadata, {
              artifact_kind: "metadata-file",
              platform: "ohos",
              arch: null,
              filetype: inferOhosFiletype(opts.metadata),
              metadata_json: { filename: basename(opts.metadata) },
            }),
          );
        }

        const release = await createReleaseOrTerminalizeVersionConflict({
          appId,
          buildId: build.id,
          provenance,
          releaseBody: {
            build_id: build.id,
            channel_id: channelId,
            product_type: opts.productType,
            release_type: opts.releaseType,
            status: opts.draft ? "draft" : "active",
            changelog,
            should_force_update: Boolean(opts.forceUpdate),
            provenance_json: provenance,
            scopes: [{ scope_type: "full", scope_value: "all" }],
          },
        });

        const result = {
          app_id: appId,
          build_id: build.id,
          release_id: release.id,
          channel: opts.channel,
          version_name: opts.versionName,
          version_code: versionCode,
          assets,
        };
        if (shouldOutputJson(program, jsonRequested(program, opts.json))) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }
        console.log(`Published OHOS release ${opts.versionName} (${versionCode})`);
        console.log(`  build:   ${build.id}`);
        console.log(`  release: ${release.id}`);
        console.log(`  channel: ${opts.channel}`);
        console.log(`  assets:  ${assets.map((a) => `${a.artifact_kind}:${a.filetype}`).join(", ")}`);
      },
    );

  builds
    .command("publish-electron <appIdOrSlug>")
    .description("Create an Electron generic-provider build/release and upload electron-builder output.")
    .requiredOption("--version-name <name>", "Electron app version.")
    .requiredOption("--version-code <code>", "Hands version code used for ordering.")
    .option("--metadata <path>", "electron-builder latest*.yml file. Repeatable.", collect, [])
    .option("--installer <path>", "Electron installer/update artifact. Repeatable.", collect, [])
    .option("--blockmap <path>", "Electron .blockmap artifact. Repeatable.", collect, [])
    .option(
      "--symbols <path>",
      "Breakpad symbols archive (dump_syms output, .zip) for crash symbolication. Repeatable.",
      collect,
      [],
    )
    .option("--channel <slug>", "Hands release channel slug.", "main")
    .option("--platform <platform>", "Electron platform metadata. Defaults from metadata filename or win32.")
    .option("--arch <arch>", "Electron arch metadata.")
    .option("--release-type <type>", "Release type metadata.", "stable")
    .option("--product-type <type>", "Product type metadata.", "electron-installer")
    .option(
      "--changelog <text>",
      "Inline changelog. Repeatable with lang=text for multiple languages.",
      collect,
      [],
    )
    .option(
      "--changelog-file <path>",
      "Read changelog from file. Repeatable with lang=path, e.g. --changelog-file zh=zh.md --changelog-file en=en.md.",
      collect,
      [],
    )
    .option("--source-commit <sha>", "Source commit SHA.")
    .option("--source-branch <branch>", "Source branch.")
    .option("--build-time <iso>", "Build time. Defaults to now.")
    .option("--ci-provider <name>", "CI provider name.")
    .option("--ci-run-id <id>", "CI run id.")
    .option("--ci-url <url>", "CI run URL.")
    .option("--force-update", "Mark release as force update.", false)
    .option("--draft", "Create draft release instead of active.", false)
    .option("--json", "Output JSON.", false)
    .action(
      async (
        appIdOrSlug: string,
        opts: {
          versionName: string;
          versionCode: string;
          metadata: string[];
          installer: string[];
          blockmap: string[];
          symbols: string[];
          channel: string;
          platform?: string;
          arch?: string;
          releaseType: string;
          productType: string;
          changelog?: string[];
          changelogFile?: string[];
          sourceCommit?: string;
          sourceBranch?: string;
          buildTime?: string;
          ciProvider?: string;
          ciRunId?: string;
          ciUrl?: string;
          forceUpdate?: boolean;
          draft?: boolean;
          json?: boolean;
        },
      ) => {
        // Before any upload: a non-human caller cannot create an active release.
        await assertActiveReleaseAllowed(opts.draft);
        const files = [...opts.metadata, ...opts.installer, ...opts.blockmap, ...opts.symbols];
        if (files.length === 0) {
          throw new Error("provide at least one --metadata, --installer, --blockmap, or --symbols file");
        }
        const metadataFiles = opts.metadata;
        const installerFiles = opts.installer;
        const blockmapFiles = opts.blockmap;
        const symbolsFiles = opts.symbols;
        for (const file of files) {
          if (!existsSync(file)) throw new Error(`missing file: ${file}`);
        }

        const appId = await resolveAppId(appIdOrSlug);
        const channelId = await resolveChannelId(appId, opts.channel);
        const versionCode = Number(opts.versionCode);
        if (!Number.isFinite(versionCode) || versionCode < 0) {
          throw new Error("--version-code must be a non-negative number");
        }

        const primaryPlatform = opts.platform ?? inferElectronPlatform(metadataFiles[0] ?? installerFiles[0]);
        const arch = opts.arch ?? null;
        const changelog = parseChangelogOptions(opts);
        const provenance = {
          source_commit: opts.sourceCommit ?? null,
          source_branch: opts.sourceBranch ?? null,
          build_time: opts.buildTime ?? new Date().toISOString(),
          ci_provider: opts.ciProvider ?? null,
          ci_run_id: opts.ciRunId ?? null,
          ci_url: opts.ciUrl ?? null,
        };
        const buildMetadata = {
          electron: {
            metadata_files: metadataFiles.map((file) => basename(file)),
            installer_files: installerFiles.map((file) => basename(file)),
            blockmap_files: blockmapFiles.map((file) => basename(file)),
            platform: primaryPlatform,
            arch,
          },
        };
        const build = await createAdmittedPublishBuild({
          appId,
          channelId,
          productType: opts.productType,
          releaseType: opts.releaseType,
          versionName: opts.versionName,
          versionCode,
          buildBody: {
            channel_id: channelId,
            product_type: opts.productType,
            release_type: opts.releaseType,
            version_name: opts.versionName,
            version_code: versionCode,
            changelog,
            source: "cli",
            status: "succeeded",
            build_metadata_json: buildMetadata,
            provenance_json: provenance,
            should_force_update: Boolean(opts.forceUpdate),
          },
        });

        const assets = [];
        for (const file of metadataFiles) {
          const platform = opts.platform ?? inferElectronPlatform(file);
          const fileName = basename(file);
          assets.push(
            await uploadAndRegisterAsset(appId, build.id, file, {
              artifact_kind: "electron-metadata",
              platform,
              arch,
              filetype: inferElectronFiletype(file),
              variant: fileName,
              metadata_json: { filename: fileName },
            }),
          );
        }
        for (const file of installerFiles) {
          const fileName = basename(file);
          assets.push(
            await uploadAndRegisterAsset(appId, build.id, file, {
              artifact_kind: "installable",
              platform: primaryPlatform,
              arch,
              filetype: inferElectronFiletype(file),
              metadata_json: { filename: fileName },
            }),
          );
        }
        for (const file of blockmapFiles) {
          const fileName = basename(file);
          assets.push(
            await uploadAndRegisterAsset(appId, build.id, file, {
              artifact_kind: "electron-blockmap",
              platform: primaryPlatform,
              arch,
              filetype: "blockmap",
              metadata_json: { filename: fileName },
            }),
          );
        }
        for (const file of symbolsFiles) {
          const fileName = basename(file);
          assets.push(
            await uploadAndRegisterAsset(appId, build.id, file, {
              artifact_kind: "breakpad-symbols",
              platform: primaryPlatform,
              arch,
              filetype: "breakpad.zip",
              metadata_json: { filename: fileName },
            }),
          );
        }

        const release = await createReleaseOrTerminalizeVersionConflict({
          appId,
          buildId: build.id,
          provenance,
          releaseBody: {
            build_id: build.id,
            channel_id: channelId,
            product_type: opts.productType,
            release_type: opts.releaseType,
            status: opts.draft ? "draft" : "active",
            changelog,
            should_force_update: Boolean(opts.forceUpdate),
            provenance_json: provenance,
            scopes: [{ scope_type: "full", scope_value: "all" }],
          },
        });

        const result = {
          app_id: appId,
          build_id: build.id,
          release_id: release.id,
          channel: opts.channel,
          version_name: opts.versionName,
          version_code: versionCode,
          assets,
        };
        if (shouldOutputJson(program, jsonRequested(program, opts.json))) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }
        console.log(`Published Electron release ${opts.versionName} (${versionCode})`);
        console.log(`  build:   ${build.id}`);
        console.log(`  release: ${release.id}`);
        console.log(`  channel: ${opts.channel}`);
        console.log(`  assets:  ${assets.map((a) => `${a.artifact_kind}:${a.filetype}`).join(", ")}`);
      },
    );

}

export async function resolveAppId(slugOrId: string): Promise<string> {
  if (slugOrId.length === 36 && slugOrId.split("-").length === 5) {
    return slugOrId;
  }
  const res = await apiRequest<{
    apps: Array<{ id: string; slug: string }>;
  }>("/api/apps");
  const match = res.apps.find((a) => a.slug === slugOrId);
  if (!match) {
    console.error(`No app with slug '${slugOrId}'.`);
    process.exit(1);
  }
  return match.id;
}

export async function resolveChannelId(appId: string, channelSlugOrId: string): Promise<string> {
  const res = await apiRequest<{ channels: ChannelRow[] }>(`/api/apps/${appId}/channels`);
  const match = res.channels.find((channel) => channel.id === channelSlugOrId || channel.slug === channelSlugOrId);
  if (!match) {
    console.error(`No channel '${channelSlugOrId}' for app '${appId}'.`);
    process.exit(1);
  }
  return match.id;
}

async function uploadAndRegisterAsset(
  appId: string,
  buildId: string,
  filePath: string,
  metadata: {
    artifact_kind: string;
    platform: string;
    arch: string | null;
    filetype: string;
    variant?: string | null;
    metadata_json?: Record<string, unknown>;
  },
): Promise<{
  id: string;
  artifact_kind: string;
  filetype: string;
  file_hash: string;
  size_bytes: number;
}> {
  const uploaded = await apiUploadFile<UploadResponse>(`/api/apps/${appId}/upload`, filePath);
  const asset = await apiRequest<{ id: string }>(`/api/apps/${appId}/builds/${buildId}/assets`, {
    method: "POST",
    body: {
      ...metadata,
      r2_key: uploaded.r2_key,
      file_hash: uploaded.file_hash,
      size_bytes: uploaded.size_bytes,
      variant: metadata.variant ?? null,
      metadata_json: {
        original_filename: uploaded.original_filename,
        filename: basename(filePath),
        ...metadata.metadata_json,
      },
    },
  });
  return {
    id: asset.id,
    artifact_kind: metadata.artifact_kind,
    filetype: metadata.filetype,
    file_hash: uploaded.file_hash,
    size_bytes: uploaded.size_bytes,
  };
}

/** Debug-symbol kinds the server accepts for appending. */
const SYMBOL_KINDS = new Set(["proguard-mapping", "native-symbols", "dsym"]);
const SYMBOL_FILETYPE: Record<string, string> = {
  "proguard-mapping": "mapping.txt",
  "native-symbols": "symbols.zip",
  dsym: "dSYM.zip",
};

function inferSymbolKind(filePath: string): string {
  const name = basename(filePath).toLowerCase();
  if (name.includes("mapping")) return "proguard-mapping";
  if (name.includes("dsym")) return "dsym";
  return "native-symbols";
}

/** Native archives can describe multiple platforms; use the actual build type. */
async function symbolPlatform(appId: string, buildId: string, kind: string): Promise<string> {
  if (kind === "proguard-mapping") return "android";
  if (kind === "dsym") return "ios";
  const build = await apiRequest<{ product_type?: unknown }>(`/api/apps/${encodeURIComponent(appId)}/builds/${encodeURIComponent(buildId)}`);
  switch (build.product_type) {
    case "android-apk": return "android";
    case "ohos-app": return "ohos";
    case "ios-ipa": return "ios";
    default: throw new Error("Cannot determine the native-symbols platform for this build type; supply --platform");
  }
}

/**
 * POST the completion step, retrying transient transport failures and the
 * server's own transient answers (ASSET_UPLOAD_BUSY, `retryable: true`).
 *
 * Safe because the endpoint is a replay when the asset is already committed
 * (build_asset_uploads.ts returns the stored row when state='ready'), so a retry
 * can only produce the same result. Bounded (three attempts for transport
 * failures, six for server-marked ones) with growing backoff,
 * then surface the last error so a real failure is not hidden.
 */
/** Backoff unit for completeWithRetry; tests shorten it. */
let completeRetryBaseMs = 1000;
export function setCompleteRetryBaseMsForTests(ms: number): void {
  completeRetryBaseMs = ms;
}

async function completeWithRetry(appId: string, buildId: string, assetId: string) {
  // Transport failures: three attempts. Server-marked transient answers (a large
  // file's verification can take a while): up to six.
  const attempts = 6;
  const transportAttempts = 3;
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await apiRequest<{
        asset_id: string;
        file_hash: string;
        size_bytes: number;
      }>(`/api/apps/${appId}/builds/${buildId}/assets/${assetId}/upload/complete`, {
        method: "POST",
      });
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      const transport = /fetch failed|network|timeout|socket hang up|ECONNRESET|EAI_AGAIN/i.test(message);
      // The server marks its own transient answers: verification still running on
      // another request (ASSET_UPLOAD_BUSY) or a storage copy that failed with
      // `retryable: true`. Large files make both likelier.
      const body = error instanceof QuiverApiError && error.body && typeof error.body === "object"
        ? error.body as { code?: unknown; retryable?: unknown }
        : null;
      const serverTransient = !!body && (body.retryable === true || body.code === "ASSET_UPLOAD_BUSY");
      if (!(transport || serverTransient) || attempt === attempts) throw error;
      if (!serverTransient && attempt >= transportAttempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, Math.min(completeRetryBaseMs * attempt, 10 * completeRetryBaseMs)));
    }
  }
  throw lastError;
}

export async function uploadDirectBuildAsset(
  appId: string,
  buildId: string,
  filePath: string,
  metadata: {
    artifact_kind: string;
    platform: string;
    arch: string | null;
    filetype: string;
    variant?: string | null;
    metadata_json?: Record<string, unknown>;
  },
): Promise<{
  id: string;
  artifact_kind: string;
  filetype: string;
  file_hash: string;
  size_bytes: number;
}> {
  const local = await sha256File(filePath);
  const idempotencyKey = createHash("sha256").update(JSON.stringify({
    build_id: buildId,
    artifact_kind: metadata.artifact_kind,
    platform: metadata.platform,
    arch: metadata.arch,
    variant: metadata.variant ?? null,
    filetype: metadata.filetype,
    sha256: local.sha256,
    size_bytes: local.sizeBytes,
  })).digest("hex");
  const declared = await apiRequest<{
    asset_id: string;
    state: string;
    upload: null | {
      url: string;
      headers: Record<string, string>;
    };
  }>(`/api/apps/${appId}/builds/${buildId}/assets/uploads`, {
    method: "POST",
    body: {
      idempotency_key: `cli:${idempotencyKey}`,
      artifact_kind: metadata.artifact_kind,
      platform: metadata.platform,
      arch: metadata.arch,
      variant: metadata.variant ?? null,
      filetype: metadata.filetype,
      sha256: local.sha256,
      size_bytes: local.sizeBytes,
      filename: basename(filePath),
      content_type: "application/octet-stream",
      metadata_json: {
        filename: basename(filePath),
        ...metadata.metadata_json,
      },
    },
  });
  if (declared.state !== "ready") {
    if (!declared.upload) throw new Error("Hands did not return a direct upload URL");
    const uploadResponse = await fetch(declared.upload.url, {
      method: "PUT",
      headers: {
        ...declared.upload.headers,
        "content-length": String(local.sizeBytes),
      },
      body: createReadStream(filePath),
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    if (!uploadResponse.ok) {
      throw new Error(`direct R2 upload failed: ${uploadResponse.status} ${uploadResponse.statusText}`);
    }
  }
  // Completion is idempotent server-side: if the row is already 'ready' with a
  // committed key, the endpoint replays the stored result. So a transient network
  // failure here can be retried without risking a duplicate asset -- and NOT
  // retrying would report "fetch failed" for an upload that actually committed,
  // which is exactly what happened during the first real use of attach-symbols.
  const completed = await completeWithRetry(appId, buildId, declared.asset_id);
  return {
    id: completed.asset_id,
    artifact_kind: metadata.artifact_kind,
    filetype: metadata.filetype,
    file_hash: completed.file_hash,
    size_bytes: completed.size_bytes,
  };
}

export function inferOhosFiletype(path: string): string {
  const name = basename(path).toLowerCase();
  if (name.endsWith(".tar.gz")) return "symbols.tar.gz";
  if (name.endsWith(".json")) return "metadata.json";
  return extname(name).replace(/^\./, "") || "bin";
}

const ARCHIVE_PATCHER_VERSION = "3.0.0";
const ARCHIVE_PATCHER_URL = `https://repo1.maven.org/maven2/com/eidu/archive-patcher/${ARCHIVE_PATCHER_VERSION}/archive-patcher-${ARCHIVE_PATCHER_VERSION}.jar`;

/**
 * Prepare the archive-patcher toolchain in a temp dir: download the jar and
 * compile the bundled PatchGen wrapper (needs javac/java on PATH — CI has a
 * JDK for the Android build). Returns the classpath (jar:dir) to run PatchGen.
 */
export async function ensureArchivePatcher(dir: string): Promise<string> {
  const jarPath = join(dir, "archive-patcher.jar");
  const res = await fetch(ARCHIVE_PATCHER_URL);
  if (!res.ok) throw new Error(`failed to download archive-patcher jar: HTTP ${res.status}`);
  await writeFile(jarPath, Buffer.from(await res.arrayBuffer()));
  // PatchGen.java ships alongside the built CLI (package "patchgen" dir).
  const patchGenSrc = fileURLToPath(new URL("../../patchgen/PatchGen.java", import.meta.url));
  if (!existsSync(patchGenSrc)) {
    throw new Error(`bundled PatchGen.java not found at ${patchGenSrc}`);
  }
  await execFileAsync("javac", ["-encoding", "UTF-8", "-cp", jarPath, "-d", dir, patchGenSrc]);
  return `${jarPath}:${dir}`;
}

/**
 * Recompress a gzip PatchGen output as xz with the `xz` tool. Returns false
 * (and leaves no usable output) when `xz` is not installed, so callers can
 * keep the gzip patch alone.
 */
export async function compressAndroidDeltaPatchXz(
  gzipPatchPath: string,
  xzPatchPath: string,
  xzCommand = "xz",
): Promise<boolean> {
  const { createWriteStream } = await import("node:fs");
  const child = spawn(xzCommand, ANDROID_DELTA_PATCH_XZ_ARGS, { stdio: ["pipe", "pipe", "inherit"] });
  let spawnError: NodeJS.ErrnoException | undefined;
  const exited = new Promise<number | null>((resolve) => {
    child.once("error", (error) => {
      spawnError = error;
      resolve(null);
    });
    child.once("close", resolve);
  });
  const steps = [
    pipeline(createReadStream(gzipPatchPath), createGunzip(), child.stdin),
    pipeline(child.stdout, createWriteStream(xzPatchPath)),
    exited.then((code) => {
      if (spawnError) throw spawnError;
      if (code !== 0) throw new Error(`xz exited with code ${code}`);
    }),
  ];
  try {
    await Promise.all(steps);
    return true;
  } catch (error) {
    // Let every stream close (the output file included) before returning, so
    // callers can delete the work directory right away.
    await Promise.allSettled(steps);
    if (spawnError?.code === "ENOENT") return false;
    throw error;
  }
}

/** The Zucchini generator (WebAssembly in one Node script) shipped with the CLI, or null if missing. */
export function zucchiniGeneratorPath(): string | null {
  const path = fileURLToPath(new URL("../../zucchini/zucchini-gen.cjs", import.meta.url));
  if (!existsSync(path)) {
    console.error(`[delta] bundled Zucchini generator not found at ${path}; skipping zucchini patches.`);
    return null;
  }
  return path;
}

/**
 * A Zucchini patch takes one to six minutes for a 30 MB APK depending on the
 * machine; give up well past that.
 */
const ZUCCHINI_TIMEOUT_MS = 15 * 60 * 1000;

/** Peak memory of one Zucchini job (Node generator plus the PatchGen JVM), with headroom. */
const ZUCCHINI_JOB_MEMORY_BYTES = 1.5 * 1024 * 1024 * 1024;

/**
 * How many Zucchini jobs to run at once: one per CPU, as many as the free
 * memory allows, at least one.
 */
export function zucchiniConcurrency(
  jobs: number,
  cpus = availableParallelism(),
  freeBytes = availableMemory(),
): number {
  return Math.max(1, Math.min(jobs, cpus, Math.floor(freeBytes / ZUCCHINI_JOB_MEMORY_BYTES)));
}

/**
 * Whether a published APK can apply Zucchini patches (it was built with
 * Android SDK 0.16.0+). Devices on an older build would never download one,
 * so no patch is made from it. A failed check counts as "no".
 */
export async function apkCanApplyZucchini(classpath: string, apkPath: string, java = "java"): Promise<boolean> {
  try {
    await execFileAsync(java, ["-cp", classpath, "PatchGen", "--zucchini-capable", apkPath], {
      maxBuffer: 1024 * 1024,
    });
    return true;
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (code !== 1) {
      console.error(`[delta] Zucchini support check failed (${(error as Error).message}); treating as unsupported.`);
    }
    return false;
  }
}

/** Free memory, within a container's memory limit when Node can read it (Node 20.13+). */
function availableMemory(): number {
  const proc = process as { availableMemory?: () => number };
  return typeof proc.availableMemory === "function" ? proc.availableMemory() : freemem();
}

/** Run tasks with at most `limit` in flight, in order of start. */
async function runLimited(limit: number, tasks: Array<() => Promise<void>>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < tasks.length) await tasks[next++]!();
  };
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
}

/**
 * Make an archive-patcher-zucchini-v1+xz patch: PatchGen --zucchini runs the
 * Zucchini generator (with this Node) between the delta-friendly blobs and
 * writes the container gzip-compressed, which is then recompressed as xz like
 * the other variant.
 */
export async function generateZucchiniDeltaPatch(args: {
  classpath: string;
  generator: string;
  oldApkPath: string;
  newApkPath: string;
  work: string;
  name: string;
  java?: string;
  xz?: string;
  timeoutMs?: number;
}): Promise<{ path: string; sizeBytes: number; seconds: number }> {
  const started = Date.now();
  const gzPath = join(args.work, `${args.name}.zpatch.gz`);
  const xzPath = join(args.work, `${args.name}.zpatch.xz`);
  await execFileAsync(
    args.java ?? "java",
    [
      // archive-patcher's delta-friendly blobs go under work, which the caller removes.
      `-Djava.io.tmpdir=${args.work}`,
      // PatchGen kills its Zucchini child before this process's own limit
      // kills the JVM, so no generator is left running.
      `-Dhands.zucchini.timeoutSeconds=${Math.max(1, Math.floor((args.timeoutMs ?? ZUCCHINI_TIMEOUT_MS) / 1000) - 30)}`,
      "-cp", args.classpath, "PatchGen", "--zucchini", process.execPath, args.generator,
      args.oldApkPath, args.newApkPath, gzPath,
    ],
    { maxBuffer: 16 * 1024 * 1024, timeout: args.timeoutMs ?? ZUCCHINI_TIMEOUT_MS, killSignal: "SIGKILL" },
  );
  if (!(await compressAndroidDeltaPatchXz(gzPath, xzPath, args.xz))) {
    throw new Error("xz not installed");
  }
  await rm(gzPath, { force: true });
  return { path: xzPath, sizeBytes: statSync(xzPath).size, seconds: (Date.now() - started) / 1000 };
}

interface DeltaSource {
  from_version_code: number;
  arch: string | null;
  size_bytes: number;
  sha256: string;
  url: string;
}

/**
 * Generate archive-patcher delta patches from the last N published versions to
 * the just-uploaded build, and upload each as a delta-patch asset. A version
 * that shipped as several APKs (universal and per-ABI) is several sources, each
 * with its own work files and patches recording its sha256 and arch. The Worker
 * serves the source APKs (GET /api/apps/:id/delta-sources) and stores the
 * patches; the CPU-heavy bsdiff runs here in CI. Skips patches that don't beat
 * the full APK size.
 */
async function generateAndUploadAndroidDeltas(args: {
  appId: string;
  buildId: string;
  channelId: string;
  newApkPath: string;
  arch: string | null;
  toVersionCode: number;
  targetSha256: string;
  newApkSize: number;
  versions: number;
  /** Also generate Zucchini patches (needs xz too). */
  zucchini?: boolean;
}): Promise<Array<{ id: string; artifact_kind: string; filetype: string; file_hash: string; size_bytes: number }>> {
  const { sources } = await apiRequest<{ sources: DeltaSource[] }>(
    `/api/apps/${args.appId}/delta-sources`,
    // No arch (a universal APK) is sent as no parameter, which the server reads as "no arch".
    // channel_id picks sources from what the target channel's devices run (older
    // servers ignore it and return the nearest earlier versions).
    // per_version: every APK of a version (universal and per-ABI) is a source;
    // without it the server returns one per version for older CLIs.
    { query: { arch: args.arch ?? undefined, before: args.toVersionCode, limit: args.versions, channel_id: args.channelId, per_version: 3 } },
  );
  if (!sources || sources.length === 0) {
    console.error(`[delta] no prior published versions to diff against; skipping.`);
    return [];
  }

  const work = await mkdtemp(join(tmpdir(), "hands-delta-"));
  const uploaded: Array<{ id: string; artifact_kind: string; filetype: string; file_hash: string; size_bytes: number }> = [];
  try {
    const cp = await ensureArchivePatcher(work);
    let xzMissing = false;
    const zucchiniGenerator = args.zucchini ? zucchiniGeneratorPath() : null;
    const zucchiniJobs: Array<{ source: DeltaSource; label: string; name: string; oldPath: string; xzSize: number }> = [];
    for (const [index, src] of sources.entries()) {
      const name = deltaSourceWorkName(src, index);
      const label = deltaSourceLabel(src);
      // Which APK the patch applies to, recorded on every variant.
      const source = { fromSha256: src.sha256, fromArch: src.arch };
      const oldPath = join(work, `old-${name}.apk`);
      const patchPath = join(work, `${name}.patch.gz`);
      const dl = await fetch(src.url);
      if (!dl.ok) {
        console.error(`[delta] ${label}: download failed HTTP ${dl.status}; skipping.`);
        continue;
      }
      await writeFile(oldPath, Buffer.from(await dl.arrayBuffer()));
      await execFileAsync("java", ["-cp", cp, "PatchGen", oldPath, args.newApkPath, patchPath], {
        maxBuffer: 16 * 1024 * 1024,
      });
      const patchSize = readFileSync(patchPath).length;
      if (patchSize >= args.newApkSize) {
        console.error(`[delta] ${label}: patch ${patchSize}B not smaller than full APK ${args.newApkSize}B; skipping.`);
        continue;
      }
      console.error(`[delta] ${label} -> v${args.toVersionCode}: patch ${patchSize}B (${(patchSize / args.newApkSize * 100).toFixed(1)}% of full)`);
      uploaded.push(
        await uploadAndRegisterAsset(args.appId, args.buildId, patchPath, {
          artifact_kind: "delta-patch",
          platform: "android",
          arch: args.arch,
          filetype: "patch",
          metadata_json: androidDeltaPatchMetadata({
            fromVersionCode: src.from_version_code,
            toVersionCode: args.toVersionCode,
            targetSha256: args.targetSha256,
            ...source,
          }),
        }),
      );
      // The xz copy is an extra for SDK 0.15.0+; the gzip patch above is what
      // older SDKs apply, so an xz failure never fails the publish.
      const xzPath = join(work, `${name}.patch.xz`);
      if (!xzMissing) try {
        if (!(await compressAndroidDeltaPatchXz(patchPath, xzPath))) {
          console.error(`[delta] xz not installed; uploaded gzip patches only.`);
          xzMissing = true;
        } else {
          const xzSize = readFileSync(xzPath).length;
          if (xzSize >= patchSize) {
            console.error(`[delta] ${label}: xz ${xzSize}B not smaller than gzip; skipping xz.`);
          } else {
            console.error(`[delta] ${label} -> v${args.toVersionCode}: xz patch ${xzSize}B (${(xzSize / args.newApkSize * 100).toFixed(1)}% of full)`);
            uploaded.push(
              await uploadAndRegisterAsset(args.appId, args.buildId, xzPath, {
                artifact_kind: "delta-patch",
                platform: "android",
                arch: args.arch,
                filetype: "patch.xz",
                metadata_json: androidDeltaPatchMetadata({
                  fromVersionCode: src.from_version_code,
                  toVersionCode: args.toVersionCode,
                  targetSha256: args.targetSha256,
                  algorithm: ANDROID_DELTA_PATCH_XZ_ALGORITHM,
                  ...source,
                }),
              }),
            );
            // The Zucchini patch is a further extra for SDK 0.16.0+, made after
            // every gzip and xz patch is uploaded (it takes about a minute each).
            // Only devices on an SDK 0.16.0+ build can use it, so skip older sources.
            if (zucchiniGenerator) {
              if (await apkCanApplyZucchini(cp, oldPath)) {
                zucchiniJobs.push({ source: src, label, name, oldPath, xzSize });
              } else {
                console.error(`[delta] ${label}: built without Zucchini support (Android SDK < 0.16.0); skipping zucchini.`);
              }
            }
          }
        }
      } catch (error) {
        console.error(`[delta] ${label}: xz patch failed (${(error as Error).message}); gzip patch kept.`);
      }
    }
    // Older SDKs use the patches above, so a failure here never fails the publish.
    const zucchiniParallel = zucchiniConcurrency(zucchiniJobs.length);
    if (zucchiniGenerator && zucchiniJobs.length > 0) {
      console.error(`[delta] generating ${zucchiniJobs.length} zucchini patch(es), ${zucchiniParallel} at a time.`);
    }
    await runLimited(zucchiniParallel, (zucchiniGenerator ? zucchiniJobs : []).map((job) => async () => {
      try {
        const zucchini = await generateZucchiniDeltaPatch({
          classpath: cp,
          generator: zucchiniGenerator!,
          oldApkPath: job.oldPath,
          newApkPath: args.newApkPath,
          work,
          name: job.name,
        });
        if (zucchini.sizeBytes >= job.xzSize) {
          console.error(`[delta] ${job.label}: zucchini ${zucchini.sizeBytes}B not smaller than xz; skipping zucchini.`);
          return;
        }
        console.error(`[delta] ${job.label} -> v${args.toVersionCode}: zucchini patch ${zucchini.sizeBytes}B (${(zucchini.sizeBytes / args.newApkSize * 100).toFixed(1)}% of full, ${zucchini.seconds.toFixed(0)}s)`);
        uploaded.push(
          await uploadAndRegisterAsset(args.appId, args.buildId, zucchini.path, {
            artifact_kind: "delta-patch",
            platform: "android",
            arch: args.arch,
            filetype: "zpatch.xz",
            metadata_json: androidDeltaPatchMetadata({
              fromVersionCode: job.source.from_version_code,
              toVersionCode: args.toVersionCode,
              targetSha256: args.targetSha256,
              algorithm: ANDROID_DELTA_PATCH_ZUCCHINI_ALGORITHM,
              fromSha256: job.source.sha256,
              fromArch: job.source.arch,
            }),
          }),
        );
      } catch (error) {
        console.error(`[delta] ${job.label}: zucchini patch failed (${(error as Error).message}); gzip and xz patches kept.`);
      }
    }));
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => {});
  }
  return uploaded;
}

export function inferElectronPlatform(filePath: string | undefined): string {
  const name = filePath ? basename(filePath).toLowerCase() : "";
  if (name.includes("-mac.") || name.includes("mac") || name.endsWith(".dmg")) {
    return "darwin";
  }
  if (name.includes("-linux.") || name.includes("linux") || name.endsWith(".appimage")) {
    return "linux";
  }
  return "win32";
}

/**
 * Collector for repeated options. Commander otherwise keeps only the LAST value
 * of a repeated flag, which for `--target`/`--binary` would silently drop the
 * other targets of a multi-target release - a quiet wrong result rather than an
 * error. Collecting into an array keeps every occurrence.
 */
function collectRepeatable(value: string, previous: string[]): string[] {
  return [...previous, value];
}

export function splitBuildTarget(target: string): { platform: string; arch: string } {
  const match = /^(darwin|linux|win32)-(arm64|x64)$/.exec(target);
  if (!match) {
    throw new Error(
      "--target must be darwin-arm64, darwin-x64, linux-arm64, linux-x64, win32-arm64, or win32-x64",
    );
  }
  return { platform: match[1]!, arch: match[2]! };
}

function parseNonNegativeInteger(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${flag} must be a non-negative integer`);
  }
  return parsed;
}

export function versionCodeFromVersion(version: string): number {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version);
  if (!match) {
    throw new Error("--version-code is required when --version is not numeric major.minor.patch");
  }
  const parts = match.slice(1).map(Number);
  if (parts.some((part) => !Number.isSafeInteger(part) || part > 999)) {
    throw new Error("numeric version components must each be between 0 and 999");
  }
  return parts[0]! * 1_000_000 + parts[1]! * 1_000 + parts[2]!;
}

export function inferElectronFiletype(filePath: string): string {
  const name = basename(filePath);
  if (name.endsWith(".blockmap")) return "blockmap";
  if (name.endsWith(".AppImage")) return "AppImage";
  const ext = extname(name).replace(/^\./, "");
  return ext || "bin";
}

export function inferIosFiletype(filePath: string): string {
  const name = basename(filePath).toLowerCase();
  if (name.endsWith(".dsym.zip")) return "dsym.zip";
  if (name.endsWith(".ipa")) return "ipa";
  if (name.endsWith(".json")) return "metadata.json";
  const ext = extname(name).replace(/^\./, "");
  return ext || "bin";
}
