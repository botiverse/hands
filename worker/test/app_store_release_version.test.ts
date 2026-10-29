import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installAscFake, makeContext, realCreds, type AscCall } from "./asc_fake";

let cachedCreds: any = null;
vi.mock("../src/lib/asc_credentials", () => ({
  getAscCredentials: async () => (cachedCreds ??= await realCreds()),
}));
vi.mock("../src/lib/asc_api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/asc_api")>()),
  resolveAscAppId: async () => "asc-app-1",
}));

const { handleReleaseAppStoreVersion, RELEASE_POLL } = await import("../src/routes/app_store_release");

/**
 * Releasing is irreversible: the cases that matter are the refusals (wrong
 * version, wrong build, wrong state, no mode) and never claiming "released"
 * before Apple shows it.
 */
type V = { id: string; versionString: string; appVersionState?: string | undefined; appStoreState?: string | undefined; build?: string | null };

function versionResource(v: V) {
  return {
    type: "appStoreVersions",
    id: v.id,
    attributes: {
      versionString: v.versionString,
      platform: "IOS",
      releaseType: "MANUAL",
      ...(v.appVersionState ? { appVersionState: v.appVersionState } : {}),
      ...(v.appStoreState ? { appStoreState: v.appStoreState } : {}),
    },
    relationships: { build: { data: v.build ? { type: "builds", id: v.build } : null } },
  };
}

/**
 * `afterRelease` is the state Apple shows on each read-back after the POST, in
 * order (the last one repeats). `onPost` sees the request when it arrives.
 */
function fakeApple(initial: V, opts: { afterRelease?: Array<Partial<V>>; onPost?: (call: AscCall) => void; postStatus?: number } = {}) {
  const version = { ...initial };
  let posted = false;
  let reads = 0;
  return installAscFake((call: AscCall) => {
    if (call.method === "GET" && call.path.startsWith("/v1/apps/asc-app-1/appStoreVersions?")) {
      return { json: { data: [versionResource(version)], links: {} } };
    }
    if (call.method === "GET" && call.path.startsWith(`/v1/appStoreVersions/${version.id}`)) {
      if (!posted) return { json: { data: versionResource(version) } };
      const seq = opts.afterRelease ?? [{ appVersionState: "READY_FOR_DISTRIBUTION", appStoreState: "READY_FOR_SALE" }];
      const next = seq[Math.min(reads++, seq.length - 1)]!;
      return { json: { data: versionResource({ ...version, ...next }) } };
    }
    if (call.method === "POST" && call.path === "/v1/appStoreVersionReleaseRequests") {
      opts.onPost?.(call);
      if (opts.postStatus) return { status: opts.postStatus, json: { errors: [{ title: "ENTITY_ERROR", detail: "cannot release" }] } };
      posted = true;
      return { status: 201, json: { data: { type: "appStoreVersionReleaseRequests", id: "rr-1" } } };
    }
    return undefined;
  });
}

const PENDING: V = { id: "ver-117", versionString: "1.17.0", appVersionState: "PENDING_DEVELOPER_RELEASE", appStoreState: "PENDING_DEVELOPER_RELEASE", build: "build-17" };

function ctx(body: unknown, first?: (sql: string, args: unknown[]) => unknown) {
  return makeContext({ body, params: { versionId: "ver-117" }, ...(first ? { first } : {}) });
}

async function release(body: unknown, first?: (sql: string, args: unknown[]) => unknown) {
  const { c, audits, statements } = ctx(body, first);
  const res = await handleReleaseAppStoreVersion(c);
  return { res, json: (await res.json()) as any, audits, statements };
}

beforeEach(() => { RELEASE_POLL.intervalMs = 0; RELEASE_POLL.timeoutMs = 50; });
afterEach(() => vi.unstubAllGlobals());

describe("release an approved App Store version", () => {
  it("PENDING_DEVELOPER_RELEASE -> POST release request -> read back READY_FOR_SALE -> released", async () => {
    // Intent rows must exist before Apple sees the POST: snapshot them at that moment.
    const { c, audits, statements } = ctx({ mode: "commit", version_string: "1.17.0", asc_build_id: "build-17" });
    let atPost: { audits: string[]; ops: number } | null = null;
    const asc = fakeApple(PENDING, {
      onPost: () => {
        atPost = {
          audits: audits.map((a) => a.action),
          ops: statements.filter((s) => /INSERT INTO operation_logs/i.test(s.sql)).length,
        };
      },
    });
    const res = await handleReleaseAppStoreVersion(c);
    const json = (await res.json()) as any;
    expect(res.status).toBe(200);
    expect(json).toMatchObject({ mode: "commit", outcome: "released", released: true, release_request_id: "rr-1", observed_state: "READY_FOR_DISTRIBUTION", version_string: "1.17.0" });
    expect(asc.writes().map((w) => `${w.method} ${w.path}`)).toEqual(["POST /v1/appStoreVersionReleaseRequests"]);
    expect(asc.writes()[0]!.body).toEqual({
      data: {
        type: "appStoreVersionReleaseRequests",
        relationships: { appStoreVersion: { data: { type: "appStoreVersions", id: "ver-117" } } },
      },
    });
    expect(atPost).toEqual({ audits: ["app_store.release_intent"], ops: 1 });
    expect(audits.map((a) => a.action)).toEqual(["app_store.release_intent", "app_store.release"]);
    expect(audits[0]!.payload).toMatchObject({ version_id: "ver-117", version_string: "1.17.0", asc_build_id: "build-17", state: "PENDING_DEVELOPER_RELEASE" });
    expect(audits[1]!.payload).toMatchObject({ outcome: "released", observed_state: "READY_FOR_DISTRIBUTION", operation_id: json.operation_id });
    const opInsert = statements.find((s) => /INSERT INTO operation_logs/i.test(s.sql))!;
    expect(opInsert.args[2]).toBe("app-store-release");
    expect(JSON.parse(String(opInsert.args[7]))).toMatchObject({ asc_version_id: "ver-117", version_string: "1.17.0" });
  });

  it("accepts the legacy READY_FOR_SALE when appVersionState is absent", async () => {
    fakeApple(PENDING, { afterRelease: [{ appVersionState: undefined, appStoreState: "READY_FOR_SALE" }] });
    const { res, json } = await release({ mode: "commit", version_string: "1.17.0" });
    expect(res.status).toBe(200);
    expect(json).toMatchObject({ outcome: "released", observed_state: "READY_FOR_SALE" });
  });

  it("still pending after the poll -> 202 release_requested, never released", async () => {
    const asc = fakeApple(PENDING, { afterRelease: [{}] });
    const { res, json, audits } = await release({ mode: "commit", version_string: "1.17.0" });
    expect(res.status).toBe(202);
    expect(json).toMatchObject({ outcome: "release_requested", released: false, observed_state: "PENDING_DEVELOPER_RELEASE" });
    expect(json.next_action).toContain("asynchronously");
    // Polled more than once, POSTed once.
    expect(asc.calls.filter((c) => c.method === "GET" && c.path.startsWith("/v1/appStoreVersions/ver-117")).length).toBeGreaterThan(1);
    expect(asc.writes()).toHaveLength(1);
    expect(audits.at(-1)!.payload.outcome).toBe("release_requested");
  });

  it("PROCESSING_FOR_DISTRIBUTION after the poll is release_requested too", async () => {
    fakeApple(PENDING, { afterRelease: [{ appVersionState: "PROCESSING_FOR_DISTRIBUTION", appStoreState: "PROCESSING_FOR_APP_STORE" }] });
    const { res, json } = await release({ mode: "commit", version_string: "1.17.0" });
    expect(res.status).toBe(202);
    expect(json).toMatchObject({ outcome: "release_requested", released: false, observed_state: "PROCESSING_FOR_DISTRIBUTION" });
  });

  it("already released -> 409 ALREADY_RELEASED and no POST", async () => {
    const asc = fakeApple({ ...PENDING, appVersionState: "READY_FOR_DISTRIBUTION", appStoreState: "READY_FOR_SALE" });
    const { res, json, audits } = await release({ mode: "commit", version_string: "1.17.0" });
    expect(res.status).toBe(409);
    expect(json.code).toBe("ALREADY_RELEASED");
    expect(json.released).toBeUndefined();
    expect(asc.writes()).toEqual([]);
    expect(audits).toEqual([]);
  });

  it.each(["PREPARE_FOR_SUBMISSION", "WAITING_FOR_REVIEW", "IN_REVIEW", "PROCESSING_FOR_DISTRIBUTION", "SOMETHING_NEW"])(
    "%s -> 409 NOT_RELEASABLE with the state and no POST",
    async (state) => {
      const asc = fakeApple({ ...PENDING, appVersionState: state, appStoreState: undefined });
      const { res, json } = await release({ mode: "commit", version_string: "1.17.0" });
      expect(res.status).toBe(409);
      expect(json).toMatchObject({ code: "NOT_RELEASABLE", state });
      expect(asc.writes()).toEqual([]);
    },
  );

  it("version_string mismatch -> 409 and no POST", async () => {
    const asc = fakeApple(PENDING);
    const { res, json, audits } = await release({ mode: "commit", version_string: "1.16.0" });
    expect(res.status).toBe(409);
    expect(json).toMatchObject({ code: "RELEASE_CONFIRMATION_MISMATCH", mismatches: ["version_string"] });
    expect(json.current.version_string).toBe("1.17.0");
    expect(asc.writes()).toEqual([]);
    expect(audits).toEqual([]);
  });

  it("build mismatch -> 409 and no POST", async () => {
    const asc = fakeApple(PENDING);
    const { res, json } = await release({ mode: "commit", version_string: "1.17.0", asc_build_id: "build-16" });
    expect(res.status).toBe(409);
    expect(json).toMatchObject({ code: "RELEASE_CONFIRMATION_MISMATCH", mismatches: ["build_id"] });
    expect(asc.writes()).toEqual([]);
  });

  it("dry_run reads only and returns the plan", async () => {
    const asc = fakeApple(PENDING);
    const { res, json, audits, statements } = await release({ mode: "dry_run", version_string: "1.17.0", asc_build_id: "build-17" });
    expect(res.status).toBe(200);
    expect(json).toMatchObject({ mode: "dry_run", outcome: "planned", released: false, writes: [] });
    expect(json.request).toMatchObject({ method: "POST", path: "/v1/appStoreVersionReleaseRequests" });
    expect(asc.calls.length).toBeGreaterThan(0);
    expect(asc.writes()).toEqual([]);
    expect(audits).toEqual([]);
    expect(statements).toEqual([]);
  });

  it.each([[{ version_string: "1.17.0" }, "MODE_REQUIRED"], [{ version_string: "1.17.0", mode: "yes" }, "INVALID_MODE"], [{ mode: "commit" }, "VERSION_STRING_REQUIRED"]])(
    "rejects %j with %s before calling Apple",
    async (body, code) => {
      const asc = fakeApple(PENDING);
      const { res, json } = await release(body);
      expect(res.status).toBe(400);
      expect(json.code).toBe(code);
      expect(asc.calls).toEqual([]);
    },
  );

  it("a version of another app is 404 and nothing is sent", async () => {
    const asc = fakeApple({ ...PENDING, id: "ver-other" });
    const { res, json } = await release({ mode: "commit", version_string: "1.17.0" });
    expect(res.status).toBe(404);
    expect(json.code).toBe("VERSION_NOT_IN_APP");
    expect(asc.writes()).toEqual([]);
  });

  it("a second call after an accepted request does not POST again (Apple still shows pending)", async () => {
    const asc = fakeApple(PENDING);
    const { res, json } = await release({ mode: "commit", version_string: "1.17.0" }, (sql) =>
      /FROM operation_logs/i.test(sql) ? { id: "op-prior", status: "success", created_at: Date.now(), post_confirmed: 1 } : null);
    expect(res.status).toBe(202);
    expect(json).toMatchObject({ outcome: "release_requested", released: false, prior_operation_id: "op-prior", observed_state: "PENDING_DEVELOPER_RELEASE" });
    expect(asc.writes()).toEqual([]);
  });

  it("a concurrent release still in progress -> 409 RELEASE_IN_PROGRESS, no POST", async () => {
    const asc = fakeApple(PENDING);
    const { res, json } = await release({ mode: "commit", version_string: "1.17.0" }, (sql) =>
      /FROM operation_logs/i.test(sql) ? { id: "op-running", status: "in_progress", created_at: Date.now(), post_confirmed: 0 } : null);
    expect(res.status).toBe(409);
    expect(json).toMatchObject({ code: "RELEASE_IN_PROGRESS", prior_operation_id: "op-running" });
    expect(asc.writes()).toEqual([]);
  });

  it("Apple refusing the POST is a 502 with the operation id, recorded as failed", async () => {
    fakeApple(PENDING, { postStatus: 409 });
    const { res, json, audits, statements } = await release({ mode: "commit", version_string: "1.17.0" });
    expect(res.status).toBe(502);
    expect(json).toMatchObject({ code: "ASC_API_REJECTED", release_requested: false, provider_cause: "cannot release" });
    expect(typeof json.operation_id).toBe("string");
    expect(audits.map((a) => a.action)).toEqual(["app_store.release_intent", "app_store.release_failed"]);
    const last = statements.filter((s) => /UPDATE operation_logs/i.test(s.sql)).at(-1)!;
    expect(last.args).toContain("failed");
  });
});
