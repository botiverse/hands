import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";

const APP_ID = "11111111-2222-3333-4444-555555555555";
type Call = { method: string; path: string; body: unknown };

vi.mock("../lib/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api.js")>();
  return {
    ...actual,
    apiRequest: async (path: string, opts: { method?: string; body?: unknown } = {}) => {
      const state = globalThis as unknown as { __CALLS: Call[]; __REPLY: unknown };
      state.__CALLS.push({ method: (opts.method ?? "GET").toUpperCase(), path: String(path), body: opts.body });
      if (state.__REPLY instanceof Error) throw state.__REPLY;
      return state.__REPLY as never;
    },
  };
});

const { formatPlan, parseListingFile, selectLocales, toListingFile } = await import("./store_listing.js");

async function run(argv: string[], reply: unknown = {}): Promise<{ calls: Call[]; out: string[] }> {
  const calls: Call[] = [];
  Object.assign(globalThis, { __CALLS: calls, __REPLY: reply });
  const out: string[] = [];
  vi.spyOn(console, "log").mockImplementation((line: unknown) => { out.push(String(line)); });
  const { registerStoreListingCommands } = await import("./store_listing.js");
  const program = new Command();
  program.exitOverride();
  program.option("--json", "", false);
  registerStoreListingCommands(program);
  await program.parseAsync(["node", "hands", ...argv]);
  return { calls, out };
}

async function listingFile(content: unknown) {
  const dir = await mkdtemp(join(tmpdir(), "hands-listing-"));
  const path = join(dir, "listing.json");
  await writeFile(path, JSON.stringify(content));
  return path;
}

const FILE = {
  "en-US": { title: "Raft", shortDescription: "Chat with agents", fullDescription: "Long" },
  "ja-JP": { title: "Raft JP" },
};

describe("store-listing file format", () => {
  it("reads the language-keyed map and Google's list shape, and round-trips pull output", () => {
    const listings = parseListingFile(FILE);
    expect(listings).toEqual([
      { language: "en-US", title: "Raft", shortDescription: "Chat with agents", fullDescription: "Long" },
      { language: "ja-JP", title: "Raft JP" },
    ]);
    expect(parseListingFile({ listings })).toEqual(listings);
    expect(toListingFile([...listings].reverse())).toEqual(FILE);
    expect(() => parseListingFile({ "en-US": "Raft" })).toThrow(/expected an object/);
    expect(() => parseListingFile({ "en-US": { language: "ja-JP" } })).toThrow(/does not match/);
  });

  it("filters --locales and refuses unknown ones", () => {
    const listings = parseListingFile(FILE);
    expect(selectLocales(listings, "ja-JP").map((l) => l.language)).toEqual(["ja-JP"]);
    expect(() => selectLocales(listings, "ko-KR")).toThrow(/ko-KR/);
  });

  it("prints the plan with before/after previews", () => {
    const text = formatPlan({
      receipt_id: "r1", operation_id: "o", package_name: "build.raft.app", edit_id: "e1", mode: "dry_run",
      outcome: "validated", default_language: "en-US", changes_not_sent_for_review: false,
      changes: [{ language: "en-US", action: "update", changed_fields: ["title"], before: { language: "en-US", title: "Old" }, after: { language: "en-US", title: "Raft" } }],
    });
    expect(text).toContain("Dry run: Google Play validated edit e1");
    expect(text).toContain("update    en-US (default)");
    expect(text).toContain('title: "Old" [3] -> "Raft" [4]');
    expect(text).toContain("--commit");
  });
});

describe("store-listing commands reach the Hands endpoints", () => {
  afterEach(() => vi.restoreAllMocks());

  it("push is a dry run unless --commit", async () => {
    const path = await listingFile(FILE);
    const reply = { receipt_id: "r", edit_id: "e", package_name: "p", mode: "dry_run", outcome: "validated", default_language: "en-US", changes: [], changes_not_sent_for_review: false };
    const dry = await run(["store-listing", "push", APP_ID, "--listing", path, "--locales", "en-US"], reply);
    expect(dry.calls).toEqual([{
      method: "POST", path: `/api/apps/${APP_ID}/distributions/play/store-listing`,
      body: { mode: "dry_run", listings: [{ language: "en-US", ...FILE["en-US"] }] },
    }]);
    const commit = await run(["store-listing", "push", APP_ID, "--listing", path, "--commit", "--changes-not-sent-for-review"], { ...reply, outcome: "committed" });
    expect(commit.calls[0]!.body).toMatchObject({ mode: "commit", changes_not_sent_for_review: true });
  });

  it("refuses ambiguous flag combinations before any request", async () => {
    const path = await listingFile(FILE);
    await expect(run(["store-listing", "push", APP_ID, "--listing", path, "--commit", "--dry-run"])).rejects.toThrow(/mutually exclusive/);
    await expect(run(["store-listing", "push", APP_ID, "--listing", path, "--locales", "en-US", "--delete-unlisted-languages"])).rejects.toThrow(/delete every other language/);
    await expect(run(["store-listing", "push", APP_ID, "--listing", path, "--changes-not-sent-for-review"])).rejects.toThrow(/only applies with --commit/);
  });

  it("surfaces the nested Hands error code, e.g. play_edit_in_review", async () => {
    const { QuiverApiError } = await import("../lib/api.js");
    const path = await listingFile(FILE);
    const error = new QuiverApiError(409, { error: { code: "edit_in_review", failure_code: "play_edit_in_review", message: "Another change for this app is in review on Google Play", receipt_id: "r9" } }, "[object Object]");
    const promise = run(["store-listing", "push", APP_ID, "--listing", path, "--commit"], error);
    await expect(promise).rejects.toMatchObject({ status: 409, message: "Another change for this app is in review on Google Play (receipt r9)", body: { code: "play_edit_in_review" } });
  });

  it("pull reads the listing endpoint", async () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const { calls } = await run(["store-listing", "pull", APP_ID], { package_name: "p", default_language: "en-US", listings: [{ language: "en-US", title: "Raft" }] });
    expect(calls).toEqual([{ method: "GET", path: `/api/apps/${APP_ID}/distributions/play/store-listing`, body: undefined }]);
    expect(JSON.parse(String(write.mock.calls[0]![0]))).toEqual({ "en-US": { title: "Raft" } });
  });
});
