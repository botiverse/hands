import { copyFile, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";

/**
 * The app-store commands must reach the endpoints the manifest/OpenAPI declare, and
 * must not write to Apple unless --commit is passed.
 */
const APP_ID = "11111111-2222-3333-4444-555555555555";
type Call = { method: string; path: string; body: unknown; query?: Record<string, unknown> };

vi.mock("../lib/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api.js")>();
  return {
    ...actual,
    apiRequest: async (path: string, opts: { method?: string; body?: unknown; query?: Record<string, unknown> } = {}) => {
      const state = globalThis as unknown as { __CALLS: Call[]; __REPLY: (call: Call) => unknown };
      const call = { method: (opts.method ?? "GET").toUpperCase(), path: String(path), body: opts.body, query: opts.query };
      state.__CALLS.push(call);
      return state.__REPLY(call) as never;
    },
    getApiBase: () => "https://hands.test",
    agentAwareFetch: (doFetch: (bearer: string | undefined) => Promise<Response>) => doFetch("token"),
  };
});

const STATUS = { version_id: "ver-117", version_string: "1.17.0", state: "PREPARE_FOR_SUBMISSION", build_attached: true, pending_submission: null };

async function run(argv: string[], reply: (call: Call) => unknown = () => ({})) {
  const calls: Call[] = [];
  Object.assign(globalThis, { __CALLS: calls, __REPLY: (call: Call) => call.path.endsWith("/app-store/status") ? STATUS : reply(call) });
  const out: string[] = [];
  vi.spyOn(console, "log").mockImplementation((line: unknown) => { out.push(String(line)); });
  const { registerAppStoreCommands } = await import("./app_store.js");
  const program = new Command();
  program.exitOverride();
  program.option("--json", "", false);
  registerAppStoreCommands(program);
  await program.parseAsync(["node", "hands", ...argv]);
  return { calls, out };
}

const FIXTURES = fileURLToPath(new URL("../../../../worker/test/fixtures/play-images/", import.meta.url));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("hands app-store", () => {
  it("prepare is a dry run unless --commit", async () => {
    const dry = await run(["app-store", "prepare", APP_ID, "--version", "1.17.0", "--build", "b-17"], () => ({ mode: "dry_run", action: "renamed", previous_version_string: "1.12.0", version_id: "ver-112", version_string: "1.17.0", state: "DEVELOPER_REJECTED" }));
    expect(dry.calls).toEqual([{ method: "POST", path: `/api/apps/${APP_ID}/app-store/versions`, body: { version_string: "1.17.0", mode: "dry_run", asc_build_id: "b-17" }, query: undefined }]);
    expect(dry.out.join("\n")).toContain("would rename 1.12.0");
    const commit = await run(["app-store", "prepare", APP_ID, "--version", "1.17.0", "--commit"], () => ({ mode: "commit", action: "created", version_id: "v", version_string: "1.17.0", state: "PREPARE_FOR_SUBMISSION", build_attached: false }));
    expect((commit.calls[0]!.body as any).mode).toBe("commit");
  });

  it("submit without --commit only reads status", async () => {
    const { calls, out } = await run(["app-store", "submit", APP_ID, "--version", "1.17.0"]);
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([`GET /api/apps/${APP_ID}/app-store/status`]);
    expect(out.join("\n")).toContain("Dry run: would submit 1.17.0");
    const committed = await run(["app-store", "submit", APP_ID, "--version", "1.17.0", "--commit"], () => ({ submission_id: "sub-1", submitted: true }));
    expect(committed.calls.at(-1)).toMatchObject({ method: "POST", path: `/api/apps/${APP_ID}/app-store/versions/ver-117/submit` });
  });

  it("withdraw without --commit only reads status; with --commit names the version", async () => {
    const dry = await run(["app-store", "withdraw", APP_ID, "--version", "1.17.0"]);
    expect(dry.calls.every((c) => c.method === "GET")).toBe(true);
    const committed = await run(["app-store", "withdraw", APP_ID, "--version", "1.17.0", "--commit"], () => ({ submission_id: "sub-1", canceled: true }));
    expect(committed.calls.at(-1)).toMatchObject({ method: "POST", path: `/api/apps/${APP_ID}/app-store/withdraw`, body: { version_id: "ver-117" } });
  });

  it("release is a dry run unless --commit, and sends the exact version/build confirmation", async () => {
    const path = `/api/apps/${APP_ID}/app-store/versions/ver-117/release`;
    const dry = await run(["app-store", "release", APP_ID, "ver-117", "--version", "1.17.0", "--build", "b-17"], () => ({
      mode: "dry_run", outcome: "planned", released: false, version: { version_id: "ver-117", version_string: "1.17.0", state: "PENDING_DEVELOPER_RELEASE", build_id: "b-17" },
    }));
    expect(dry.calls).toEqual([{ method: "POST", path, body: { mode: "dry_run", version_string: "1.17.0", asc_build_id: "b-17" }, query: undefined }]);
    expect(dry.out.join("\n")).toContain("Dry run: would release 1.17.0");
    expect(dry.out.join("\n")).toContain("--commit");

    const committed = await run(["app-store", "release", APP_ID, "ver-117", "--version", "1.17.0", "--commit"], () => ({
      mode: "commit", outcome: "release_requested", released: false, version_id: "ver-117", version_string: "1.17.0", observed_state: "PENDING_DEVELOPER_RELEASE",
    }));
    expect(committed.calls).toEqual([{ method: "POST", path, body: { mode: "commit", version_string: "1.17.0" }, query: undefined }]);
    expect(committed.out.join("\n")).toContain("Release requested");
    expect(committed.out.join("\n")).not.toContain("Released ");
  });

  it("release requires --version", async () => {
    await expect(run(["app-store", "release", APP_ID, "ver-117", "--commit"])).rejects.toThrow();
  });

  it("localizations push sends mode dry_run by default to the version's endpoint", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hands-asc-"));
    const file = join(dir, "listing.json");
    await writeFile(file, JSON.stringify({ "en-US": { keywords: "chat,agents" } }));
    const { calls } = await run(["app-store", "localizations", "push", APP_ID, "--version", "1.17.0", "--file", file], () => ({ outcome: "planned", localizations: [] }));
    expect(calls.at(-1)).toMatchObject({
      method: "POST",
      path: `/api/apps/${APP_ID}/app-store/versions/ver-117/localizations`,
      body: { mode: "dry_run", localizations: { "en-US": { keywords: "chat,agents" } } },
    });
  });

  it("screenshots push reads <dir>/<locale>/<display_type>/ in numeric order and posts multipart", async () => {
    const root = await mkdtemp(join(tmpdir(), "hands-shots-"));
    const folder = join(root, "en-US", "APP_IPHONE_67");
    await mkdir(folder, { recursive: true });
    await copyFile(`${FIXTURES}phone-1080x1920.png`, join(folder, "10-last.png"));
    await copyFile(`${FIXTURES}feature-graphic-1024x500.png`, join(folder, "2-first.png"));
    const { collectScreenshotSets } = await import("./app_store.js");
    const sets = await collectScreenshotSets(root);
    expect(sets).toEqual([{ locale: "en-US", display_type: "APP_IPHONE_67", files: [join(folder, "2-first.png"), join(folder, "10-last.png")] }]);

    let posted: { url: string; request: any; files: string[] } | null = null;
    vi.stubGlobal("fetch", vi.fn(async (url: unknown, init?: RequestInit) => {
      const form = init!.body as FormData;
      posted = { url: String(url), request: JSON.parse(String(form.get("request"))), files: [...form.keys()].filter((k) => k !== "request") };
      return new Response(JSON.stringify({ outcome: "planned", sets: [] }));
    }));
    await run(["app-store", "screenshots", "push", APP_ID, "--version-id", "ver-117", "--dir", root]);
    expect(posted!.url).toBe(`https://hands.test/api/apps/${APP_ID}/app-store/versions/ver-117/screenshots`);
    expect(posted!.request.mode).toBe("dry_run");
    expect(posted!.request.sets[0].images.map((i: any) => i.part)).toEqual(["img1", "img2"]);
    expect(posted!.files).toEqual(["img1", "img2"]);

    await run(["app-store", "screenshots", "push", APP_ID, "--version-id", "ver-117", "--dir", root, "--commit"]);
    expect(posted!.request.mode).toBe("commit");
  });
});
