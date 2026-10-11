/**
 * AppGallery invitation-test status sync: after submit Hands must keep reading
 * the Huawei test version, a failed compile must end the submission, and the
 * submit route must not silently pick a test group when several exist.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { assessAgcTestVersionStatus, getAgcTestVersionStatus, mapAgcTestReleaseState } from "../src/lib/agc_api";

const auth = { accessToken: "token-1" };
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

describe("getAgcTestVersionStatus", () => {
  it("reads the test lane with the version id and stays read-only", async () => {
    const fetchMock = vi.fn(async () => json({
      ret: { code: 0 },
      appInfo: { releaseState: 4 },
      auditInfo: { auditOpinion: "" },
      openTestInfo: { startTime: 1, endTime: 2 },
    }));
    const status = await getAgcTestVersionStatus(auth, "app-1", "ver-9", fetchMock as unknown as typeof fetch);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://connect-api.cloud.huawei.com/api/publish/v3/app-info?appId=app-1&releaseType=6&versionId=ver-9");
    expect(init.method ?? "GET").toBe("GET");
    expect(status).toEqual({
      release_state: 4, audit_opinion: null, open_test_info: { start_time: 1, end_time: 2 },
      version_number: null, version_id: null, app_id: null, release_type: null, update_time: null, identity_keys: [],
    });
  });

  it("captures the version identity Huawei echoes, names only for unknown version keys", async () => {
    const fetchMock = vi.fn(async () => json({
      ret: { code: 0 },
      appInfo: { releaseState: 0, versionNumber: "1.13.0", versionId: "v", appId: "a", releaseType: "6", updateTime: "2026-10-11 02:30:00", someVersionCode: 10100001 },
    }));
    const status = await getAgcTestVersionStatus(auth, "a", "v", fetchMock as unknown as typeof fetch);
    expect(status.version_number).toBe("1.13.0");
    expect(status.version_id).toBe("v");
    expect(status.app_id).toBe("a");
    expect(status.release_type).toBe(6);
    expect(status.update_time).toBe("2026-10-11 02:30:00");
    expect(status.identity_keys).toEqual(["someVersionCode", "versionId", "versionNumber"]);
  });

  it("reports an absent state as null rather than 0", async () => {
    const fetchMock = vi.fn(async () => json({ ret: { code: 0 }, appInfo: {} }));
    expect((await getAgcTestVersionStatus(auth, "a", "v", fetchMock as unknown as typeof fetch)).release_state).toBeNull();
  });
});

describe("public-test route error mapping", () => {
  it("does not return HTTP success for a provider business error reported in HTTP 200", async () => {
    const { agcRouteErrorStatus } = await import("../src/routes/agc_testing");
    const { AgcApiError } = await import("../src/lib/agc_api");
    expect(agcRouteErrorStatus(new AgcApiError(200, "provider rejected"))).toBe(502);
    expect(agcRouteErrorStatus(new AgcApiError(429, "rate limited"))).toBe(429);
  });
});

describe("mapAgcTestReleaseState", () => {
  it("maps every documented releaseType=6 value", () => {
    expect(mapAgcTestReleaseState(0)).toBe("testing_active");
    expect(mapAgcTestReleaseState(1)).toBe("rejected");
    expect(mapAgcTestReleaseState(13)).toBe("rejected");
    expect(mapAgcTestReleaseState(2)).toBe("stopped");
    expect(mapAgcTestReleaseState(10)).toBe("stopped");
    expect(mapAgcTestReleaseState(3)).toBe("testing_scheduled");
    expect(mapAgcTestReleaseState(4)).toBe("testing_review");
    expect(mapAgcTestReleaseState(12)).toBe("testing_review");
    expect(mapAgcTestReleaseState(7)).toBe("ready");
    expect(mapAgcTestReleaseState(11)).toBe("ready");
  });
  it("does not guess unknown values", () => {
    expect(mapAgcTestReleaseState(99)).toBeNull();
    expect(mapAgcTestReleaseState(null)).toBeNull();
  });
});

describe("assessAgcTestVersionStatus (fail-closed identity guard)", () => {
  const reading = (over: Partial<Awaited<ReturnType<typeof getAgcTestVersionStatus>>>) => ({
    release_state: 0, audit_opinion: null, open_test_info: null,
    version_number: null, version_id: null, app_id: null, release_type: null, update_time: null, identity_keys: [], ...over,
  });
  const expected = { version_name: "1.13.0", version_id: "ver-1", app_id: "agc-app" };

  it("production case: releaseState 0 with a listing-review opinion and no version identity does not open the test", () => {
    // API said 0 / "应用上架审核通过" while the console still showed the test under review.
    const out = assessAgcTestVersionStatus(reading({ audit_opinion: "应用上架审核通过" }), expected);
    expect(out.next).toBeNull();
    expect(out.identity_status).toBe("unconfirmed");
    expect(out.identity_reasons).toEqual(["no_version_identity_in_response", "listing_review_opinion_in_test_lane"]);
  });

  it("moves only when the response names the expected version in the test lane", () => {
    const out = assessAgcTestVersionStatus(reading({ version_number: "1.13.0", release_type: 6 }), expected);
    expect(out).toEqual({ next: "testing_active", identity_status: "confirmed", identity_reasons: [] });
  });

  it("an echoed versionId that matches the queried one confirms on its own; one that differs rejects even with a matching version number", () => {
    expect(assessAgcTestVersionStatus(reading({ version_id: "ver-1" }), expected)).toEqual({ next: "testing_active", identity_status: "confirmed", identity_reasons: [] });
    expect(assessAgcTestVersionStatus(reading({ version_id: "ver-2", version_number: "1.13.0" }), expected).identity_reasons).toEqual(["version_id_mismatch"]);
    expect(assessAgcTestVersionStatus(reading({ version_id: "ver-1", app_id: "other-app" }), expected).identity_reasons).toEqual(["app_id_mismatch"]);
  });

  it("a matching versionId does not excuse a conflicting version number", () => {
    const out = assessAgcTestVersionStatus(reading({ version_id: "ver-1", version_number: "1.12.0" }), expected);
    expect(out.next).toBeNull();
    expect(out.identity_reasons).toEqual(["version_mismatch"]);
  });

  it("a version mismatch or a non-test releaseType keeps the state", () => {
    expect(assessAgcTestVersionStatus(reading({ version_number: "1.12.0" }), expected).identity_reasons).toEqual(["version_mismatch"]);
    expect(assessAgcTestVersionStatus(reading({ version_number: "1.13.0", release_type: 1 }), expected).identity_reasons)
      .toEqual(["response_release_type_not_test_lane"]);
    expect(assessAgcTestVersionStatus(reading({ version_number: "1.13.0" }), { ...expected, version_name: null }).identity_reasons).toEqual(["no_expected_version_on_build"]);
  });

  it("rejections are held to the same identity bar", () => {
    const out = assessAgcTestVersionStatus(reading({ release_state: 1 }), expected);
    expect(out.next).toBeNull();
    expect(mapAgcTestReleaseState(1)).toBe("rejected");
  });
});

// ---- route-level behaviour with a tiny in-memory D1 stand-in ----

type Row = Record<string, unknown>;
function fakeDb(submission: Row) {
  const events: Row[] = [];
  const updates: Array<{ sql: string; args: unknown[] }> = [];
  const stmt = (sql: string) => ({
    args: [] as unknown[],
    bind(...args: unknown[]) { this.args = args; return this; },
    async first() {
      if (sql.includes("FROM market_submissions")) return { ...submission };
      if (sql.includes("FROM builds")) return { version_name: "1.13.0", version_code: 10100001 };
      return null;
    },
    async all() { return { results: events }; },
    async run() { apply(sql, this.args); return {}; },
  });
  function apply(sql: string, args: unknown[]) {
    updates.push({ sql, args });
    if (sql.startsWith("UPDATE market_submissions SET state=?1")) {
      submission.state = args[0]; submission.provider_state_json = args[1]; submission.error_message = args[2]; submission.updated_at = args[3];
    } else if (sql.startsWith("UPDATE market_submissions SET state='failed'")) {
      submission.state = "failed"; submission.provider_state_json = args[0]; submission.error_message = args[1];
    } else if (sql.startsWith("UPDATE market_submissions SET provider_state_json")) {
      submission.provider_state_json = args[0];
    } else if (sql.startsWith("INSERT INTO market_submission_events")) {
      events.push({ sql, args });
    }
  }
  const db = {
    prepare: (sql: string) => stmt(sql),
    async batch(list: Array<ReturnType<typeof stmt>>) { for (const s of list) await s.run(); return list.map(() => ({meta:{changes:1}})); },
  };
  return { db, events, updates, submission };
}

function ctx(db: unknown, params: Record<string, string>, body: unknown = {}) {
  return {
    env: { DB: db, AGC_CRED_ENC_KEY: "k" },
    req: { param: (n: string) => params[n] ?? "", json: async () => body },
    json: (b: unknown, status = 200) => new Response(JSON.stringify(b), { status }),
    get: (key: string) => (key === "user" ? { id: "u-1", email: "t@example.com" } : undefined),
  } as never;
}

async function loadRoutes(fetchBodies: unknown[]) {
  vi.resetModules();
  vi.doMock("../src/lib/agc_credentials", async (orig) => ({
    ...(await orig<typeof import("../src/lib/agc_credentials")>()),
    getAgcCredentials: async () => ({ type: "api_client", client_id: "c", client_secret: "s" }),
    agcCredentialKind: () => "api_client",
  }));
  vi.doMock("../src/lib/permissions", () => ({ insertAuditLog: async () => {} }));
  const calls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input); calls.push(url);
    if (url.includes("/oauth2/")) return json({ access_token: "t", expires_in: 3600 });
    return json(fetchBodies.shift());
  }));
  const routes = await import("../src/routes/agc_testing");
  return { routes, calls };
}

const base = {
  id: "sub-1", app_id: "app-1", build_id: "b-1", external_app_id: "agc-app",
  external_version_id: "ver-1", external_package_id: "pkg-1", error_message: null,
  created_at: 1, updated_at: 1,
};

afterEach(() => { vi.unstubAllGlobals(); vi.doUnmock("../src/lib/agc_credentials"); vi.doUnmock("../src/lib/permissions"); });

describe("handleGetAgcSubmission sync", () => {
  it("moves testing_review to testing_active when Huawei approves", async () => {
    const { routes, calls } = await loadRoutes([{ ret: { code: 0 }, appInfo: { releaseState: 0, versionNumber: "1.13.0" } }]);
    const f = fakeDb({ ...base, state: "testing_review", provider_state_json: JSON.stringify({ submitted: true, group_ids: ["g1"] }) });
    const res = await routes.handleGetAgcSubmission(ctx(f.db, { appId: "app-1", submissionId: "sub-1" }));
    const body = await res.json() as { submission: { state: string; provider_state: Row } };
    expect(calls.some((u) => u.includes("releaseType=6") && u.includes("versionId=ver-1"))).toBe(true);
    expect(body.submission.state).toBe("testing_active");
    expect(body.submission.provider_state).toMatchObject({ group_ids: ["g1"], release_state: 0, version_number: "1.13.0", identity_status: "confirmed" });
    expect(f.events).toHaveLength(1);
  });

  it("keeps testing_review when Huawei answers 0 without naming the version (production case)", async () => {
    const { routes } = await loadRoutes([{ ret: { code: 0 }, appInfo: { releaseState: 0 }, auditInfo: { auditOpinion: "应用上架审核通过" } }]);
    const f = fakeDb({ ...base, state: "testing_review", provider_state_json: JSON.stringify({ submitted: true }) });
    const body = await (await routes.handleGetAgcSubmission(ctx(f.db, { appId: "app-1", submissionId: "sub-1" }))).json() as { submission: { state: string; provider_state: Row } };
    expect(body.submission.state).toBe("testing_review");
    expect(f.events).toHaveLength(0);
    expect(body.submission.provider_state).toMatchObject({
      submitted: true, release_state: 0, audit_opinion: "应用上架审核通过", identity_status: "unconfirmed",
      identity_reasons: ["no_version_identity_in_response", "listing_review_opinion_in_test_lane"],
    });
  });

  it("records the audit opinion on rejection", async () => {
    const { routes } = await loadRoutes([{ ret: { code: 0 }, appInfo: { releaseState: 1, versionNumber: "1.13.0" }, auditInfo: { auditOpinion: "图标不合规" } }]);
    const f = fakeDb({ ...base, state: "testing_review", provider_state_json: "{}" });
    const body = await (await routes.handleGetAgcSubmission(ctx(f.db, { appId: "app-1", submissionId: "sub-1" }))).json() as { submission: { state: string; provider_state: Row } };
    expect(body.submission.state).toBe("rejected");
    expect(body.submission.provider_state.audit_opinion).toBe("图标不合规");
  });

  it("writes no event when the state is unchanged", async () => {
    const { routes } = await loadRoutes([{ ret: { code: 0 }, appInfo: { releaseState: 4 } }]);
    const f = fakeDb({ ...base, state: "testing_review", provider_state_json: "{}" });
    const body = await (await routes.handleGetAgcSubmission(ctx(f.db, { appId: "app-1", submissionId: "sub-1" }))).json() as { submission: { state: string } };
    expect(body.submission.state).toBe("testing_review");
    expect(f.events).toHaveLength(0);
  });

  it("keeps the stored submission and reports sync_error when Huawei fails", async () => {
    const { routes } = await loadRoutes([{ ret: { code: 204144647, msg: "version not exist" } }]);
    const f = fakeDb({ ...base, state: "testing_review", provider_state_json: "{}" });
    const res = await routes.handleGetAgcSubmission(ctx(f.db, { appId: "app-1", submissionId: "sub-1" }));
    expect(res.status).toBe(200);
    const body = await res.json() as { submission: { state: string }; sync_error: string };
    expect(body.submission.state).toBe("testing_review");
    expect(body.sync_error).toContain("version not exist");
  });

  it("fails a processing submission when the package compile fails", async () => {
    const { routes } = await loadRoutes([{ ret: { code: 0 }, pkgStateList: [{ pkgId: "pkg-1", successStatus: 2 }] }]);
    const f = fakeDb({ ...base, state: "processing", provider_state_json: "{}" });
    const body = await (await routes.handleGetAgcSubmission(ctx(f.db, { appId: "app-1", submissionId: "sub-1" }))).json() as { submission: { state: string; error_message: string } };
    expect(body.submission.state).toBe("failed");
    expect(body.submission.error_message).toMatch(/could not compile/);
  });

  it("leaves a still-parsing package in processing", async () => {
    const { routes } = await loadRoutes([{ ret: { code: 0 }, pkgStateList: [{ pkgId: "pkg-1", successStatus: 1 }] }]);
    const f = fakeDb({ ...base, state: "processing", provider_state_json: "{}" });
    const body = await (await routes.handleGetAgcSubmission(ctx(f.db, { appId: "app-1", submissionId: "sub-1" }))).json() as { submission: { state: string } };
    expect(body.submission.state).toBe("processing");
  });
});

describe("handleSubmitAgcInvitationTest group selection", () => {
  it("refuses to guess when several groups exist and none was given", async () => {
    const { routes, calls } = await loadRoutes([{ rtnCode: 0, groups: [{ groupId: "g1", groupName: "Botiverse" }, { groupId: "g2", groupName: "Insiders" }] }]);
    const f = fakeDb({ ...base, state: "ready", provider_state_json: "{}" });
    const res = await routes.handleSubmitAgcInvitationTest(ctx(f.db, { appId: "app-1", submissionId: "sub-1" }, {}));
    expect(res.status).toBe(400);
    const body = await res.json() as { groups: Row[] };
    expect(body.groups).toEqual([{ group_id: "g1", group_name: "Botiverse" }, { group_id: "g2", group_name: "Insiders" }]);
    expect(calls.some((u) => u.includes("/version/submit"))).toBe(false);
    expect(f.submission.state).toBe("ready");
  });

  it("defaults to the only group when exactly one exists", async () => {
    const { routes } = await loadRoutes([
      { rtnCode: 0, groups: [{ groupId: "g1", groupName: "Botiverse" }] },
      { ret: { code: 0 } }, { ret: { code: 0 } },
    ]);
    const f = fakeDb({ ...base, state: "ready", provider_state_json: "{}" });
    const body = await (await routes.handleSubmitAgcInvitationTest(ctx(f.db, { appId: "app-1", submissionId: "sub-1" }, {}))).json() as { group_ids: string[] };
    expect(body.group_ids).toEqual(["g1"]);
  });
});

describe("handleStartAgcInvitationTest retry", () => {
  it("returns the existing submission while it is still in review", async () => {
    vi.resetModules();
    vi.doMock("../src/lib/permissions", () => ({ insertAuditLog: async () => {} }));
    const routes = await import("../src/routes/agc_testing");
    const existing = { ...base, state: "testing_review", provider_state_json: "{}" };
    const db = {
      prepare: (sql: string) => ({
        bind() { return this; },
        async first() { return sql.includes("build_assets") ? { r2_key: "k", file_hash: "h", size_bytes: 1, filetype: "app" } : existing; },
        async run() { throw new Error(`unexpected write: ${sql}`); },
      }),
    };
    const res = await routes.handleStartAgcInvitationTest(ctx(db, { appId: "app-1", buildId: "b-1" }, { package_name: "build.raft.mobile" }));
    expect(((await res.json()) as { submission: { id: string } }).submission.id).toBe("sub-1");
  });

  it.each(["failed", "rejected", "stopped"])("supersedes a %s submission without deleting its history", async (state) => {
    vi.resetModules();
    vi.doMock("../src/lib/permissions", () => ({ insertAuditLog: async () => {} }));
    const routes = await import("../src/routes/agc_testing");
    const writes: string[] = [];
    const db = {
      prepare: (sql: string) => ({
        bind() { return this; },
        async first() { return sql.includes("build_assets") ? { r2_key: "k", file_hash: "h", size_bytes: 1, filetype: "app" } : { ...base, state, provider_state_json: "{}" }; },
        async run() { writes.push(sql); return {}; },
      }),
    };
    Object.assign(db, { batch: async (list: Array<{ run(): Promise<unknown> }>) => {
      for (const stmt of list) await stmt.run();
      return list.map(() => ({ meta: { changes: 1 } }));
    } });
    // No AGC credentials → the new attempt fails fast after claiming the key.
    await routes.handleStartAgcInvitationTest(ctx(db, { appId: "app-1", buildId: "b-1" }, { package_name: "build.raft.mobile" }));
    expect(writes.some((w) => w.startsWith("DELETE"))).toBe(false);
    expect(writes[0]).toMatch(/^UPDATE market_submissions SET idempotency_key=/);
    expect(writes[1]).toMatch(/^INSERT INTO market_submissions/);
  });
});
