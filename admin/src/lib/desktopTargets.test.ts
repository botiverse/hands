import { describe, expect, it } from "vitest";
import type { BuildAsset } from "./api";
import { desktopAssetRole, groupDesktopTargets, isDesktopBuild } from "./desktopTargets";

let n = 0;
const asset = (over: Partial<BuildAsset>): BuildAsset => ({
  id: `a${n++}`, build_id: "b", artifact_kind: "installable", platform: "darwin", arch: "arm64", variant: null,
  filetype: "dmg", r2_key: "k", file_hash: "h".repeat(64), size_bytes: 10, signature: null,
  signing_credential_id: null, metadata_json: "{}", download_count: 0, created_at: 1, ...over,
});

describe("desktop targets", () => {
  it("is a desktop build only with a desktop manifest or archive", () => {
    expect(isDesktopBuild([asset({ platform: "android", arch: null, filetype: "apk" })])).toBe(false);
    expect(isDesktopBuild([asset({ artifact_kind: "desktop-archive", filetype: "zip" })])).toBe(true);
  });

  it("groups each target's manifest, archive and installers, live only with a manifest", () => {
    const { targets, other } = groupDesktopTargets([
      asset({ platform: "win32", arch: "x64", artifact_kind: "desktop-archive", filetype: "zip", size_bytes: 100 }),
      asset({ artifact_kind: "desktop-manifest", filetype: "json", size_bytes: 5 }),
      asset({ artifact_kind: "desktop-archive", filetype: "zip", size_bytes: 200 }),
      asset({ size_bytes: 300 }),
      asset({ platform: "android", arch: null, filetype: "apk", artifact_kind: "installable" }),
    ]);
    expect(targets.map((g) => [g.target, g.live, g.sizeBytes, g.installers.length])).toEqual([
      ["darwin-arm64", true, 500, 1],
      ["win32-x64", false, 100, 0],
    ]);
    expect(targets[0]!.label.en).toBe("macOS · Apple silicon");
    expect(other).toHaveLength(1);
  });

  it("names each asset's role", () => {
    expect(desktopAssetRole(asset({ artifact_kind: "desktop-manifest" })).en).toBe("Update manifest");
    expect(desktopAssetRole(asset({ artifact_kind: "desktop-archive" })).zh).toBe("完整压缩包");
    expect(desktopAssetRole(asset({})).en).toBe("Installer");
  });
});
