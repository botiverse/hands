import { afterEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";

// Stub auth so the test exercises the request shape, not token resolution.
vi.mock("../lib/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api.js")>();
  return {
    ...actual,
    apiRequest: async (path: string, opts: { method?: string } = {}) => {
      const calls = (globalThis as unknown as { __CALLS: Array<{ method: string; path: string }> }).__CALLS;
      calls.push({ method: (opts.method ?? "GET").toUpperCase(), path: String(path) });
      return { ok: true } as never;
    },
  };
});

/**
 * These tests assert that `hands releases cancel` / `restore` hit the SAME endpoints
 * the agent manifest advertises for `cancel-release` / `restore-release`.
 *
 * Asserting the command merely exists would be the mistake that bit #778: a check that
 * passes while the thing it claims to guarantee (reaching the right endpoint) is broken.
 * The assertion here is on the outgoing request, so a wrong method or path fails.
 */
const APP_ID = "11111111-2222-3333-4444-555555555555";
const RELEASE_ID = "rel-abc";

// The manifest declares:
//   cancel-release  -> DELETE /api/apps/{app_id}/releases/{release_id}
//   restore-release -> POST   /api/apps/{app_id}/releases/{release_id}/rollback
const EXPECTED = {
  cancel: { method: "DELETE", path: `/api/apps/${APP_ID}/releases/${RELEASE_ID}` },
  restore: { method: "POST", path: `/api/apps/${APP_ID}/releases/${RELEASE_ID}/rollback` },
} as const;

async function run(argv: string[]): Promise<Array<{ method: string; path: string }>> {
  const calls: Array<{ method: string; path: string }> = [];
  (globalThis as unknown as { __CALLS: typeof calls }).__CALLS = calls;

  const { registerReleaseCommands } = await import("./releases.js");
  const program = new Command();
  program.exitOverride();
  registerReleaseCommands(program);
  await program.parseAsync(["node", "hands", ...argv]);
  return calls;
}

describe("hands releases cancel/restore reach the manifest endpoints", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("cancel sends DELETE to /api/apps/{app}/releases/{release}", async () => {
    const calls = await run(["releases", "cancel", APP_ID, RELEASE_ID]);
    expect(calls).toContainEqual(EXPECTED.cancel);
  });

  it("restore sends POST to /api/apps/{app}/releases/{release}/rollback", async () => {
    const calls = await run(["releases", "restore", APP_ID, RELEASE_ID]);
    expect(calls).toContainEqual(EXPECTED.restore);
  });
});
