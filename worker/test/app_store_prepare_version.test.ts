import { afterEach, describe, expect, it, vi } from "vitest";
import { installAscFake, makeContext, realCreds, type AscCall } from "./asc_fake";

let cachedCreds: any = null;
vi.mock("../src/lib/asc_credentials", () => ({
  getAscCredentials: async () => (cachedCreds ??= await realCreds()),
}));
vi.mock("../src/lib/asc_api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/asc_api")>()),
  resolveAscAppId: async () => "asc-app-1",
}));

const { handlePrepareAppStoreVersion, planPrepare, classifyVersionState } = await import("../src/routes/app_store_release");

/**
 * The 2026-10 raft-ios situation: 1.12.0 was withdrawn (DEVELOPER_REJECTED, never
 * released) and a POST for 1.17.0 failed with Apple's 409 "You cannot create a new
 * version of the App in the current state", because Apple allows one unreleased
 * version per platform. Prepare must move 1.12.0 to 1.17.0 instead of creating.
 */
type V = { id: string; versionString: string; appVersionState?: string; appStoreState?: string; build?: string | null; omitBuild?: boolean };

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
    ...(v.omitBuild ? {} : { relationships: { build: { data: v.build ? { type: "builds", id: v.build } : null } } }),
  };
}

function fakeApple(initial: V[], opts: {
  readback?: (v: V) => V;
  failAttach?: boolean;
  builds?: string[];
} = {}) {
  const versions = initial.map((v) => ({ ...v }));
  return installAscFake((call: AscCall) => {
    if (call.method === "GET" && call.path.startsWith("/v1/builds?")) {
      return { json: { data: (opts.builds ?? ["build-17"]).map((id) => ({ type: "builds", id })) } };
    }
    if (call.method === "GET" && call.path.startsWith("/v1/apps/asc-app-1/appStoreVersions?")) {
      return { json: { data: versions.map(versionResource), links: {} } };
    }
    const one = call.path.match(/^\/v1\/appStoreVersions\/([^/?]+)(\?.*)?$/);
    if (one && call.method === "GET") {
      const v = versions.find((x) => x.id === one[1]);
      if (!v) return { status: 404, json: { errors: [{ title: "not found" }] } };
      return { json: { data: versionResource(opts.readback ? opts.readback(v) : v) } };
    }
    if (one && call.method === "PATCH") {
      const v = versions.find((x) => x.id === one[1])!;
      const build = call.body?.data?.relationships?.build?.data?.id;
      if (build && opts.failAttach) return { status: 409, json: { errors: [{ title: "ENTITY_ERROR", detail: "build cannot be attached" }] } };
      if (call.body?.data?.attributes?.versionString) v.versionString = call.body.data.attributes.versionString;
      if (build) v.build = build;
      return { json: { data: versionResource(v) } };
    }
    if (call.method === "POST" && call.path === "/v1/appStoreVersions") {
      const created: V = { id: "ver-new", versionString: call.body.data.attributes.versionString, appVersionState: "PREPARE_FOR_SUBMISSION", build: null };
      versions.push(created);
      return { status: 201, json: { data: versionResource(created) } };
    }
    return undefined;
  });
}

const prepare = async (body: Record<string, unknown>) => {
  const { c, audits } = makeContext({ body });
  const res = await handlePrepareAppStoreVersion(c);
  return { res, json: (await res.json()) as any, audits };
};

afterEach(() => vi.unstubAllGlobals());

describe("prepare renames the one editable, never-released version", () => {
  it("renames withdrawn 1.12.0 to 1.17.0 and attaches the build in one PATCH, then reads it back", async () => {
    const asc = fakeApple([
      { id: "ver-112", versionString: "1.12.0", appVersionState: "DEVELOPER_REJECTED", appStoreState: "DEVELOPER_REJECTED", build: "build-12" },
      { id: "ver-111", versionString: "1.11.0", appVersionState: "READY_FOR_DISTRIBUTION", appStoreState: "READY_FOR_SALE", build: "build-11" },
    ]);
    const { res, json, audits } = await prepare({ version_string: "1.17.0", asc_build_id: "build-17" });
    expect(res.status).toBe(200);
    expect(json).toMatchObject({
      action: "renamed",
      version_id: "ver-112",
      version_string: "1.17.0",
      previous_version_string: "1.12.0",
      build_attached: true,
      build_id: "build-17",
      reused: true,
    });
    // No POST: creating would hit Apple's one-unreleased-version rule.
    expect(asc.writes().map((w) => `${w.method} ${w.path}`)).toEqual(["PATCH /v1/appStoreVersions/ver-112"]);
    expect(asc.writes()[0]!.body.data).toEqual({
      type: "appStoreVersions",
      id: "ver-112",
      attributes: { versionString: "1.17.0" },
      relationships: { build: { data: { type: "builds", id: "build-17" } } },
    });
    // Both the decision and the read-back asked for the build relationship explicitly.
    const list = asc.calls.find((c) => c.path.startsWith("/v1/apps/asc-app-1/appStoreVersions?"))!;
    expect(list.path).toContain("include=build");
    expect(list.path).toContain("filter[platform]=IOS");
    const readback = asc.calls.filter((c) => c.method === "GET" && c.path.startsWith("/v1/appStoreVersions/ver-112"));
    expect(readback.map((c) => c.path)).toEqual(["/v1/appStoreVersions/ver-112?include=build"]);
    expect(audits).toHaveLength(1);
    expect(audits[0]!.action).toBe("app_store.prepare_version");
    expect(audits[0]!.payload).toMatchObject({ action: "renamed", previous_version_string: "1.12.0", outcome: "ok" });
  });

  it("refuses with 409 when another version is WAITING_FOR_REVIEW, names it, and writes nothing", async () => {
    const asc = fakeApple([
      { id: "ver-112", versionString: "1.12.0", appVersionState: "WAITING_FOR_REVIEW", appStoreState: "WAITING_FOR_REVIEW" },
    ]);
    const { res, json } = await prepare({ version_string: "1.17.0", asc_build_id: "build-17" });
    expect(res.status).toBe(409);
    expect(json).toMatchObject({ code: "VERSION_IN_FLIGHT", version_id: "ver-112", version_string: "1.12.0", state: "WAITING_FOR_REVIEW" });
    expect(json.next_action).toContain("withdraw");
    expect(json.next_action).toContain("ver-112");
    expect(asc.writes()).toEqual([]);
  });

  it("refuses to rename a version approved and pending developer release", async () => {
    const asc = fakeApple([{ id: "ver-112", versionString: "1.12.0", appVersionState: "PENDING_DEVELOPER_RELEASE" }]);
    const { res, json } = await prepare({ version_string: "1.17.0" });
    expect(res.status).toBe(409);
    expect(json.code).toBe("VERSION_IN_FLIGHT");
    expect(json.next_action).toContain("release it");
    expect(asc.writes()).toEqual([]);
  });

  it("dry_run returns the rename plan and makes no non-GET call", async () => {
    const asc = fakeApple([{ id: "ver-112", versionString: "1.12.0", appVersionState: "DEVELOPER_REJECTED", build: "build-12" }]);
    const { res, json, audits } = await prepare({ version_string: "1.17.0", asc_build_id: "build-17", mode: "dry_run" });
    expect(res.status).toBe(200);
    expect(json).toMatchObject({ mode: "dry_run", action: "renamed", version_id: "ver-112", previous_version_string: "1.12.0", current_build_id: "build-12", writes: [] });
    expect(asc.writes()).toEqual([]);
    expect(audits).toEqual([]);
  });

  it("fails closed when the read-back version string does not match", async () => {
    fakeApple(
      [{ id: "ver-112", versionString: "1.12.0", appVersionState: "DEVELOPER_REJECTED" }],
      { readback: (v) => ({ ...v, versionString: "1.12.0" }) },
    );
    const { res, json, audits } = await prepare({ version_string: "1.17.0", asc_build_id: "build-17" });
    expect(res.status).toBe(502);
    expect(json.code).toBe("READBACK_MISMATCH");
    expect(json.mismatches).toContain("version_string");
    expect(json.build_attached).toBeUndefined();
    expect(audits[0]!.payload.outcome).toBe("readback_mismatch");
  });

  it("fails closed when Apple does not return the build relationship on read-back (not asked != none)", async () => {
    fakeApple(
      [{ id: "ver-112", versionString: "1.12.0", appVersionState: "DEVELOPER_REJECTED" }],
      { readback: (v) => ({ ...v, omitBuild: true }) },
    );
    const { res, json } = await prepare({ version_string: "1.17.0", asc_build_id: "build-17" });
    expect(res.status).toBe(502);
    expect(json.mismatches).toEqual(["build_relationship_not_returned"]);
  });

  it("creates when every other version is released, and attaches the build", async () => {
    const asc = fakeApple([{ id: "ver-111", versionString: "1.11.0", appVersionState: "READY_FOR_DISTRIBUTION" }]);
    const { res, json } = await prepare({ version_string: "1.17.0", asc_build_id: "build-17" });
    expect(res.status).toBe(200);
    expect(json).toMatchObject({ action: "created", version_id: "ver-new", build_attached: true, reused: false });
    expect(json.previous_version_string).toBeUndefined();
    expect(asc.writes().map((w) => `${w.method} ${w.path}`)).toEqual([
      "POST /v1/appStoreVersions",
      "PATCH /v1/appStoreVersions/ver-new",
    ]);
  });

  it("reuses a version that already has the requested string", async () => {
    const asc = fakeApple([{ id: "ver-117", versionString: "1.17.0", appVersionState: "PREPARE_FOR_SUBMISSION" }]);
    const { json } = await prepare({ version_string: "1.17.0", asc_build_id: "build-17" });
    expect(json).toMatchObject({ action: "reused", version_id: "ver-117", build_attached: true });
    expect(asc.writes().map((w) => w.body.data.attributes)).toEqual([undefined]);
  });

  it("checks build ownership before any write", async () => {
    const asc = fakeApple([{ id: "ver-112", versionString: "1.12.0", appVersionState: "DEVELOPER_REJECTED" }], { builds: ["other"] });
    const { res, json } = await prepare({ version_string: "1.17.0", asc_build_id: "build-17" });
    expect(res.status).toBe(404);
    expect(json.code).toBe("ASC_BUILD_NOT_IN_APP");
    expect(asc.writes()).toEqual([]);
  });

  it("reports exactly what was written when a later step fails", async () => {
    fakeApple([], { failAttach: true });
    const { res, json, audits } = await prepare({ version_string: "1.17.0", asc_build_id: "build-17" });
    expect(res.status).toBe(502);
    expect(json).toMatchObject({ code: "PREPARE_PARTIALLY_APPLIED", action: "created", version_id: "ver-new", completed_steps: ["create_version"] });
    expect(audits[0]!.payload.outcome).toBe("partial_failure");
  });

  it("refuses when a version is in a state Hands does not recognise", async () => {
    const asc = fakeApple([{ id: "ver-x", versionString: "1.12.0", appVersionState: "SOMETHING_NEW" }]);
    const { res, json } = await prepare({ version_string: "1.17.0" });
    expect(res.status).toBe(409);
    expect(json.code).toBe("VERSION_STATE_UNKNOWN");
    expect(asc.writes()).toEqual([]);
  });

  it("rejects an invalid mode before calling Apple", async () => {
    const asc = fakeApple([]);
    const { res, json } = await prepare({ version_string: "1.17.0", mode: "maybe" });
    expect(res.status).toBe(400);
    expect(json.code).toBe("INVALID_MODE");
    expect(asc.calls).toEqual([]);
  });
});

describe("planPrepare", () => {
  const v = (id: string, versionString: string, state: string) => ({
    id, versionString, state, appVersionState: state, appStoreState: null, platform: "IOS", releaseType: "MANUAL",
    buildId: null, buildRelationshipReturned: true,
  });

  it("refuses to pick when two editable versions exist", () => {
    const plan = planPrepare([v("a", "1.12.0", "DEVELOPER_REJECTED"), v("b", "1.13.0", "PREPARE_FOR_SUBMISSION")], "1.17.0");
    expect("status" in plan && plan.body.code).toBe("MULTIPLE_EDITABLE_VERSIONS");
  });

  it("refuses to reuse an already-released version string", () => {
    const plan = planPrepare([v("a", "1.17.0", "READY_FOR_DISTRIBUTION")], "1.17.0");
    expect("status" in plan && plan.body.code).toBe("VERSION_NOT_EDITABLE");
  });

  it("treats INVALID_BINARY as editable (the fix is a different build)", () => {
    expect(classifyVersionState({ appVersionState: "INVALID_BINARY", appStoreState: null })).toBe("editable");
    expect(planPrepare([v("a", "1.12.0", "INVALID_BINARY")], "1.17.0")).toMatchObject({ action: "renamed" });
  });

  it("prefers appVersionState over the deprecated appStoreState", () => {
    expect(classifyVersionState({ appVersionState: "READY_FOR_DISTRIBUTION", appStoreState: "NOT_APPLICABLE" })).toBe("released");
  });
});
