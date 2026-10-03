import { describe, expect, it } from "vitest";
import { googlePlayPackageOptions } from "./googlePlayPackages";
const channels = [{ id: "main", slug: "main", bundle_id: null }, { id: "preview", slug: "preview", bundle_id: "build.raft.preview" }];
const build = { channel_id: "main", status: "succeeded", product_type: "android-apk", parsed_metadata_json: "{}", build_metadata_json: '{"package_name":"build.raft.app"}' };
describe("Play package choices", () => {
  it("uses an uploaded main package even before inspection metadata exists", () => {
    expect(googlePlayPackageOptions(channels, [build])).toEqual([
      { packageName: "build.raft.app", source: "declared", isMain: true },
      { packageName: "build.raft.preview", source: "channel", isMain: false },
    ]);
  });
  it("deduplicates sources but keeps conflicting package identities as choices", () => {
    expect(googlePlayPackageOptions(channels, [{ ...build, parsed_metadata_json: '{"package_id":"build.raft.app"}' }])[0]?.source).toBe("parsed");
    expect(googlePlayPackageOptions([], [{ ...build, parsed_metadata_json: '{"package_id":"different.play.app"}' }])).toHaveLength(2);
  });
  it("excludes failed builds, other platforms and malformed metadata", () => {
    expect(googlePlayPackageOptions([], [
      { ...build, status: "failed" }, { ...build, product_type: "ios-ipa" },
      { ...build, build_metadata_json: '{"package_name":"broken/name"}' },
      { ...build, build_metadata_json: "malformed" },
    ])).toEqual([]);
  });
});
