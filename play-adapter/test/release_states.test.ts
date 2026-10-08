import { describe, expect, it, vi } from "vitest";
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
  it("queries the live track without creating, changing, or committing an edit", async () => {
    const f = fixture({ releases: [row] });
    expect(await f.client.listReleaseStates("build.raft.app", track)).toEqual([row]);
    expect(f.requests).toEqual([{ url: "https://androidpublisher.googleapis.com/androidpublisher/v3/applications/build.raft.app/tracks/closed.alpha/releases", method: "GET", body: undefined }]);
  });
  it("preserves unknown future lifecycle states and accepts an empty collection", async () => {
    expect(await fixture({ releases: [{ ...row, releaseLifecycleState: "FUTURE_STATE" }] }).client.listReleaseStates("build.raft.app", track)).toEqual([{ ...row, releaseLifecycleState: "FUTURE_STATE" }]);
    expect(await fixture({}).client.listReleaseStates("build.raft.app", track)).toEqual([]);
  });
  it.each([
    { releases: [{ ...row, track: "production" }] },
    { releases: [{ ...row, activeArtifacts: [{ versionCode: "11300005" }] }] },
    { releases: [{ ...row, activeArtifacts: [{ versionCode: 0 }] }] },
    { releases: [{ ...row, releaseLifecycleState: null }] },
    { releases: {} },
    { releases: Array.from({ length: 21 }, () => row) },
  ])("rejects malformed or mismatched provider data", async response => {
    await expect(fixture(response).client.listReleaseStates("build.raft.app", track)).rejects.toMatchObject({ code: "play_releases_malformed" });
  });
  it("keeps provider permission errors as failures, not approval or an empty release", async () => {
    await expect(fixture({ error: { message: "permission denied" } }, 403).client.listReleaseStates("build.raft.app", track)).rejects.toMatchObject({ code: "play_api_rejected" });
  });
});
