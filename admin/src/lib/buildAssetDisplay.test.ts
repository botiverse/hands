import { describe, expect, it } from "vitest";
import {
  buildAssetFilename,
  formatBuildAssetExactSize,
  formatBuildAssetSize,
} from "./buildAssetDisplay";

describe("build-asset display identity", () => {
  it("prefers the original filename and supports historical filename metadata", () => {
    expect(
      buildAssetFilename({
        metadata_json: JSON.stringify({
          original_filename: "valid-1000002-to-1000003.patch.gz",
          filename: "renamed.patch.gz",
        }),
        r2_key: "apps/example/pending/hash.gz",
      }),
    ).toBe("valid-1000002-to-1000003.patch.gz");

    expect(
      buildAssetFilename({
        metadata_json: JSON.stringify({ filename: "legacy.apk" }),
        r2_key: "apps/example/pending/hash.apk",
      }),
    ).toBe("legacy.apk");
  });

  it("falls back safely when legacy metadata is malformed", () => {
    expect(
      buildAssetFilename({
        metadata_json: "{not-json",
        r2_key: "apps/example/pending/fallback.patch.gz",
      }),
    ).toBe("fallback.patch.gz");
  });

  it("keeps tiny patches exact instead of rounding them to zero megabytes", () => {
    expect(formatBuildAssetSize(64)).toBe("64 B");
    expect(formatBuildAssetSize(11_295_525)).toBe("10.77 MiB");
    expect(formatBuildAssetExactSize(11_295_525)).toBe(
      "10.77 MiB (11,295,525 bytes)",
    );
  });
});
