import { copyFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
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
    getApiBase: () => "https://hands.test",
    agentAwareFetch: (doFetch: (bearer: string | undefined) => Promise<Response>) => doFetch("token"),
  };
});

const { collectImageSets, formatPlan, parseListingFile, selectLocales, toListingFile } = await import("./store_listing.js");

/** Real designer exports, shared with the worker's image tests. */
const FIXTURES = fileURLToPath(new URL("../../../../worker/test/fixtures/play-images/", import.meta.url));
const PHONE = `${FIXTURES}phone-1080x1920.png`;
const FEATURE = `${FIXTURES}feature-graphic-1024x500.png`;

async function tree(files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), "hands-images-"));
  for (const [path, source] of Object.entries(files)) {
    await mkdir(join(root, path, ".."), { recursive: true });
    await copyFile(source, join(root, path));
  }
  return root;
}

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
    expect(formatPlan({
      receipt_id: "r1", operation_id: "o", package_name: "p", edit_id: "e1", mode: "dry_run", outcome: "validated",
      default_language: "en-US", changes_not_sent_for_review: false, changes: [],
      image_changes: [{ language: "en-US", imageType: "icon", action: "replace", before: [], after: [{ id: "i", sha256: "a", size_bytes: 1 }] }],
      image_warnings: [{ code: "provider_sha256_mismatch", language: "en-US", imageType: "icon", index: 0 }],
    })).toContain("warning   en-US icon #1: provider_sha256_mismatch");
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

describe("store-listing images directory", () => {
  afterEach(() => vi.restoreAllMocks());

  it("reads the designer export layout (<device>/<lang>/NN.png) with the explicit locale table", async () => {
    const root = await tree({
      "phone/en/02-activity.png": PHONE, "phone/en/01-chat.png": PHONE, "phone/en/10-late.png": PHONE,
      "phone/zh-Hans/01-chat.png": PHONE, "phone/ja/01-chat.png": PHONE,
      "feature-graphic/en/feature-graphic.png": FEATURE,
      "tablet-10/en/01-chat.png": PHONE,
    });
    const sets = await collectImageSets(root);
    expect(sets.map((set) => [set.language, set.imageType, set.files.map((file) => file.slice(root.length + 1))])).toEqual([
      ["en-US", "phoneScreenshots", ["phone/en/01-chat.png", "phone/en/02-activity.png", "phone/en/10-late.png"]],
      ["en-US", "tenInchScreenshots", ["tablet-10/en/01-chat.png"]],
      ["en-US", "featureGraphic", ["feature-graphic/en/feature-graphic.png"]],
      ["ja-JP", "phoneScreenshots", ["phone/ja/01-chat.png"]],
      ["zh-CN", "phoneScreenshots", ["phone/zh-Hans/01-chat.png"]],
    ]);
    expect((await collectImageSets(root, { locales: ["ja-JP"] })).map((set) => set.language)).toEqual(["ja-JP"]);
  });

  it("reads the language-first layout and applies default/ to every target language without its own set", async () => {
    const root = await tree({
      "default/featureGraphic/01.png": FEATURE,
      "default/phoneScreenshots/01.png": PHONE,
      "ja-JP/phoneScreenshots/01.png": PHONE,
    });
    const sets = await collectImageSets(root, { languages: ["en-US", "ja-JP"] });
    expect(sets.map((set) => [set.language, set.imageType, set.source])).toEqual([
      ["en-US", "phoneScreenshots", "default"],
      ["en-US", "featureGraphic", "default"],
      ["ja-JP", "phoneScreenshots", "language"],
      ["ja-JP", "featureGraphic", "default"],
    ]);
    await expect(collectImageSets(await tree({ "default/icon/1.png": PHONE }))).rejects.toThrow(/need target languages/);
    await expect(collectImageSets(await tree({ "en-US/screens/1.png": PHONE }))).rejects.toThrow(/unknown imageType folder/);
    await expect(collectImageSets(await tree({ "phone/en/1.gif": PHONE }))).rejects.toThrow(/only .png/);
    await expect(collectImageSets(await tree({ "phone/en/1.png": PHONE, "phone/en-US/1.png": PHONE }))).rejects.toThrow(/two folders/);
  });

  it("push --images sends one multipart request: request JSON + one part per declared image", async () => {
    const root = await tree({ "phone/en/01.png": PHONE, "phone/en/02.png": PHONE, "feature-graphic/en/fg.png": FEATURE });
    const listing = await listingFile({ "en-US": { title: "Raft" } });
    const sent: Array<{ url: string; form: FormData; auth: string | null }> = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      sent.push({ url, form: init.body as FormData, auth: new Headers(init.headers).get("authorization") });
      return Response.json({ receipt_id: "r", edit_id: "e", package_name: "p", mode: "dry_run", outcome: "validated", default_language: "en-US", changes: [], image_changes: [], changes_not_sent_for_review: false });
    });
    await run(["store-listing", "push", APP_ID, "--listing", listing, "--images", root, "--ai-generated-state", "aiGeneratedStateNotAiGenerated"]);
    vi.unstubAllGlobals();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe(`https://hands.test/api/apps/${APP_ID}/distributions/play/store-listing`);
    expect(sent[0]!.auth).toBe("Bearer token");
    const request = JSON.parse(String(sent[0]!.form.get("request")));
    const sha = (path: string) => readFile(path).then((bytes) => createHash("sha256").update(bytes).digest("hex"));
    expect(request).toEqual({
      mode: "dry_run",
      listings: [{ language: "en-US", title: "Raft" }],
      images: [
        { language: "en-US", imageType: "phoneScreenshots", images: [
          { part: "img1", sha256: await sha(PHONE), aiGeneratedState: "aiGeneratedStateNotAiGenerated" },
          { part: "img2", sha256: await sha(PHONE), aiGeneratedState: "aiGeneratedStateNotAiGenerated" },
        ] },
        { language: "en-US", imageType: "featureGraphic", images: [{ part: "img3", sha256: await sha(FEATURE), aiGeneratedState: "aiGeneratedStateNotAiGenerated" }] },
      ],
    });
    const part = sent[0]!.form.get("img3") as File;
    expect(part.type).toBe("image/png");
    expect(part.size).toBe((await readFile(FEATURE)).byteLength);
  });
});
