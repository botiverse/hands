import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HandsLogger } from "./logger.js";

const cleanup: string[] = [];

afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

function temporaryDirectory(): string {
  const path = mkdtempSync(join(tmpdir(), "hands-node-logger-"));
  cleanup.push(path);
  return path;
}

describe("HandsLogger", () => {
  it("appends JSONL and resumes monotonic sequence numbers after restart", () => {
    const dir = temporaryDirectory();
    const first = new HandsLogger({ dir, name: "cli", minLevel: "debug" });
    first.info("cli", "started", { command: "apps" }, "command_start");
    first.warn("cli", "slow", undefined, "command_slow");

    const second = new HandsLogger({ dir, name: "cli", minLevel: "debug" });
    second.info("cli", "completed", { command: "apps" }, "command_success");

    const entries = second
      .currentFiles()
      .flatMap((path) => readFileSync(path, "utf8").trim().split("\n"))
      .map((line) => JSON.parse(line) as { seq: number; event: string });
    expect(entries.map((entry) => entry.seq).sort((a, b) => a - b)).toEqual([1, 2, 3]);
    expect(entries.some((entry) => entry.event === "command_success")).toBe(true);
  });

  it("rotates daily files at the size cap and keeps a bounded ring", () => {
    const dir = temporaryDirectory();
    const logger = new HandsLogger({
      dir,
      name: "rotate",
      maxFileBytes: 240,
      maxTotalBytes: 10_000,
      ringSize: 2,
      now: () => new Date("2026-07-10T04:00:00+08:00"),
    });
    logger.info("test", "a".repeat(100));
    logger.info("test", "b".repeat(100));
    logger.info("test", "c".repeat(100));

    expect(logger.currentFiles().length).toBeGreaterThan(1);
    expect(logger.snapshot()).toHaveLength(2);
    expect(logger.snapshot().map((entry) => entry.message)).toEqual([
      "b".repeat(100),
      "c".repeat(100),
    ]);
  });

  it("applies mandatory default redaction before disk and ring output", () => {
    const dir = temporaryDirectory();
    const logger = new HandsLogger({ dir, name: "redaction" });
    logger.info(
      "auth",
      "Authorization: Bearer abc.def.ghi token sk_agent_supersecret",
      { authorization: "Bearer raw-secret", safe: "visible" },
    );

    const output = readFileSync(logger.currentFiles()[0]!, "utf8");
    expect(output).not.toContain("raw-secret");
    expect(output).not.toContain("sk_agent_supersecret");
    expect(output).toContain("[REDACTED]");
    expect(logger.snapshot()[0]?.fields?.safe).toBe("visible");
  });

  it("allows a custom redactor to drop an entry after default redaction", () => {
    const dir = temporaryDirectory();
    const logger = new HandsLogger({ dir, name: "drop", redactor: () => null });
    logger.info("test", "do not persist");
    expect(logger.currentFiles()).toEqual([]);
    expect(logger.snapshot()).toEqual([]);
  });
});
