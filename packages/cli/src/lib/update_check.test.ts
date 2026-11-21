import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  isNewerVersion,
  startUpdateCheck,
  updateCachePath,
  updateCheckDisabled,
} from "./update_check.js";

describe("isNewerVersion", () => {
  it("compares x.y.z numerically", () => {
    expect(isNewerVersion("0.5.62", "0.5.43")).toBe(true);
    expect(isNewerVersion("0.10.0", "0.9.9")).toBe(true);
    expect(isNewerVersion("0.5.43", "0.5.43")).toBe(false);
    expect(isNewerVersion("0.5.42", "0.5.43")).toBe(false);
  });
  it("never treats a pre-release or garbage as newer", () => {
    expect(isNewerVersion("0.6.0-beta.1", "0.5.0")).toBe(false);
    expect(isNewerVersion("latest", "0.5.0")).toBe(false);
  });
});

describe("startUpdateCheck", () => {
  let dir: string;
  const saved = { ...process.env };
  const env = { HOME: "/nonexistent" } as NodeJS.ProcessEnv;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "hands-update-"));
    process.env.XDG_CONFIG_HOME = dir;
    delete process.env.HANDS_NO_UPDATE_CHECK;
    delete process.env.QUIVER_NO_UPDATE_CHECK;
  });
  afterEach(() => {
    process.env = { ...saved };
    rmSync(dir, { recursive: true, force: true });
  });

  it("prints the upgrade command when the registry has a newer version, and caches it", async () => {
    const lines: string[] = [];
    let lookups = 0;
    const check = startUpdateCheck("0.5.43", {
      env,
      now: () => 1_000,
      fetchLatest: async () => { lookups++; return "0.5.62"; },
      write: (l) => lines.push(l),
    });
    await check.finish();
    expect(lines).toEqual([
      "A newer Hands CLI is available: 0.5.43 -> 0.5.62. Upgrade with: npm i -g @botiverse/hands-cli@latest",
    ]);
    expect(JSON.parse(readFileSync(updateCachePath(), "utf8"))).toEqual({ checkedAt: 1_000, latest: "0.5.62" });

    // Within a day the cache answers; no second lookup.
    const again: string[] = [];
    await startUpdateCheck("0.5.43", {
      env,
      now: () => 1_000 + 60_000,
      fetchLatest: async () => { lookups++; return "0.5.62"; },
      write: (l) => again.push(l),
    }).finish();
    expect(lookups).toBe(1);
    expect(again).toHaveLength(1);
  });

  it("looks again after a day", async () => {
    mkdirSync(dirname(updateCachePath()), { recursive: true });
    writeFileSync(updateCachePath(), JSON.stringify({ checkedAt: 0, latest: "0.5.50" }));
    const lines: string[] = [];
    await startUpdateCheck("0.5.50", {
      env,
      now: () => 25 * 60 * 60 * 1000,
      fetchLatest: async () => "0.5.62",
      write: (l) => lines.push(l),
    }).finish();
    expect(lines[0]).toContain("0.5.50 -> 0.5.62");
  });

  it("says nothing when up to date or when the registry fails", async () => {
    const lines: string[] = [];
    await startUpdateCheck("0.5.62", { env, fetchLatest: async () => "0.5.62", write: (l) => lines.push(l) }).finish();
    await startUpdateCheck("0.5.62", {
      env,
      now: () => 10 * CHECK_DAY,
      fetchLatest: async () => { throw new Error("offline"); },
      write: (l) => lines.push(l),
    }).finish();
    expect(lines).toEqual([]);
  });

  it("does not wait long for a slow registry", async () => {
    const lines: string[] = [];
    const started = Date.now();
    await startUpdateCheck("0.5.43", {
      env,
      fetchLatest: (signal) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")))),
      write: (l) => lines.push(l),
    }).finish();
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(lines).toEqual([]);
  });

  it("is off in CI and with HANDS_NO_UPDATE_CHECK", async () => {
    expect(updateCheckDisabled({ CI: "true" })).toBe(true);
    expect(updateCheckDisabled({ CI: "false" })).toBe(false);
    process.env.HANDS_NO_UPDATE_CHECK = "1";
    expect(updateCheckDisabled({})).toBe(true);
    let lookups = 0;
    await startUpdateCheck("0.5.43", { env, fetchLatest: async () => { lookups++; return "9.9.9"; } }).finish();
    expect(lookups).toBe(0);
  });
});

const CHECK_DAY = 24 * 60 * 60 * 1000;
