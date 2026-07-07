/**
 * `quiver builds` — list / inspect builds inside an app.
 *
 * Wires GET /api/apps/:appId/builds + GET /api/apps/:appId/builds/:buildId.
 */

import type { Command } from "commander";
import { existsSync, readFileSync } from "node:fs";
import { basename, extname } from "node:path";
import { apiRequest, apiUploadFile } from "../lib/api.js";

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

function collect(value: string, previous: string[]): string[] {
  return previous.concat(value);
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
        if (opts.json) {
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
            `${b.version_name} (${b.version_code})  ${b.product_type}/${b.release_type}  status=${b.status}${flag}  id=${b.id.slice(0, 8)}`,
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
        if (opts.json) {
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

  builds
    .command("publish-android <appIdOrSlug>")
    .description("Create an Android build/release and upload APK plus support artifacts.")
    .requiredOption("--apk <path>", "Installable APK path.")
    .requiredOption("--version-name <name>", "Android versionName.")
    .requiredOption("--version-code <code>", "Android versionCode.")
    .option("--channel <slug>", "Quiver channel slug.", "main")
    .option("--arch <abi>", "APK ABI/arch metadata.", "arm64-v8a")
    .option("--release-type <type>", "Release type metadata.", "stable")
    .option("--product-type <type>", "Product type metadata.", "android-apk")
    .option("--mapping <path>", "R8/ProGuard mapping.txt support artifact.")
    .option("--symbols <path>", "Native symbols archive support artifact.")
    .option("--dsym <path>", "iOS dSYM archive (dSYM.zip) support artifact.")
    .option("--metadata <path>", "Build metadata JSON support artifact.")
    .option("--changelog <text>", "Inline changelog.")
    .option("--changelog-file <path>", "Read changelog from file.")
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
          changelog?: string;
          changelogFile?: string;
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
        const appId = await resolveAppId(appIdOrSlug);
        const channelId = await resolveChannelId(appId, opts.channel);
        const versionCode = Number(opts.versionCode);
        if (!Number.isFinite(versionCode) || versionCode < 0) {
          throw new Error("--version-code must be a non-negative number");
        }
        for (const file of [opts.apk, opts.mapping, opts.symbols, opts.dsym, opts.metadata].filter(Boolean) as string[]) {
          if (!existsSync(file)) throw new Error(`missing file: ${file}`);
        }
        const changelog = opts.changelogFile
          ? readFileSync(opts.changelogFile, "utf8")
          : opts.changelog ?? null;
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

        const build = await apiRequest<{ id: string }>(`/api/apps/${appId}/builds`, {
          method: "POST",
          body: {
            channel_id: channelId,
            product_type: opts.productType,
            release_type: opts.releaseType,
            version_name: opts.versionName,
            version_code: versionCode,
            changelog,
            source: "cli",
            status: "succeeded",
            build_metadata_json: metadataJson,
            provenance_json: provenance,
            should_force_update: Boolean(opts.forceUpdate),
          },
        });

        const assets = [];
        assets.push(
          await uploadAndRegisterAsset(appId, build.id, opts.apk, {
            artifact_kind: "installable",
            platform: "android",
            arch: opts.arch,
            filetype: "apk",
          }),
        );
        if (opts.mapping) {
          assets.push(
            await uploadAndRegisterAsset(appId, build.id, opts.mapping, {
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
              filetype: "dsym.zip",
            }),
          );
        }
        if (opts.metadata) {
          assets.push(
            await uploadAndRegisterAsset(appId, build.id, opts.metadata, {
              artifact_kind: "metadata-file",
              platform: "android",
              arch: null,
              filetype: "metadata.json",
            }),
          );
        }

        const release = await apiRequest<{ id: string }>(`/api/apps/${appId}/releases`, {
          method: "POST",
          body: {
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
        if (opts.json) {
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
    .command("publish-electron <appIdOrSlug>")
    .description("Create an Electron generic-provider build/release and upload electron-builder output.")
    .requiredOption("--version-name <name>", "Electron app version.")
    .requiredOption("--version-code <code>", "Quiver version code used for ordering.")
    .option("--metadata <path>", "electron-builder latest*.yml file. Repeatable.", collect, [])
    .option("--installer <path>", "Electron installer/update artifact. Repeatable.", collect, [])
    .option("--blockmap <path>", "Electron .blockmap artifact. Repeatable.", collect, [])
    .option("--channel <slug>", "Quiver channel slug.", "main")
    .option("--platform <platform>", "Electron platform metadata. Defaults from metadata filename or win32.")
    .option("--arch <arch>", "Electron arch metadata.")
    .option("--release-type <type>", "Release type metadata.", "stable")
    .option("--product-type <type>", "Product type metadata.", "electron-installer")
    .option("--changelog <text>", "Inline changelog.")
    .option("--changelog-file <path>", "Read changelog from file.")
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
          channel: string;
          platform?: string;
          arch?: string;
          releaseType: string;
          productType: string;
          changelog?: string;
          changelogFile?: string;
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
        const files = [...opts.metadata, ...opts.installer, ...opts.blockmap];
        if (files.length === 0) {
          throw new Error("provide at least one --metadata, --installer, or --blockmap file");
        }
        const metadataFiles = opts.metadata;
        const installerFiles = opts.installer;
        const blockmapFiles = opts.blockmap;
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
        const changelog = opts.changelogFile
          ? readFileSync(opts.changelogFile, "utf8")
          : opts.changelog ?? null;
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

        const build = await apiRequest<{ id: string }>(`/api/apps/${appId}/builds`, {
          method: "POST",
          body: {
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

        const release = await apiRequest<{ id: string }>(`/api/apps/${appId}/releases`, {
          method: "POST",
          body: {
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
        if (opts.json) {
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

async function resolveAppId(slugOrId: string): Promise<string> {
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

async function resolveChannelId(appId: string, channelSlugOrId: string): Promise<string> {
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

export function inferElectronFiletype(filePath: string): string {
  const name = basename(filePath);
  if (name.endsWith(".blockmap")) return "blockmap";
  if (name.endsWith(".AppImage")) return "AppImage";
  const ext = extname(name).replace(/^\./, "");
  return ext || "bin";
}
