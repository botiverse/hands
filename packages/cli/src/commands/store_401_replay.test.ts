import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";

// Exercise real commands, apiRequest, multipart builders and agentAwareFetch. Only
// token acquisition and network are faked; no request reaches Hands or a store.
const auth = vi.hoisted(() => ({ admit: vi.fn(), fresh: vi.fn(), force: vi.fn() }));
vi.mock("../lib/agent_env.js", () => ({ admitAgent: auth.admit }));
vi.mock("../lib/agent_refresh.js", () => ({ getFreshAgentAccessToken: auth.fresh, forceRefreshAgentToken: auth.force }));

import { setApiBase } from "../lib/api.js";
import { registerAppStoreCommands } from "./app_store.js";
import { registerStoreListingCommands } from "./store_listing.js";
import { registerStoreProductsCommands } from "./store_products.js";
import { registerReleaseCommands } from "./releases.js";
import { registerAgcCommands } from "./agc.js";
import { registerBuildCommands } from "./builds.js";
import { registerTestflightCommands } from "./testflight.js";
import { registerApiCommand } from "./api.js";

const APP = "11111111-2222-3333-4444-555555555555";
const env = { agentId: "test-agent", slockHome: "/tmp/unused", transportDir: "/tmp/unused", raftBin: "/tmp/unused/raft" };
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
const tempDirs: string[] = [];
async function tempDir() {
  const dir = await mkdtemp(join(tmpdir(), "hands-store-retry-"));
  tempDirs.push(dir);
  return dir;
}

function program(): Command {
  const cli = new Command(); cli.exitOverride(); cli.option("--json", "", false);
  registerAppStoreCommands(cli); registerStoreListingCommands(cli); registerStoreProductsCommands(cli);
  registerReleaseCommands(cli); registerAgcCommands(cli); registerBuildCommands(cli); registerTestflightCommands(cli); registerApiCommand(cli);
  return cli;
}

afterEach(async () => {
  process.exitCode = undefined; vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.clearAllMocks();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("store CLI reactive 401 handling (local fake network)", () => {
  it("sends each commit and Play edit once while retrying read-only previews after a 401", async () => {
    const dir = await tempDir();
    const localization = join(dir, "localization.json");
    const info = join(dir, "info.json");
    const listing = join(dir, "listing.json");
    const products = join(dir, "products.json");
    await writeFile(localization, JSON.stringify({ "en-US": { keywords: "chat" } }));
    await writeFile(info, JSON.stringify({ localizations: { "en-US": { name: "Example" } } }));
    await writeFile(listing, JSON.stringify({ "en-US": { title: "Example" } }));
    await writeFile(products, JSON.stringify({ google: { products: [{ productId: "example.product" }] } }));
    const ascDir = join(dir, "asc", "en-US", "APP_IPHONE_67");
    const playDir = join(dir, "play", "en-US", "phoneScreenshots");
    await mkdir(ascDir, { recursive: true }); await mkdir(playDir, { recursive: true });
    await writeFile(join(ascDir, "1.png"), "image fixture"); await writeFile(join(playDir, "1.png"), "image fixture");

    const cases: Array<{ name: string; args: string[]; target: string; product?: boolean; directCommit?: boolean; intrinsicWrite?: boolean; noPreviewRetry?: boolean }> = [
      { name: "Apple prepare", args: ["app-store", "prepare", APP, "--version-name", "1.2.3"], target: "/app-store/versions" },
      { name: "Apple screenshots", args: ["app-store", "screenshots", "push", APP, "--version-id", "v1", "--dir", join(dir, "asc")], target: "/screenshots" },
      { name: "Apple localizations", args: ["app-store", "localizations", "push", APP, "--version-id", "v1", "--file", localization], target: "/localizations" },
      { name: "Apple app info (currently guarded)", args: ["app-store", "app-info", "push", APP, "--version-name", "1.2.3", "--version-id", "v1", "--file", info], target: "/app-info" },
      { name: "Apple release", args: ["app-store", "release", APP, "v1", "--version-name", "1.2.3"], target: "/release" },
      { name: "Play listing JSON", args: ["store-listing", "push", APP, "--listing", listing], target: "/distributions/play/store-listing", noPreviewRetry: true },
      { name: "Play listing multipart", args: ["store-listing", "push", APP, "--images", join(dir, "play")], target: "/distributions/play/store-listing", noPreviewRetry: true },
      { name: "Play products", args: ["store-products", "apply", "android", "--file", products], target: "/store-products", product: true },
      { name: "Play symbols", args: ["releases", "play-upload-symbols", APP, "release1", "--note", "test"], target: "/upload-symbols", noPreviewRetry: true },
      { name: "Apple submit", args: ["app-store", "submit", APP, "--version-name", "1.2.3"], target: "/submit", directCommit: true },
      { name: "Apple withdraw", args: ["app-store", "withdraw", APP, "--version-name", "1.2.3"], target: "/withdraw", directCommit: true },
      { name: "Play promote", args: ["releases", "play-promote", APP, "release1", "--track", "internal", "--note", "test"], target: "/promote", directCommit: true, intrinsicWrite: true },
      { name: "Play send for review", args: ["releases", "play-send-for-review", APP, "release1", "--note", "test"], target: "/send-for-review", directCommit: true, intrinsicWrite: true },
      { name: "Play halt", args: ["releases", "play-halt", APP, "release1", "--note", "test"], target: "/halt", directCommit: true, intrinsicWrite: true },
      { name: "Play rollback", args: ["releases", "play-rollback", APP, "release1", "--to-version-code", "1", "--note", "test"], target: "/rollback", directCommit: true, intrinsicWrite: true },
      { name: "AGC market upload", args: ["agc", "upload-market", APP, "build1", "--package-name", "build.example"], target: "/agc-market-package", directCommit: true, intrinsicWrite: true },
      { name: "AGC market status records terminal transition", args: ["agc", "market-status", APP, "build1"], target: "/agc-market-package", directCommit: true, intrinsicWrite: true },
      { name: "AGC test upload", args: ["agc", "upload", APP, "build1", "--package-name", "build.example"], target: "/agc-invitation-test", directCommit: true, intrinsicWrite: true },
      { name: "AGC submit", args: ["agc", "submit", APP, "submission1", "--group", "group1"], target: "/submit", directCommit: true, intrinsicWrite: true },
      { name: "AGC status binds a compiled package", args: ["agc", "status", APP, "submission1"], target: "/agc-submissions/submission1", directCommit: true, intrinsicWrite: true },
      { name: "TestFlight publish", args: ["builds", "testflight-publish", APP, "build1", "--distribution", "internal", "--group-id", "group1"], target: "/testflight-publish", directCommit: true, intrinsicWrite: true },
      { name: "TestFlight crash delete", args: ["testflight", "close", APP, "crash", "submission1"], target: "/testflight-crashes/submission1", directCommit: true, intrinsicWrite: true },
      { name: "TestFlight feedback delete", args: ["testflight", "close", APP, "feedback", "submission1"], target: "/testflight-feedback/submission1", directCommit: true, intrinsicWrite: true },
    ];
    auth.admit.mockReturnValue({ kind: "agent", env });
    auth.fresh.mockResolvedValue("fresh-before-send"); auth.force.mockResolvedValue("refreshed-after-401");
    setApiBase("https://hands.test");
    vi.spyOn(console, "log").mockImplementation(() => {});
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});

    for (const item of cases) {
      for (const mode of item.directCommit ? ["commit"] as const : ["dry_run", "commit"] as const) {
        const sent: Array<{ bearer: string | null; body: unknown }> = [];
        auth.force.mockClear(); auth.fresh.mockClear(); stderr.mockClear();
        vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
          const path = new URL(String(url)).pathname;
          if (path === "/api/apps") return json({ apps: [{ id: APP, slug: "android", platform: "android" }] });
          if (path.endsWith("/app-store/status")) return json({ version_id: "v1", version_string: "1.2.3", state: "PREPARE_FOR_SUBMISSION", build_attached: true, pending_submission: null });
          if (path === `/api/apps/${APP}/releases/release1`) return json({ release: { revision: 1 } });
          if (!path.endsWith(item.target)) throw new Error(`unexpected ${path} in ${item.name}`);
          const body = init?.body instanceof FormData ? JSON.parse(String(init.body.get("request"))) : init?.body ? JSON.parse(String(init.body)) : {};
          // Product apply always previews before the commit. Only the target
          // phase receives 401; the other phase succeeds without a store write.
          if (item.product && body.mode !== mode) return json({ product_id: body.product.productId, mode: body.mode, outcome: "planned", changes: [] });
          const headers = new Headers(init?.headers);
          sent.push({ bearer: headers.get("authorization"), body });
          return json({ error: "unauthorized" }, 401);
        }));
        try { await program().parseAsync(["node", "hands", ...item.args, ...(mode === "commit" && !item.intrinsicWrite ? ["--commit"] : [])]); } catch { /* expected 401 */ }
        const retries = mode === "dry_run" && !item.noPreviewRetry;
        expect(sent.length, `${item.name} ${mode} request count`).toBe(retries ? 2 : 1);
        expect(sent[0]?.bearer, `${item.name} initial bearer`).toBe("Bearer fresh-before-send");
        if (!item.directCommit) expect((sent[0]?.body as { mode?: string })?.mode, item.name).toBe(mode);
        if (retries) expect(sent[1]?.bearer, `${item.name} refreshed bearer`).toBe("Bearer refreshed-after-401");
        expect(auth.force.mock.calls.length, `${item.name} refresh count`).toBe(retries ? 1 : 0);
        expect(auth.fresh.mock.calls.length, `${item.name} proactive token resolution`).toBeGreaterThan(0);
        if (!retries) expect(stderr.mock.calls.flat().join(" "), `${item.name} uncertainty warning`).toContain("outcome may be unknown");
        if (item.name === "TestFlight publish") {
          expect(stderr.mock.calls.flat().join(" ")).toContain(`hands builds testflight-status --distribution internal -- ${APP} build1`);
        }
      }
    }
  });

  it("does not replay listing reads that create a Play edit, but retries a receipt read to success", async () => {
    auth.admit.mockReturnValue({ kind: "agent", env });
    auth.fresh.mockResolvedValue("fresh-before-send"); auth.force.mockResolvedValue("refreshed-after-401");
    setApiBase("https://hands.test");
    const output = vi.spyOn(console, "log").mockImplementation(() => {});
    let calls: Array<{ path: string; bearer: string | null }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      calls.push({ path, bearer: new Headers(init?.headers).get("authorization") });
      if (path.endsWith("/receipts") && calls.length === 2) return json({ receipts: [] });
      return json({ error: "unauthorized" }, 401);
    }));
    await expect(program().parseAsync(["node", "hands", "store-listing", "pull", APP])).rejects.toMatchObject({ status: 401 });
    expect(calls).toEqual([{ path: `/api/apps/${APP}/distributions/play/store-listing`, bearer: "Bearer fresh-before-send" }]);
    expect(auth.force).not.toHaveBeenCalled();
    calls = [];
    await program().parseAsync(["node", "hands", "store-listing", "receipts", APP]);
    expect(calls.map((c) => c.bearer)).toEqual(["Bearer fresh-before-send", "Bearer refreshed-after-401"]);
    expect(auth.force).toHaveBeenCalledOnce();
    expect(output).toHaveBeenCalledWith("No store listing receipts.");
  });

  it("does not replay the side-effecting status request during AppGallery upload", async () => {
    auth.admit.mockReturnValue({ kind: "agent", env });
    auth.fresh.mockResolvedValue("fresh-before-send"); auth.force.mockResolvedValue("refreshed-after-401");
    setApiBase("https://hands.test");
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request) => {
      const path = new URL(String(url)).pathname;
      calls.push(path);
      return path.endsWith("/agc-invitation-test") ? json({ submission_id: "submission1" }) : json({ error: "unauthorized" }, 401);
    }));
    await expect(program().parseAsync(["node", "hands", "agc", "upload", APP, "build1", "--package-name", "build.example", "--wait"]))
      .rejects.toMatchObject({ status: 401 });
    expect(calls).toEqual([`/api/apps/${APP}/builds/build1/agc-invitation-test`, `/api/apps/${APP}/agc-submissions/submission1`]);
    expect(auth.force).not.toHaveBeenCalled();
    expect(stderr.mock.calls.flat().join(" ")).toContain("outcome may be unknown");
    expect(stderr.mock.calls.flat().join(" ")).toContain(`hands agc status -- ${APP} submission1`);
    expect(stderr.mock.calls.flat().join(" ")).toContain("before retrying upload");
  });

  it("retains the AppGallery submission id from a failed upload response", async () => {
    auth.admit.mockReturnValue({ kind: "agent", env });
    auth.fresh.mockResolvedValue("fresh-before-send"); auth.force.mockResolvedValue("refreshed-after-401");
    setApiBase("https://hands.test");
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request) => {
      calls.push(new URL(String(url)).pathname);
      return json({ error: "AppGallery invitation upload failed", submission_id: "submission1" }, 502);
    }));
    await expect(program().parseAsync(["node", "hands", "agc", "upload", APP, "build1", "--package-name", "build.example"]))
      .rejects.toMatchObject({ status: 502 });
    expect(calls).toEqual([`/api/apps/${APP}/builds/build1/agc-invitation-test`]);
    expect(auth.force).not.toHaveBeenCalled();
    expect(stderr.mock.calls.flat().join(" ")).toContain(`hands agc status -- ${APP} submission1`);
    expect(stderr.mock.calls.flat().join(" ")).toContain("check Huawei before retrying upload");
  });

  it("suggests the build lookup if the AppGallery upload response has no id", async () => {
    auth.admit.mockReturnValue({ kind: "agent", env });
    auth.fresh.mockResolvedValue("fresh-before-send"); auth.force.mockResolvedValue("refreshed-after-401");
    setApiBase("https://hands.test");
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    const responses = [json({ error: "unauthorized" }, 401), json({}), new Error("connection lost")];
    let calls = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      const response = responses[calls++];
      if (response instanceof Error) throw response;
      return response!;
    }));
    const args = ["node", "hands", "agc", "upload", APP, "build1", "--package-name", "build.example"];
    await expect(program().parseAsync(args)).rejects.toMatchObject({ status: 401 });
    await expect(program().parseAsync(args)).rejects.toThrow(`hands agc status --build -- ${APP} build1`);
    await expect(program().parseAsync(args)).rejects.toThrow("connection lost");
    expect(calls).toBe(3);
    expect(auth.force).not.toHaveBeenCalled();
    expect(stderr.mock.calls.flat().join(" ")).toContain(`hands agc status --build -- ${APP} build1`);
    expect(stderr.mock.calls.flat().join(" ")).toContain("check Huawei before retrying upload");
  });

  it("uses the protected status path on later AppGallery polling iterations", async () => {
    auth.admit.mockReturnValue({ kind: "agent", env });
    auth.fresh.mockResolvedValue("fresh-before-send"); auth.force.mockResolvedValue("refreshed-after-401");
    setApiBase("https://hands.test");
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void) => {
      queueMicrotask(callback);
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout);
    let statusCalls = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request) => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith("/agc-invitation-test")) return json({ submission_id: "submission1" });
      if (path.endsWith("/agc-submissions/submission1")) {
        statusCalls++;
        return statusCalls <= 2 ? json({ submission: { state: "processing" }, events: [] }) : json({ error: "unauthorized" }, 401);
      }
      throw new Error(`unexpected ${path}`);
    }));
    await expect(program().parseAsync(["node", "hands", "agc", "upload", APP, "build1", "--package-name", "build.example", "--wait"]))
      .rejects.toMatchObject({ status: 401 });
    expect(statusCalls).toBe(3);
    expect(auth.force).not.toHaveBeenCalled();
    expect(stderr.mock.calls.flat().join(" ")).toContain(`hands agc status -- ${APP} submission1`);
  });

  it("retains the TestFlight build identity if polling fails after publish returned", async () => {
    auth.admit.mockReturnValue({ kind: "agent", env });
    auth.fresh.mockResolvedValue("fresh-before-send"); auth.force.mockResolvedValue(null);
    setApiBase("https://hands.test");
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    const calls: string[] = [];
    let statusCalls = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      calls.push(`${init?.method ?? "GET"} ${path}`);
      if (path !== `/api/apps/${APP}/builds/build1/testflight-publish`) throw new Error(`unexpected ${path}`);
      if (init?.method === "POST") return json({ hands_build_id: "build1", asc_build_id: "asc-build1", state: "waiting_for_review" });
      statusCalls++;
      return statusCalls === 1
        ? json({ asc_build_id: "asc-build1", processing_state: "VALID", state: "ready" })
        : json({ error: "unauthorized" }, 401);
    }));
    await expect(program().parseAsync(["node", "hands", "builds", "testflight-publish", APP, "build1", "--distribution", "external", "--group-id", "group1", "--bundle-id", "build.example", "--wait"]))
      .rejects.toMatchObject({ status: 401 });
    expect(calls).toEqual([
      `GET /api/apps/${APP}/builds/build1/testflight-publish`,
      `POST /api/apps/${APP}/builds/build1/testflight-publish`,
      `GET /api/apps/${APP}/builds/build1/testflight-publish`,
    ]);
    expect(stderr.mock.calls.flat().join(" ")).toContain(`hands builds testflight-status --distribution external --bundle-id build.example -- ${APP} build1`);
    expect(stderr.mock.calls.flat().join(" ")).toContain("before retrying publish");
  });

  it("makes the AppGallery recovery command option-safe", async () => {
    auth.admit.mockReturnValue({ kind: "agent", env });
    auth.fresh.mockResolvedValue("fresh-before-send");
    setApiBase("https://hands.test");
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn(async () => json({ error: "failed", submission_id: "-odd'$(echo x)" }, 502)));
    await expect(program().parseAsync(["node", "hands", "agc", "upload", APP, "build1", "--package-name", "build.example"]))
      .rejects.toMatchObject({ status: 502 });
    const message = stderr.mock.calls.flat().join(" ");
    const command = message.match(/Inspect it with (.+) and check Huawei/s)?.[1];
    expect(command).toBe(`hands agc status -- ${APP} '-odd'\\''$(echo x)'`);
    const args = ["agc", "status", "--", APP, "-odd'$(echo x)"];
    if (process.platform !== "win32") {
      const shellArgs = JSON.parse(execFileSync("sh", ["-c", `hands() { node -e 'console.log(JSON.stringify(process.argv.slice(1)))' \"$@\"; }; ${command}`], { encoding: "utf8" }));
      expect(shellArgs).toEqual(args);
    }
    let parsed: string[] = [];
    const parser = new Command(); parser.command("agc").command("status <app> <id>").action((app, id) => { parsed = [app, id]; });
    await parser.parseAsync(["node", "hands", ...args]);
    expect(parsed).toEqual([APP, "-odd'$(echo x)"]);
  });

  it("quotes TestFlight recovery arguments for a POSIX shell", async () => {
    auth.admit.mockReturnValue({ kind: "agent", env });
    auth.fresh.mockResolvedValue("fresh-before-send"); auth.force.mockResolvedValue(null);
    setApiBase("https://hands.test");
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn(async () => json({ error: "unauthorized" }, 401)));
    await expect(program().parseAsync(["node", "hands", "builds", "testflight-publish", APP, "build one", "--distribution", "external", "--group-id", "group1", "--bundle-id", "app'$(echo x)"]))
      .rejects.toMatchObject({ status: 401 });
    expect(stderr.mock.calls.flat().join(" ")).toContain(`hands builds testflight-status --distribution external --bundle-id 'app'\\''$(echo x)' -- ${APP} 'build one'`);
  });

  it("does not replay raw API calls, including an edit-creating GET and writes", async () => {
    auth.admit.mockReturnValue({ kind: "agent", env });
    auth.fresh.mockResolvedValue("fresh-before-send"); auth.force.mockResolvedValue("refreshed-after-401");
    setApiBase("https://hands.test");
    const stdout = vi.spyOn(console, "log").mockImplementation(() => {});
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    const exit = vi.spyOn(process, "exit").mockImplementation((() => { throw new Error("exit"); }) as typeof process.exit);
    const cases = [
      { method: "GET", path: `/api/apps/${APP}/distributions/play/store-listing` },
      { method: "HEAD", path: "/api/apps" },
      { method: "POST", path: `/api/apps/${APP}/google-play-binding/tracks`, body: '{"package_name":"build.example"}' },
      { method: "PUT", path: `/api/apps/${APP}/google-play-binding`, body: "{}" },
      { method: "PATCH", path: `/api/apps/${APP}/app-store/versions/v1`, body: "{}" },
      { method: "DELETE", path: `/api/apps/${APP}/testflight-crashes/c1` },
    ];
    for (const item of cases) {
      const sent: Array<{ bearer: string | null; method: string | undefined; body: BodyInit | null | undefined; redirect: RequestRedirect | undefined }> = [];
      auth.fresh.mockClear(); auth.force.mockClear(); stderr.mockClear(); stdout.mockClear(); exit.mockClear();
      vi.stubGlobal("fetch", vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        sent.push({ bearer: new Headers(init?.headers).get("authorization"), method: init?.method, body: init?.body, redirect: init?.redirect });
        return json({ code: "UNAUTHORIZED", error: "unauthorized" }, 401);
      }));
      await expect(program().parseAsync(["node", "hands", "api", item.method, item.path, ...(item.body ? ["--data", item.body] : []), "--json"])).rejects.toThrow("exit");
      expect(sent, `${item.method} ${item.path}`).toEqual([{ bearer: "Bearer fresh-before-send", method: item.method, body: item.body, redirect: "manual" }]);
      expect(auth.fresh).toHaveBeenCalledOnce(); expect(auth.force).not.toHaveBeenCalled(); expect(exit).toHaveBeenCalledWith(1);
      expect(stderr.mock.calls.flat().join(" ")).toContain("outcome may be unknown");
      expect(JSON.parse(String(stdout.mock.calls[0]?.[0]))).toMatchObject({ code: "UNAUTHORIZED" });
    }
  });

  it("reports an ambiguous product commit as failed and uncertain in JSON without a replay", async () => {
    const dir = await tempDir(); const file = join(dir, "products.json");
    await writeFile(file, JSON.stringify({ google: { products: [{ productId: "example.product" }] } }));
    auth.admit.mockReturnValue({ kind: "agent", env }); auth.fresh.mockResolvedValue("fresh-before-send"); auth.force.mockResolvedValue("refreshed-after-401");
    setApiBase("https://hands.test");
    const output = vi.spyOn(console, "log").mockImplementation(() => {});
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    const modes: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      if (path === "/api/apps") return json({ apps: [{ id: APP, slug: "android", platform: "android" }] });
      if (!path.endsWith("/store-products")) throw new Error(`unexpected ${path}`);
      const body = JSON.parse(String(init?.body)); modes.push(body.mode);
      return body.mode === "dry_run" ? json({ product_id: body.product.productId, mode: "dry_run", outcome: "planned", changes: [] })
        : json({ code: "AUTH_UNKNOWN", outcome: "committed", error: "unauthorized" }, 401);
    }));
    await program().parseAsync(["node", "hands", "store-products", "apply", "android", "--file", file, "--commit", "--json"]);
    expect(modes).toEqual(["dry_run", "commit"]); expect(auth.force).not.toHaveBeenCalled();
    const result = JSON.parse(String(output.mock.calls[0]?.[0]));
    expect(result).toMatchObject({ stopped: true, results: [{ product_id: "example.product", outcome: "failed", outcome_uncertain: true, code: "AUTH_UNKNOWN" }] });
    expect(result.results[0].message).toContain("inspect the provider"); expect(process.exitCode).toBe(1);
    expect(stderr.mock.calls.flat().join(" ")).toContain("outcome may be unknown");
  });

  it("rebuilds an Apple multipart preview and succeeds after a 401 refresh", async () => {
    const dir = await tempDir();
    const ascDir = join(dir, "asc", "en-US", "APP_IPHONE_67");
    await mkdir(ascDir, { recursive: true }); await writeFile(join(ascDir, "1.png"), "image fixture");
    auth.admit.mockReturnValue({ kind: "agent", env });
    auth.fresh.mockResolvedValue("fresh-before-send"); auth.force.mockResolvedValue("refreshed-after-401");
    setApiBase("https://hands.test"); vi.spyOn(console, "log").mockImplementation(() => {});
    const requests: Array<{ bearer: string | null; request: string; bytes: string }> = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const form = init?.body as FormData;
      const file = form.get("img1") as Blob;
      requests.push({ bearer: new Headers(init?.headers).get("authorization"), request: String(form.get("request")), bytes: await file.text() });
      return requests.length === 1 ? json({ error: "unauthorized" }, 401) : json({ mode: "dry_run", outcome: "planned", sets: [] });
    }));
    await program().parseAsync(["node", "hands", "app-store", "screenshots", "push", APP, "--version-id", "v1", "--dir", join(dir, "asc"), "--json"]);
    expect(requests).toHaveLength(2);
    expect(requests.map((r) => r.bearer)).toEqual(["Bearer fresh-before-send", "Bearer refreshed-after-401"]);
    expect(requests[1]!.request).toBe(requests[0]!.request);
    expect(requests.map((r) => r.bytes)).toEqual(["image fixture", "image fixture"]);
    expect(auth.force).toHaveBeenCalledOnce();
  });
});
