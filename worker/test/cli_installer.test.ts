import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleCliInstaller, handleCliInstallerMetadata, renderCliInstaller } from "../src/routes/cli_installer";
import { handleExternalLatestDl } from "../src/routes/external_dl";
vi.mock("@cloudflare/containers", () => ({ Container: class {}, getRandom: () => { throw new Error("unused"); } }));
import worker from "../src/index";

function d1(sqlite: Database.Database) {
  return { prepare(sql: string) {
    const indexes: number[] = [];
    const statement = sqlite.prepare(sql.replace(/\?(\d+)/g, (_match, index) => { indexes.push(Number(index)); return "?"; }));
    const bind = (...values: unknown[]) => {
      const bound = indexes.length ? indexes.map((index) => values[index - 1]) : values;
      return {
        first: async <T>() => (statement.get(...bound) as T | undefined) ?? null,
        all: async <T>() => ({ results: statement.all(...bound) as T[] }),
      };
    };
    return { bind, first: () => bind().first() };
  } };
}

const hash = (value: string) => createHash("sha256").update(value).digest("hex");

describe("Hands CLI installer endpoints", () => {
  let sqlite: Database.Database;
  let env: { DB: ReturnType<typeof d1>; BUSINESS_ORIGIN: string };
  let app: Hono<{ Bindings: typeof env }>;
  beforeEach(() => {
    sqlite = new Database(":memory:");
    sqlite.exec(`
      CREATE TABLE apps (id TEXT PRIMARY KEY, slug TEXT);
      CREATE TABLE channels (id TEXT PRIMARY KEY, app_id TEXT, slug TEXT);
      CREATE TABLE releases (id TEXT PRIMARY KEY, app_id TEXT, channel_id TEXT, build_id TEXT,
        product_type TEXT, status TEXT, hidden INTEGER, rollout_cohort_count INTEGER,
        availability_at INTEGER, activated_at INTEGER, created_at INTEGER, changelog TEXT);
      CREATE TABLE release_scopes (release_id TEXT, scope_type TEXT, scope_value TEXT);
      CREATE TABLE builds (id TEXT PRIMARY KEY, status TEXT, artifact_mode TEXT,
        product_type TEXT NOT NULL DEFAULT 'cli-binary', release_type TEXT NOT NULL DEFAULT 'stable');
      CREATE TABLE build_assets (build_id TEXT, platform TEXT, arch TEXT, variant TEXT,
        filetype TEXT, artifact_kind TEXT, file_hash TEXT, size_bytes INTEGER, created_at INTEGER);
      CREATE TABLE external_build_targets (build_id TEXT, target TEXT, raw_sha256 TEXT, raw_size_bytes INTEGER);
      INSERT INTO apps VALUES ('app', 'my-cli');
      INSERT INTO channels VALUES ('main-id', 'app', 'main');
      INSERT INTO builds (id, status, artifact_mode) VALUES ('build-1', 'succeeded', 'hands_r2');
      INSERT INTO releases (id, app_id, channel_id, build_id, product_type, status, hidden, rollout_cohort_count, availability_at, activated_at, created_at) VALUES ('release-1', 'app', 'main-id', 'build-1', 'cli-binary', 'active', 0, NULL, NULL, 1, 1);
      INSERT INTO release_scopes VALUES ('release-1', 'full', 'all');
    `);
    env = { DB: d1(sqlite), BUSINESS_ORIGIN: "https://hands.example" };
    app = new Hono<{ Bindings: typeof env }>();
    app.get("/dl/:slug/:channel/install.sh", handleCliInstaller as never);
    app.get("/dl/:slug/:channel/:file", handleExternalLatestDl as never);
    app.get("/public/v2/apps/:slug/installer/:channel/:target", handleCliInstallerMetadata as never);
  });
  afterEach(() => sqlite.close());

  function hosted(sha = hash("binary"), size = 6) {
    sqlite.prepare("INSERT INTO build_assets VALUES ('build-1', 'linux', 'x64', NULL, 'binary', 'installable', ?, ?, 1)").run(sha, size);
  }
  function metadata(channel = "main", target = "linux-x64") {
    return app.request(`/public/v2/apps/my-cli/installer/${channel}/${target}`, {}, env);
  }

  it("serves the script at the short path before the generic binary route", async () => {
    const res = await app.request("/dl/my-cli/main/install.sh", {}, env);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^text\/x-shellscript/);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const script = await res.text();
    expect(script).toContain("https://hands.example/public/v2/apps/my-cli/installer/main");
    expect(script).not.toContain("http://localhost");
  });

  it("registers the short route on the actual Worker", async () => {
    const response = await worker.fetch(new Request("https://hands.example/dl/my-cli/main/install.sh"),
      env as never, { waitUntil() {}, passThroughOnException() {} } as never);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/^text\/x-shellscript/);
    expect(await response.text()).toContain("https://hands.example/public/v2/apps/my-cli/installer/main");
    hosted();
    const metadataResponse = await worker.fetch(new Request("https://hands.example/public/v2/apps/my-cli/installer/main/linux-x64"),
      env as never, { waitUntil() {}, passThroughOnException() {} } as never);
    expect(metadataResponse.status).toBe(200);
    expect(await metadataResponse.text()).toBe(`release-1 ${hash("binary")} 6\n`);
  });

  it("fails closed for unsafe names and insecure configuration", async () => {
    expect((await app.request("/dl/my-cli/releases/install.sh", {}, env)).status).toBe(400);
    expect((await app.request("/dl/my%27cli/main/install.sh", {}, env)).status).toBe(400);
    expect((await app.request("/dl/my-cli/main/install.sh", {}, { ...env, BUSINESS_ORIGIN: "http://hands.example" })).status).toBe(503);
    expect((await metadata("main", "win32-x64")).status).toBe(400);
  });

  it("returns the hosted release and identity; latest aliases main", async () => {
    hosted();
    const main = await metadata();
    expect(main.status).toBe(200);
    expect(await main.text()).toBe(`release-1 ${hash("binary")} 6\n`);
    expect(await (await metadata("latest")).text()).toBe(`release-1 ${hash("binary")} 6\n`);
    expect(main.headers.get("cache-control")).toBe("no-store");
  });

  it("accepts uppercase app and channel names", async () => {
    hosted();
    sqlite.exec("UPDATE apps SET slug = 'My-CLI'; UPDATE channels SET slug = 'Beta';");
    const script = await app.request("/dl/My-CLI/Beta/install.sh", {}, env);
    expect(script.status).toBe(200);
    const info = await app.request("/public/v2/apps/My-CLI/installer/Beta/linux-x64", {}, env);
    expect(info.status).toBe(200);
    expect(await info.text()).toBe(`release-1 ${hash("binary")} 6\n`);
  });

  it("resolves a real latest channel rather than shadowing it with the alias", async () => {
    hosted();
    sqlite.exec(`INSERT INTO channels VALUES ('latest-id', 'app', 'latest');
      INSERT INTO builds (id, status, artifact_mode) VALUES ('build-2', 'succeeded', 'external');
      INSERT INTO releases (id, app_id, channel_id, build_id, product_type, status, hidden, rollout_cohort_count, availability_at, activated_at, created_at) VALUES ('release-2', 'app', 'latest-id', 'build-2', 'cli-binary', 'active', 0, NULL, NULL, 2, 2);
      INSERT INTO release_scopes VALUES ('release-2', 'full', 'all');`);
    sqlite.prepare("INSERT INTO external_build_targets VALUES ('build-2', 'linux-x64', ?, 8)").run(hash("external"));
    expect(await (await metadata("latest")).text()).toBe(`release-2 ${hash("external")} 8\n`);
  });

  it("uses declared external placement even when stray hosted rows exist", async () => {
    hosted();
    sqlite.prepare("UPDATE builds SET artifact_mode = 'external'").run();
    sqlite.prepare("INSERT INTO external_build_targets VALUES ('build-1', 'linux-x64', ?, 8)").run(hash("external"));
    expect(await (await metadata()).text()).toBe(`release-1 ${hash("external")} 8\n`);
  });

  it.each([
    ["hidden", "UPDATE releases SET hidden = 1"],
    ["staged rollout", "UPDATE releases SET rollout_cohort_count = 50"],
    ["future availability", "UPDATE releases SET availability_at = 9999999999999"],
    ["draft", "UPDATE releases SET status = 'draft'"],
    ["superseded", "UPDATE releases SET status = 'superseded'"],
    ["wrong product", "UPDATE releases SET product_type = 'desktop-installer'"],
    ["failed build", "UPDATE builds SET status = 'failed'"],
    ["QA build", "UPDATE builds SET release_type = 'qa'"],
    ["simulator QA build", "UPDATE builds SET product_type = 'ios-simulator-qa'"],
    ["scoped release", "UPDATE release_scopes SET scope_type = 'platform', scope_value = 'linux'"],
  ])("does not select a %s", async (_label, sql) => {
    hosted();
    sqlite.exec(sql);
    expect((await metadata()).status).toBe(404);
  });

  it("does not silently fall back to an older release if the latest lacks the target", async () => {
    hosted();
    sqlite.exec(`INSERT INTO builds (id, status, artifact_mode) VALUES ('build-2', 'succeeded', 'hands_r2');
      INSERT INTO releases (id, app_id, channel_id, build_id, product_type, status, hidden, rollout_cohort_count, availability_at, activated_at, created_at) VALUES ('release-2', 'app', 'main-id', 'build-2', 'cli-binary', 'active', 0, NULL, NULL, 2, 2);
      INSERT INTO release_scopes VALUES ('release-2', 'full', 'all');`);
    expect((await metadata()).status).toBe(404);
  });

  it("rejects malformed integrity metadata and a primary row of the wrong kind", async () => {
    hosted("wrong", 6);
    expect((await metadata()).status).toBe(409);
    sqlite.prepare("UPDATE build_assets SET file_hash = ?, size_bytes = 0").run(hash("binary"));
    expect((await metadata()).status).toBe(409);
    sqlite.prepare("UPDATE build_assets SET size_bytes = 6, filetype = 'sh'").run();
    expect((await metadata()).status).toBe(404);
  });
});

describe("generated installer executed by a real POSIX shell", () => {
  let root: string;
  let bin: string;
  let destination: string;
  let fixture: string;
  let metadataPath: string;
  let requests: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "hands-installer-"));
    bin = join(root, "bin");
    destination = join(root, "install with spaces");
    fixture = join(root, "binary");
    metadataPath = join(root, "metadata");
    requests = join(root, "requests");
    mkdirSync(bin);
    mkdirSync(destination);
    writeFileSync(fixture, "binary");
    writeFileSync(metadataPath, `release-1 ${hash("binary")} 6\n`);
    writeFileSync(join(bin, "uname"), "#!/bin/sh\ncase \"$1\" in -s) echo \"${TEST_OS:-Linux}\" ;; -m) echo \"${TEST_ARCH:-x86_64}\" ;; esac\n", { mode: 0o755 });
    writeFileSync(join(bin, "curl"), `#!/bin/sh
out=
while [ "$#" -gt 0 ]; do
  case "$1" in -o) out=$2; shift 2 ;; --proto|--proto-redir) shift 2 ;; -fsSL) shift ;; *) url=$1; shift ;; esac
done
printf '%s\\n' "$url" >> "$TEST_REQUESTS"
case "$url" in
  */installer/*) cat "$TEST_METADATA" ;;
  */releases/*) [ "\${TEST_DOWNLOAD_FAIL:-0}" = 0 ] || exit 22; cp "$TEST_BINARY" "$out" ;;
  *) exit 22 ;;
esac
`, { mode: 0o755 });
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));
  function run(extra: Record<string, string> = {}) {
    const script = join(root, "install.sh");
    writeFileSync(script, renderCliInstaller("https://hands.example", "my-cli", "main"));
    return spawnSync("/bin/sh", [script], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
        HANDS_INSTALL_DIR: destination, TEST_BINARY: fixture, TEST_METADATA: metadataPath,
        TEST_REQUESTS: requests, ...extra },
    });
  }
  it("detects target, pins a release, checks bytes and atomically installs executable", () => {
    const result = run({ TEST_OS: "Darwin", TEST_ARCH: "arm64", HANDS_INSTALL_NAME: "my-command" });
    expect(result.status).toBe(0);
    const installed = join(destination, "my-command");
    expect(readFileSync(installed, "utf8")).toBe("binary");
    expect(statSync(installed).mode & 0o111).toBe(0o111);
    expect(readFileSync(requests, "utf8")).toBe("https://hands.example/public/v2/apps/my-cli/installer/main/darwin-arm64\nhttps://hands.example/dl/my-cli/releases/release-1/darwin-arm64\n");
  });
  it("uses the macOS-compatible shasum when sha256sum is unavailable", () => {
    for (const name of ["cat", "cp", "mkdir", "mktemp", "wc", "tr", "chmod", "mv", "rm", "shasum"]) {
      symlinkSync(`/usr/bin/${name}`, join(bin, name));
    }
    const result = run({ TEST_OS: "Darwin", TEST_ARCH: "arm64", PATH: bin });
    expect(result.status).toBe(0);
    expect(readFileSync(join(destination, "my-cli"), "utf8")).toBe("binary");
  });
  it("creates a missing install directory using the caller's umask", () => {
    const fresh = join(root, "new", "bin");
    const result = run({ HANDS_INSTALL_DIR: fresh });
    expect(result.status).toBe(0);
    expect(statSync(fresh).mode & 0o777).toBe(0o777 & ~process.umask());
  });
  it("preserves an existing executable on checksum mismatch", () => {
    writeFileSync(join(destination, "my-cli"), "old");
    writeFileSync(fixture, "tamper"); // same length, so only the digest catches it
    const result = run();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("SHA-256 does not match");
    expect(readFileSync(join(destination, "my-cli"), "utf8")).toBe("old");
  });
  it("preserves an existing executable on wrong size or download failure", () => {
    writeFileSync(join(destination, "my-cli"), "old");
    writeFileSync(fixture, "wrong length");
    expect(run().stderr).toContain("size does not match");
    expect(readFileSync(join(destination, "my-cli"), "utf8")).toBe("old");
    expect(run({ TEST_DOWNLOAD_FAIL: "1" }).stderr).toContain("download failed");
    expect(readFileSync(join(destination, "my-cli"), "utf8")).toBe("old");
  });
  it("rejects untrusted metadata and unsupported machines before downloading", () => {
    writeFileSync(metadataPath, `release-1;touch ${hash("binary")} 6\n`);
    expect(run().status).not.toBe(0);
    expect(readFileSync(requests, "utf8").split("\n").filter(Boolean)).toHaveLength(1);
    expect(run({ TEST_OS: "Windows" }).stderr).toContain("only Linux and macOS");
    expect(run({ TEST_ARCH: "riscv64" }).stderr).toContain("unsupported CPU");
  });
  it("rejects unsafe paths and leaves directories untouched", () => {
    expect(run({ HANDS_INSTALL_NAME: "../other" }).stderr).toContain("invalid HANDS_INSTALL_NAME");
    expect(run({ HANDS_INSTALL_DIR: "relative" }).stderr).toContain("absolute path");
    mkdirSync(join(destination, "my-cli"));
    expect(run().stderr).toContain("destination is a directory");
  });
});
