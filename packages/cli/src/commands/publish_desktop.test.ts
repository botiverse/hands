import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { Command } from "commander";
import {
  buildDesktopManifest,
  checkLinkTarget,
  uniqueDigests,
  walkDesktopBundle,
} from "../lib/desktop_bundle.js";

const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

function makeBundle(dir: string, binary = "binary-v1"): string {
  const app = join(dir, "Raft.app");
  mkdirSync(join(app, "Contents/MacOS"), { recursive: true });
  mkdirSync(join(app, "Contents/Frameworks/X.framework/Versions/A"), { recursive: true });
  mkdirSync(join(app, "Contents/runtime/lib"), { recursive: true });
  writeFileSync(join(app, "Contents/MacOS/Raft"), binary);
  chmodSync(join(app, "Contents/MacOS/Raft"), 0o755);
  writeFileSync(join(app, "Contents/Info.plist"), "<plist/>");
  chmodSync(join(app, "Contents/Info.plist"), 0o644);
  // Two copies of the same bytes: one stored object.
  writeFileSync(join(app, "Contents/runtime/lib/libjvm.dylib"), "jvm-bytes");
  writeFileSync(join(app, "Contents/runtime/lib/libjvm-copy.dylib"), "jvm-bytes");
  writeFileSync(join(app, "Contents/Frameworks/X.framework/Versions/A/X"), "framework");
  symlinkSync("A", join(app, "Contents/Frameworks/X.framework/Versions/Current"));
  symlinkSync("Versions/Current/X", join(app, "Contents/Frameworks/X.framework/X"));
  return app;
}

describe("desktop bundle walk", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "hands-desktop-walk-")); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("records files with digest, size and mode, symlinks with their target, sorted by path", async () => {
    const walked = await walkDesktopBundle(makeBundle(dir));
    const manifest = buildDesktopManifest("darwin-arm64", walked);
    expect(manifest).toMatchObject({ schema: 1, target: "darwin-arm64", root: "Raft.app" });
    expect(manifest.files.map((f) => f.path)).toEqual([
      "Contents/Frameworks/X.framework/Versions/A/X",
      "Contents/Frameworks/X.framework/Versions/Current",
      "Contents/Frameworks/X.framework/X",
      "Contents/Info.plist",
      "Contents/MacOS/Raft",
      "Contents/runtime/lib/libjvm-copy.dylib",
      "Contents/runtime/lib/libjvm.dylib",
    ]);
    expect(manifest.files.find((f) => f.path === "Contents/MacOS/Raft")).toEqual({
      path: "Contents/MacOS/Raft", sha256: sha("binary-v1"), size: 9, mode: "755", link: null,
    });
    expect(manifest.files.find((f) => f.path === "Contents/Info.plist")).toMatchObject({ mode: "644" });
    expect(manifest.files.find((f) => f.path === "Contents/Frameworks/X.framework/X")).toEqual({
      path: "Contents/Frameworks/X.framework/X", link: "Versions/Current/X",
    });
    expect(manifest.total_size).toBe(9 + 8 + 9 + 9 + 9);
    expect(uniqueDigests(manifest)).toHaveLength(4);
  });

  it("refuses a symlink that points outside the bundle or is absolute", async () => {
    const app = makeBundle(dir);
    symlinkSync("../../../etc", join(app, "Contents/escape"));
    await expect(walkDesktopBundle(app)).rejects.toThrow(/outside the bundle/);
    expect(() => checkLinkTarget("a/b", "/usr/lib")).toThrow(/relative/);
    expect(() => checkLinkTarget("a/b", "../c")).not.toThrow();
    expect(() => checkLinkTarget("a/b", "../../c")).toThrow(/outside/);
  });

  it("refuses a bundle that is not a directory", async () => {
    writeFileSync(join(dir, "file"), "x");
    await expect(walkDesktopBundle(join(dir, "file"))).rejects.toThrow(/must be a directory/);
  });
});

describe("builds publish-desktop", () => {
  let dir: string;
  let server: ReturnType<typeof createServer>;
  let requests: Array<{ method: string; url: string; body?: any }>;
  let stored: Map<string, Buffer>;
  let staged: Map<string, Buffer>;
  let assetUploads: Map<string, Buffer>;
  let failPutOnce: Set<string>;
  let originalApi: string | undefined;
  let originalToken: string | undefined;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "hands-publish-desktop-"));
    requests = [];
    stored = new Map();
    staged = new Map();
    assetUploads = new Map();
    failPutOnce = new Set();
    let nextAsset = 1;
    let nextBuild = 1;
    server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const raw = Buffer.concat(chunks);
      const body = req.headers["content-type"]?.includes("application/json") && raw.length ? JSON.parse(raw.toString("utf8")) : undefined;
      const url = req.url ?? "";
      requests.push({ method: req.method ?? "GET", url, body });
      res.setHeader("content-type", "application/json");
      const host = `http://${req.headers.host}`;
      if (url === "/api/apps" && req.method === "POST") return res.end(JSON.stringify({ id: "app-2", org_id: "org", ...body }));
      if (url === "/api/apps") return res.end(JSON.stringify({ apps: [{ id: "app-1", slug: "raft-desktop" }] }));
      if (url === "/api/apps/app-1/channels") return res.end(JSON.stringify({ channels: [{ id: "channel-1", slug: "main", name: "Main" }] }));
      if (req.method === "GET" && url.startsWith("/api/apps/app-1/releases?")) return res.end(JSON.stringify({ releases: [] }));
      if (url === "/api/apps/app-1/desktop/files/missing") {
        const missing = (body.files as Array<{ sha256: string; size: number }>)
          .filter((f) => !stored.has(f.sha256))
          .map((f) => ({ ...f, upload_url: `${host}/r2-files/${f.sha256}`, headers: { "content-type": "application/octet-stream" }, expires_at: Date.now() + 3600_000 }));
        return res.end(JSON.stringify({ missing, present_count: body.files.length - missing.length }));
      }
      if (url.startsWith("/r2-files/") && req.method === "PUT") {
        const digest = url.split("/").at(-1)!;
        if (failPutOnce.delete(digest)) {
          res.statusCode = 503;
          return res.end();
        }
        staged.set(digest, raw);
        return res.end();
      }
      if (url === "/api/apps/app-1/desktop/files/complete") {
        const results = (body.files as Array<{ sha256: string; size: number }>).map((f) => {
          if (stored.has(f.sha256)) return { ...f, status: "present", retryable: false };
          const bytes = staged.get(f.sha256);
          if (!bytes) return { ...f, status: "missing_upload", retryable: false };
          if (sha(bytes) !== f.sha256) return { ...f, status: "sha256_mismatch", retryable: false };
          stored.set(f.sha256, bytes);
          return { ...f, status: "stored", retryable: false };
        });
        return res.end(JSON.stringify({ ok: true, results }));
      }
      if (url === "/api/apps/app-1/builds" && req.method === "POST") return res.end(JSON.stringify({ id: `build-${nextBuild++}` }));
      const declare = /^\/api\/apps\/app-1\/builds\/(build-\d+)\/assets\/uploads$/.exec(url);
      if (declare) {
        const assetId = `asset-${nextAsset++}`;
        return res.end(JSON.stringify({ asset_id: assetId, state: "pending", upload: { url: `${host}/r2-assets/${assetId}`, headers: { "content-type": "application/octet-stream" } } }));
      }
      if (url.startsWith("/r2-assets/") && req.method === "PUT") {
        assetUploads.set(url.split("/").at(-1)!, raw);
        return res.end();
      }
      const complete = /^\/api\/apps\/app-1\/builds\/build-\d+\/assets\/(asset-\d+)\/upload\/complete$/.exec(url);
      if (complete) {
        const bytes = assetUploads.get(complete[1]!) ?? Buffer.alloc(0);
        return res.end(JSON.stringify({ asset_id: complete[1], state: "ready", file_hash: sha(bytes), size_bytes: bytes.length }));
      }
      if (/^\/api\/apps\/app-1\/builds\/build-\d+$/.test(url) && req.method === "PATCH") return res.end(JSON.stringify({ ok: true }));
      if (url === "/api/apps/app-1/releases" && req.method === "POST") return res.end(JSON.stringify({ id: "release-1" }));
      res.statusCode = 404;
      return res.end(JSON.stringify({ error: "not found" }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("bad address");
    originalApi = process.env.HANDS_API;
    originalToken = process.env.HANDS_BEARER_TOKEN;
    process.env.HANDS_API = `http://127.0.0.1:${address.port}`;
    process.env.HANDS_BEARER_TOKEN = "test-token";
    const { setApiBase } = await import("../lib/api.js");
    setApiBase(process.env.HANDS_API);
    const { setCompleteRetryBaseMsForTests } = await import("./builds.js");
    setCompleteRetryBaseMsForTests(1);
    const { setDesktopRetryBaseMsForTests } = await import("./publish_desktop.js");
    setDesktopRetryBaseMsForTests(1);
  });

  afterEach(async () => {
    if (originalApi === undefined) delete process.env.HANDS_API;
    else process.env.HANDS_API = originalApi;
    if (originalToken === undefined) delete process.env.HANDS_BEARER_TOKEN;
    else process.env.HANDS_BEARER_TOKEN = originalToken;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  });

  async function run(bundle: string, extra: string[] = []) {
    const archive = join(dir, "Raft.zip");
    const installer = join(dir, "Raft.dmg");
    writeFileSync(archive, "zip-bytes");
    writeFileSync(installer, "dmg-bytes");
    const { registerBuildCommands } = await import("./builds.js");
    const program = new Command().version("0.5.70").option("--json", "JSON output", false);
    program.exitOverride();
    registerBuildCommands(program);
    const logs: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((line: unknown) => { logs.push(String(line)); });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await program.parseAsync(["node", "hands", "builds", "publish-desktop", "raft-desktop",
        "--target", "darwin-arm64", "--version-name", "1.2.0", "--version-code", "1002000",
        "--bundle", bundle, "--archive", archive, "--installer", installer, "--notes", "Faster sync", "--json", ...extra]);
    } finally {
      spy.mockRestore();
      errSpy.mockRestore();
    }
    return JSON.parse(logs.join("\n"));
  }

  it("uploads distinct files once, then the manifest, archive and installer, then publishes", async () => {
    failPutOnce.add(sha("framework"));
    const result = await run(makeBundle(dir));
    expect(result).toMatchObject({
      build_id: "build-1",
      release_id: "release-1",
      target: "darwin-arm64",
      version_name: "1.2.0",
      version_code: 1002000,
      files: { files: 5, links: 2, unique: 4, uploaded: 4, reused: 0 },
    });
    // The same jvm bytes appear twice in the bundle and are uploaded once.
    const puts = requests.filter((r) => r.method === "PUT" && r.url.startsWith("/r2-files/"));
    expect(puts.filter((r) => r.url.endsWith(sha("jvm-bytes")))).toHaveLength(1);
    // The failed PUT was retried.
    expect(puts.filter((r) => r.url.endsWith(sha("framework")))).toHaveLength(2);
    expect([...stored.keys()].sort()).toEqual([sha("binary-v1"), sha("<plist/>"), sha("jvm-bytes"), sha("framework")].sort());

    const build = requests.find((r) => r.method === "POST" && r.url === "/api/apps/app-1/builds")!;
    expect(build.body).toMatchObject({
      product_type: "desktop-installer",
      version_name: "1.2.0",
      version_code: 1002000,
      changelog: "Faster sync",
      status: "pending",
      asset_ingest_protocol_version: 1,
      required_asset_slots_json: [
        { artifact_kind: "desktop-manifest", platform: "darwin", arch: "arm64", variant: null, filetype: "json" },
        { artifact_kind: "desktop-archive", platform: "darwin", arch: "arm64", variant: null, filetype: "zip" },
        { artifact_kind: "installable", platform: "darwin", arch: "arm64", variant: null, filetype: "dmg" },
      ],
    });
    const manifest = JSON.parse(assetUploads.get("asset-1")!.toString("utf8"));
    expect(manifest).toMatchObject({ schema: 1, target: "darwin-arm64", root: "Raft.app" });
    expect(manifest.files).toHaveLength(7);

    const sequence = requests.map((r) => `${r.method} ${r.url.replace(/\?.*$/, "")}`);
    const lastFileComplete = sequence.lastIndexOf("POST /api/apps/app-1/desktop/files/complete");
    expect(lastFileComplete).toBeLessThan(sequence.indexOf("POST /api/apps/app-1/builds"));
    const patch = sequence.indexOf("PATCH /api/apps/app-1/builds/build-1");
    expect(patch).toBeGreaterThan(sequence.lastIndexOf("POST /api/apps/app-1/builds/build-1/assets/asset-3/upload/complete"));
    const release = requests.find((r) => r.method === "POST" && r.url === "/api/apps/app-1/releases")!;
    expect(sequence.indexOf("POST /api/apps/app-1/releases")).toBeGreaterThan(patch);
    expect(release.body).toMatchObject({ build_id: "build-1", status: "active", product_type: "desktop-installer", scopes: [{ scope_type: "full", scope_value: "all" }] });
  });

  it("reuses files Hands already holds and uploads only what changed", async () => {
    await run(makeBundle(dir));
    requests = [];
    const v2 = mkdtempSync(join(dir, "v2-"));
    const result = await run(makeBundle(v2, "binary-v2"), ["--draft"]);
    expect(result.files).toMatchObject({ unique: 4, uploaded: 1, reused: 3 });
    const puts = requests.filter((r) => r.method === "PUT" && r.url.startsWith("/r2-files/"));
    expect(puts.map((r) => r.url)).toEqual([`/r2-files/${sha("binary-v2")}`]);
    expect(requests.find((r) => r.method === "POST" && r.url === "/api/apps/app-1/releases")!.body.status).toBe("draft");
  });

  it("stops before creating a build when Hands refuses an uploaded file", async () => {
    const bundle = makeBundle(dir);
    // Corrupt the staged bytes the server sees for one digest.
    const original = server.listeners("request")[0] as (...args: any[]) => void;
    server.removeAllListeners("request");
    server.on("request", (req, res) => {
      if (req.url?.endsWith(sha("<plist/>")) && req.method === "PUT") {
        req.resume();
        req.on("end", () => { staged.set(sha("<plist/>"), Buffer.from("tampered")); res.end(); });
        return;
      }
      original(req, res);
    });
    await expect(run(bundle)).rejects.toThrow(/refused 1 uploaded file/);
    expect(requests.some((r) => r.method === "POST" && r.url === "/api/apps/app-1/builds")).toBe(false);
  });

  it("creates a desktop app with a runtime", async () => {
    const { registerAppCommands } = await import("./apps.js");
    const program = new Command();
    registerAppCommands(program);
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await program.parseAsync(["node", "hands", "apps", "create", "--slug", "compose", "--name", "Compose", "--platform", "desktop", "--runtime", "jvm"]);
    } finally {
      spy.mockRestore();
    }
    expect(requests.find((r) => r.method === "POST" && r.url === "/api/apps")!.body).toEqual({
      slug: "compose", name: "Compose", platform: "desktop", runtime: "jvm",
    });
  });

  it("validates target and version code before uploading", async () => {
    const bundle = makeBundle(dir);
    await expect(run(bundle, ["--target", "darwin-universal"])).rejects.toThrow(/--target must be one of/);
    await expect(run(bundle, ["--version-code", "-1"])).rejects.toThrow(/--version-code/);
    expect(requests.some((r) => r.url.includes("/desktop/files/"))).toBe(false);
  });
});
