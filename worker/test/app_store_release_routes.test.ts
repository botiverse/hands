import { describe, expect, it, vi } from "vitest";
import {
  handleSubmitAppStoreVersion,
  handlePrepareAppStoreVersion,
  handleSetAppStoreReleaseNotes,
  handleWithdrawAppStoreVersion,
  handleGetAppStoreReleaseStatus,
} from "../src/routes/app_store_release";

/**
 * These assert the guards, not the happy path. Submitting is the one action with an
 * external, hard-to-undo effect, so the cases that matter are the ones where it must
 * REFUSE.
 */
async function makeContext(body: unknown, opts: { query?: Record<string, string> } = {}) {
  const appId = "app-1";
  // Answer per statement instead of returning one object for every query: a blanket
  // stub makes a query against a column that does not exist look fine (that is how
  // `SELECT bundle_id, asc_app_id FROM apps` stayed green while failing in production).
  const db = {
    prepare: (sql: string) => ({
      bind: () => ({
        first: async () => {
          // `asc_app_id` is not a column anywhere; the route resolves it from Apple.
          // These guard tests do not exercise that lookup, so the app row carries a
          // pre-resolved id and the channel row carries the bundle id.
          if (/SELECT id FROM apps/i.test(sql)) return { id: appId };
          if (/FROM channels/i.test(sql)) return { bundle_id: "build.raft.app" };
          return {};
        },
        // The audit row written after a successful submit.
        run: async () => ({ meta: { changes: 1 } }),
      }),
    }),
  };
  return {
    env: { DB: db, ASC_CRED_ENC_KEY: "k" },
    req: {
      param: (name: string) => (name === "appId" ? appId : name === "versionId" ? "ver-1" : ""),
      query: (name: string) => opts.query?.[name],
      json: async () => body,
    },
    get: () => "test:publisher",
    json: (data: unknown, status = 200) => new Response(JSON.stringify(data), { status }),
  } as any;
}

// A real P-256 key: ascRequest signs a JWT before every call, so a placeholder PEM
// fails before the guard under test is ever reached.
async function realCreds() {
  const pair = (await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"],
  )) as CryptoKeyPair;
  const pkcs8 = new Uint8Array((await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer);
  let bin = "";
  for (const b of pkcs8) bin += String.fromCharCode(b);
  return { key_id: "TESTKEY123", issuer_id: "issuer-uuid-1234",
    p8: `-----BEGIN PRIVATE KEY-----\n${btoa(bin)}\n-----END PRIVATE KEY-----` };
}
let cachedCreds: any = null;
vi.mock("../src/lib/asc_credentials", () => ({
  getAscCredentials: async () => (cachedCreds ??= await realCreds()),
}));
// The route resolves the ASC app id from Apple via the main channel's bundle id.
// Stubbing that resolution here keeps these guard tests about the guards; the DB
// stub used to return a fake `asc_app_id` column to skip it, which is exactly the
// kind of fiction that let a query against a non-existent column stay green.
vi.mock("../src/lib/asc_api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/asc_api")>()),
  resolveAscAppId: async () => "asc-app-1",
}));

describe("App Store submission guards", () => {
  it("refuses to submit while another submission is pending, and names it", async () => {
    // Without this guard the caller gets an opaque App Store Connect rejection and has
    // to guess that a pending submission is the reason.
    vi.stubGlobal("fetch", vi.fn(async (url: unknown) => {
      const u = String(url);
      // The version-binding check runs first now, so the mock must serve the app's
      // version list before the submission lookup is reached.
      if (u.includes("/appStoreVersions?")) {
        return new Response(JSON.stringify({ data: [{ id: "ver-1", attributes: { versionString: "1.15.2" } }] }));
      }
      if (u.includes("/reviewSubmissions?")) {
        return new Response(JSON.stringify({ data: [{ id: "sub-9", attributes: { state: "WAITING_FOR_REVIEW" } }] }));
      }
      if (u.includes("/reviewSubmissions/sub-9/items")) {
        return new Response(JSON.stringify({ data: [{ relationships: { appStoreVersion: { data: { id: "ver-old" } } } }] }));
      }
      return new Response(JSON.stringify({ data: {} }));
    }));
    const res = await handleSubmitAppStoreVersion(await makeContext({}));
    expect(res.status).toBe(409);
    const body = (await res.json()) as any;
    expect(body.code).toBe("REVIEW_ALREADY_PENDING");
    expect(body.submission_id).toBe("sub-9");
    expect(body.version_id).toBe("ver-old");
  });

  it("reuses an open READY_FOR_REVIEW draft left by an earlier failed attempt", async () => {
    // A failed attempt can leave the draft created in step 1 behind; the retry must
    // put the version into that draft rather than open a second one.
    const writes: Array<{ url: string; method: string; body: any }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: unknown, init?: RequestInit) => {
      const u = String(url); const method = init?.method ?? "GET";
      if (method !== "GET") writes.push({ url: u, method, body: init?.body ? JSON.parse(String(init.body)) : null });
      if (u.includes("/appStoreVersions?")) {
        return new Response(JSON.stringify({ data: [{ id: "ver-1", attributes: { versionString: "1.17.0", platform: "IOS" } }] }));
      }
      if (u.includes("/reviewSubmissions?")) {
        return new Response(JSON.stringify({ data: [{ id: "sub-draft", attributes: { state: "READY_FOR_REVIEW", platform: "IOS" } }] }));
      }
      return new Response(JSON.stringify({ data: {} }));
    }));
    const res = await handleSubmitAppStoreVersion(await makeContext({}));
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body).toMatchObject({ submission_id: "sub-draft", submitted: true, reused_draft: true });
    expect(writes.some((w) => w.method === "POST" && w.url.endsWith("/v1/reviewSubmissions"))).toBe(false);
    expect(writes[0]!.body.data.relationships.reviewSubmission.data.id).toBe("sub-draft");
  });

  it("refuses to reuse a version Apple is holding, so an in-review 1.12 cannot be modified", async () => {
    // Reusing a version that is waiting for / in review would attach a different build
    // to a submission under Apple's consideration -- one mis-call corrupts it.
    vi.stubGlobal("fetch", vi.fn(async (url: unknown, init?: RequestInit) => {
      const u = String(url);
      // Any write would be a bug; fail loudly if one happens.
      if ((init?.method ?? "GET") !== "GET") throw new Error(`unexpected write to ${u}`);
      if (u.includes("/appStoreVersions?")) {
        return new Response(JSON.stringify({ data: [{
          id: "ver-112",
          attributes: { versionString: "1.12", appStoreState: "WAITING_FOR_REVIEW", platform: "IOS" },
        }] }));
      }
      // The build-ownership read now runs before any decision, so no write can
      // precede it; it is a read and is served.
      if (u.includes("/v1/builds?")) return new Response(JSON.stringify({ data: [{ id: "build-x" }] }));
      throw new Error(`unexpected request to ${u}`);
    }));
    const res = await handlePrepareAppStoreVersion(
      await makeContext({ version_string: "1.12", asc_build_id: "build-x" }),
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as any;
    expect(body.code).toBe("VERSION_NOT_EDITABLE");
    expect(body.state).toBe("WAITING_FOR_REVIEW");
  });

  it("refuses a version already approved and awaiting release", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({ data: [{
        id: "ver-112",
        attributes: { versionString: "1.12", appStoreState: "PENDING_DEVELOPER_RELEASE", platform: "IOS" },
      }] }))));
    const res = await handlePrepareAppStoreVersion(await makeContext({ version_string: "1.12" }));
    expect(res.status).toBe(409);
    const body = (await res.json()) as any;
    expect(body.code).toBe("VERSION_NOT_EDITABLE");
    expect(body.next_action).toContain("approved and waiting to be released");
  });

  it("refuses a version id belonging to another app, with no write", async () => {
    // ASC team keys are not app-scoped, so without this a publisher of app A can
    // rewrite app B's release notes by passing B's version id.
    vi.stubGlobal("fetch", vi.fn(async (url: unknown, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("/appStoreVersions?")) {
        return new Response(JSON.stringify({ data: [{ id: "ver-mine", attributes: { versionString: "1.15.2" } }] }));
      }
      if ((init?.method ?? "GET") !== "GET") throw new Error(`unexpected write to ${u}`);
      return new Response(JSON.stringify({ data: [] }));
    }));
    const res = await handleSetAppStoreReleaseNotes(
      await makeContext({ notes: { "en-US": "hijacked" } }),
    );
    expect(res.status).toBe(404);
    expect((await res.json() as any).code).toBe("VERSION_NOT_IN_APP");
  });

  function notesApple(locales: string[]) {
    const writes: Array<{ method: string; url: string; body: any }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: unknown, init?: RequestInit) => {
      const u = String(url); const method = init?.method ?? "GET";
      if (u.includes("/appStoreVersions?")) return new Response(JSON.stringify({ data: [{ id: "ver-1", attributes: { versionString: "1.17.0" } }] }));
      if (method !== "GET") {
        writes.push({ method, url: u, body: JSON.parse(String(init!.body)) });
        return new Response(JSON.stringify({ data: {} }));
      }
      if (u.includes("/appStoreVersionLocalizations")) {
        return new Response(JSON.stringify({ data: locales.map((locale) => ({ id: `loc-${locale}`, attributes: { locale } })) }));
      }
      return new Response(JSON.stringify({ data: [] }));
    }));
    return writes;
  }

  it("refuses What's New for a locale with no localization, writing nothing", async () => {
    // Creating it with only whatsNew leaves supportUrl unset and Apple refuses review.
    const writes = notesApple(["en-US"]);
    const res = await handleSetAppStoreReleaseNotes(await makeContext({ notes: { "en-US": "Bug fixes", ja: "不具合を修正" } }));
    expect(res.status).toBe(409);
    const body = (await res.json()) as any;
    expect(body).toMatchObject({ code: "LOCALIZATION_MISSING", locales: ["ja"] });
    expect(body.next_action).toContain("hands app-store localizations push");
    expect(writes).toEqual([]);
  });

  it("updates What's New on existing locales with a PATCH", async () => {
    const writes = notesApple(["en-US", "ja"]);
    const res = await handleSetAppStoreReleaseNotes(await makeContext({ notes: { "en-US": "Bug fixes", ja: "不具合を修正" } }));
    expect(res.status).toBe(200);
    expect(writes.map((w) => `${w.method} ${w.url.replace(/^https:\/\/[^/]+/, "")}`)).toEqual([
      "PATCH /v1/appStoreVersionLocalizations/loc-en-US",
      "PATCH /v1/appStoreVersionLocalizations/loc-ja",
    ]);
    expect(writes[1]!.body.data.attributes).toEqual({ whatsNew: "不具合を修正" });
  });

  it("refuses a submission id belonging to another app, with no write", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: unknown, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("/reviewSubmissions?")) {
        return new Response(JSON.stringify({ data: [{ id: "sub-mine", attributes: { state: "WAITING_FOR_REVIEW" } }] }));
      }
      if ((init?.method ?? "GET") !== "GET") throw new Error(`unexpected write to ${u}`);
      return new Response(JSON.stringify({ data: [] }));
    }));
    const res = await handleWithdrawAppStoreVersion(
      await makeContext({ submission_id: "sub-theirs" }),
    );
    expect(res.status).toBe(404);
    expect((await res.json() as any).code).toBe("SUBMISSION_NOT_IN_APP");
  });

  it("refuses to submit a version id belonging to another app", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: unknown, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("/appStoreVersions?")) return new Response(JSON.stringify({ data: [{ id: "ver-mine" }] }));
      if ((init?.method ?? "GET") !== "GET") throw new Error(`unexpected write to ${u}`);
      return new Response(JSON.stringify({ data: [] }));
    }));
    const res = await handleSubmitAppStoreVersion(await makeContext({}));
    expect(res.status).toBe(404);
    expect((await res.json() as any).code).toBe("VERSION_NOT_IN_APP");
  });

  it("rejects an invalid release_type instead of sending it to Apple", async () => {
    const res = await handlePrepareAppStoreVersion(
      await makeContext({ version_string: "1.15.2", release_type: "EVERYONE" }),
    );
    expect(res.status).toBe(400);
    expect((await res.json() as any).code).toBe("INVALID_RELEASE_TYPE");
  });
});

/**
 * A rejected submission (UNRESOLVED_ISSUES) stays open and Apple refuses a new one for
 * the platform until it is resubmitted or cancelled. `owner` is the version its item
 * holds; every non-GET is recorded.
 */
function stubUnresolved(owner: string | null, writes: Array<{ url: string; method: string; body: any }>) {
  vi.stubGlobal("fetch", vi.fn(async (url: unknown, init?: RequestInit) => {
    const u = String(url); const method = init?.method ?? "GET";
    if (method !== "GET") {
      writes.push({ url: u, method, body: init?.body ? JSON.parse(String(init.body)) : null });
      return new Response(JSON.stringify({ data: {} }));
    }
    if (u.includes("/appStoreVersions?")) {
      return new Response(JSON.stringify({ data: [{ id: "ver-1", attributes: { versionString: "1.17.0", platform: "IOS", appVersionState: "REJECTED" } }] }));
    }
    if (u.includes("/reviewSubmissions?")) {
      return new Response(JSON.stringify({ data: [
        { id: "sub-done", attributes: { state: "COMPLETE", platform: "IOS" } },
        { id: "sub-rej", attributes: { state: "UNRESOLVED_ISSUES", platform: "IOS" } },
      ] }));
    }
    if (u.includes("/reviewSubmissions/sub-rej/items")) {
      return new Response(JSON.stringify({ data: owner ? [{ relationships: { appStoreVersion: { data: { id: owner } } } }] : [] }));
    }
    return new Response(JSON.stringify({ data: [] }));
  }));
}

describe("App Store rejected (UNRESOLVED_ISSUES) submissions", () => {
  it("resubmits the rejected submission that holds this version, without a new submission or item", async () => {
    // The version is already an item of the open submission: creating a submission is
    // refused by Apple while it is open, and adding the item again fails.
    const writes: Array<{ url: string; method: string; body: any }> = [];
    stubUnresolved("ver-1", writes);
    const res = await handleSubmitAppStoreVersion(await makeContext({}));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ submission_id: "sub-rej", submitted: true, resubmitted: true });
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ method: "PATCH" });
    expect(writes[0]!.url).toMatch(/\/v1\/reviewSubmissions\/sub-rej$/);
    expect(writes[0]!.body.data.attributes).toEqual({ submitted: true });
  });

  it("refuses when the rejected submission holds another version, and writes nothing", async () => {
    const writes: Array<{ url: string; method: string; body: any }> = [];
    stubUnresolved("ver-old", writes);
    const res = await handleSubmitAppStoreVersion(await makeContext({}));
    expect(res.status).toBe(409);
    const body = (await res.json()) as any;
    expect(body).toMatchObject({ code: "UNRESOLVED_SUBMISSION_PENDING", submission_id: "sub-rej", submission_state: "UNRESOLVED_ISSUES", version_id: "ver-old" });
    expect(body.next_action).toContain("sub-rej");
    expect(writes).toEqual([]);
  });

  it("refuses when the rejected submission's version cannot be read, rather than resubmitting it", async () => {
    const writes: Array<{ url: string; method: string; body: any }> = [];
    stubUnresolved(null, writes);
    const res = await handleSubmitAppStoreVersion(await makeContext({}));
    expect(res.status).toBe(409);
    expect((await res.json() as any)).toMatchObject({ code: "UNRESOLVED_SUBMISSION_PENDING", version_id: null });
    expect(writes).toEqual([]);
  });

  it("withdraw by version cancels the rejected submission holding it", async () => {
    const writes: Array<{ url: string; method: string; body: any }> = [];
    stubUnresolved("ver-1", writes);
    const res = await handleWithdrawAppStoreVersion(await makeContext({ version_id: "ver-1" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ submission_id: "sub-rej", version_id: "ver-1", canceled: true });
    expect(writes).toHaveLength(1);
    expect(writes[0]!.url).toMatch(/\/v1\/reviewSubmissions\/sub-rej$/);
    expect(writes[0]!.body.data.attributes).toEqual({ canceled: true });
  });

  it("status reports the rejected submission as pending", async () => {
    const writes: Array<{ url: string; method: string; body: any }> = [];
    stubUnresolved("ver-1", writes);
    const res = await handleGetAppStoreReleaseStatus(await makeContext({}, { query: { version_string: "1.17.0" } }));
    expect(res.status).toBe(200);
    expect((await res.json() as any).pending_submission).toEqual({ id: "sub-rej", state: "UNRESOLVED_ISSUES" });
    expect(writes).toEqual([]);
  });
});

describe("App Store error body", () => {
  it("passes Apple's associated errors through to the caller", async () => {
    const { errorBody } = await import("../src/routes/app_store_release");
    const { AscApiError } = await import("../src/lib/asc_api");
    const { status, body } = errorBody(new AscApiError(409, "not in valid state", "check associated errors",
      [{ resource: "/v1/appScreenshotSets/s1", code: "ENTITY_ERROR.ATTRIBUTE.REQUIRED", detail: "screenshots required" }]));
    expect(status).toBe(502);
    expect(body.provider_associated_errors).toEqual([
      { resource: "/v1/appScreenshotSets/s1", code: "ENTITY_ERROR.ATTRIBUTE.REQUIRED", detail: "screenshots required" },
    ]);
    expect(errorBody(new AscApiError(409, "x")).body.provider_associated_errors).toBeUndefined();
  });

  it("passes Apple's code, source and further errors through, only when present", async () => {
    const { errorBody } = await import("../src/routes/app_store_release");
    const { AscApiError } = await import("../src/lib/asc_api");
    const error = new AscApiError(409, "A required attribute is missing.", "supportUrl required");
    error.code = "ENTITY_ERROR.ATTRIBUTE.REQUIRED";
    error.source = "/data/attributes/supportUrl";
    error.others = [{ code: "ENTITY_ERROR.ATTRIBUTE.REQUIRED", title: null, detail: "keywords required", source: "/data/attributes/keywords" }];
    expect(errorBody(error).body).toMatchObject({
      code: "ASC_API_REJECTED",
      provider_cause: "supportUrl required",
      provider_code: "ENTITY_ERROR.ATTRIBUTE.REQUIRED",
      provider_source: "/data/attributes/supportUrl",
      provider_errors: error.others,
    });
    const bare = errorBody(new AscApiError(409, "x")).body;
    expect(bare).not.toHaveProperty("provider_code");
    expect(bare).not.toHaveProperty("provider_source");
    expect(bare).not.toHaveProperty("provider_errors");
  });
});
