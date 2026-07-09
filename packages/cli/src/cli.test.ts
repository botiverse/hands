/**
 * Smoke tests for the quiver CLI.
 *
 * Run: `pnpm --filter @botiverse/hands-cli test`
 *
 * v1 tests cover: config load/save (without leaking the real file),
 * + apiRequest routing (against a tiny local http.createServer stub).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";

describe("config round-trip", () => {
  let dir: string;
  let originalXdg: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "quiver-cli-"));
    originalXdg = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = dir;
  });

  afterEach(() => {
    if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = originalXdg;
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  });

  it("returns empty config when no file exists", async () => {
    const { getConfig } = await import("../src/lib/config.js");
    expect(getConfig()).toEqual({});
  });

  it("saveConfig persists to the XDG path", async () => {
    const { saveConfig, getConfig } = await import("../src/lib/config.js");
    saveConfig({ apiBase: "https://example.test", sessionCookie: "tok123" });
    const path = join(dir, "quiver", "auth.json");
    expect(existsSync(path)).toBe(true);
    const raw = JSON.parse(readFileSync(path, "utf8"));
    expect(raw.apiBase).toBe("https://example.test");
    expect(raw.sessionCookie).toBe("tok123");
    expect(getConfig().apiBase).toBe("https://example.test");
  });
});

describe("apiRequest", () => {
  let server: ReturnType<typeof createServer>;
  let baseUrl: string;
  let lastCookie: string | null = null;
  let lastAuthorization: string | null = null;

  beforeEach(async () => {
    server = createServer((req, res) => {
      lastCookie = req.headers.cookie ?? null;
      lastAuthorization = req.headers.authorization ?? null;
      res.setHeader("content-type", "application/json");
      if (req.url === "/api/auth/me") {
        res.end(JSON.stringify({ account: { id: "u1", display_name: "Test" } }));
        return;
      }
      if (req.url?.startsWith("/api/apps")) {
        res.end(JSON.stringify({ apps: [] }));
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ error: "not found" }));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("bad address");
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  it("sends the QUIVER_SESSION_COOKIE env var as a cookie header", async () => {
    process.env.QUIVER_SESSION_COOKIE = "abc123";
    process.env.QUIVER_API = baseUrl;
    const { apiRequest } = await import("../src/lib/api.js");
    const me = await apiRequest<{ account: { id: string } }>("/api/auth/me");
    expect(me.account.id).toBe("u1");
    expect(lastCookie).toBe("abc123");
    delete process.env.QUIVER_SESSION_COOKIE;
    delete process.env.QUIVER_API;
  });

  it("prefers QUIVER_AUTH_TOKEN as a bearer token over cookie auth", async () => {
    process.env.QUIVER_SESSION_COOKIE = "cookie-token";
    process.env.QUIVER_AUTH_TOKEN = "bearer-token";
    process.env.QUIVER_API = baseUrl;
    const { apiRequest } = await import("../src/lib/api.js");
    const me = await apiRequest<{ account: { id: string } }>("/api/auth/me");
    expect(me.account.id).toBe("u1");
    expect(lastAuthorization).toBe("Bearer bearer-token");
    expect(lastCookie).toBeNull();
    delete process.env.QUIVER_SESSION_COOKIE;
    delete process.env.QUIVER_AUTH_TOKEN;
    delete process.env.QUIVER_API;
  });

  it("throws QuiverApiError on non-2xx", async () => {
    process.env.QUIVER_API = baseUrl;
    const { apiRequest, QuiverApiError } = await import("../src/lib/api.js");
    await expect(apiRequest("/api/missing")).rejects.toBeInstanceOf(QuiverApiError);
    delete process.env.QUIVER_API;
  });
});

describe("electron build helpers", () => {
  it("infers Electron platforms from metadata and artifact filenames", async () => {
    const { inferElectronPlatform } = await import("../src/commands/builds.js");
    expect(inferElectronPlatform("dist/latest.yml")).toBe("win32");
    expect(inferElectronPlatform("dist/latest-mac.yml")).toBe("darwin");
    expect(inferElectronPlatform("dist/latest-linux.yml")).toBe("linux");
    expect(inferElectronPlatform("dist/Raft-1.2.3.AppImage")).toBe("linux");
    expect(inferElectronPlatform("dist/Raft-1.2.3.dmg")).toBe("darwin");
  });

  it("infers Electron filetypes without lowercasing AppImage", async () => {
    const { inferElectronFiletype } = await import("../src/commands/builds.js");
    expect(inferElectronFiletype("dist/latest.yml")).toBe("yml");
    expect(inferElectronFiletype("dist/Raft Setup 1.2.3.exe")).toBe("exe");
    expect(inferElectronFiletype("dist/Raft-1.2.3.AppImage")).toBe("AppImage");
    expect(inferElectronFiletype("dist/Raft Setup 1.2.3.exe.blockmap")).toBe("blockmap");
  });
});

describe("iOS build helper contract", () => {
  it("documents signed IPA as the installable artifact shape", async () => {
    const { inferIosFiletype } = await import("../src/commands/builds.js");
    expect(inferIosFiletype("build/App.ipa")).toBe("ipa");
    expect(inferIosFiletype("build/App.dSYM.zip")).toBe("dsym.zip");
    expect(inferIosFiletype("build/metadata.json")).toBe("metadata.json");
  });

  it("serializes localized publish changelogs like release updates", async () => {
    const { parseChangelogOptions } = await import("../src/commands/builds.js");
    expect(
      parseChangelogOptions({
        changelog: ["zh=中文更新", "en=English update"],
      }),
    ).toBe(JSON.stringify({ "zh-CN": "中文更新", en: "English update" }));
    expect(parseChangelogOptions({ changelog: ["plain update"] })).toBe("plain update");
    expect(parseChangelogOptions({})).toBeNull();
    expect(() =>
      parseChangelogOptions({ changelog: ["plain update", "en=English update"] }),
    ).toThrow("mix of plain and lang= changelog entries");
  });
});

describe("build publish changelog options", () => {
  it("supports repeatable lang=file changelogs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "quiver-changelog-"));
    try {
      const zh = join(dir, "zh.md");
      const en = join(dir, "en.md");
      writeFileSync(zh, "中文更新\n");
      writeFileSync(en, "English update\n");
      const { parseChangelogOptions } = await import("../src/commands/builds.js");
      expect(
        parseChangelogOptions({
          changelogFile: [`zh=${zh}`, `en=${en}`],
        }),
      ).toBe(JSON.stringify({ "zh-CN": "中文更新", en: "English update" }));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
