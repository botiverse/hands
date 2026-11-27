import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { Command } from "commander";
import { parse } from "yaml";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/agent_env.js", () => ({ admitAgent: () => ({ kind: "none" }) }));

const APP = "11111111-2222-3333-4444-555555555555";
const ARCHES = ["arm64", "x64"] as const;
const b64 = (b: Buffer) => createHash("sha512").update(b).digest("base64");
const havePython = (() => { try { execFileSync("python3", ["--version"], { stdio: "ignore" }); return true; } catch { return false; } })();

// Zips the way ditto does (modes and symlinks kept); an `unzip` stand-in when the machine has none.
const ZIP_PY = `
import os, stat, sys, zipfile
src, out = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
    base = os.path.dirname(src)
    for root, dirs, files in os.walk(src):
        for name in sorted(dirs) + sorted(files):
            p = os.path.join(root, name); rel = os.path.relpath(p, base); st = os.lstat(p)
            if stat.S_ISLNK(st.st_mode):
                i = zipfile.ZipInfo(rel); i.create_system = 3; i.external_attr = (st.st_mode & 0xFFFF) << 16; z.writestr(i, os.readlink(p))
            elif stat.S_ISDIR(st.st_mode):
                i = zipfile.ZipInfo(rel + "/"); i.create_system = 3; i.external_attr = ((st.st_mode & 0xFFFF) << 16) | 0x10; z.writestr(i, b"")
            else: z.write(p, rel)
`;
const UNZIP_PY = `
import os, stat, sys, zipfile
args = [a for a in sys.argv[1:] if a != "-q"]
if args and args[0] == "-v": sys.exit(0)
z = zipfile.ZipFile(args[0]); dest = args[args.index("-d") + 1]
for i in z.infolist():
    mode = i.external_attr >> 16; dst = os.path.join(dest, i.filename)
    os.makedirs(os.path.dirname(dst.rstrip("/")) or ".", exist_ok=True)
    if stat.S_ISLNK(mode): os.symlink(z.read(i).decode(), dst)
    elif i.filename.endswith("/"): os.makedirs(dst, exist_ok=True); os.chmod(dst, stat.S_IMODE(mode) or 0o755)
    else:
        with open(dst, "wb") as f: f.write(z.read(i))
        os.chmod(dst, stat.S_IMODE(mode) or 0o644)
`;

function release(root: string, version: string, arch: string): Buffer {
  const app = path.join(root, `${version}-${arch}`, "My App.app");
  const put = (rel: string, body: string): void => {
    mkdirSync(path.dirname(path.join(app, rel)), { recursive: true });
    writeFileSync(path.join(app, rel), body);
  };
  put("Contents/Info.plist", `<plist><key>CFBundleShortVersionString</key>\n<string>${version}</string></plist>`);
  put("Contents/Resources/app.asar", `asar ${arch} ${"frontend ".repeat(20_000)}${version}`);
  put("Contents/Resources/same.bin", "same");
  put("Contents/Frameworks/Electron Framework.framework/Versions/A/Resources/Info.plist", "<plist><key>CFBundleVersion</key>\n<string>45.3.2</string></plist>");
  const zip = path.join(root, `My-App-${version}-${arch}.zip`);
  execFileSync("python3", ["-I", "-c", ZIP_PY, app, zip]);
  return readFileSync(zip);
}

const feedText = (version: string, zips: Record<string, Buffer>): string => [
  `version: ${version}`,
  "files:",
  ...Object.entries(zips).flatMap(([arch, bytes]) => [
    `  - url: My-App-${version}-${arch}.zip`,
    `    sha512: ${b64(bytes)}`,
    `    size: ${bytes.length}`,
  ]),
  `path: My-App-${version}-${Object.keys(zips)[0]}.zip`,
  `sha512: ${b64(Object.values(zips)[0]!)}`,
  "releaseDate: '2026-11-27T00:00:00.000Z'",
  "",
].join("\n");

describe.skipIf(!havePython)("hands electron make-patches", () => {
  let server: Server;
  let fixtures: string;
  let dir: string;
  let out: string[];
  let err: string[];
  const zips = new Map<string, Buffer>(); // file name -> bytes
  const feeds = new Map<string, string>(); // version -> latest-mac.yml
  let corrupt: Set<string>;
  const saved = { api: process.env.HANDS_API, token: process.env.HANDS_BEARER_TOKEN, path: process.env.PATH };
  const releases = [
    { id: "rel-110", build_id: "b-110", status: "draft", version_name: "1.1.0", version_code: 110, product_type: "desktop-installer" },
    { id: "rel-100", build_id: "b-100", status: "active", version_name: "1.0.0", version_code: 100, product_type: "desktop-installer" },
    { id: "rel-095", build_id: "b-095", status: "cancelled", version_name: "0.9.5", version_code: 95, product_type: "desktop-installer" },
    { id: "rel-090", build_id: "b-090", status: "superseded", version_name: "0.9.0", version_code: 90, product_type: "desktop-installer" },
    { id: "rel-080", build_id: "b-080", status: "superseded", version_name: "0.8.0", version_code: 80, product_type: "electron-installer" },
    { id: "rel-070", build_id: "b-070", status: "superseded", version_name: "0.7.0", version_code: 70, product_type: "electron-installer" },
  ];

  beforeAll(() => {
    fixtures = mkdtempSync(path.join(tmpdir(), "hands-make-patches-fixtures-"));
    for (const version of ["1.1.0", "1.0.0", "0.9.0", "0.8.0", "0.7.0"]) {
      const made: Record<string, Buffer> = {};
      for (const arch of ARCHES) {
        made[arch] = release(fixtures, version, arch);
        zips.set(`My-App-${version}-${arch}.zip`, made[arch]);
      }
      feeds.set(version, feedText(version, made));
    }
    try { execFileSync("unzip", ["-v"], { stdio: "ignore" }); } catch {
      const bin = path.join(fixtures, "bin");
      mkdirSync(bin);
      writeFileSync(path.join(bin, "unzip"), `#!/usr/bin/env python3\n${UNZIP_PY}`);
      chmodSync(path.join(bin, "unzip"), 0o755);
      process.env.PATH = `${bin}${path.delimiter}${process.env.PATH ?? ""}`;
    }
  });
  afterAll(() => {
    rmSync(fixtures, { recursive: true, force: true });
    process.env.PATH = saved.path;
  });

  beforeEach(async () => {
    out = [];
    err = [];
    corrupt = new Set();
    process.exitCode = undefined;
    dir = mkdtempSync(path.join(tmpdir(), "hands-make-patches-"));
    for (const arch of ARCHES) writeFileSync(path.join(dir, `My-App-1.1.0-${arch}.zip`), zips.get(`My-App-1.1.0-${arch}.zip`)!);
    writeFileSync(path.join(dir, "latest-mac.yml"), feeds.get("1.1.0")!);
    vi.spyOn(console, "log").mockImplementation((...args) => { out.push(args.join(" ")); });
    vi.spyOn(console, "error").mockImplementation((...args) => { err.push(args.join(" ")); });
    server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://x");
      const json = (body: unknown, status = 200) => { res.statusCode = status; res.setHeader("content-type", "application/json"); res.end(JSON.stringify(body)); };
      if (url.pathname === `/api/apps/${APP}/releases`) {
        expect(url.searchParams.get("channel")).toBe("main");
        return json({ releases: releases.filter((r) => r.product_type === url.searchParams.get("product_type")) });
      }
      let m = /^\/api\/apps\/[^/]+\/releases\/rel-(\d+)\/electron-metadata\/latest-mac\.yml$/.exec(url.pathname);
      if (m) {
        const r = releases.find((x) => x.id === `rel-${m![1]}`)!;
        res.setHeader("content-type", "text/yaml; charset=utf-8");
        return res.end(feeds.get(r.version_name));
      }
      m = /^\/api\/apps\/[^/]+\/builds\/b-(\d+)\/assets$/.exec(url.pathname);
      if (m) {
        const r = releases.find((x) => x.build_id === `b-${m![1]}`)!;
        return json({
          assets: ARCHES.map((arch) => ({
            id: `a-${r.version_name}-${arch}`, variant: null, r2_key: `apps/x/builds/${r.build_id}/${arch}.zip`,
            metadata_json: JSON.stringify({ filename: `My-App-${r.version_name}-${arch}.zip` }),
          })),
        });
      }
      m = /^\/api\/apps\/[^/]+\/builds\/[^/]+\/assets\/a-([^/]+)-(arm64|x64)\/download$/.exec(url.pathname);
      if (m) {
        expect(url.searchParams.get("presign")).toBe("1");
        return json({ download_url: `/r2/My-App-${m[1]}-${m[2]}.zip` });
      }
      m = /^\/r2\/(.+)$/.exec(url.pathname);
      if (m && zips.has(m[1]!)) {
        const bytes = zips.get(m[1]!)!;
        return res.end(corrupt.has(m[1]!) ? Buffer.concat([bytes, Buffer.from("x")]) : bytes);
      }
      return json({ error: "not found" }, 404);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("bad address");
    process.env.HANDS_API = `http://127.0.0.1:${address.port}`;
    process.env.HANDS_BEARER_TOKEN = "session-token";
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
    rmSync(dir, { recursive: true, force: true });
    if (saved.api === undefined) delete process.env.HANDS_API; else process.env.HANDS_API = saved.api;
    if (saved.token === undefined) delete process.env.HANDS_BEARER_TOKEN; else process.env.HANDS_BEARER_TOKEN = saved.token;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  async function run(...args: string[]) {
    const { registerElectronCommands } = await import("./electron.js");
    const program = new Command().option("--json", "JSON output", false);
    registerElectronCommands(program);
    await program.parseAsync(["node", "hands", "electron", "make-patches", APP, "--version-name", "1.1.0", "--dir", dir, "--level", "3", ...args]);
  }

  const patchesJson = () => JSON.parse(readFileSync(path.join(dir, "patches.json"), "utf8"));
  const patchFiles = () => readdirSync(dir).filter((f) => f.endsWith(".patch")).sort();

  it("patches from the newest three releases, both names of the product type, and lists them in the feed", async () => {
    const feed = path.join(dir, "latest-mac.yml");
    await run("--update-feed", feed);
    expect(process.exitCode ?? 0).toBe(0);
    const result = patchesJson();
    expect(result.previousVersion).toBe("1.0.0");
    expect(result.electronVersion).toBe("45.3.2");
    expect(result.patches.map((p: { from: string; arch: string }) => `${p.from}/${p.arch}`)).toEqual([
      "1.0.0/arm64", "1.0.0/x64", "0.9.0/arm64", "0.9.0/x64", "0.8.0/arm64", "0.8.0/x64",
    ]);
    expect(patchFiles()).toEqual([
      "My-App-1.1.0-arm64-from-0.8.0.patch", "My-App-1.1.0-arm64-from-0.9.0.patch", "My-App-1.1.0-arm64-from-1.0.0.patch",
      "My-App-1.1.0-x64-from-0.8.0.patch", "My-App-1.1.0-x64-from-0.9.0.patch", "My-App-1.1.0-x64-from-1.0.0.patch",
    ]);
    for (const p of result.patches) {
      const bytes = readFileSync(path.join(dir, p.url));
      expect(p.size).toBe(bytes.length);
      expect(p.sha512).toBe(b64(bytes));
      expect(bytes.toString("latin1", 0, 8)).toBe("HANDPAT1");
    }
    expect(result.slots[0]).toEqual({
      file: "My-App-1.1.0-arm64-from-1.0.0.patch", artifact_kind: "update-patch", platform: "darwin", arch: "arm64",
      variant: "patch-from-1.0.0", filetype: "patch",
      metadata: { from: "1.0.0", algorithm: "app-patch-v1", sha512: result.patches[0].sha512 },
    });
    const written = parse(readFileSync(feed, "utf8"));
    const original = parse(feeds.get("1.1.0")!);
    expect(written).toEqual({ ...original, patches: result.patches, previousVersion: "1.0.0", electronVersion: "45.3.2" });
    expect(out.join("\n")).toContain("Made 6 patches");
  }, 120_000);

  it("writes Raft Desktop's magic on request, from exactly the versions asked for", async () => {
    await run("--legacy-magic", "--from", "0.9.0", "--arch", "arm64");
    expect(patchFiles()).toEqual(["My-App-1.1.0-arm64-from-0.9.0.patch"]);
    expect(readFileSync(path.join(dir, patchFiles()[0]!)).toString("latin1", 0, 8)).toBe("RAFTPAT1");
  }, 60_000);

  it("skips an older base that fails, and ships the others", async () => {
    corrupt.add("My-App-0.9.0-x64.zip");
    await run("--from-count", "2");
    expect(process.exitCode ?? 0).toBe(0);
    expect(patchesJson().patches.map((p: { from: string }) => p.from)).toEqual(["1.0.0", "1.0.0"]);
    expect(patchFiles()).toEqual(["My-App-1.1.0-arm64-from-1.0.0.patch", "My-App-1.1.0-x64-from-1.0.0.patch"]);
    expect(err.join("\n")).toMatch(/warning: patches from 0\.9\.0 failed/);
  }, 60_000);

  it("ships no patches and leaves the feed alone when the newest base fails (exit 2)", async () => {
    corrupt.add("My-App-1.0.0-x64.zip");
    const feed = path.join(dir, "latest-mac.yml");
    await run("--from-count", "2", "--update-feed", feed);
    expect(process.exitCode).toBe(2);
    expect(patchFiles()).toEqual([]);
    expect(existsSync(path.join(dir, "patches.json"))).toBe(false);
    expect(readFileSync(feed, "utf8")).toBe(feeds.get("1.1.0"));
    expect(err.join("\n")).toMatch(/error: patches from 1\.0\.0 failed/);
  }, 60_000);

  it("is not a failure to have nothing worth shipping: the feed stays as it was", async () => {
    const feed = path.join(dir, "latest-mac.yml");
    await run("--from-count", "1", "--max-bytes", "100", "--update-feed", feed, "--json");
    expect(process.exitCode ?? 0).toBe(0);
    expect(JSON.parse(out.join("\n"))).toMatchObject({ previousVersion: "1.0.0", patches: [], slots: [] });
    expect(patchFiles()).toEqual([]);
    expect(readFileSync(feed, "utf8")).toBe(feeds.get("1.1.0"));
  }, 60_000);

  it("refuses a release zip that is not the one its feed lists", async () => {
    writeFileSync(path.join(dir, "My-App-1.1.0-x64.zip"), "other bytes");
    await expect(run()).rejects.toThrow(/My-App-1\.1\.0-x64\.zip is not the file latest-mac\.yml lists/);
  });

  it("limits the number of bases", async () => {
    await expect(run("--from-count", "11")).rejects.toThrow(/--from-count must be 0 to 10/);
  });
});
