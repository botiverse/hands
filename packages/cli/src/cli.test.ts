/**
 * Smoke tests for the quiver CLI.
 *
 * Run: `pnpm --filter @botiverse/hands-cli test`
 *
 * v1 tests cover: config load/save (without leaking the real file),
 * + apiRequest routing (against a tiny local http.createServer stub).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { Command } from "commander";
import fixturePolicy from "./fixtures/collect-policy.json";

describe("config round-trip", () => {
  let dir: string;
  let originalXdg: string | undefined;
  let originalHandsApi: string | undefined;
  let originalQuiverApi: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "quiver-cli-"));
    originalXdg = process.env.XDG_CONFIG_HOME;
    originalHandsApi = process.env.HANDS_API;
    originalQuiverApi = process.env.QUIVER_API;
    process.env.XDG_CONFIG_HOME = dir;
    delete process.env.HANDS_API;
    delete process.env.QUIVER_API;
  });

  afterEach(() => {
    if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = originalXdg;
    if (originalHandsApi === undefined) delete process.env.HANDS_API;
    else process.env.HANDS_API = originalHandsApi;
    if (originalQuiverApi === undefined) delete process.env.QUIVER_API;
    else process.env.QUIVER_API = originalQuiverApi;
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  });

  it("returns empty config when no file exists", async () => {
    const { getConfig, resolveApiBase } = await import("../src/lib/config.js");
    expect(getConfig()).toEqual({});
    expect(resolveApiBase()).toBe("https://hands.build");
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

  it("treats the legacy QUIVER_SESSION_COOKIE env var as bearer auth", async () => {
    process.env.QUIVER_SESSION_COOKIE = "abc123";
    process.env.QUIVER_API = baseUrl;
    const { apiRequest } = await import("../src/lib/api.js");
    const me = await apiRequest<{ account: { id: string } }>("/api/auth/me");
    expect(me.account.id).toBe("u1");
    expect(lastAuthorization).toBe("Bearer abc123");
    expect(lastCookie).toBeNull();
    delete process.env.QUIVER_SESSION_COOKIE;
    delete process.env.QUIVER_API;
  });

  it("prefers QUIVER_AUTH_TOKEN over the legacy session variable", async () => {
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

describe("local notarization contract", () => {
  const sha256 = "a".repeat(64);
  const expected = {
    submissionName: "Raft-1.2.3-arm64.dmg",
    sha256,
    sizeBytes: 3,
  };
  const exported = {
    export_id: "export-1",
    app_id: "app-1",
    issued_at: 1,
    credential_updated_at: 1,
    submission_name: expected.submissionName,
    source_sha256: sha256,
    source_size_bytes: expected.sizeBytes,
    credentials: {
      kind: "app_store_connect_api_key" as const,
      key_id: "KEY1234567",
      issuer_id: "12345678-1234-1234-1234-1234567890ab",
      p8: "-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----",
    },
  };
  const freshExport = () => ({
    ...exported,
    credentials: { ...exported.credentials },
  });

  it("submits locally, binds Apple's log digest, then staples and validates", async () => {
    const { notarizeAndStapleLocal } = await import(
      "../src/commands/builds.js"
    );
    const dir = mkdtempSync(join(tmpdir(), "hands-notary-test-"));
    const artifact = join(dir, expected.submissionName);
    writeFileSync(artifact, "abc");
    const sourceSha256 = (await import("node:crypto"))
      .createHash("sha256")
      .update("abc")
      .digest("hex");
    const calls: string[][] = [];
    let keyPath = "";
    const credentialExport = {
      ...freshExport(),
      source_sha256: sourceSha256,
    };
    const result = await notarizeAndStapleLocal({
      filePath: artifact,
      export: credentialExport,
      expected: { ...expected, sha256: sourceSha256 },
      platform: "darwin",
      timeoutMs: 1_000,
      exec: async (_file, args) => {
        calls.push(args);
        if (args[0] === "notarytool" && args[1] === "submit") {
          keyPath = args[args.indexOf("--key") + 1] ?? "";
          expect(statSync(keyPath).mode & 0o777).toBe(0o600);
          expect(readFileSync(keyPath, "utf8")).toContain("BEGIN PRIVATE KEY");
          return {
            stdout: JSON.stringify({ id: "apple-1", status: "Accepted" }),
            stderr: "",
          };
        }
        if (args[0] === "notarytool" && args[1] === "log") {
          writeFileSync(args.at(-1) ?? "", JSON.stringify({ sha256: sourceSha256 }));
          return { stdout: "", stderr: "" };
        }
        if (args[0] === "stapler" && args[1] === "staple") {
          appendFileSync(artifact, "ticket");
        }
        return { stdout: "", stderr: "" };
      },
    });
    expect(result).toMatchObject({
      notarization_id: "apple-1",
      status: "Accepted",
      source_sha256: sourceSha256,
      source_size_bytes: 3,
      apple_sha256: sourceSha256,
      binding_verified: true,
      stapled: true,
      staple_validated: true,
      credential_export_id: "export-1",
    });
    expect(result.final_sha256).not.toBe(sourceSha256);
    expect(calls.map((call) => call.slice(0, 2))).toEqual([
      ["notarytool", "submit"],
      ["notarytool", "log"],
      ["stapler", "staple"],
      ["stapler", "validate"],
    ]);
    expect(JSON.stringify(calls)).not.toContain("PRIVATE KEY");
    expect(JSON.stringify(calls)).not.toContain("secret");
    expect(JSON.stringify(result)).not.toContain("PRIVATE KEY");
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(existsSync(keyPath)).toBe(false);
    expect(credentialExport.credentials.p8).toBe("");
    rmSync(dir, { recursive: true, force: true });
  });

  it("does not staple an Accepted result whose Apple log digest mismatches", async () => {
    const { notarizeAndStapleLocal } = await import(
      "../src/commands/builds.js"
    );
    const dir = mkdtempSync(join(tmpdir(), "hands-notary-test-"));
    const artifact = join(dir, expected.submissionName);
    writeFileSync(artifact, "abc");
    const sourceSha256 = (await import("node:crypto"))
      .createHash("sha256")
      .update("abc")
      .digest("hex");
    const calls: string[][] = [];
    await expect(
      notarizeAndStapleLocal({
        filePath: artifact,
        export: { ...freshExport(), source_sha256: sourceSha256 },
        expected: { ...expected, sha256: sourceSha256 },
        platform: "darwin",
        timeoutMs: 1_000,
        exec: async (_file, args) => {
          calls.push(args);
          if (args[1] === "submit") {
            return {
              stdout: JSON.stringify({ id: "apple-1", status: "Accepted" }),
              stderr: "",
            };
          }
          if (args[1] === "log") {
            writeFileSync(args.at(-1) ?? "", JSON.stringify({ sha256: "b".repeat(64) }));
          }
          return { stdout: "", stderr: "" };
        },
      }),
    ).rejects.toThrow("developer log SHA-256 does not match");
    expect(calls.some((call) => call[0] === "stapler")).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  it("fails before secret export use on a non-macOS host", async () => {
    const { notarizeAndStapleLocal } = await import(
      "../src/commands/builds.js"
    );
    await expect(
      notarizeAndStapleLocal({
        filePath: "unused.dmg",
        export: freshExport(),
        expected,
        platform: "linux",
        timeoutMs: 1_000,
        exec: async () => {
          throw new Error("must not run");
        },
      }),
    ).rejects.toThrow("requires macOS");
  });
});

describe("external build publish helpers", () => {
  it("splits the public target into the existing platform/arch storage shape", async () => {
    const { splitBuildTarget } = await import("../src/commands/builds.js");
    expect(splitBuildTarget("darwin-arm64")).toEqual({ platform: "darwin", arch: "arm64" });
    expect(splitBuildTarget("linux-x64")).toEqual({ platform: "linux", arch: "x64" });
    expect(() => splitBuildTarget("node")).toThrow("--target must be");
  });

  it("derives an ordering code for numeric semantic versions", async () => {
    const { versionCodeFromVersion } = await import("../src/commands/builds.js");
    expect(versionCodeFromVersion("0.72.12")).toBe(72_012);
    expect(versionCodeFromVersion("1.2.3-beta.1")).toBe(1_002_003);
    expect(() => versionCodeFromVersion("nightly")).toThrow("--version-code is required");
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

describe("OHOS build helper contract", () => {
  it("preserves the App Pack, HAP, symbols, and metadata asset types", async () => {
    const { inferOhosFiletype } = await import("../src/commands/builds.js");
    expect(inferOhosFiletype("build/Raft.app")).toBe("app");
    expect(inferOhosFiletype("build/entry-default-signed.hap")).toBe("hap");
    expect(inferOhosFiletype("build/ohos-symbols.tar.gz")).toBe("symbols.tar.gz");
    expect(inferOhosFiletype("build/ohos-release-metadata.json")).toBe("metadata.json");
  });

  it("honors the root --json flag for nested build commands", async () => {
    const { shouldOutputJson } = await import("../src/commands/builds.js");
    const program = new Command().option("--json", "JSON output", false);
    program.parse(["node", "hands", "--json"]);
    expect(shouldOutputJson(program, false)).toBe(true);
    expect(shouldOutputJson(new Command(), true)).toBe(true);
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

describe("Hands logging integration", () => {
  it("validates the CLI collect-policy fixture against hands-node schema", async () => {
    const { validateCollectPolicy } = await import("@botiverse/hands-node/logs/schema");
    expect(validateCollectPolicy(fixturePolicy)).toEqual({ valid: true, errors: [] });
  });

  it("never throws when the configured log directory cannot be created", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hands-cli-logging-"));
    const blocked = join(dir, "not-a-directory");
    writeFileSync(blocked, "file");
    const original = process.env.HANDS_LOG_DIR;
    process.env.HANDS_LOG_DIR = blocked;
    try {
      const { recordCliEvent, resetCliLoggerForTests } = await import("./lib/logging.js");
      resetCliLoggerForTests();
      expect(() => recordCliEvent("info", "test", "test event")).not.toThrow();
      resetCliLoggerForTests();
    } finally {
      if (original === undefined) delete process.env.HANDS_LOG_DIR;
      else process.env.HANDS_LOG_DIR = original;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
