import { describe, expect, it } from "vitest";

import { formatQuota } from "./quota.js";
import { formatPlayReviewStatus } from "./play.js";

const RESET = Date.UTC(2026, 10, 22, 14, 10);
const quota = {
  key: "google_play:tracks.releases.list", service: "google_play", operation: "tracks.releases.list",
  scope: "package", scope_key: "build.raft.app", limit: 12, used: 5,
  remaining: { gate: 7, interactive: 3, background: 0 }, reset_at: RESET, exhausted_until: null,
  source: "measured 2026-11-22",
};

describe("hands quota output", () => {
  it("prints one row per quota with what is left per caller and when it resets", () => {
    expect(formatQuota({ quotas: [quota] }).split("\n")).toEqual([
      "QUOTA                             SCOPE           USED  GATE  INTERACTIVE  BACKGROUND  RESETS",
      "google_play tracks.releases.list  build.raft.app  5/12  7     3            0           2026-11-22T14:10:00.000Z",
      "Remaining is per caller: gate (a write waiting on the read), interactive (a person or agent asked), background (the hourly poll).",
      "Limit source: measured 2026-11-22.",
    ]);
  });

  it("says when Google itself reported the quota used up", () => {
    const out = formatQuota({ quotas: [{ ...quota, used: 2, exhausted_until: RESET, remaining: { gate: 0, interactive: 0, background: 0 } }] });
    expect(out).toContain("google_play tracks.releases.list: Google said the quota is used up; Hands makes no calls until 2026-11-22T14:10:00.000Z.");
  });

  it("prints App Store Connect's quota as Apple reported it", () => {
    const asc = { key: "app_store_connect:api", service: "app_store_connect", operation: "api", scope: "api_key", scope_key: "KEY123",
      window: "rolling_hour" as const, limit: 3600, remaining: 1234, observed_at: RESET, exhausted_until: null, source: "reported by Apple (X-Rate-Limit)" };
    expect(formatQuota({ quotas: [asc] }).split("\n")).toEqual([
      "app_store_connect API key KEY123: 1234/3600 requests left in Apple's rolling hour (reported 2026-11-22T14:10:00.000Z).",
      "Limit source: reported by Apple (X-Rate-Limit).",
    ]);
    const stale = formatQuota({ quotas: [{ ...asc, limit: null, remaining: null, exhausted_until: RESET }] });
    expect(stale).toContain("app_store_connect API key KEY123: no report from Apple in the last hour (last 2026-11-22T14:10:00.000Z).");
    expect(stale).toContain("Apple refused for quota (429); only writes call it until 2026-11-22T14:10:00.000Z.");
  });

  it("explains an empty list", () => {
    expect(formatQuota({ quotas: [] })).toMatch(/^No rationed upstream calls apply to this app/);
  });
});

describe("play review-status quota note", () => {
  it("says whose budget refused the read and when it resets", () => {
    const out = formatPlayReviewStatus({
      package_name: "build.raft.app", read_at: 0,
      tracks: [
        { hands_track: "production", play_track: "production", source: "cached", read_at: RESET - 3_600_000, error_code: "play_quota_exceeded",
          quota: { used: 8, limit: 12, reset_at: RESET, source: "hands_budget" }, releases: [] },
        { hands_track: "internal", play_track: "qa", source: "unavailable", error_code: "play_quota_exceeded",
          quota: { used: 3, limit: 12, reset_at: RESET, source: "google" }, releases: [] },
      ],
      in_review: [], production_version_code: null, publishing_access: null,
    });
    expect(out).toContain("  Quota: 8 of 12 reads used this hour (Hands' budget, Google not called); resets at 2026-11-22T14:10:00.000Z");
    expect(out).toContain("  Quota: 3 of 12 reads used this hour (Google said it is used up); resets at 2026-11-22T14:10:00.000Z");
  });
});
