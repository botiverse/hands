/**
 * `hands builds publish-desktop` — publish one target of a desktop app.
 *
 * Steps, in order, so that nothing is published until every byte is verified:
 *   1. walk the bundle and build its manifest (every file hashed, symlinks recorded);
 *   2. ask Hands which file digests it does not hold (`/desktop/files/missing`);
 *   3. PUT those files straight to R2 (bounded concurrency, retried);
 *   4. have Hands verify them into content-addressed storage (`/desktop/files/complete`);
 *   5. create a pending build whose required slots are the manifest, the archive and
 *      the optional installer, upload them as direct build assets (Hands validates the
 *      manifest against the stored files when it seals it);
 *   6. mark the build succeeded and create the release.
 *
 * Files Hands already holds for this app (any earlier version) are not uploaded again.
 */

import type { Command } from "commander";
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { apiRequest, QuiverApiError } from "../lib/api.js";
import { assertActiveReleaseAllowed } from "../lib/release_preflight.js";
import { jsonRequested } from "../lib/json_output.js";
import {
  DESKTOP_TARGETS,
  buildDesktopManifest,
  isFileEntry,
  uniqueDigests,
  walkDesktopBundle,
} from "../lib/desktop_bundle.js";
import {
  createAdmittedPublishBuild,
  createReleaseOrTerminalizeVersionConflict,
  inferElectronFiletype,
  resolveAppId,
  resolveChannelId,
  shouldOutputJson,
  splitBuildTarget,
  uploadDirectBuildAsset,
} from "./builds.js";

/** Digests per `/missing` call: the server's limit. */
const MISSING_CHUNK = 1000;
/** The server verifies at most this many files per `/complete` call. */
const COMPLETE_CHUNK = 100;
const PUT_CONCURRENCY = 4;
const PUT_ATTEMPTS = 3;
const COMPLETE_ATTEMPTS = 3;

let retryBaseMs = 1000;
export function setDesktopRetryBaseMsForTests(ms: number): void {
  retryBaseMs = ms;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface MissingFile {
  sha256: string;
  size: number;
  upload_url: string;
  headers?: Record<string, string>;
}

interface CompleteResult {
  sha256: string;
  size: number;
  status: string;
  retryable: boolean;
}

async function mapBounded<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]!);
  }));
}

/**
 * PUT one file to its presigned URL, retrying transient failures. A 403 means the
 * URL expired (a long upload queue can outlive the hour it is valid): ask Hands for
 * a fresh one, which also reports the file as no longer missing if another run
 * stored it meanwhile.
 */
async function putFile(
  initial: MissingFile,
  path: string,
  refresh: () => Promise<MissingFile | null>,
): Promise<void> {
  let file = initial;
  let refreshed = false;
  let lastError: unknown;
  for (let attempt = 1; attempt <= PUT_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(file.upload_url, {
        method: "PUT",
        headers: {
          "content-type": "application/octet-stream",
          ...file.headers,
          "content-length": String(file.size),
        },
        body: file.size === 0 ? Buffer.alloc(0) : createReadStream(path),
        duplex: "half",
      } as RequestInit & { duplex: "half" });
      if (response.ok) return;
      lastError = new Error(`upload of ${basename(path)} failed: HTTP ${response.status}`);
      if (response.status === 403 && !refreshed) {
        refreshed = true;
        const fresh = await refresh();
        if (!fresh) return;
        file = fresh;
        attempt -= 1;
        continue;
      }
      // 4xx other than a timeout or throttling will not improve on retry.
      if (response.status < 500 && response.status !== 408 && response.status !== 429) break;
    } catch (error) {
      lastError = error;
    }
    if (attempt < PUT_ATTEMPTS) await sleep(retryBaseMs * attempt);
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function completeFiles(appId: string, files: Array<{ sha256: string; size: number }>): Promise<void> {
  let pending = files;
  for (let attempt = 1; attempt <= COMPLETE_ATTEMPTS && pending.length > 0; attempt += 1) {
    const response = await apiRequest<{ results: CompleteResult[] }>(`/api/apps/${appId}/desktop/files/complete`, {
      method: "POST",
      body: { files: pending },
    });
    const failed = response.results.filter((r) => r.status !== "stored" && r.status !== "present");
    const terminal = failed.filter((r) => !r.retryable);
    if (terminal.length > 0) {
      const first = terminal[0]!;
      throw new Error(
        `Hands refused ${terminal.length} uploaded file(s); first: ${first.sha256} (${first.status}). ` +
          "The bundle changed while publishing, or the upload was corrupted; re-run the command.",
      );
    }
    pending = failed.map((r) => ({ sha256: r.sha256, size: r.size }));
    if (pending.length > 0 && attempt < COMPLETE_ATTEMPTS) await sleep(retryBaseMs * attempt);
  }
  if (pending.length > 0) {
    throw new Error(`Hands could not store ${pending.length} file(s) after ${COMPLETE_ATTEMPTS} attempts (storage error); re-run the command`);
  }
}

export interface DesktopUploadSummary {
  files: number;
  links: number;
  unique: number;
  uploaded: number;
  uploaded_bytes: number;
  reused: number;
}

/** Steps 2-4: upload every digest Hands does not hold yet and have it verified. */
export async function uploadDesktopFiles(
  appId: string,
  digests: Array<{ sha256: string; size: number }>,
  pathsByDigest: Map<string, string>,
  onProgress?: (done: number, total: number) => void,
): Promise<{ uploaded: number; uploaded_bytes: number; reused: number }> {
  let uploaded = 0;
  let uploadedBytes = 0;
  for (let index = 0; index < digests.length; index += MISSING_CHUNK) {
    const chunk = digests.slice(index, index + MISSING_CHUNK);
    const { missing } = await apiRequest<{ missing: MissingFile[] }>(`/api/apps/${appId}/desktop/files/missing`, {
      method: "POST",
      body: { files: chunk },
    });
    let done = 0;
    await mapBounded(missing, PUT_CONCURRENCY, async (file) => {
      const path = pathsByDigest.get(file.sha256);
      if (!path) throw new Error(`Hands asked for a file this bundle does not contain: ${file.sha256}`);
      await putFile(file, path, async () => {
        const again = await apiRequest<{ missing: MissingFile[] }>(`/api/apps/${appId}/desktop/files/missing`, {
          method: "POST",
          body: { files: [{ sha256: file.sha256, size: file.size }] },
        });
        return again.missing[0] ?? null;
      });
      done += 1;
      onProgress?.(uploaded + done, digests.length);
    });
    for (let start = 0; start < missing.length; start += COMPLETE_CHUNK) {
      await completeFiles(appId, missing.slice(start, start + COMPLETE_CHUNK).map((f) => ({ sha256: f.sha256, size: f.size })));
    }
    uploaded += missing.length;
    uploadedBytes += missing.reduce((sum, f) => sum + f.size, 0);
  }
  return { uploaded, uploaded_bytes: uploadedBytes, reused: digests.length - uploaded };
}

function formatMegabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function registerPublishDesktopCommand(builds: Command, program: Command): void {
  builds
    .command("publish-desktop <appIdOrSlug>")
    .description(
      "Publish one target of a desktop app (any runtime): upload the bundle's files content-addressed " +
        "(files Hands already holds are reused), its manifest and full archive, an optional installer, and create the release.",
    )
    .requiredOption("--target <os-arch>", `Machine target: ${DESKTOP_TARGETS.join(", ")}.`)
    // Not `--version`: the root program owns that flag (it prints the CLI version).
    .requiredOption("--version-name <semver>", "Version name, for example 1.4.0.")
    .requiredOption("--version-code <int>", "Monotonic integer version code the app reports when it checks for updates.")
    .requiredOption("--bundle <path>", "The app bundle (.app directory) or install directory to publish.")
    .requiredOption("--archive <zip>", "Full archive (zip) of the same bundle, the fallback when an incremental update cannot be applied.")
    .option("--installer <file>", "Installer for first installs (dmg, pkg, msi, exe, AppImage, deb, ...).")
    .option("--channel <slug>", "Hands channel slug.", "main")
    .option("--product-type <type>", "Product type.", "desktop-installer")
    .option("--release-type <type>", "Release type metadata.", "stable")
    .option("--notes <text>", "Release notes.")
    .option("--notes-file <path>", "Read release notes from a file.")
    .option("--force-update", "Mark the release as a forced update.", false)
    .option("--draft", "Create a draft release instead of an active one.", false)
    .option("--json", "Output JSON.", false)
    .action(async (appIdOrSlug: string, opts: {
      target: string;
      versionName: string;
      versionCode: string;
      bundle: string;
      archive: string;
      installer?: string;
      channel: string;
      productType: string;
      releaseType: string;
      notes?: string;
      notesFile?: string;
      forceUpdate?: boolean;
      draft?: boolean;
      json?: boolean;
    }) => {
      if (!(DESKTOP_TARGETS as readonly string[]).includes(opts.target)) {
        throw new Error(`--target must be one of ${DESKTOP_TARGETS.join(", ")}`);
      }
      const { platform, arch } = splitBuildTarget(opts.target);
      const versionCode = Number(opts.versionCode);
      if (!Number.isSafeInteger(versionCode) || versionCode < 0) {
        throw new Error("--version-code must be a non-negative integer");
      }
      if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]+)?$/.test(opts.versionName)) {
        throw new Error("--version-name must be a semantic version such as 1.4.0");
      }
      if (opts.notes !== undefined && opts.notesFile !== undefined) {
        throw new Error("use either --notes or --notes-file, not both");
      }
      for (const file of [opts.archive, opts.installer].filter(Boolean) as string[]) {
        if (!existsSync(file) || !statSync(file).isFile()) throw new Error(`missing file: ${file}`);
      }
      if (!existsSync(opts.bundle)) throw new Error(`missing bundle: ${opts.bundle}`);
      const changelog = opts.notesFile !== undefined
        ? readFileSync(opts.notesFile, "utf8").trim()
        : opts.notes?.trim() ?? null;

      // Before any upload: a non-human caller cannot create an active release.
      await assertActiveReleaseAllowed(opts.draft);
      const appId = await resolveAppId(appIdOrSlug);
      const channelId = await resolveChannelId(appId, opts.channel);
      const versionQuery = {
        appId, channelId, productType: opts.productType, releaseType: opts.releaseType,
        versionName: opts.versionName, versionCode, draft: Boolean(opts.draft),
      };
      // One version is one build and one release carrying every target. Refuse early,
      // before any upload, when this version exists in a state that cannot take a target.
      const existing = await findVersionRelease(versionQuery);

      const walked = await walkDesktopBundle(opts.bundle);
      const manifest = buildDesktopManifest(opts.target, walked);
      const digests = uniqueDigests(manifest);
      const fileCount = manifest.files.filter(isFileEntry).length;
      const quiet = shouldOutputJson(program, jsonRequested(program, opts.json));
      if (!quiet) {
        console.error(`Bundle ${walked.root}: ${fileCount} files (${digests.length} distinct), ${manifest.files.length - fileCount} symlinks, ${formatMegabytes(manifest.total_size)}`);
      }
      const transfer = await uploadDesktopFiles(appId, digests, walked.pathsByDigest);
      const summary: DesktopUploadSummary = {
        files: fileCount,
        links: manifest.files.length - fileCount,
        unique: digests.length,
        ...transfer,
      };

      const work = await mkdtemp(join(tmpdir(), "hands-desktop-"));
      try {
        const manifestPath = join(work, `${walked.root}-${opts.target}.manifest.json`);
        await writeFile(manifestPath, JSON.stringify(manifest));
        // The manifest goes last: once it is sealed the target is live on a published
        // release, so the archive and installer it advertises must already be there.
        const planned: PlannedAsset[] = [
          ...(opts.installer
            ? [{ path: opts.installer, artifact_kind: "installable", filetype: inferElectronFiletype(opts.installer) }]
            : []),
          { path: opts.archive, artifact_kind: "desktop-archive", filetype: "zip" },
          { path: manifestPath, artifact_kind: "desktop-manifest", filetype: "json" },
        ];
        const slot = { platform, arch, target: opts.target };

        let buildId: string;
        let releaseId: string;
        let appended: boolean;
        let assets: UploadedAsset[];
        if (existing) {
          assets = await uploadTargetAssets(appId, existing.build_id, planned, slot);
          buildId = existing.build_id;
          releaseId = existing.id;
          appended = true;
        } else {
          const build = await createAdmittedPublishBuild({
            appId,
            channelId,
            productType: opts.productType,
            releaseType: opts.releaseType,
            versionName: opts.versionName,
            versionCode,
            buildBody: {
              changelog,
              source: "cli",
              status: "pending",
              asset_ingest_protocol_version: 1,
              required_asset_slots_json: planned.map((entry) => ({
                artifact_kind: entry.artifact_kind,
                platform,
                arch,
                variant: null,
                filetype: entry.filetype,
              })),
              build_metadata_json: {
                desktop: { first_target: opts.target, root: walked.root },
              },
              should_force_update: Boolean(opts.forceUpdate),
            },
          });
          assets = await uploadTargetAssets(appId, build.id, planned, slot);
          await apiRequest(`/api/apps/${appId}/builds/${build.id}`, { method: "PATCH", body: { status: "succeeded" } });
          try {
            const release = await createReleaseOrTerminalizeVersionConflict({
              appId,
              buildId: build.id,
              provenance: {},
              releaseBody: {
                build_id: build.id,
                channel_id: channelId,
                product_type: opts.productType,
                release_type: opts.releaseType,
                status: opts.draft ? "draft" : "active",
                changelog,
                should_force_update: Boolean(opts.forceUpdate),
                scopes: [{ scope_type: "full", scope_value: "all" }],
              },
            });
            buildId = build.id;
            releaseId = release.id;
            appended = false;
          } catch (error) {
            // Another target's job created this version between our lookup and now.
            // Our build was terminalized as failed; add this target to the winner.
            const winner = await findVersionRelease(versionQuery).catch(() => null);
            if (!winner || !isVersionConflict(error)) throw error;
            assets = await uploadTargetAssets(appId, winner.build_id, planned, slot);
            buildId = winner.build_id;
            releaseId = winner.id;
            appended = true;
          }
        }

        const result = {
          app_id: appId,
          build_id: buildId,
          release_id: releaseId,
          appended,
          channel: opts.channel,
          target: opts.target,
          version_name: opts.versionName,
          version_code: versionCode,
          draft: Boolean(opts.draft),
          files: summary,
          assets,
        };
        if (quiet) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }
        console.log(appended
          ? `Added desktop ${opts.target} to ${opts.versionName} (${versionCode})`
          : `Published desktop ${opts.target} ${opts.versionName} (${versionCode})${opts.draft ? " as a draft" : ""}`);
        console.log(`  build:   ${buildId}`);
        console.log(`  release: ${releaseId}${appended ? " (existing)" : ""}`);
        console.log(`  channel: ${opts.channel}`);
        console.log(`  files:   ${summary.files} total; uploaded ${summary.uploaded} new (${formatMegabytes(summary.uploaded_bytes)}), reused ${summary.reused}`);
        console.log(`  assets:  ${assets.map((a) => `${a.artifact_kind}:${a.filetype}`).join(", ")}`);
        if (appended && (changelog !== null || opts.forceUpdate)) {
          console.error("note: --notes and --force-update apply when a version is first published; the existing release keeps its own. Use `hands releases update` to change them.");
        }
      } finally {
        await rm(work, { recursive: true, force: true }).catch(() => {});
      }
    });
}

interface PlannedAsset {
  path: string;
  artifact_kind: string;
  filetype: string;
}

type UploadedAsset = Awaited<ReturnType<typeof uploadDirectBuildAsset>>;

interface VersionRelease {
  id: string;
  build_id: string;
  status: string;
  version_name: string;
  version_code: number;
}

function isVersionConflict(error: unknown): boolean {
  for (let current = error; current instanceof Error; current = current.cause) {
    if (current instanceof QuiverApiError && (current.body as { code?: unknown } | null)?.code === "RELEASE_VERSION_ALREADY_EXISTS") return true;
  }
  return false;
}

/**
 * The release that already owns this version on the channel, if any, after checking
 * it can take another target: same version name, still a draft or active, and not
 * active when the caller asked for a draft (adding a target to an active release
 * makes it live at once).
 */
export async function findVersionRelease(args: {
  appId: string; channelId: string; productType: string; releaseType: string;
  versionName: string; versionCode: number; draft: boolean;
}): Promise<VersionRelease | null> {
  const { releases } = await apiRequest<{ releases: VersionRelease[] }>(`/api/apps/${args.appId}/releases`, {
    query: {
      channel: args.channelId,
      product_type: args.productType,
      release_type: args.releaseType,
      version_code: args.versionCode,
    },
  });
  const release = releases.find((r) => r.version_code === args.versionCode && r.status !== "cancelled");
  if (!release) return null;
  if (release.version_name !== args.versionName) {
    throw new Error(
      `version code ${args.versionCode} already belongs to version ${release.version_name} (release ${release.id}); ` +
        "every target of a version must use the same --version-name and --version-code",
    );
  }
  if (release.status !== "draft" && release.status !== "active") {
    throw new Error(`release ${release.id} for ${args.versionName} is ${release.status}; publish a new version instead`);
  }
  if (release.status === "active" && args.draft) {
    throw new Error(
      `release ${release.id} for ${args.versionName} is already active, so adding a target publishes it immediately; ` +
        "re-run without --draft (a person only), or publish every target to a draft before making it active",
    );
  }
  return release;
}

/** Upload one target's slots to a build. Re-running with the same bytes replays. */
async function uploadTargetAssets(
  appId: string,
  buildId: string,
  planned: PlannedAsset[],
  slot: { platform: string; arch: string; target: string },
): Promise<UploadedAsset[]> {
  const assets: UploadedAsset[] = [];
  for (const entry of planned) {
    try {
      assets.push(await uploadDirectBuildAsset(appId, buildId, entry.path, {
        artifact_kind: entry.artifact_kind,
        platform: slot.platform,
        arch: slot.arch,
        filetype: entry.filetype,
        metadata_json: { filename: basename(entry.path), target: slot.target },
      }));
    } catch (error) {
      const code = error instanceof QuiverApiError && error.body && typeof error.body === "object"
        ? (error.body as { code?: unknown }).code
        : undefined;
      const hint = code === "DESKTOP_TARGET_EXISTS" || code === "ASSET_APPEND_CONFLICT"
        ? ` ${slot.target} is already on this version with different files; publish a new version instead.`
        : "";
      throw new Error(
        `uploading ${entry.artifact_kind} for ${slot.target} to build ${buildId} failed${code ? ` (${String(code)})` : ""}:${hint} ${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error },
      );
    }
  }
  return assets;
}
