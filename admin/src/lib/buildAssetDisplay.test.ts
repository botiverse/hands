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

  it("localizes missing metadata while keeping real filenames and byte counts intact", () => {
    expect(buildAssetFilename({ metadata_json: "{}", r2_key: "" }, "zh-CN")).toBe("未命名文件");
    expect(buildAssetFilename({ metadata_json: '{"original_filename":"keep.apk"}', r2_key: "" }, "zh-CN")).toBe("keep.apk");
    expect(formatBuildAssetSize(-1, "zh-CN")).toBe("大小未知");
    expect(formatBuildAssetExactSize(11_295_525, "zh-CN")).toBe("10.77 MiB (11,295,525 字节)");
  });

  it("keeps tiny patches exact instead of rounding them to zero megabytes", () => {
    expect(formatBuildAssetSize(64)).toBe("64 B");
    expect(formatBuildAssetSize(11_295_525)).toBe("10.77 MiB");
    expect(formatBuildAssetExactSize(11_295_525)).toBe(
      "10.77 MiB (11,295,525 bytes)",
    );
  });
});
