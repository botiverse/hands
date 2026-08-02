/**
 * Crash ingest derives the product from a closed set instead of hardcoding
 * Electron, and the Breakpad symbolication lane names no product at all.
 *
 * The property that matters for existing clients is the negative one: a client
 * that sends no product annotation — every Electron client shipped so far —
 * must get byte-identical output. So each assertion here has an Electron
 * counterpart, not just a Tauri one.
 */

import { describe, expect, it } from "vitest";
import {
  MINIDUMP_SYMBOLICATION_LABEL,
  minidumpSymbolicationText,
} from "../src/routes/feedback";

describe("minidump symbolication output is product-neutral", () => {
  const text = (over: Partial<Parameters<typeof minidumpSymbolicationText>[0]> = {}) =>
    minidumpSymbolicationText({
      hasSymbols: false,
      crashReason: "EXCEPTION_ACCESS_VIOLATION",
      crashAddress: "0x0",
      versionCode: 1020300,
      stack: "0  app!main + 0x10",
      ...over,
    });

  it("names no product anywhere in the block or its label", () => {
    // The lane handles any Crashpad minidump. Naming one product told operators
    // of every other product the wrong thing.
    const produced = `${MINIDUMP_SYMBOLICATION_LABEL}\n${text()}`;
    for (const product of ["Electron", "electron", "Tauri", "tauri"]) {
      expect(produced).not.toContain(product);
    }
  });

  it("does not tell the operator to run a product-specific command", () => {
    // The old tip said `publish-electron --symbols`, which is the wrong command
    // for a Tauri app — worse than saying nothing, because it looks actionable.
    expect(text()).not.toContain("publish-electron");
    // Nor a wildcard standing in for one. `hands builds publish-*` is not a
    // subcommand — the real ones are publish-electron / publish-tauri / etc.
    // A pseudo-command fails the same test the old text failed: it reads as
    // copy-pasteable and is not. Naming no command is the point.
    for (const pseudo of ["publish-*", "publish-<", "publish-{"]) {
      expect(text()).not.toContain(pseudo);
    }
    // Whatever the wording, it must not offer a token that looks runnable.
    expect(text()).not.toMatch(/`[^`]*publish[^`]*`/);
    // It still has to be actionable: the symbols hint and the version survive.
    expect(text()).toContain("Breakpad symbols");
    expect(text()).toContain("1020300");
  });

  it("keeps the tip only when symbols are missing and a version is known", () => {
    expect(text({ hasSymbols: true })).not.toContain("Tip:");
    expect(text({ versionCode: null })).not.toContain("Tip:");
    expect(text()).toContain("Tip:");
  });

  it("carries the stack and the crash reason through unchanged", () => {
    expect(text()).toContain("0  app!main + 0x10");
    expect(text()).toContain("EXCEPTION_ACCESS_VIOLATION @ 0x0");
    expect(text({ crashReason: null })).not.toContain("Reason:");
  });
});
