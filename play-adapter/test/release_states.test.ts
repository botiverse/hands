import { afterEach, describe, expect, it, vi } from "vitest";
import { GooglePlayClient } from "../src/google_play";

const track = "closed.alpha";
const row = { releaseName: "1.13", track, activeArtifacts: [{ versionCode: 11300005 }],
  releaseLifecycleState: "RELEASE_LIFECYCLE_STATE_IN_REVIEW" };
function fixture(response: unknown, status = 200) {
  const requests: Array<{ url: string; method: string; body: unknown }> = [];
  const fetchImpl = vi.fn(async (url: RequestInfo | URL, init: RequestInit = {}) => {
    requests.push({ url: String(url), method: init.method ?? "GET", body: init.body });
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer test-token");
    return Response.json(response, { status });
  });
  return { requests, client: new GooglePlayClient("test-token", fetchImpl as typeof fetch, 1024) };
}
describe("read-only Google release lifecycle", () => {
  afterEach(() => vi.restoreAllMocks());
  it("queries the live track without creating, changing, or committing an edit", async () => {
    const f = fixture({ releases: [row] });
    expect(await f.client.listReleaseStates("build.raft.app", track)).toEqual([row]);
    expect(f.requests).toEqual([{ url: "https://androidpublisher.googleapis.com/androidpublisher/v3/applications/build.raft.app/tracks/closed.alpha/releases", method: "GET", body: undefined }]);
  });
  it("preserves unknown future lifecycle states and accepts an empty collection", async () => {
    expect(await fixture({ releases: [{ ...row, releaseLifecycleState: "FUTURE_STATE" }] }).client.listReleaseStates("build.raft.app", track)).toEqual([{ ...row, releaseLifecycleState: "FUTURE_STATE" }]);
    expect(await fixture({}).client.listReleaseStates("build.raft.app", track)).toEqual([]);
  });
  it("normalizes omitted ProtoJSON defaults without losing other release versions", async () => {
    const omitted = { track, releaseLifecycleState: "RELEASE_LIFECYCLE_STATE_DRAFT" };
    expect(await fixture({ releases: [omitted, row] }).client.listReleaseStates("build.raft.app", track))
      .toEqual([{ ...omitted, releaseName: "", activeArtifacts: [] }, row]);
    const unnamed = { track, activeArtifacts: row.activeArtifacts, releaseLifecycleState: row.releaseLifecycleState };
    expect(await fixture({ releases: [unnamed] }).client.listReleaseStates("build.raft.app", track))
      .toEqual([{ ...unnamed, releaseName: "" }]);
  });
  it.each(["", "null", '"private-response"'])("keeps non-object responses as failures with safe parsing flags", async body => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const client = new GooglePlayClient("private-access-token", vi.fn(async () => new Response(body)) as typeof fetch, 1024);
    await expect(client.listReleaseStates("build.raft.app", track)).rejects.toMatchObject({ code: "play_api_malformed" });
    expect(warn).toHaveBeenCalledWith("hands_play_response_shape", JSON.stringify({ stage: "list_release_states",
      status: 200, jsonObject: false, bodyEmpty: body === "", jsonParsed: body !== "" }));
    expect(JSON.stringify(warn.mock.calls)).not.toContain("private-");
  });
  it.each([
    { releases: [{ ...row, track: "production" }] },
    { releases: [{ ...row, activeArtifacts: [{ versionCode: "11300005" }] }] },
    { releases: [{ ...row, activeArtifacts: [{ versionCode: 0 }] }] },
    { releases: [{ ...row, releaseLifecycleState: null }] },
    { releases: [{ ...row, releaseName: null }] },
    { releases: [{ ...row, activeArtifacts: null }] },
    { releases: {} },
    { releases: Array.from({ length: 21 }, () => row) },
  ])("rejects malformed or mismatched provider data", async response => {
    await expect(fixture(response).client.listReleaseStates("build.raft.app", track)).rejects.toMatchObject({ code: "play_releases_malformed" });
  });
  it("diagnoses malformed rows with fixed flags without disclosing provider data", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const response = { releases: [{ ...row, track: "private-track", releaseName: "private-name",
      releaseLifecycleState: "private-state", activeArtifacts: [{ versionCode: "private-version" }] }] };
    await expect(fixture(response).client.listReleaseStates("build.raft.app", track)).rejects.toMatchObject({ code: "play_releases_malformed" });
    expect(warn).toHaveBeenCalledWith("hands_play_release_shape", JSON.stringify({ rowObject: true,
      trackMatches: false, nameString: true, namePresent: true, stateString: true, artifactsArray: true, artifactsPresent: true, artifactVersionsValid: false }));
    expect(JSON.stringify(warn.mock.calls)).not.toContain("private-");
  });
  it("diagnoses invalid JSON without logging the response", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchImpl = vi.fn(async () => new Response("private-response", { status: 200 }));
    const client = new GooglePlayClient("private-access-token", fetchImpl as typeof fetch, 1024);
    await expect(client.listReleaseStates("build.raft.app", track)).rejects.toMatchObject({ code: "play_api_malformed" });
    expect(warn).toHaveBeenCalledWith("hands_play_response_shape", JSON.stringify({ stage: "list_release_states", status: 200, jsonObject: false, bodyEmpty: false, jsonParsed: false }));
    expect(JSON.stringify(warn.mock.calls)).not.toContain("private-");
  });
  it("keeps provider permission errors as failures, not approval or an empty release", async () => {
    await expect(fixture({ error: { message: "permission denied" } }, 403).client.listReleaseStates("build.raft.app", track)).rejects.toMatchObject({ code: "play_api_rejected" });
  });
});
