/**
 * `quiver builds` — list / inspect builds inside an app.
 *
 * Wires GET /api/apps/:appId/builds + GET /api/apps/:appId/builds/:buildId.
 */

import type { Command } from "commander";
import { createHash } from "node:crypto";
import { createReadStream, existsSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, writeFile, rm, stat } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { apiRequest, apiUploadFile } from "../lib/api.js";

const execFileAsync = promisify(execFile);

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

export interface NotarizationResult {
  notarization_id: string;
  submission_id: string;
  status: string;
  submission_name: string;
  source_sha256: string;
  source_size_bytes: number;
  apple_sha256: string;
  binding_verified: true;
  stapled: true;
  staple_validated: true;
  final_sha256: string;
  final_size_bytes: number;
  credential_export_id: string;
}

export interface NotarizationCredentialExport {
  export_id: string;
  app_id: string;
  issued_at: number;
  credential_updated_at: number;
  submission_name: string;
  source_sha256: string;
  source_size_bytes: number;
  credentials: {
    kind: "app_store_connect_api_key";
    key_id: string;
    issuer_id: string;
    p8: string;
  };
}

export class NotarizationCommandError extends Error {
  readonly result: NotarizationResult | null;

  constructor(message: string, result: NotarizationResult | null = null) {
    super(message);
    this.name = "NotarizationCommandError";
    this.result = result;
  }
}

interface ChannelRow {
  id: string;
  slug: string;
  name: string;
}

function collect(value: string, previous: string[]): string[] {
  return previous.concat(value);
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
        if (shouldOutputJson(program, opts.json)) {
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
        if (shouldOutputJson(program, opts.json)) {
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
    .command("publish-version <appIdOrSlug>")
    .description("Register an immutable externally hosted Node/CLI build target.")
    .requiredOption("--version <version>", "Release version name.")
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
          version: string;
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
          : versionCodeFromVersion(opts.version);
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
            version_name: opts.version,
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

        if (shouldOutputJson(program, opts.json)) {
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
    .command("publish-android <appIdOrSlug>")
    .description("Create an Android build/release and upload APK plus support artifacts.")
    .requiredOption("--apk <path>", "Installable APK path.")
    .requiredOption("--version-name <name>", "Android versionName.")
    .requiredOption("--version-code <code>", "Android versionCode.")
    .option("--channel <slug>", "Hands release channel slug.", "main")
    .option("--arch <abi>", "APK ABI/arch metadata.", "arm64-v8a")
    .option("--release-type <type>", "Release type metadata.", "stable")
    .option("--product-type <type>", "Product type metadata.", "android-apk")
    .option("--mapping <path>", "R8/ProGuard mapping.txt support artifact.")
    .option("--symbols <path>", "Native symbols archive support artifact.")
    .option("--dsym <path>", "iOS dSYM archive (dSYM.zip) support artifact.")
    .option("--metadata <path>", "Build metadata JSON support artifact.")
    .option(
      "--delta-patch <spec>",
      "Delta patch as <from_version_code>=<path> (archive-patcher). Repeatable — clients on that version get offered this patch instead of the full APK.",
      collect,
      [],
    )
    .option(
      "--generate-deltas <N>",
      "After uploading, generate + upload archive-patcher delta patches from the last N published versions (needs a JDK on PATH — CI has one). Clients on those versions download the small patch instead of the full APK.",
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
        const appId = await resolveAppId(appIdOrSlug);
        const channelId = await resolveChannelId(appId, opts.channel);
        const versionCode = Number(opts.versionCode);
        if (!Number.isFinite(versionCode) || versionCode < 0) {
          throw new Error("--version-code must be a non-negative number");
        }
        for (const file of [opts.apk, opts.mapping, opts.symbols, opts.dsym, opts.metadata].filter(Boolean) as string[]) {
          if (!existsSync(file)) throw new Error(`missing file: ${file}`);
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
        const installable = await uploadAndRegisterAsset(appId, build.id, opts.apk, {
          artifact_kind: "installable",
          platform: "android",
          arch: opts.arch,
          filetype: "apk",
        });
        assets.push(installable);
        // Delta patches: <from_version_code>=<path>. target_sha256 is the new
        // APK's hash so the client can verify the reconstructed file. The
        // server offers a patch only when it beats the full APK size.
        for (const spec of opts.deltaPatch ?? []) {
          const eq = spec.indexOf("=");
          if (eq <= 0) throw new Error(`--delta-patch must be <from_version_code>=<path>, got: ${spec}`);
          const fromVersionCode = Number(spec.slice(0, eq).trim());
          const patchPath = spec.slice(eq + 1).trim();
          if (!Number.isFinite(fromVersionCode)) throw new Error(`bad from_version_code in --delta-patch: ${spec}`);
          if (!existsSync(patchPath)) throw new Error(`missing delta patch file: ${patchPath}`);
          assets.push(
            await uploadAndRegisterAsset(appId, build.id, patchPath, {
              artifact_kind: "delta-patch",
              platform: "android",
              arch: opts.arch,
              filetype: "patch",
              metadata_json: {
                from_version_code: fromVersionCode,
                to_version_code: versionCode,
                algorithm: "archive-patcher-v1",
                target_sha256: installable.file_hash,
              },
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
            newApkPath: opts.apk,
            arch: opts.arch,
            toVersionCode: versionCode,
            targetSha256: installable.file_hash,
            newApkSize: installable.size_bytes,
            versions: n,
          });
          assets.push(...generated);
        }
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
        if (shouldOutputJson(program, opts.json)) {
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
        assets.push(
          await uploadAndRegisterAsset(appId, build.id, opts.ipa, {
            artifact_kind: "installable",
            platform: "ios",
            arch: null,
            filetype: inferIosFiletype(opts.ipa),
            metadata_json: {
              filename: ipaName,
              signed: true,
              distribution: "testflight",
            },
          }),
        );
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
              platform: "ios",
              arch: null,
              filetype: inferIosFiletype(opts.metadata),
              metadata_json: { filename: basename(opts.metadata) },
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
        if (shouldOutputJson(program, opts.json)) {
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
        console.log("  note:    upload the same signed IPA to TestFlight from macOS CI.");
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
        if (shouldOutputJson(program, opts.json)) {
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
        if (shouldOutputJson(program, opts.json)) {
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

  builds
    .command("notarize <appIdOrSlug>")
    .description(
      "Export this app's ASC key, notarize the local macOS artifact with notarytool, and staple it.",
    )
    .requiredOption("--file <path>", "Signed .dmg or .pkg to notarize and staple.")
    .option("--timeout-seconds <seconds>", "Maximum local notarytool wait.", "1800")
    .option("--json", "Output JSON.", false)
    .action(
      async (
        appIdOrSlug: string,
        opts: {
          file: string;
          timeoutSeconds: string;
          json?: boolean;
        },
      ) => {
        if (!existsSync(opts.file)) throw new Error(`missing file: ${opts.file}`);
        const submissionName = basename(opts.file);
        if (!/\.(dmg|pkg)$/i.test(submissionName)) {
          throw new Error("--file must be a .dmg or .pkg artifact that stapler supports");
        }
        const timeoutSeconds = parsePositiveInteger(
          opts.timeoutSeconds,
          "--timeout-seconds",
        );
        const appId = await resolveAppId(appIdOrSlug);
        const fileStat = await stat(opts.file);
        if (!fileStat.isFile() || fileStat.size <= 0) {
          throw new Error("--file must be a non-empty regular file");
        }
        const localSha256 = await sha256File(opts.file);
        const exported = await apiRequest<NotarizationCredentialExport>(
          `/api/apps/${appId}/notarization-credentials/export`,
          {
            method: "POST",
            body: {
              sha256: localSha256,
              size_bytes: fileStat.size,
              submission_name: submissionName,
            },
          },
        );
        assertCredentialExportBinding(exported, {
          appId,
          submissionName,
          sha256: localSha256,
          sizeBytes: fileStat.size,
        });
        const result = await notarizeAndStapleLocal({
          filePath: opts.file,
          export: exported,
          expected: {
            submissionName,
            sha256: localSha256,
            sizeBytes: fileStat.size,
          },
          timeoutMs: timeoutSeconds * 1000,
        });

        if (shouldOutputJson(program, opts.json)) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }
        console.log("Apple notarization accepted, bound, stapled, and validated.");
        console.log(`  notarization: ${result.notarization_id}`);
        console.log(`  submission:   ${result.submission_id}`);
        console.log(`  source sha256: ${result.source_sha256}`);
        console.log(`  final sha256:  ${result.final_sha256}`);
      },
    );

}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

function assertCredentialExportBinding(
  result: NotarizationCredentialExport,
  expected: {
    appId: string;
    submissionName: string;
    sha256: string;
    sizeBytes: number;
  },
): void {
  if (
    result.app_id !== expected.appId ||
    result.submission_name !== expected.submissionName ||
    result.source_sha256.toLowerCase() !== expected.sha256.toLowerCase() ||
    result.source_size_bytes !== expected.sizeBytes ||
    result.credentials.kind !== "app_store_connect_api_key" ||
    !/^[A-Za-z0-9]{8,64}$/.test(result.credentials.key_id) ||
    !/^[A-Fa-f0-9]{8}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{12}$/.test(
      result.credentials.issuer_id,
    ) ||
    !result.credentials.p8.includes("BEGIN PRIVATE KEY")
  ) {
    throw new NotarizationCommandError(
      "Hands returned credentials bound to a different app or artifact tuple",
    );
  }
}

type LocalExec = (
  file: string,
  args: string[],
  options: { timeout: number; maxBuffer: number },
) => Promise<{ stdout: string; stderr: string }>;

async function defaultLocalExec(
  file: string,
  args: string[],
  options: { timeout: number; maxBuffer: number },
) {
  const result = await execFileAsync(file, args, options);
  return { stdout: String(result.stdout), stderr: String(result.stderr) };
}

function parseJsonRecord(raw: string, label: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("not an object");
    }
    return parsed as Record<string, unknown>;
  } catch {
    throw new NotarizationCommandError(`${label} did not return valid JSON`);
  }
}

export async function notarizeAndStapleLocal(args: {
  filePath: string;
  export: NotarizationCredentialExport;
  expected: {
    submissionName: string;
    sha256: string;
    sizeBytes: number;
  };
  timeoutMs: number;
  platform?: NodeJS.Platform;
  exec?: LocalExec;
}): Promise<NotarizationResult> {
  if ((args.platform ?? process.platform) !== "darwin") {
    throw new NotarizationCommandError(
      "local Apple notarization requires macOS with Xcode command-line tools",
    );
  }
  assertCredentialExportBinding(args.export, {
    appId: args.export.app_id,
    ...args.expected,
  });
  const run = args.exec ?? defaultLocalExec;
  const artifactPath = resolve(args.filePath);
  const work = await mkdtemp(join(tmpdir(), "hands-notary-"));
  // Keep the path independent of server-controlled key metadata.
  const keyPath = join(work, "AuthKey.p8");
  const logPath = join(work, "notary-log.json");
  const execOptions = { timeout: args.timeoutMs, maxBuffer: 4 * 1024 * 1024 };

  try {
    await writeFile(keyPath, args.export.credentials.p8, { mode: 0o600 });
    // Drop the long-lived JS reference as soon as the mode-0600 file exists.
    // The temporary directory is still removed in the finally block.
    args.export.credentials.p8 = "";
    let submitOutput: { stdout: string; stderr: string };
    try {
      submitOutput = await run(
        "xcrun",
        [
          "notarytool",
          "submit",
          artifactPath,
          "--key",
          keyPath,
          "--key-id",
          args.export.credentials.key_id,
          "--issuer",
          args.export.credentials.issuer_id,
          "--wait",
          "--output-format",
          "json",
        ],
        execOptions,
      );
    } catch {
      throw new NotarizationCommandError(
        "Apple notarytool submit failed or timed out",
      );
    }

    const submit = parseJsonRecord(submitOutput.stdout, "Apple notarytool submit");
    const submissionId =
      typeof submit.id === "string"
        ? submit.id
        : typeof submit.submissionId === "string"
          ? submit.submissionId
          : "";
    const status = typeof submit.status === "string" ? submit.status : "";
    if (!submissionId || status !== "Accepted") {
      throw new NotarizationCommandError(
        `Apple notarization ended with status ${status || "unknown"}`,
      );
    }

    // The source bytes must remain unchanged from the tuple Hands audited.
    const postSubmitStat = await stat(artifactPath);
    const postSubmitSha256 = await sha256File(artifactPath);
    if (
      postSubmitStat.size !== args.expected.sizeBytes ||
      postSubmitSha256.toLowerCase() !== args.expected.sha256.toLowerCase()
    ) {
      throw new NotarizationCommandError(
        "local artifact changed while Apple notarization was in progress",
      );
    }

    try {
      await run(
        "xcrun",
        [
          "notarytool",
          "log",
          submissionId,
          "--key",
          keyPath,
          "--key-id",
          args.export.credentials.key_id,
          "--issuer",
          args.export.credentials.issuer_id,
          logPath,
        ],
        execOptions,
      );
    } catch {
      throw new NotarizationCommandError(
        "Apple developer log could not be downloaded for exact-byte binding",
      );
    }
    const log = parseJsonRecord(
      await readFile(logPath, "utf8"),
      "Apple developer log",
    );
    const appleSha256 =
      typeof log.sha256 === "string" ? log.sha256.toLowerCase() : "";
    if (
      !/^[a-f0-9]{64}$/.test(appleSha256) ||
      appleSha256 !== args.expected.sha256.toLowerCase()
    ) {
      throw new NotarizationCommandError(
        "Apple developer log SHA-256 does not match the local source artifact",
      );
    }

    try {
      await run("xcrun", ["stapler", "staple", artifactPath], execOptions);
      await run("xcrun", ["stapler", "validate", artifactPath], execOptions);
    } catch {
      throw new NotarizationCommandError(
        "Apple accepted the artifact but stapling or staple validation failed",
      );
    }

    const finalStat = await stat(artifactPath);
    const finalSha256 = await sha256File(artifactPath);
    return {
      notarization_id: submissionId,
      submission_id: submissionId,
      status,
      submission_name: args.expected.submissionName,
      source_sha256: args.expected.sha256.toLowerCase(),
      source_size_bytes: args.expected.sizeBytes,
      apple_sha256: appleSha256,
      binding_verified: true,
      stapled: true,
      staple_validated: true,
      final_sha256: finalSha256,
      final_size_bytes: finalStat.size,
      credential_export_id: args.export.export_id,
    };
  } finally {
    args.export.credentials.p8 = "";
    await rm(work, { recursive: true, force: true }).catch(() => {});
  }
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
async function ensureArchivePatcher(dir: string): Promise<string> {
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

interface DeltaSource {
  from_version_code: number;
  arch: string | null;
  size_bytes: number;
  sha256: string;
  url: string;
}

/**
 * Generate archive-patcher delta patches from the last N published versions to
 * the just-uploaded build, and upload each as a delta-patch asset. The Worker
 * serves the source APKs (GET /api/apps/:id/delta-sources) and stores the
 * patches; the CPU-heavy bsdiff runs here in CI. Skips patches that don't beat
 * the full APK size.
 */
async function generateAndUploadAndroidDeltas(args: {
  appId: string;
  buildId: string;
  newApkPath: string;
  arch: string;
  toVersionCode: number;
  targetSha256: string;
  newApkSize: number;
  versions: number;
}): Promise<Array<{ id: string; artifact_kind: string; filetype: string; file_hash: string; size_bytes: number }>> {
  const { sources } = await apiRequest<{ sources: DeltaSource[] }>(
    `/api/apps/${args.appId}/delta-sources`,
    { query: { arch: args.arch, before: args.toVersionCode, limit: args.versions } },
  );
  if (!sources || sources.length === 0) {
    console.error(`[delta] no prior published versions to diff against; skipping.`);
    return [];
  }

  const work = await mkdtemp(join(tmpdir(), "hands-delta-"));
  const uploaded: Array<{ id: string; artifact_kind: string; filetype: string; file_hash: string; size_bytes: number }> = [];
  try {
    const cp = await ensureArchivePatcher(work);
    for (const src of sources) {
      const oldPath = join(work, `old-${src.from_version_code}.apk`);
      const patchPath = join(work, `from-${src.from_version_code}.patch.gz`);
      const dl = await fetch(src.url);
      if (!dl.ok) {
        console.error(`[delta] v${src.from_version_code}: download failed HTTP ${dl.status}; skipping.`);
        continue;
      }
      await writeFile(oldPath, Buffer.from(await dl.arrayBuffer()));
      await execFileAsync("java", ["-cp", cp, "PatchGen", oldPath, args.newApkPath, patchPath], {
        maxBuffer: 16 * 1024 * 1024,
      });
      const patchSize = readFileSync(patchPath).length;
      if (patchSize >= args.newApkSize) {
        console.error(`[delta] v${src.from_version_code}: patch ${patchSize}B not smaller than full APK ${args.newApkSize}B; skipping.`);
        continue;
      }
      console.error(`[delta] v${src.from_version_code} -> v${args.toVersionCode}: patch ${patchSize}B (${(patchSize / args.newApkSize * 100).toFixed(1)}% of full)`);
      uploaded.push(
        await uploadAndRegisterAsset(args.appId, args.buildId, patchPath, {
          artifact_kind: "delta-patch",
          platform: "android",
          arch: args.arch,
          filetype: "patch",
          metadata_json: {
            from_version_code: src.from_version_code,
            to_version_code: args.toVersionCode,
            algorithm: "archive-patcher-v1+gzip",
            target_sha256: args.targetSha256,
          },
        }),
      );
    }
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

function parsePositiveInteger(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive integer`);
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
