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
type Call = { method: string; path: string; body: unknown; query?: Record<string, unknown>; retryOnUnauthorized?: boolean | undefined };

vi.mock("../lib/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api.js")>();
  return {
    ...actual,
    apiRequest: async (path: string, opts: { method?: string; body?: unknown; query?: Record<string, unknown>; retryOnUnauthorized?: boolean } = {}) => {
      const state = globalThis as unknown as { __CALLS: Call[]; __REPLY: (call: Call) => unknown };
      const call = { method: (opts.method ?? "GET").toUpperCase(), path: String(path), body: opts.body, query: opts.query, ...(opts.retryOnUnauthorized !== undefined ? { retryOnUnauthorized: opts.retryOnUnauthorized } : {}) };
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
  // Mirror index.ts: the global -V/--version used to swallow a subcommand's
  // `--version 1.17.0` and print the CLI version instead.
  program.version("0.0.0-test");
  program.option("--json", "", false);
  registerAppStoreCommands(program);
  await program.parseAsync(["node", "hands", ...argv]);
  return { calls, out };
}

const PREFLIGHT_PATH = `/api/apps/${APP_ID}/app-store/versions/ver-117/preflight`;
const PREFLIGHT_BLOCKED = {
  version_id: "ver-117", version_string: "1.17.0", state: "PREPARE_FOR_SUBMISSION", ready: false,
  findings: [
    { severity: "error", check: "localization_required_fields", locale: "zh-Hans", resource: "/v1/appStoreVersionLocalizations/loc-zh", message: "You must provide a value for the attribute 'supportUrl'", fix: "hands app-store localizations push ..." },
    { severity: "warning", check: "unreadable:age_rating", message: "could not read age_rating: 500 UNEXPECTED_ERROR" },
    { severity: "info", check: "localization_whats_new", locale: "ja", message: "whatsNew is empty" },
  ],
  checked: ["version_state", "build"],
  not_checkable: [{ check: "app_privacy", reason: "not in the public API" }],
};
const PREFLIGHT_READY = { ...PREFLIGHT_BLOCKED, ready: true, findings: [PREFLIGHT_BLOCKED.findings[2]] };

const FIXTURES = fileURLToPath(new URL("../../../../worker/test/fixtures/play-images/", import.meta.url));

afterEach(() => {
  process.exitCode = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("hands app-store", () => {
  it("prepare is a dry run unless --commit", async () => {
    const dry = await run(["app-store", "prepare", APP_ID, "--version-name", "1.17.0", "--build", "b-17"], () => ({ mode: "dry_run", action: "renamed", previous_version_string: "1.12.0", version_id: "ver-112", version_string: "1.17.0", state: "DEVELOPER_REJECTED" }));
    expect(dry.calls).toEqual([{ method: "POST", path: `/api/apps/${APP_ID}/app-store/versions`, body: { version_string: "1.17.0", mode: "dry_run", asc_build_id: "b-17" }, query: undefined, retryOnUnauthorized: true }]);
    expect(dry.out.join("\n")).toContain("would rename 1.12.0");
    const commit = await run(["app-store", "prepare", APP_ID, "--version-name", "1.17.0", "--commit"], () => ({ mode: "commit", action: "created", version_id: "v", version_string: "1.17.0", state: "PREPARE_FOR_SUBMISSION", build_attached: false }));
    expect((commit.calls[0]!.body as any).mode).toBe("commit");
    expect(commit.calls[0]!.retryOnUnauthorized).toBe(false);
  });

  it("submit without --commit only reads status and the preflight, and prints its errors", async () => {
    const { calls, out } = await run(["app-store", "submit", APP_ID, "--version-name", "1.17.0"], () => PREFLIGHT_BLOCKED);
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([`GET /api/apps/${APP_ID}/app-store/status`, `GET ${PREFLIGHT_PATH}`]);
    const text = out.join("\n");
    expect(text).toContain("Dry run: would submit 1.17.0");
    expect(text).toContain("You must provide a value for the attribute 'supportUrl'");
    expect(text).toContain("Apple will likely refuse this submission");
    // Only errors in the dry run; the full table is `preflight`.
    expect(text).not.toContain("whatsNew is empty");
    expect(process.exitCode ?? 0).toBe(0);
    const json = await run(["app-store", "submit", APP_ID, "--version-name", "1.17.0", "--json"], () => PREFLIGHT_BLOCKED);
    expect(JSON.parse(json.out.join("\n"))).toMatchObject({ mode: "dry_run", preflight: { ready: false } });
    // An older server without the route: the dry run still works.
    const old = await run(["app-store", "submit", APP_ID, "--version-name", "1.17.0"], () => { throw new Error("404 Not Found"); });
    expect(old.out.join("\n")).toContain("Preflight unavailable: 404 Not Found");
    const committed = await run(["app-store", "submit", APP_ID, "--version-name", "1.17.0", "--commit"], () => ({ submission_id: "sub-1", submitted: true }));
    expect(committed.calls.at(-1)).toMatchObject({ method: "POST", path: `/api/apps/${APP_ID}/app-store/versions/ver-117/submit` });
  });

  it("preflight prints a table grouped by severity and exits non-zero on any error", async () => {
    const blocked = await run(["app-store", "preflight", APP_ID, "--version-name", "1.17.0"], () => PREFLIGHT_BLOCKED);
    expect(blocked.calls.map((c) => `${c.method} ${c.path}`)).toEqual([`GET /api/apps/${APP_ID}/app-store/status`, `GET ${PREFLIGHT_PATH}`]);
    const text = blocked.out.join("\n");
    expect(text).toContain("Preflight 1.17.0 (ver-117, PREPARE_FOR_SUBMISSION): NOT READY");
    const order = ["Errors (1):", "Warnings (1):", "Info (1):", "Checked: version_state, build", "Not checked: app_privacy"].map((h) => text.indexOf(h));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(text).toContain("zh-Hans: You must provide a value for the attribute 'supportUrl'");
    expect(text).toContain("resource: /v1/appStoreVersionLocalizations/loc-zh");
    expect(process.exitCode).toBe(1);

    process.exitCode = undefined;
    const ready = await run(["app-store", "preflight", APP_ID, "--version-id", "ver-117", "--json"], () => PREFLIGHT_READY);
    // --version-id skips the status lookup.
    expect(ready.calls.map((c) => c.path)).toEqual([PREFLIGHT_PATH]);
    expect(JSON.parse(ready.out.join("\n"))).toMatchObject({ ready: true });
    expect(process.exitCode ?? 0).toBe(0);

    const warningsOnly = await run(["app-store", "preflight", APP_ID, "--version-id", "ver-117"], () => ({ ...PREFLIGHT_BLOCKED, findings: [PREFLIGHT_BLOCKED.findings[1]] }));
    expect(warningsOnly.out.join("\n")).toContain("Warnings (1):");
    expect(process.exitCode ?? 0).toBe(0);
  });

  it("labels a rejected (UNRESOLVED_ISSUES) pending submission and a resubmit", async () => {
    const { describePendingSubmission } = await import("./app_store.js");
    expect(describePendingSubmission({ id: "sub-rej", state: "UNRESOLVED_ISSUES" })).toBe("sub-rej (UNRESOLVED_ISSUES — Apple rejected; fix then submit again)");
    expect(describePendingSubmission({ id: "sub-9", state: "IN_REVIEW" })).toBe("sub-9 (IN_REVIEW)");
    expect(describePendingSubmission(null)).toBe("none");
    const committed = await run(["app-store", "submit", APP_ID, "--version-name", "1.17.0", "--commit"], () => ({ submission_id: "sub-rej", submitted: true, resubmitted: true }));
    expect(committed.out.join("\n")).toContain("Resubmitted 1.17.0 (ver-117) in its rejected review submission sub-rej.");
  });

  it("withdraw without --commit only reads status; with --commit names the version", async () => {
    const dry = await run(["app-store", "withdraw", APP_ID, "--version-name", "1.17.0"]);
    expect(dry.calls.every((c) => c.method === "GET")).toBe(true);
    const committed = await run(["app-store", "withdraw", APP_ID, "--version-name", "1.17.0", "--commit"], () => ({ submission_id: "sub-1", canceled: true }));
    expect(committed.calls.at(-1)).toMatchObject({ method: "POST", path: `/api/apps/${APP_ID}/app-store/withdraw`, body: { version_id: "ver-117" } });
  });

  it("release is a dry run unless --commit, and sends the exact version/build confirmation", async () => {
    const path = `/api/apps/${APP_ID}/app-store/versions/ver-117/release`;
    const dry = await run(["app-store", "release", APP_ID, "ver-117", "--version-name", "1.17.0", "--build", "b-17"], () => ({
      mode: "dry_run", outcome: "planned", released: false, version: { version_id: "ver-117", version_string: "1.17.0", state: "PENDING_DEVELOPER_RELEASE", build_id: "b-17" },
    }));
    expect(dry.calls).toEqual([{ method: "POST", path, body: { mode: "dry_run", version_string: "1.17.0", asc_build_id: "b-17" }, query: undefined, retryOnUnauthorized: true }]);
    expect(dry.out.join("\n")).toContain("Dry run: would release 1.17.0");
    expect(dry.out.join("\n")).toContain("--commit");

    const committed = await run(["app-store", "release", APP_ID, "ver-117", "--version-name", "1.17.0", "--commit"], () => ({
      mode: "commit", outcome: "release_requested", released: false, version_id: "ver-117", version_string: "1.17.0", observed_state: "PENDING_DEVELOPER_RELEASE",
    }));
    expect(committed.calls).toEqual([{ method: "POST", path, body: { mode: "commit", version_string: "1.17.0" }, query: undefined, retryOnUnauthorized: false }]);
    expect(committed.out.join("\n")).toContain("Release requested");
    expect(committed.out.join("\n")).not.toContain("Released ");
  });

  it("release requires --version-name", async () => {
    await expect(run(["app-store", "release", APP_ID, "ver-117", "--commit"])).rejects.toThrow();
  });

  it("localizations push sends mode dry_run by default to the version's endpoint", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hands-asc-"));
    const file = join(dir, "listing.json");
    await writeFile(file, JSON.stringify({ "en-US": { keywords: "chat,agents" } }));
    const { calls } = await run(["app-store", "localizations", "push", APP_ID, "--version-name", "1.17.0", "--file", file], () => ({ outcome: "planned", localizations: [] }));
    expect(calls.at(-1)).toMatchObject({
      method: "POST",
      path: `/api/apps/${APP_ID}/app-store/versions/ver-117/localizations`,
      body: { mode: "dry_run", localizations: { "en-US": { keywords: "chat,agents" } } },
    });
  });

  it("app-info previews by default, sends the exact version guard, and keeps commits explicit", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hands-info-"));
    const file = join(dir, "info.json");
    const desired = { primary_category: "PRODUCTIVITY", localizations: { "en-US": { name: "New Name", subtitle: "Chat" } } };
    await writeFile(file, JSON.stringify(desired));
    const plan = { outcome: "planned", version: { id: "ver-117", version_string: "1.17.0", platform: "IOS", state: "PREPARE_FOR_SUBMISSION" }, app_info: { id: "info-1", state: "PREPARE_FOR_SUBMISSION" }, observed_platforms: ["IOS"], localizations: [{ locale: "en-US", action: "update", changed_fields: ["name"], before: { name: "Old" }, after: { name: "New Name" }, blocker: null }], category: { before: "UTILITIES", after: "PRODUCTIVITY", action: "update", blocker: null }, locale_consistency: { missing_app_info: [], missing_version: ["ja"] } };
    const dry = await run(["app-store", "app-info", "push", APP_ID, "--version-name", "1.17.0", "--file", file], () => plan);
    expect(dry.calls).toEqual([
      { method: "GET", path: `/api/apps/${APP_ID}/app-store/status`, body: undefined, query: { version_string: "1.17.0" } },
      { method: "POST", path: `/api/apps/${APP_ID}/app-store/versions/ver-117/app-info`, body: { ...desired, mode: "dry_run", version_string: "1.17.0" }, query: undefined, retryOnUnauthorized: true },
    ]);
    const text = dry.out.join("\n");
    expect(text).toContain('name: "Old" [3] -> "New Name" [8]');
    expect(text).toContain("App Information languages missing in the selected version: ja");
    expect(text).toContain("not checked or reserved");
    expect(text).toContain("Run again with --commit to write.");
    const json = await run(["app-store", "app-info", "push", APP_ID, "--version-name", "1.17.0", "--version-id", "ver/117", "--file", file, "--json"], () => plan);
    expect(json.calls).toEqual([{ method: "POST", path: `/api/apps/${APP_ID}/app-store/versions/ver%2F117/app-info`, body: { ...desired, mode: "dry_run", version_string: "1.17.0" }, query: undefined, retryOnUnauthorized: true }]);
    expect(JSON.parse(json.out.join("\n"))).toEqual(plan);
    const { QuiverApiError } = await import("../lib/api.js");
    const guard = { code: "APP_INFO_CLIENT_UPGRADE_REQUIRED", error: "upgrade @botiverse/hands-cli to 0.5.44 or newer before running App Information --commit; nothing was written" };
    const failure = await run(["app-store", "app-info", "push", APP_ID, "--version-name", "1.17.0", "--version-id", "ver-117", "--file", file, "--commit"], () => { throw new QuiverApiError(409, guard, guard.error); }).catch((e) => e);
    expect(failure).toBeInstanceOf(QuiverApiError);
    expect(failure.body).toEqual(guard);
    expect((globalThis as any).__CALLS).toEqual([{ method: "POST", path: `/api/apps/${APP_ID}/app-store/versions/ver-117/app-info`, body: { ...desired, mode: "commit", version_string: "1.17.0", commit_contract_version: 1 }, query: undefined, retryOnUnauthorized: false }]);
  });

  it("app-info accepts only complete confirmed results matching the request", async () => {
    const { assertAppInfoConfirmed } = await import("./app_store.js");
    const desired = { localizations: { "en-US": { name: "New Name", subtitle: "Chat" } }, primary_category: "PRODUCTIVITY" };
    const confirmed = { ok: true, outcome: "committed", operation_id: "op-1", recovery_required: false, mismatches: [],
      results: [{ target: "en-US", status: "written", localization_id: "loc-1" }, { target: "primary_category", status: "unchanged", localization_id: null }],
      readback: { localizations: [{ locale: "en-US", id: "loc-1", fields: { name: "New Name", subtitle: "Chat" } }], primary_category: "PRODUCTIVITY" } };
    expect(assertAppInfoConfirmed(confirmed, desired)).toBe(confirmed);
    const unchanged = { ...confirmed, outcome: "no_changes", results: confirmed.results.map((r) => ({ ...r, status: "unchanged" })) };
    expect(assertAppInfoConfirmed(unchanged, desired)).toBe(unchanged);
    const bad = [null, {}, { ...confirmed, results: [] }, { ...confirmed, mismatches: [{}] },
      { ...confirmed, recovery_required: true }, { ...confirmed, operation_id: "" },
      { ...confirmed, readback: {} }, { ...confirmed, readback: { ...confirmed.readback, primary_category: "UTILITIES" } },
      { ...confirmed, readback: { ...confirmed.readback, localizations: [{ locale: "en-US", id: "loc-1", fields: { name: "Other", subtitle: "Chat" } }] } },
      { ...confirmed, readback: { ...confirmed.readback, localizations: [{ locale: "en-US", id: "different", fields: { name: "New Name", subtitle: "Chat" } }] } },
      { ...confirmed, results: [confirmed.results[0], confirmed.results[0]] },
      { ...confirmed, results: [{ ...confirmed.results[0], status: "unknown" }, confirmed.results[1]] },
      { ...confirmed, outcome: "no_changes" }, { ...unchanged, outcome: "committed" }];
    for (const response of bad) expect(() => assertAppInfoConfirmed(response, desired)).toThrow("App Information write result was not confirmed");
  });

  it("app-info warns on lost, malformed or intermediary responses without hiding a structured result", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hands-info-")); const file = join(dir, "info.json");
    await writeFile(file, JSON.stringify({ localizations: { "en-US": { name: "Example" } } }));
    const { QuiverApiError } = await import("../lib/api.js");
    const errors: string[] = []; vi.spyOn(console, "error").mockImplementation((line: unknown) => { errors.push(String(line)); });
    const argv = ["app-store", "app-info", "push", APP_ID, "--version-name", "1.17.0", "--version-id", "ver-117", "--file", file, "--commit"];
    const warning = "Write result could not be confirmed";
    for (const response of [() => { throw new Error("connection lost"); }, () => { throw new QuiverApiError(401, "proxy error", "unauthorized"); }, () => ({ ok: true }), () => { throw new QuiverApiError(502, { code: "APP_INFO_WRITE_FAILED", operation_id: "op", recovery_required: false }, "malformed"); }]) {
      errors.length = 0; await expect(run(argv, response)).rejects.toThrow(); expect(errors.join("\n")).toContain(warning);
    }
    const structured = { code: "APP_INFO_RECOVERY_REQUIRED", operation_id: "op-1", recovery_required: true, results: [{ target: "en-US", status: "unknown" }] };
    errors.length = 0; await expect(run(argv, () => { throw new QuiverApiError(502, structured, "inspect"); })).rejects.toThrow();
    expect(errors.join("\n")).toContain("Recovery required for operation op-1"); expect(errors.join("\n")).not.toContain(warning);
    const releaseUnconfirmed = { code: "APP_INFO_RECOVERY_REQUIRED", operation_id: "op-2", recovery_required: true, mutation_started: true,
      results: [{ target: "en-US", status: "written" }], prior_status: 200, prior_result: { outcome: "committed" } };
    errors.length = 0; await expect(run(argv, () => { throw new QuiverApiError(502, releaseUnconfirmed, "inspect"); })).rejects.toThrow();
    expect(errors.join("\n")).toContain("en-US: written"); expect(errors.join("\n")).toContain("Recovery required for operation op-2");
    expect(errors.join("\n")).toContain("lock may already be absent");
    errors.length = 0; await expect(run(argv, () => { throw new QuiverApiError(502, { ...releaseUnconfirmed, mutation_started: false, results: [] }, "inspect"); })).rejects.toThrow();
    expect(errors.join("\n")).toContain("Recovery required for operation op-2"); expect(errors.join("\n")).toContain(warning);
    errors.length = 0; await expect(run(argv, () => { throw new QuiverApiError(409, { code: "APP_INFO_COMMIT_UNVERIFIED" }, "blocked"); })).rejects.toThrow();
    expect(errors.join("\n")).not.toContain(warning);
    errors.length = 0; await expect(run(argv, () => { throw new QuiverApiError(409, { code: "APP_INFO_CLIENT_UPGRADE_REQUIRED" }, "upgrade"); })).rejects.toThrow();
    expect(errors.join("\n")).not.toContain(warning);
  });

  it("app-info prints blocking platform and AppInfo details, and preserves JSON errors", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hands-info-")); const file = join(dir, "info.json");
    await writeFile(file, JSON.stringify({ localizations: { "en-US": { name: "Example" } } }));
    const { QuiverApiError } = await import("../lib/api.js");
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((line: unknown) => { errors.push(String(line)); });
    const argv = ["app-store", "app-info", "push", APP_ID, "--version-name", "1.17.0", "--version-id", "ver-117", "--file", file];
    const blocked = { code: "APP_INFO_OTHER_PLATFORM_ACTIVE", error: "another platform has an active version", other_versions: [{ id: "mac-1", versionString: "2.0", platform: "MAC_OS", state: "IN_REVIEW" }] };
    const failure = await run(argv, () => { throw new QuiverApiError(409, blocked, blocked.error); }).catch((e) => e);
    expect(failure.body).toEqual(blocked);
    expect(errors.join("\n")).toContain("Other version: 2.0 (mac-1, MAC_OS, IN_REVIEW)");
    const ambiguous = { code: "APP_INFO_NOT_UNAMBIGUOUS", error: "ambiguous", app_infos: [{ id: "draft-1", state: "PREPARE_FOR_SUBMISSION" }, { id: "pending", state: "IN_REVIEW" }] };
    await run(argv, () => { throw new QuiverApiError(409, ambiguous, ambiguous.error); }).catch(() => undefined);
    expect(errors.join("\n")).toContain("App Information: pending (IN_REVIEW)");
    await run([...argv, "--json"], () => { throw new QuiverApiError(409, blocked, blocked.error); }).catch(() => undefined);
    const lastLog = (console.log as any).mock.calls.at(-1)?.[0];
    expect(JSON.parse(lastLog)).toEqual(blocked);
    await expect(run(["app-store", "app-info", "push", APP_ID, "--file", file])).rejects.toThrow();
  });

  it("screenshots inspect only reads the selected version and locale, preserving Apple's metadata", async () => {
    const inspection = { version_id: "ver-117", localizations: [{ locale: "en-US", sets: [
      { id: "set-1", display_type: "FAKE_APPLE_TYPE", screenshots: [{ id: "s1", file_name: "one.png", width: 1398, height: 2034, state: "COMPLETE" }] },
      { id: "set-2", display_type: null, screenshots: [{ id: "s2", file_name: null, width: null, height: null, state: null }] },
    ] }] };
    const path = `/api/apps/${APP_ID}/app-store/versions/ver-117/screenshots`;
    const got = await run(["app-store", "screenshots", "inspect", APP_ID, "--version-name", "1.17.0", "--locale", "en-US"], () => inspection);
    expect(got.calls).toEqual([
      { method: "GET", path: `/api/apps/${APP_ID}/app-store/status`, body: undefined, query: { version_string: "1.17.0" } },
      { method: "GET", path, body: undefined, query: { locale: "en-US" } },
    ]);
    expect(got.out.join("\n")).toContain("FAKE_APPLE_TYPE (set-1)");
    expect(got.out.join("\n")).toContain("one.png: 1398x2034, COMPLETE");
    expect(got.out.join("\n")).toContain("s2: dimensions unavailable, state unavailable");
    const json = await run(["app-store", "screenshots", "inspect", APP_ID, "--version-id", "ver-117", "--json"], () => inspection);
    expect(json.calls).toEqual([{ method: "GET", path, body: undefined, query: {} }]);
    expect(JSON.parse(json.out.join("\n"))).toEqual(inspection);
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

  it("prints the fields a blocked locale create is missing", async () => {
    const { formatLocalizationResult } = await import("./app_store.js");
    const text = formatLocalizationResult({ localizations: [
      { locale: "ja", action: "create", blocker: "missing_required_fields", missing_fields: ["keywords", "supportUrl"], changed_fields: [] },
      { locale: "fr-FR", action: "create", blocker: "version_not_editable", missing_fields: ["supportUrl"], changed_fields: [] },
    ] });
    expect(text).toContain("BLOCKED (missing_required_fields: keywords, supportUrl) ja");
    expect(text).toContain("BLOCKED (version_not_editable) fr-FR");
  });

  it("screenshots push --commit fails with its own code when Apple is still processing, and FAILED wins over pending", async () => {
    const root = await mkdtemp(join(tmpdir(), "hands-shots-"));
    await mkdir(join(root, "en-US", "APP_IPHONE_67"), { recursive: true });
    await copyFile(`${FIXTURES}phone-1080x1920.png`, join(root, "en-US", "APP_IPHONE_67", "01.png"));
    const next = "Apple is still processing some screenshots. Run the dry run again later: if every set is `unchanged`, files and order are confirmed; if a set shows `reorder` or `replace`, run --commit again.";
    const set = (locale: string, status: string) => ({ locale, display_type: "APP_IPHONE_67", action: "replace", status, images: [] });
    const reply = (status: number, body: unknown) => vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status })));
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((line: unknown) => { errors.push(String(line)); });
    const argv = ["app-store", "screenshots", "push", APP_ID, "--version-id", "ver-117", "--dir", root, "--commit"];

    reply(202, { ok: false, outcome: "uploaded_pending", code: "SCREENSHOTS_PENDING", error: "1 screenshot set(s) uploaded but still processing at Apple: en-US APP_IPHONE_67",
      failed_sets: [], pending_sets: ["en-US APP_IPHONE_67"], next_action: next, sets: [set("en-US", "uploaded_pending")] });
    const pending = await run(argv).catch((e) => e);
    expect(pending.name).toBe("QuiverApiError");
    expect(pending.body.code).toBe("SCREENSHOTS_PENDING");
    expect(pending.body.next_action).toBe(next);
    expect(errors.join("\n")).toContain("en-US APP_IPHONE_67: replace -> uploaded_pending");
    expect(errors.join("\n")).toContain("Uploaded, still processing at Apple: en-US APP_IPHONE_67");

    errors.length = 0;
    reply(502, { ok: false, outcome: "failed", code: "SCREENSHOTS_FAILED", error: "1 screenshot set(s) did not reach the requested state",
      failed_sets: ["en-US APP_IPHONE_67"], pending_sets: ["ja APP_IPHONE_67"], next_action: `Fix the failed sets and push again. ${next}`,
      sets: [set("en-US", "failed"), set("ja", "uploaded_pending")] });
    const failed = await run(argv).catch((e) => e);
    expect(failed.body.code).toBe("SCREENSHOTS_FAILED");
    expect(errors.join("\n")).toContain("Failed: en-US APP_IPHONE_67");
    expect(errors.join("\n")).toContain("Uploaded, still processing at Apple: ja APP_IPHONE_67");

    reply(200, { ok: true, outcome: "committed", failed_sets: [], pending_sets: [], sets: [set("en-US", "ok")] });
    const ok = await run(argv);
    expect(ok.out.join("\n")).toContain("Committed and read back from Apple.");
  });
});
