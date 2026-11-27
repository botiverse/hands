// `hands electron make-patches`: macOS update patches for an Electron release.
//
// From each of the newest N releases on the channel (the bases) to the new
// version, per architecture: the base's zip is downloaded from Hands and
// checked against that release's own latest-mac.yml, both apps are unpacked,
// the patch is made (@botiverse/hands-app-patch), dropped when it is too big
// to be worth it, and otherwise applied once to the base app and compared
// with the new app (`diff -r`). What comes out is the patch files, a
// patches.json for the publish step (feed entries plus the build asset slots
// they need) and, on request, the new latest-mac.yml with `patches` listed.
//
// Failure: when the newest base fails, nothing is written to the feed and the
// command exits 2 (ship without patches, or fix it); an older base that fails
// is skipped with a warning. No base, or only patches too big to ship, is not
// a failure: `patches` is empty and the feed is left as it was.
//
// Needs `unzip` and `diff` (any Linux runner) and a Node whose zstd takes a
// dictionary (22.19+ / 24.6+).

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Command } from "commander";
import { parse, parseDocument } from "yaml";
import { apiRequest, getApiBase } from "../lib/api.js";
import { jsonRequested } from "../lib/json_output.js";
import { resolveAppId } from "./builds.js";

export const DEFAULT_FROM_COUNT = 3;
export const MAX_FROM_COUNT = 10;
const DEFAULT_ARCHES = ["arm64", "x64"];
const FEED = "latest-mac.yml";
/** `desktop-installer` first; releases published under the old name are bases too. */
const PRODUCT_TYPES = ["desktop-installer", "electron-installer"];
const BASE_STATUSES = new Set(["active", "superseded"]);

export interface FeedPatchEntry { from: string; arch: string; url: string; size: number; sha512: string }
export interface PatchSlot {
  file: string;
  artifact_kind: "update-patch";
  platform: "darwin";
  arch: string;
  variant: string;
  filetype: "patch";
  metadata: { from: string; algorithm: string; sha512: string };
}
export interface PatchesJson {
  previousVersion: string | null;
  electronVersion: string;
  patches: FeedPatchEntry[];
  slots: PatchSlot[];
}

interface FeedFile { url: string; sha512: string; size?: number }
interface ReleaseRow { id: string; build_id: string; status: string; version_name: string; version_code: number; product_type?: string }
interface AssetRow { id: string; variant: string | null; r2_key: string; metadata_json: unknown }

export const patchFileName = (name: string, version: string, arch: string, from: string): string => `${name}-${version}-${arch}-from-${from}.patch`;

const VERSION_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

/** Negative when a < b. A prerelease sorts before its release; unparseable is null. */
export function compareVersions(a: string, b: string): number | null {
  const x = VERSION_RE.exec(a.trim());
  const y = VERSION_RE.exec(b.trim());
  if (!x || !y) return null;
  for (let i = 1; i <= 3; i++) {
    const d = Number(x[i]) - Number(y[i]);
    if (d !== 0) return d;
  }
  if (x[4] === y[4]) return 0;
  if (x[4] === undefined) return 1;
  if (y[4] === undefined) return -1;
  return x[4] < y[4] ? -1 : 1;
}

export function parseBytes(value: string): number {
  const m = /^(\d+(?:\.\d+)?)\s*(b|kb|kib|mb|mib|gb|gib)?$/i.exec(value.trim());
  if (!m) throw new Error(`not a size: ${value}`);
  const unit = (m[2] ?? "b").toLowerCase();
  const scale: Record<string, number> = { b: 1, kb: 1e3, kib: 1024, mb: 1e6, mib: 1024 ** 2, gb: 1e9, gib: 1024 ** 3 };
  return Math.floor(Number(m[1]) * scale[unit]!);
}

function readFeed(file: string): { version: string; files: FeedFile[] } {
  const value = parse(readFileSync(file, "utf8"), { maxAliasCount: 0 }) as { version?: unknown; files?: unknown } | null;
  if (!value || typeof value !== "object") throw new Error(`${file}: not a YAML mapping`);
  return feedOf(value, file);
}

function feedOf(value: { version?: unknown; files?: unknown }, where: string): { version: string; files: FeedFile[] } {
  const files = Array.isArray(value.files) ? value.files.filter((f): f is FeedFile => !!f && typeof f.url === "string" && typeof f.sha512 === "string") : [];
  if (value.version === undefined || value.version === null) throw new Error(`${where}: no version`);
  return { version: String(value.version), files };
}

const zipFor = (files: FeedFile[], arch: string): FeedFile | undefined => files.find((f) => f.url.split("/").pop()!.endsWith(`-${arch}.zip`));

async function sha512File(file: string): Promise<string> {
  const hash = createHash("sha512");
  await pipeline(createReadStream(file), hash);
  return hash.digest("base64");
}

/** The names a build asset answers to on the /electron route (worker/src/routes/electron.ts candidateNames). */
function assetNames(asset: AssetRow): Set<string> {
  const names = new Set<string>();
  if (asset.variant) names.add(asset.variant);
  const leaf = asset.r2_key.split("/").pop();
  if (leaf) names.add(leaf);
  let metadata: Record<string, unknown> = {};
  try {
    const raw = typeof asset.metadata_json === "string" ? JSON.parse(asset.metadata_json || "{}") : asset.metadata_json;
    if (raw && typeof raw === "object" && !Array.isArray(raw)) metadata = raw as Record<string, unknown>;
  } catch { /* none */ }
  for (const key of ["filename", "name", "path", "url"]) {
    const value = metadata[key];
    if (typeof value === "string" && value.trim()) {
      names.add(value);
      const last = value.split("/").pop();
      if (last) names.add(last);
    }
  }
  return names;
}

function requireTool(cmd: string, args: string[]): void {
  try {
    execFileSync(cmd, args, { stdio: "ignore" });
  } catch {
    throw new Error(`\`${cmd}\` is required (install it on the runner)`);
  }
}

/** The newest releases on the channel below `version`, newest first. */
async function baseReleases(appId: string, channel: string, version: string): Promise<ReleaseRow[]> {
  const seen = new Map<string, ReleaseRow>();
  for (const productType of PRODUCT_TYPES) {
    const { releases } = await apiRequest<{ releases: ReleaseRow[] }>(`/api/apps/${appId}/releases`, { query: { channel, product_type: productType } });
    for (const r of releases ?? []) seen.set(r.id, r);
  }
  const byVersion = new Map<string, ReleaseRow>();
  for (const r of seen.values()) {
    if (!BASE_STATUSES.has(r.status) || typeof r.version_name !== "string") continue;
    const cmp = compareVersions(r.version_name, version);
    if (cmp === null || cmp >= 0) continue;
    const other = byVersion.get(r.version_name);
    // One release per version: the active one, else the newest.
    if (!other || (r.status === "active" && other.status !== "active") || (r.status === other.status && r.version_code > other.version_code)) byVersion.set(r.version_name, r);
  }
  return [...byVersion.values()].sort((a, b) => (b.version_code - a.version_code) || (compareVersions(b.version_name, a.version_name) ?? 0));
}

async function downloadAsset(appId: string, buildId: string, assetId: string, to: string): Promise<void> {
  const { download_url: url } = await apiRequest<{ download_url: string }>(`/api/apps/${appId}/builds/${buildId}/assets/${assetId}/download`, { query: { presign: 1 } });
  const res = await fetch(new URL(url, getApiBase()));
  if (!res.ok || !res.body) throw new Error(`download failed: ${res.status} ${res.statusText}`);
  await pipeline(Readable.fromWeb(res.body as import("node:stream/web").ReadableStream), createWriteStream(to));
}

interface MakePatchesOptions {
  versionName: string;
  dir: string;
  channel: string;
  fromCount: string;
  from: string[];
  arch?: string;
  name?: string;
  out?: string;
  updateFeed?: string;
  maxShare: string;
  maxBytes: string;
  legacyMagic?: boolean;
  level: string;
  json?: boolean;
}

export function registerElectronCommands(program: Command): void {
  const electron = program.command("electron").description("Electron update tooling (electron-updater generic feed on Hands).");

  electron
    .command("make-patches <appIdOrSlug>")
    .description(
      "Make macOS update patches from the newest releases on the channel to a new version, verify each by applying it, " +
      "and optionally list them in latest-mac.yml. Needs `unzip`, `diff` and Node 22.19+.",
    )
    .requiredOption("--version-name <version>", "The new version (latest-mac.yml's version).")
    .requiredOption("--dir <dir>", "Folder with the new release's latest-mac.yml and per-arch zips (<name>-<version>-<arch>.zip).")
    .option("--channel <slug>", "Hands channel the bases come from.", "main")
    .option("--from-count <n>", `How many of the newest releases below the new version to patch from (max ${MAX_FROM_COUNT}).`, String(DEFAULT_FROM_COUNT))
    .option("--from <version>", "Patch from exactly this release version. Repeatable; replaces --from-count.", (v: string, all: string[]) => [...all, v], [] as string[])
    .option("--arch <list>", "Comma-separated architectures. Default: arm64 and x64, those the feed has a zip for.")
    .option("--name <prefix>", "File name prefix. Default: from the feed's zip names.")
    .option("--out <dir>", "Where the patches and patches.json go. Default: --dir.")
    .option("--update-feed <file>", "Write the patches into this latest-mac.yml (atomically, only when every step succeeded).")
    .option("--max-share <ratio>", "Drop a patch bigger than this share of its zip.", "0.4")
    .option("--max-bytes <size>", "Drop a patch bigger than this (at most 64MiB, the client's limit).", "64MiB")
    .option("--legacy-magic", "Write Raft Desktop's RAFTPAT1 magic, for clients that only read that one.", false)
    .option("--level <n>", "zstd level, 1 to 22.", "19")
    .option("--json", "Output patches.json on stdout.", false)
    .action(async (appIdOrSlug: string, opts: MakePatchesOptions, command: Command) => {
      const json = jsonRequested(command, opts.json);
      const log = (line: string): void => { console.error(line); };
      const result = await makePatches(appIdOrSlug, opts, log);
      if (result.exitCode) process.exitCode = result.exitCode;
      if (json) {
        console.log(JSON.stringify(result.patches, null, 2));
        return;
      }
      if (!result.patches) return;
      const { patches } = result.patches;
      console.log(patches.length
        ? `Made ${patches.length} patch${patches.length === 1 ? "" : "es"}: ${patches.map((p) => `${p.url} (${p.size} B)`).join(", ")}`
        : "No patches made.");
    });
}

export async function makePatches(appIdOrSlug: string, opts: MakePatchesOptions, log: (line: string) => void): Promise<{ exitCode: number; patches: PatchesJson | null }> {
  // Loaded here, not with the CLI: every other command runs on any Node 20+.
  const { MAX_PATCH_FILE, PATCH_ALGORITHM, zstdDictionarySupported } = await import("@botiverse/hands-app-patch");
  const { appVersionOf, electronVersionOf, makeVerifiedAppPatch, unpackApp } = await import("@botiverse/hands-app-patch/make");
  const version = opts.versionName;
  const dir = opts.dir;
  const out = opts.out ?? dir;
  const level = Number(opts.level);
  const maxShare = Number(opts.maxShare);
  const maxBytes = Math.min(parseBytes(opts.maxBytes), MAX_PATCH_FILE);
  const fromCount = Number(opts.fromCount);
  if (!Number.isInteger(level) || level < 1 || level > 22) throw new Error("--level must be 1 to 22");
  if (!(maxShare > 0 && maxShare <= 1)) throw new Error("--max-share must be above 0 and at most 1");
  if (!Number.isInteger(fromCount) || fromCount < 0 || fromCount > MAX_FROM_COUNT) throw new Error(`--from-count must be 0 to ${MAX_FROM_COUNT}`);
  if (opts.from.length > MAX_FROM_COUNT) throw new Error(`at most ${MAX_FROM_COUNT} --from`);
  if (compareVersions(version, version) === null) throw new Error(`--version-name ${version} is not a release version (x.y.z)`);
  if (!zstdDictionarySupported()) throw new Error(`Node ${process.version} has no zstd dictionary support; use Node 22.19+ or 24.6+`);
  requireTool("unzip", ["-v"]);
  requireTool("diff", ["--version"]);

  const feedPath = path.join(dir, FEED);
  if (!existsSync(feedPath)) throw new Error(`missing ${feedPath}`);
  const feed = readFeed(feedPath);
  if (feed.version !== version) throw new Error(`${FEED} is for ${feed.version}, not ${version}`);
  const arches = opts.arch ? opts.arch.split(",").map((a) => a.trim()).filter(Boolean) : DEFAULT_ARCHES.filter((a) => zipFor(feed.files, a));
  if (arches.length === 0) throw new Error(`${FEED} lists no per-arch zip (-arm64.zip / -x64.zip)`);

  mkdirSync(out, { recursive: true });
  const work = mkdtempSync(path.join(tmpdir(), "hands-make-patches-"));
  const made: string[] = [];
  try {
    // The new release, unpacked once per architecture.
    let name = opts.name;
    const next = new Map<string, { app: string; zipSize: number }>();
    const electronVersions = new Set<string>();
    for (const arch of arches) {
      const entry = zipFor(feed.files, arch);
      if (!entry) throw new Error(`${FEED} has no ${arch} zip`);
      const zipName = entry.url.split("/").pop()!;
      const suffix = `-${version}-${arch}.zip`;
      if (!name) {
        if (!zipName.endsWith(suffix)) throw new Error(`cannot tell the name prefix from ${zipName}; pass --name`);
        name = zipName.slice(0, -suffix.length);
      }
      const zip = path.join(dir, zipName);
      if (!existsSync(zip)) throw new Error(`missing ${zip}`);
      if ((await sha512File(zip)) !== entry.sha512) throw new Error(`${zipName} is not the file ${FEED} lists (sha512)`);
      const app = unpackApp(zip, path.join(work, `new-${arch}`));
      if (appVersionOf(app) !== version) throw new Error(`${zipName}: the app says ${appVersionOf(app)}, not ${version}`);
      electronVersions.add(electronVersionOf(app));
      next.set(arch, { app, zipSize: statSync(zip).size });
    }
    if (electronVersions.size !== 1) throw new Error(`the architectures carry different Electron versions: ${[...electronVersions].join(", ")}`);
    const electronVersion = [...electronVersions][0]!;

    const appId = await resolveAppId(appIdOrSlug);
    const releases = await baseReleases(appId, opts.channel, version);
    let bases: ReleaseRow[];
    if (opts.from.length > 0) {
      bases = [];
      for (const from of opts.from) {
        const r = releases.find((x) => x.version_name === from);
        if (!r) throw new Error(`no active or superseded release ${from} below ${version} on channel ${opts.channel}`);
        bases.push(r);
      }
      bases.sort((a, b) => (b.version_code - a.version_code) || (compareVersions(b.version_name, a.version_name) ?? 0));
    } else {
      bases = releases.slice(0, fromCount);
    }
    log(`bases: ${bases.map((b) => b.version_name).join(", ") || "none"} -> ${version}`);

    const patches: FeedPatchEntry[] = [];
    let previousVersion: string | null = null;
    for (const [index, base] of bases.entries()) {
      const from = base.version_name;
      const fromBase: FeedPatchEntry[] = [];
      const files: string[] = [];
      try {
        const baseFeedText = await apiRequest<string>(`/api/apps/${appId}/releases/${base.id}/electron-metadata/${FEED}`);
        const baseFeedValue = parse(String(baseFeedText), { maxAliasCount: 0 }) as { version?: unknown; files?: unknown } | null;
        if (!baseFeedValue || typeof baseFeedValue !== "object") throw new Error(`${from}: its ${FEED} is not a YAML mapping`);
        const baseFeed = feedOf(baseFeedValue, `${from} ${FEED}`);
        if (baseFeed.version !== from) throw new Error(`the ${FEED} of ${from} says ${baseFeed.version}`);
        const { assets } = await apiRequest<{ assets: AssetRow[] }>(`/api/apps/${appId}/builds/${base.build_id}/assets`);
        for (const arch of arches) {
          const entry = zipFor(baseFeed.files, arch);
          if (!entry) {
            log(`warning: ${from} has no ${arch} zip; no ${arch} patch from it`);
            continue;
          }
          const zipName = entry.url.split("/").pop()!;
          const asset = assets.find((a) => assetNames(a).has(zipName));
          if (!asset) throw new Error(`${from}: ${zipName} is not in its build`);
          const zip = path.join(work, `base-${from}-${arch}.zip`);
          await downloadAsset(appId, base.build_id, asset.id, zip);
          if ((await sha512File(zip)) !== entry.sha512) throw new Error(`${zipName} does not match the sha512 in ${from}'s ${FEED}`);
          const oldApp = unpackApp(zip, path.join(work, `base-${from}-${arch}`));
          const url = patchFileName(name!, version, arch, from);
          const patchFile = path.join(out, url);
          const { app: newApp, zipSize } = next.get(arch)!;
          const result = await makeVerifiedAppPatch({
            oldApp, newApp, newZipSize: zipSize, from, to: version, arch, patchFile, workDir: work,
            maxShare, maxBytes, level, legacyMagic: opts.legacyMagic === true,
          });
          rmSync(zip, { force: true });
          rmSync(path.dirname(oldApp), { recursive: true, force: true });
          if (!result.kept) {
            log(`${url}: ${result.size} B is over the ${result.limit} B limit, not worth shipping`);
            continue;
          }
          files.push(patchFile);
          fromBase.push({ from, arch, url, size: result.patch.size, sha512: result.patch.sha512 });
          log(`${url}: ${result.patch.size} B (zip ${zipSize} B), files ${JSON.stringify(result.patch.files)}`);
        }
      } catch (error) {
        for (const file of files) rmSync(file, { force: true });
        const why = error instanceof Error ? error.message : String(error);
        if (index === 0) {
          // The newest base is the routine update: without it, ship no patches.
          log(`error: patches from ${from} failed: ${why}`);
          for (const file of made) rmSync(file, { force: true });
          return { exitCode: 2, patches: null };
        }
        log(`warning: patches from ${from} failed, skipped: ${why}`);
        continue;
      }
      previousVersion ??= from;
      made.push(...files);
      patches.push(...fromBase);
    }

    const result: PatchesJson = {
      previousVersion,
      electronVersion,
      patches,
      slots: patches.map((p) => ({
        file: p.url,
        artifact_kind: "update-patch",
        platform: "darwin",
        arch: p.arch,
        variant: `patch-from-${p.from}`,
        filetype: "patch",
        metadata: { from: p.from, algorithm: PATCH_ALGORITHM, sha512: p.sha512 },
      })),
    };
    writeFileSync(path.join(out, "patches.json"), `${JSON.stringify(result, null, 2)}\n`);
    if (opts.updateFeed) {
      if (patches.length === 0) log(`${opts.updateFeed}: no patches, left as it was`);
      else writeFeedPatches(opts.updateFeed, result);
    }
    return { exitCode: 0, patches: result };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** Adds `patches`, `previousVersion` and `electronVersion` to a latest-mac.yml, keeping the rest as it was; written atomically. */
export function writeFeedPatches(file: string, result: PatchesJson): void {
  const doc = parseDocument(readFileSync(file, "utf8"));
  if (doc.errors.length > 0) throw new Error(`${file}: ${doc.errors[0]!.message}`);
  doc.set("patches", result.patches.map((p) => ({ ...p })));
  if (result.previousVersion) doc.set("previousVersion", result.previousVersion);
  doc.set("electronVersion", result.electronVersion);
  const temp = `${file}.tmp-${process.pid}`;
  writeFileSync(temp, doc.toString({ lineWidth: 0 }));
  renameSync(temp, file);
}
