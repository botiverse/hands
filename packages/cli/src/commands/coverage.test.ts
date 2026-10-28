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
      const calls = (globalThis as unknown as { __CALLS: Array<{ method: string; path: string }> }).__CALLS;
      calls.push({ method: (opts.method ?? "GET").toUpperCase(), path: String(path) });
      return { url: "https://example.invalid/signed" } as never;
    },
  };
});

async function run(argv: string[]): Promise<Array<{ method: string; path: string }>> {
  const calls: Array<{ method: string; path: string }> = [];
  (globalThis as unknown as { __CALLS: typeof calls }).__CALLS = calls;

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
