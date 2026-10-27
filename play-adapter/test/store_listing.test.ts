import { exportPKCS8, generateKeyPair } from "jose";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { createPlayAdapterService } from "../src/index";
import { planStoreListings } from "../src/store_listing";
import type { PlayAdapterEnv, PlayDiscoveryInput, PlayListing, StoreListingPushRpcInput } from "../src/types";

const PACKAGE = "build.raft.app";
let binding: PlayDiscoveryInput;

beforeAll(async () => {
  const pair = await generateKeyPair("RS256", { extractable: true });
  binding = {
    credential: {
      type: "service_account",
      client_email: "tenant-app@example.iam.gserviceaccount.com",
      private_key: await exportPKCS8(pair.privateKey),
    },
    packageName: PACKAGE,
  };
});

const env: PlayAdapterEnv = { MAX_AAB_SIZE_BYTES: "209715200" };

const EN: PlayListing = { language: "en-US", title: "Raft", shortDescription: "Chat with agents", fullDescription: "Long text", video: "" };
const JA: PlayListing = { language: "ja-JP", title: "Raft JP", shortDescription: "短い", fullDescription: "長い" };

interface FixtureOptions {
  /** Google's error message for the commit (classified, never echoed). */
  commitError?: { status: number; message: string };
  commitNetworkError?: boolean;
  validateStatus?: number;
  /** Return a different listing from PUT than what was sent. */
  updateEchoes?: (sent: PlayListing) => unknown;
  defaultLanguage?: string;
}

function googleFixture(initial: PlayListing[], options: FixtureOptions = {}) {
  let nextEdit = 1;
  let live = new Map(initial.map((listing) => [listing.language, { ...listing }]));
  const edits = new Map<string, Map<string, PlayListing>>();
  const requests: Array<{ method: string; path: string; body: unknown }> = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? "GET";
    if (url.href === "https://oauth2.googleapis.com/token") {
      return Response.json({ access_token: "access-token", expires_in: 3600 });
    }
    const body = typeof init.body === "string" ? JSON.parse(init.body) : null;
    const path = url.pathname.replace(`/androidpublisher/v3/applications/${PACKAGE}/edits`, "") + url.search;
    requests.push({ method, path, body });
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer access-token");
    if (method === "POST" && path === "") {
      const id = `edit-${nextEdit++}`;
      edits.set(id, new Map([...live].map(([k, v]) => [k, { ...v }])));
      return Response.json({ id });
    }
    const match = /^\/([^/:?]+)(.*)$/.exec(url.pathname.replace(`/androidpublisher/v3/applications/${PACKAGE}/edits`, ""));
    const editId = decodeURIComponent(match?.[1] ?? "");
    const rest = match?.[2] ?? "";
    const edit = edits.get(editId);
    if (!edit) return Response.json({ error: { code: 404, message: "edit not found" } }, { status: 404 });
    if (method === "DELETE" && rest === "") {
      edits.delete(editId);
      return new Response(null, { status: 204 });
    }
    if (method === "GET" && rest === "/details") return Response.json({ defaultLanguage: options.defaultLanguage ?? "en-US", contactEmail: "x@example.com" });
    if (method === "GET" && rest === "/listings") {
      return Response.json(edit.size ? { kind: "androidpublisher#listingsListResponse", listings: [...edit.values()] } : {});
    }
    const listingPath = /^\/listings\/([^/]+)$/.exec(rest);
    if (listingPath && method === "PUT") {
      const language = decodeURIComponent(listingPath[1]!);
      edit.set(language, body);
      return Response.json(options.updateEchoes ? options.updateEchoes(body) : body);
    }
    if (listingPath && method === "DELETE") {
      edit.delete(decodeURIComponent(listingPath[1]!));
      return new Response(null, { status: 204 });
    }
    if (method === "POST" && url.pathname.endsWith(":validate")) {
      if (options.validateStatus) {
        return Response.json({ error: { code: options.validateStatus, message: `secret ${JSON.stringify(binding.credential)}`, errors: [{ reason: "badRequest" }] } }, { status: options.validateStatus });
      }
      return Response.json({ id: editId.replace(/:.*/, "") });
    }
    if (method === "POST" && url.pathname.endsWith(":commit")) {
      if (options.commitNetworkError) throw new TypeError("network");
      if (options.commitError) {
        return Response.json({ error: { code: options.commitError.status, message: options.commitError.message } }, { status: options.commitError.status });
      }
      live = new Map([...edit].map(([k, v]) => [k, { ...v }]));
      edits.delete(editId);
      return Response.json({ id: editId });
    }
    return Response.json({ error: { code: 400, message: "unexpected" } }, { status: 400 });
  });
  return { fetchImpl, requests, edits, live: () => live };
}

function push(overrides: Partial<StoreListingPushRpcInput> = {}): StoreListingPushRpcInput {
  return { ...binding, operationId: "op-1", mode: "dry_run", listings: [{ language: "en-US", title: "Raft 2" }], ...overrides };
}

// The fixture's edit path parser includes ":validate"/":commit" in the id segment.
function realEdits(edits: Map<string, unknown>) {
  return [...edits.keys()].filter((key) => !key.includes(":"));
}

describe("store listing plan", () => {
  it("merges absent fields from Play, marks unchanged, and requires full text for a new language", () => {
    const plan = planStoreListings([EN], [
      { language: "en-US", title: "Raft" },
      { language: "ja-JP", title: "Raft JP", shortDescription: "短い", fullDescription: "長い" },
    ], { deleteUnlistedLanguages: false, defaultLanguage: "en-US" });
    expect(plan.map((c) => [c.language, c.action, c.changed_fields])).toEqual([
      ["en-US", "unchanged", []],
      ["ja-JP", "create", ["title", "shortDescription", "fullDescription"]],
    ]);
    expect(() => planStoreListings([EN], [{ language: "ko-KR", title: "Raft" }], { deleteUnlistedLanguages: false, defaultLanguage: null }))
      .toThrow(/new language and needs shortDescription, fullDescription/);
  });

  it("deletes unlisted languages only when asked, and never the default language", () => {
    expect(planStoreListings([EN, JA], [{ language: "en-US", title: "X" }], { deleteUnlistedLanguages: false, defaultLanguage: "en-US" }))
      .toHaveLength(1);
    const plan = planStoreListings([EN, JA], [{ language: "en-US", title: "X" }], { deleteUnlistedLanguages: true, defaultLanguage: "en-US" });
    expect(plan.map((c) => [c.language, c.action])).toEqual([["en-US", "update"], ["ja-JP", "delete"]]);
    expect(() => planStoreListings([EN, JA], [JA], { deleteUnlistedLanguages: true, defaultLanguage: "en-US" }))
      .toThrow(/default language/);
  });
});

describe("Google Play store listing RPC", () => {
  it("reads listings and the default language in a throwaway edit", async () => {
    const google = googleFixture([JA, EN]);
    const result = await createPlayAdapterService({ fetchImpl: google.fetchImpl }).readStoreListings(binding, env);
    expect(result).toEqual({ ok: true, value: { package_name: PACKAGE, default_language: "en-US", listings: [EN, JA] } });
    expect(realEdits(google.edits)).toEqual([]);
  });

  it("dry run applies edits.listings.update, validates, deletes the edit, and changes nothing live", async () => {
    const google = googleFixture([EN]);
    const result = await createPlayAdapterService({ fetchImpl: google.fetchImpl }).pushStoreListings(push(), env);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toMatchObject({ edit_id: "edit-1", mode: "dry_run", outcome: "validated", default_language: "en-US" });
    expect(result.value.changes).toEqual([{
      language: "en-US", action: "update", changed_fields: ["title"],
      before: EN, after: { ...EN, title: "Raft 2" },
    }]);
    expect(google.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      "POST ", "GET /edit-1/details", "GET /edit-1/listings", "PUT /edit-1/listings/en-US",
      "POST /edit-1:validate", "DELETE /edit-1",
    ]);
    // The full merged resource is PUT, so fields Hands was not given are preserved.
    expect(google.requests[3]!.body).toEqual({ ...EN, title: "Raft 2" });
    expect(google.live().get("en-US")).toEqual(EN);
  });

  it("commit uses ERROR_IF_IN_REVIEW and reads the committed listing back from a new edit", async () => {
    const google = googleFixture([EN]);
    const result = await createPlayAdapterService({ fetchImpl: google.fetchImpl }).pushStoreListings(push({ mode: "commit" }), env);
    expect(result).toMatchObject({ ok: true, value: { outcome: "committed", edit_id: "edit-1", changes_not_sent_for_review: false } });
    const commit = google.requests.find((r) => r.path.includes(":commit"))!;
    expect(commit.path).toBe("/edit-1:commit?changesInReviewBehavior=ERROR_IF_IN_REVIEW");
    expect(google.live().get("en-US")?.title).toBe("Raft 2");
    expect(google.requests.slice(-4).map((r) => `${r.method} ${r.path}`)).toEqual([
      "POST ", "GET /edit-2/details", "GET /edit-2/listings", "DELETE /edit-2",
    ]);
  });

  it("sends changesNotSentForReview only when the caller opts in", async () => {
    const google = googleFixture([EN]);
    await createPlayAdapterService({ fetchImpl: google.fetchImpl })
      .pushStoreListings(push({ mode: "commit", changesNotSentForReview: true }), env);
    expect(google.requests.find((r) => r.path.includes(":commit"))!.path)
      .toBe("/edit-1:commit?changesInReviewBehavior=ERROR_IF_IN_REVIEW&changesNotSentForReview=true");
  });

  it("surfaces EDIT_IN_REVIEW as play_edit_in_review and deletes the still-valid edit", async () => {
    const google = googleFixture([EN], { commitError: { status: 400, message: "Changes are currently in review and ERROR_IF_IN_REVIEW was set" } });
    const result = await createPlayAdapterService({ fetchImpl: google.fetchImpl }).pushStoreListings(push({ mode: "commit" }), env);
    expect(result).toMatchObject({ ok: false, error: { status: 409, code: "play_edit_in_review", cause: { stage: "commit_edit", provider_cause: "EDIT_IN_REVIEW" } } });
    expect(JSON.stringify(result)).not.toContain("currently in review");
    expect(realEdits(google.edits)).toEqual([]);
    expect(google.live().get("en-US")).toEqual(EN);
  });

  it("names the changesNotSentForReview remedy when Google requires it", async () => {
    const google = googleFixture([EN], { commitError: { status: 400, message: "Changes cannot be sent for review automatically. Please set the query parameter changesNotSentForReview to true." } });
    const result = await createPlayAdapterService({ fetchImpl: google.fetchImpl }).pushStoreListings(push({ mode: "commit" }), env);
    expect(result).toMatchObject({ ok: false, error: { status: 409, code: "play_changes_not_sent_for_review" } });
  });

  it("does not delete the edit when the commit got no answer", async () => {
    const google = googleFixture([EN], { commitNetworkError: true });
    const result = await createPlayAdapterService({ fetchImpl: google.fetchImpl }).pushStoreListings(push({ mode: "commit" }), env);
    expect(result).toMatchObject({ ok: false, error: { code: "play_commit_ambiguous" } });
    expect(google.requests.filter((r) => r.method === "DELETE")).toEqual([]);
  });

  it("fails closed on a validate rejection, deletes the edit, and keeps Google's text out", async () => {
    const google = googleFixture([EN], { validateStatus: 400 });
    const result = await createPlayAdapterService({ fetchImpl: google.fetchImpl }).pushStoreListings(push({ mode: "commit" }), env);
    expect(result).toMatchObject({ ok: false, error: { code: "play_api_rejected", cause: { stage: "validate_edit" } } });
    expect(JSON.stringify(result)).not.toContain("BEGIN PRIVATE KEY");
    expect(google.requests.some((r) => r.path.includes(":commit"))).toBe(false);
    expect(realEdits(google.edits)).toEqual([]);
  });

  it("fails closed when Google's update response does not echo the listing", async () => {
    const google = googleFixture([EN], { updateEchoes: (sent) => ({ ...(sent as PlayListing), title: "other" }) });
    const result = await createPlayAdapterService({ fetchImpl: google.fetchImpl }).pushStoreListings(push(), env);
    expect(result).toMatchObject({ ok: false, error: { code: "play_listing_readback_mismatch" } });
    expect(google.requests.some((r) => r.path.includes(":validate"))).toBe(false);
  });

  it("reports no_changes without validating or committing", async () => {
    const google = googleFixture([EN]);
    const result = await createPlayAdapterService({ fetchImpl: google.fetchImpl })
      .pushStoreListings(push({ mode: "commit", listings: [{ language: "en-US", title: "Raft" }] }), env);
    expect(result).toMatchObject({ ok: true, value: { outcome: "no_changes" } });
    expect(google.requests.map((r) => `${r.method} ${r.path}`)).toEqual(["POST ", "GET /edit-1/details", "GET /edit-1/listings", "DELETE /edit-1"]);
  });

  it("deletes an unlisted language only with deleteUnlistedLanguages", async () => {
    const google = googleFixture([EN, JA]);
    const result = await createPlayAdapterService({ fetchImpl: google.fetchImpl })
      .pushStoreListings(push({ mode: "commit", listings: [EN], deleteUnlistedLanguages: true }), env);
    expect(result).toMatchObject({ ok: true, value: { outcome: "committed" } });
    expect(google.requests.map((r) => `${r.method} ${r.path}`)).toContain("DELETE /edit-1/listings/ja-JP");
    expect([...google.live().keys()]).toEqual(["en-US"]);
  });

  it("rejects over-limit, empty, unknown and duplicate input before OAuth", async () => {
    const google = googleFixture([EN]);
    const service = createPlayAdapterService({ fetchImpl: google.fetchImpl });
    const cases: Array<[unknown, string]> = [
      [[{ language: "en-US", title: "x".repeat(31) }], "listing_field_too_long"],
      [[{ language: "en-US", shortDescription: "😀".repeat(81) }], "listing_field_too_long"],
      [[{ language: "en-US", fullDescription: " " }], "listing_field_empty"],
      [[{ language: "en-US", subtitle: "x" }], "listing_field_unknown"],
      [[{ language: "en-US", title: "a" }, { language: "en-us", title: "b" }], "listing_language_invalid"],
      [[{ language: "en-US" }], "listing_field_missing"],
      [[], "listing_request_invalid"],
    ];
    for (const [listings, code] of cases) {
      const result = await service.pushStoreListings(push({ listings: listings as PlayListing[] }), env);
      expect(result, code).toMatchObject({ ok: false, error: { status: 400, code } });
    }
    // 30 full-width characters is within the title limit (code points, not bytes).
    expect(await service.pushStoreListings(push({ listings: [{ language: "en-US", title: "筏".repeat(30) }] }), env))
      .toMatchObject({ ok: true });
    expect(google.fetchImpl.mock.calls.filter(([url]) => String(url).includes("oauth2"))).toHaveLength(1);
  });
});
