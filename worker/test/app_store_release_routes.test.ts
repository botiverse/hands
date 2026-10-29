import { describe, expect, it, vi } from "vitest";
import {
  handleSubmitAppStoreVersion,
  handlePrepareAppStoreVersion,
  handleSetAppStoreReleaseNotes,
  handleWithdrawAppStoreVersion,
} from "../src/routes/app_store_release";

/**
 * These assert the guards, not the happy path. Submitting is the one action with an
 * external, hard-to-undo effect, so the cases that matter are the ones where it must
 * REFUSE.
 */
async function makeContext(body: unknown, opts: { submissions?: Array<{ id: string; state: string }> } = {}) {
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
      }),
    }),
  };
  return {
    env: { DB: db, ASC_CRED_ENC_KEY: "k" },
    req: {
      param: (name: string) => (name === "appId" ? appId : name === "versionId" ? "ver-1" : ""),
      query: () => undefined,
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
        return new Response(JSON.stringify({ data: [{ relationships: { appStoreVersionForReview: { data: { id: "ver-old" } } } }] }));
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

  it("refuses to reuse a version Apple is holding, so an in-review 1.12 cannot be modified", async () => {
    // Reusing a version that is waiting for / in review would attach a different build
    // to a submission under Apple's consideration -- one mis-call corrupts it.
    vi.stubGlobal("fetch", vi.fn(async (url: unknown) => {
      const u = String(url);
      if (u.includes("/appStoreVersions?")) {
        return new Response(JSON.stringify({ data: [{
          id: "ver-112",
          attributes: { versionString: "1.12", appStoreState: "WAITING_FOR_REVIEW", platform: "IOS" },
        }] }));
      }
      // Any write would be a bug; fail loudly if one happens.
      throw new Error(`unexpected write to ${u}`);
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
