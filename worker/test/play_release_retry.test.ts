import { describe, expect, it, vi } from "vitest";
import { listReleaseStatesWithRetry } from "../src/lib/play_release_poll";

const input = { credential: {} as never, packageName: "build.raft.app", tracks: {} as never, handsTrack: "internal" as const };
const ok = { ok: true as const, value: [] };
const rejected = { ok: false as const, error: { code: "play_api_rejected", message: "403" } };

describe("release state read retry", () => {
  it("retries a permission refusal once and returns the second answer", async () => {
    const service = { listReleaseStates: vi.fn().mockResolvedValueOnce(rejected).mockResolvedValueOnce(ok) };
    expect(await listReleaseStatesWithRetry(service as never, input, 0)).toEqual(ok);
    expect(service.listReleaseStates).toHaveBeenCalledTimes(2);
  });
  it("does not retry success or other failures, and gives up after one retry", async () => {
    const other = { ok: false as const, error: { code: "play_token_rejected", message: "x" } };
    for (const first of [ok, other]) {
      const service = { listReleaseStates: vi.fn().mockResolvedValue(first) };
      expect(await listReleaseStatesWithRetry(service as never, input, 0)).toEqual(first);
      expect(service.listReleaseStates).toHaveBeenCalledTimes(1);
    }
    const service = { listReleaseStates: vi.fn().mockResolvedValue(rejected) };
    expect(await listReleaseStatesWithRetry(service as never, input, 0)).toEqual(rejected);
    expect(service.listReleaseStates).toHaveBeenCalledTimes(2);
  });
});
