// One version code can ship as several APKs (universal and arm64-v8a). Each is
// its own delta source: its own work files, and patches that record which APK
// they apply to (from_sha256 / from_arch).
import { afterEach, describe, expect, it, vi } from "vitest";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { gzipSync } from "node:zlib";
import { Command } from "commander";
import {
  androidDeltaPatchMetadata,
  deltaSourceWorkName,
  preflightAndroidDeltaPatches,
} from "./builds.js";

const ARM = "c".repeat(64);
const UNI = "D".repeat(64);

describe("androidDeltaPatchMetadata source fields", () => {
  const base = { fromVersionCode: 10, toVersionCode: 11, targetSha256: "a".repeat(64) };

  it("records the source APK's sha256 (lower-case) and arch (universal as null)", () => {
    expect(androidDeltaPatchMetadata({ ...base, fromSha256: UNI, fromArch: "universal" })).toEqual({
      from_version_code: 10,
      to_version_code: 11,
      algorithm: "archive-patcher-v1+gzip",
      target_sha256: "a".repeat(64),
      from_sha256: "d".repeat(64),
      from_arch: null,
    });
    expect(androidDeltaPatchMetadata({ ...base, fromSha256: ARM, fromArch: "arm64-v8a", algorithm: "archive-patcher-v1+xz" }))
      .toMatchObject({ algorithm: "archive-patcher-v1+xz", from_sha256: ARM, from_arch: "arm64-v8a" });
  });

  it("leaves both out without a valid source hash, and from_arch out when the arch is unknown", () => {
    expect(androidDeltaPatchMetadata(base)).not.toHaveProperty("from_sha256");
    expect(androidDeltaPatchMetadata({ ...base, fromSha256: "abc", fromArch: "arm64-v8a" })).not.toHaveProperty("from_arch");
    expect(androidDeltaPatchMetadata({ ...base, fromSha256: ARM })).not.toHaveProperty("from_arch");
  });
});

describe("deltaSourceWorkName", () => {
  it("gives two APKs of one version code distinct work files", () => {
    const names = [
      deltaSourceWorkName({ from_version_code: 10, sha256: ARM }, 0),
      deltaSourceWorkName({ from_version_code: 10, sha256: UNI }, 1),
      // Even the same hash twice (or none) cannot collide.
      deltaSourceWorkName({ from_version_code: 10, sha256: ARM }, 2),
      deltaSourceWorkName({ from_version_code: 10, sha256: null }, 3),
    ];
    expect(new Set(names).size).toBe(4);
    expect(names[0]).toBe(`from-10-${"c".repeat(12)}-0`);
    expect(names[1]).toBe(`from-10-${"d".repeat(12)}-1`);
  });
});

describe("--delta-patch spec", () => {
  it("accepts <vc>=<path> and <vc>@<sha256>=<path>, and refuses a repeated source", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hands-delta-spec-"));
    try {
      const patch = join(dir, "p.patch.gz");
      writeFileSync(patch, gzipSync(Buffer.from("GFbFv1_0body", "ascii")));
      expect(await preflightAndroidDeltaPatches([`10=${patch}`, `10@${UNI}=${patch}`, `10@${ARM}=${patch}`])).toEqual([
        { fromVersionCode: 10, patchPath: patch },
        { fromVersionCode: 10, patchPath: patch, fromSha256: "d".repeat(64) },
        { fromVersionCode: 10, patchPath: patch, fromSha256: ARM },
      ]);
      await expect(preflightAndroidDeltaPatches([`10@abc=${patch}`])).rejects.toThrow("bad source sha256");
      await expect(preflightAndroidDeltaPatches([`10@${ARM}@x=${patch}`])).rejects.toThrow("--delta-patch must be");
      await expect(preflightAndroidDeltaPatches([`10=${patch}`, `10=${patch}`])).rejects.toThrow("given twice");
      await expect(preflightAndroidDeltaPatches([`10@${ARM}=${patch}`, `10@${ARM.toUpperCase()}=${patch}`])).rejects.toThrow("given twice");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("publish-android --generate-deltas with two APKs of one version code", () => {
  const restore: Array<() => void> = [];
  afterEach(() => {
    while (restore.length) restore.pop()!();
    vi.unstubAllGlobals();
  });

  it("makes and uploads a patch from each, under distinct files, recording each source", async () => {
    let xzAvailable = true;
    try {
      execFileSync("xz", ["--version"]);
    } catch {
      xzAvailable = false;
    }
    const dir = mkdtempSync(join(tmpdir(), "hands-delta-two-sources-"));
    restore.push(() => rmSync(dir, { recursive: true, force: true }));
    const apk = join(dir, "app.apk");
    writeFileSync(apk, "new-apk");
    // Stand-ins for javac and java (PatchGen): each patch is the gzip of a marker
    // naming the old APK it was made from, and every call is logged.
    const bin = join(dir, "bin");
    const log = join(dir, "java.log");
    execFileSync("mkdir", ["-p", bin]);
    writeFileSync(join(bin, "javac"), "#!/bin/sh\nexit 0\n");
    writeFileSync(join(bin, "java"), `#!/usr/bin/env node
const fs = require("node:fs");
const zlib = require("node:zlib");
const args = process.argv.slice(2);
const at = args.indexOf("PatchGen");
const rest = args.slice(at + 1);
if (rest[0] === "--zucchini-capable") process.exit(0);
const [oldApk, , out] = rest[0] === "--zucchini" ? rest.slice(3) : rest;
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ out, old: fs.readFileSync(oldApk, "utf8") }) + "\\n");
// Incompressible noise, repeated beyond gzip's 32 KiB window, so the xz copy is
// smaller than the gzip one (as with real patches); the Zucchini one smaller still.
let seed = 7;
const noise = Buffer.alloc(rest[0] === "--zucchini" ? 8000 : 40000, 0).map(() => (seed = (seed * 1103515245 + 12345) >>> 0) >>> 24);
const body = rest[0] === "--zucchini" ? noise : Buffer.concat([noise, noise]);
fs.writeFileSync(out, zlib.gzipSync(Buffer.concat([Buffer.from("GFbFv1_0" + fs.readFileSync(oldApk, "utf8")), body])));
`);
    chmodSync(join(bin, "javac"), 0o755);
    chmodSync(join(bin, "java"), 0o755);
    const originalPath = process.env.PATH;
    process.env.PATH = `${bin}:${originalPath}`;
    restore.push(() => { process.env.PATH = originalPath; });

    const realFetch = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes("archive-patcher")) return new Response("jar");
      return realFetch(input, init);
    });

    const registered: Array<Record<string, any>> = [];
    const sourceQueries: URLSearchParams[] = [];
    let uploads = 0;
    let port = 0;
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const raw = Buffer.concat(chunks).toString("utf8");
      res.setHeader("content-type", "application/json");
      const url = req.url ?? "";
      if (req.method === "GET" && url === "/api/apps") return res.end(JSON.stringify({ apps: [{ id: "app-1", slug: "android-app" }] }));
      if (req.method === "GET" && url === "/api/apps/app-1/channels") return res.end(JSON.stringify({ channels: [{ id: "channel-1", slug: "main", name: "Main" }] }));
      if (req.method === "GET" && url.startsWith("/api/apps/app-1/releases?")) return res.end(JSON.stringify({ releases: [] }));
      if (req.method === "POST" && url === "/api/apps/app-1/builds") return res.end(JSON.stringify({ id: "build-1" }));
      if (req.method === "POST" && url === "/api/apps/app-1/releases") return res.end(JSON.stringify({ id: "release-1" }));
      if (req.method === "POST" && url === "/api/apps/app-1/upload") {
        uploads += 1;
        return res.end(JSON.stringify({
          file_hash: uploads === 1 ? "a".repeat(64) : uploads.toString(16).padStart(64, "0"),
          r2_key: `apps/app-1/upload-${uploads}`,
          size_bytes: uploads === 1 ? 50_000_000 : 100,
          original_filename: "x",
        }));
      }
      if (req.method === "POST" && url === "/api/apps/app-1/builds/build-1/assets") {
        registered.push(JSON.parse(raw));
        return res.end(JSON.stringify({ id: `asset-${registered.length}` }));
      }
      if (req.method === "GET" && url.startsWith("/api/apps/app-1/delta-sources?")) {
        sourceQueries.push(new URL(url, "http://x").searchParams);
        return res.end(JSON.stringify({
          arch: null,
          before: 11,
          sources: [
            { from_version_code: 10, arch: "arm64-v8a", size_bytes: 9, sha256: ARM, url: `http://127.0.0.1:${port}/src/arm.apk` },
            { from_version_code: 10, arch: null, size_bytes: 9, sha256: UNI, url: `http://127.0.0.1:${port}/src/universal.apk` },
          ],
        }));
      }
      if (req.method === "GET" && url.startsWith("/src/")) {
        res.setHeader("content-type", "application/octet-stream");
        return res.end(url.includes("arm") ? "OLD-ARM" : "OLD-UNIVERSAL");
      }
      res.statusCode = 404;
      return res.end(JSON.stringify({ error: `not found ${req.method} ${url}` }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    restore.push(() => server.close());
    port = (server.address() as { port: number }).port;
    for (const [key, value] of [["HANDS_API", `http://127.0.0.1:${port}`], ["HANDS_BEARER_TOKEN", "test-token"]] as const) {
      const original = process.env[key];
      process.env[key] = value;
      restore.push(() => { if (original === undefined) delete process.env[key]; else process.env[key] = original; });
    }

    const { registerBuildCommands } = await import("./builds.js");
    const program = new Command().version("0.5.14").option("--json", "JSON output", false);
    registerBuildCommands(program);
    await program.parseAsync([
      "node", "hands", "builds", "publish-android", "android-app",
      "--apk", apk, "--version-name", "1.0.1", "--version-code", "11",
      "--generate-deltas", "3", "--draft",
    ]);

    // Asks for every APK of a version, which older CLIs do not get.
    expect(sourceQueries.map((q) => q.get("per_version"))).toEqual(["3"]);
    const patches = registered.filter((asset) => asset.artifact_kind === "delta-patch");
    const algorithms = xzAvailable
      ? ["archive-patcher-v1+gzip", "archive-patcher-v1+xz", "archive-patcher-zucchini-v1+xz"]
      : ["archive-patcher-v1+gzip"];
    // One patch per source APK and algorithm, every one naming its source.
    expect(patches.map((p) => [p.metadata_json.algorithm, p.metadata_json.from_sha256, p.metadata_json.from_arch]).sort()).toEqual(
      algorithms.flatMap((algorithm) => [[algorithm, ARM, "arm64-v8a"], [algorithm, "d".repeat(64), null]]).sort(),
    );
    expect(patches.every((p) => p.metadata_json.from_version_code === 10 && p.metadata_json.to_version_code === 11)).toBe(true);
    // Distinct work files, and each patch made from its own source APK.
    const filenames = patches.map((p) => p.metadata_json.filename as string);
    expect(new Set(filenames).size).toBe(patches.length);
    const calls = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { out: string; old: string });
    const oldApkOf = new Map<string, string>();
    for (const { out, old } of calls) {
      const stem = basename(out).replace(/\.(patch|zpatch)\.gz$/, "");
      // A work-file stem is only ever made from one source APK.
      expect(oldApkOf.get(stem) ?? old).toBe(old);
      oldApkOf.set(stem, old);
    }
    expect(oldApkOf.size).toBe(2);
    for (const patch of patches) {
      const stem = (patch.metadata_json.filename as string).replace(/\.(patch|zpatch)\.(gz|xz)$/, "");
      expect(oldApkOf.get(stem)).toBe(patch.metadata_json.from_arch === "arm64-v8a" ? "OLD-ARM" : "OLD-UNIVERSAL");
    }
  }, 60_000);
});
