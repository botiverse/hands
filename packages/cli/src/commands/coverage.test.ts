import { afterEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";

/**
 * Assert that the new CLI commands reach the SAME endpoints the agent manifest
 * declares for the corresponding actions. Checking that a command merely exists
 * would repeat the #778 mistake: passing while the thing it should guarantee is broken.
 */
const APP_ID = "11111111-2222-3333-4444-555555555555";
const ACCOUNT_ID = "acct-999";
const BUILD_ID = "build-xyz";
const ASSET_ID = "asset-xyz";

vi.mock("../lib/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api.js")>();
  return {
    ...actual,
    apiRequest: async (path: string, opts: { method?: string } = {}) => {
      const state = globalThis as unknown as {
        __CALLS: Array<{ method: string; path: string }>;
        __BUILD_SHAPE?: "bare" | "wrapped";
      };
      state.__CALLS.push({ method: (opts.method ?? "GET").toUpperCase(), path: String(path) });
      // A build GET returns the build object directly; the "wrapped" form exists
      // only so the tolerant unwrapping can be tested against both shapes.
      if (/\/builds\/[^/]+$/.test(String(path)) && (opts.method ?? "GET").toUpperCase() === "GET") {
        const build = {
          id: BUILD_ID,
          status: "failed",
          version_name: "0.0.0-upload-probe.1",
          version_code: 4666106250041909,
          asset_count: 0,
          assets: [],
        };
        return (state.__BUILD_SHAPE === "wrapped" ? { build } : build) as never;
      }
      return { url: "https://example.invalid/signed" } as never;
    },
  };
});

async function run(
  argv: string[],
  buildShape: "bare" | "wrapped" = "bare",
): Promise<Array<{ method: string; path: string }>> {
  const calls: Array<{ method: string; path: string }> = [];
  const state = globalThis as unknown as { __CALLS: typeof calls; __BUILD_SHAPE: typeof buildShape };
  state.__CALLS = calls;
  state.__BUILD_SHAPE = buildShape;

  const [{ registerAppCommands }, { registerBuildCommands }] = await Promise.all([
    import("./apps.js"),
    import("./builds.js"),
  ]);
  const program = new Command();
  program.exitOverride();
  registerAppCommands(program);
  registerBuildCommands(program);
  await program.parseAsync(["node", "hands", ...argv]);
  return calls;
}

describe("apps member commands reach the manifest endpoints", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // add-app-member     -> POST   /api/apps/{app}/members
  // update-app-member  -> PATCH  /api/apps/{app}/members/{account}
  // remove-app-member  -> DELETE /api/apps/{app}/members/{account}
  it("add-member POSTs to /api/apps/{app}/members", async () => {
    const calls = await run(["apps", "add-member", APP_ID, ACCOUNT_ID, "viewer"]);
    expect(calls).toContainEqual({ method: "POST", path: `/api/apps/${APP_ID}/members` });
  });

  it("update-member PATCHes /api/apps/{app}/members/{account}", async () => {
    const calls = await run(["apps", "update-member", APP_ID, ACCOUNT_ID, "publisher"]);
    expect(calls).toContainEqual({
      method: "PATCH",
      path: `/api/apps/${APP_ID}/members/${ACCOUNT_ID}`,
    });
  });

  it("remove-member DELETEs /api/apps/{app}/members/{account}", async () => {
    const calls = await run(["apps", "remove-member", APP_ID, ACCOUNT_ID]);
    expect(calls).toContainEqual({
      method: "DELETE",
      path: `/api/apps/${APP_ID}/members/${ACCOUNT_ID}`,
    });
  });
});

describe("builds asset commands reach the manifest endpoints", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // presign-build-asset -> GET    /api/apps/{app}/builds/{build}/assets/{asset}/download?presign=1
  // delete-build-asset  -> DELETE /api/apps/{app}/builds/{build}/assets/{asset}
  it("presign-asset GETs the presigned download path", async () => {
    const calls = await run(["builds", "presign-asset", APP_ID, BUILD_ID, ASSET_ID]);
    expect(calls).toContainEqual({
      method: "GET",
      path: `/api/apps/${APP_ID}/builds/${BUILD_ID}/assets/${ASSET_ID}/download?presign=1`,
    });
  });

  it("builds delete DELETEs the build path", async () => {
    const calls = await run(["builds", "delete", APP_ID, BUILD_ID]);
    expect(calls).toContainEqual({
      method: "DELETE",
      path: `/api/apps/${APP_ID}/builds/${BUILD_ID}`,
    });
  });

  it("builds delete --dry-run prints the real status from a bare build object", async () => {
    const logged: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    });
    try {
      await run(["builds", "delete", APP_ID, BUILD_ID, "--dry-run"], "bare");
    } finally {
      spy.mockRestore();
    }
    const output = logged.join("\n");
    // Asserting the OUTPUT, not just that a GET happened: the original test only
    // checked the request, which is why it passed while the report printed nulls.
    expect(output).toContain("status=failed");
    expect(output).toContain("0.0.0-upload-probe.1");
    expect(output).not.toContain("status=null");
  });

  it("builds delete --dry-run still reads a wrapped {build} response", async () => {
    const logged: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    });
    try {
      await run(["builds", "delete", APP_ID, BUILD_ID, "--dry-run"], "wrapped");
    } finally {
      spy.mockRestore();
    }
    expect(logged.join("\n")).toContain("status=failed");
  });

  it("builds delete records what it removed before deleting", async () => {
    const logged: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    });
    let calls: Array<{ method: string; path: string }> = [];
    try {
      calls = await run(["builds", "delete", APP_ID, BUILD_ID]);
    } finally {
      spy.mockRestore();
    }
    const output = logged.join("\n");
    // The success line alone is not evidence of WHICH build went away.
    expect(output).toContain("status=failed");
    expect(output).toContain("0.0.0-upload-probe.1");
    expect(output).toContain("assets=0");
    // The NAME of this test says "before deleting", so assert the ORDER, not
    // merely that a DELETE happened: the record is only useful if it is read
    // while the build still exists.
    const getIndex = calls.findIndex(
      (call) => call.method === "GET" && call.path === `/api/apps/${APP_ID}/builds/${BUILD_ID}`,
    );
    const deleteIndex = calls.findIndex((call) => call.method === "DELETE");
    expect(getIndex).toBeGreaterThanOrEqual(0);
    expect(deleteIndex).toBeGreaterThanOrEqual(0);
    expect(getIndex).toBeLessThan(deleteIndex);
  });

  it("builds delete --dry-run reads the build and issues no DELETE", async () => {
    const calls = await run(["builds", "delete", APP_ID, BUILD_ID, "--dry-run"]);
    expect(calls).toContainEqual({
      method: "GET",
      path: `/api/apps/${APP_ID}/builds/${BUILD_ID}`,
    });
    // The whole point of --dry-run: nothing is removed, so a 409 is discovered
    // before anyone decides to delete rather than after a failed attempt.
    expect(calls.some((call) => call.method === "DELETE")).toBe(false);
  });

  it("delete-asset DELETEs the asset path", async () => {
    const calls = await run(["builds", "delete-asset", APP_ID, BUILD_ID, ASSET_ID]);
    expect(calls).toContainEqual({
      method: "DELETE",
      path: `/api/apps/${APP_ID}/builds/${BUILD_ID}/assets/${ASSET_ID}`,
    });
  });
});
