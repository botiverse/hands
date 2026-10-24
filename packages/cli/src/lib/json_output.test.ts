import { describe, it, expect } from "vitest";
import { Command } from "commander";
import { jsonRequested } from "./json_output.js";

/** Minimal stand-in for the shape commander gives a handler. */
function fakeCommand(globals: { json?: boolean }): Command {
  return { optsWithGlobals: () => globals } as unknown as Command;
}

describe("jsonRequested", () => {
  it("returns true when the caller passed the subcommand's own --json", () => {
    expect(jsonRequested(fakeCommand({}), true)).toBe(true);
  });

  /**
   * The regression this helper exists for. `--json` is registered on both the
   * program and each subcommand, and commander fills only the subcommand's
   * object, so a handler reading `opts.json` sees false while the program's
   * copy holds the value. Reading the globals is what makes the flag work.
   */
  it("returns true when only the program-level --json was set", () => {
    expect(jsonRequested(fakeCommand({ json: true }), false)).toBe(true);
    expect(jsonRequested(fakeCommand({ json: true }), undefined)).toBe(true);
  });

  it("returns false when neither registration was set", () => {
    expect(jsonRequested(fakeCommand({ json: false }), false)).toBe(false);
    expect(jsonRequested(fakeCommand({}), undefined)).toBe(false);
  });

  it("does not mistake a false global for a set flag", () => {
    expect(jsonRequested(fakeCommand({ json: false }), true)).toBe(true);
  });
});
