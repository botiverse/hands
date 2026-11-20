import { describe, expect, it } from "vitest";

import { formatPlayReviewStatus } from "./play.js";
describe("play review-status output", () => {
  it("leads with what is in review and the production versionCode, and marks stored states", () => {
    const out = formatPlayReviewStatus({
      package_name: "build.raft.app", read_at: Date.UTC(2026, 10, 20, 15),
      tracks: [
        { hands_track: "internal", play_track: "internal", source: "live", releases: [{ release_name: "1.27.0", state: "RELEASE_LIFECYCLE_STATE_PUBLISHED", state_label: "", version_codes: [12700006] }] },
        { hands_track: "production", play_track: "production", source: "stored", error_code: "play_api_rejected", releases: [{ release_name: null, state: "RELEASE_LIFECYCLE_STATE_IN_REVIEW", state_label: "", version_codes: [12600003], observed_at: Date.UTC(2026, 10, 20, 14) }] },
      ],
      in_review: [{ hands_track: "production", play_track: "production", version_codes: [12600003], release_name: null, source: "stored" }],
      production_version_code: null,
      publishing_access: null,
    });
    expect(out.split("\n").slice(0, 3)).toEqual([
      "Google Play · build.raft.app · read 2026-11-20T15:00:00.000Z",
      "In review: production (production) 12600003 [stored]",
      "Production versionCode: none published",
    ]);
    expect(out).toContain("internal (internal): live");
    expect(out).toContain("PUBLISHED                12700006  1.27.0");
    expect(out).toContain("production (production): Play refused the read (play_api_rejected); last states the poll observed");
    expect(out).toContain("(observed 2026-11-20T14:00:00.000Z)");
  });
});
