import { describe, expect, it } from "vitest";
import { publicDocAssetPaths } from "../src/lib/public_docs";

describe("public docs asset routing", () => {
  it("serves the generated docs index without a Markdown twin", () => {
    expect(publicDocAssetPaths("/docs")).toEqual({
      htmlPath: "/docs/",
      markdownTwinPath: null,
    });
  });

  it("derives article HTML and Markdown twin paths from any generated slug", () => {
    expect(publicDocAssetPaths("/docs/tauri-updater")).toEqual({
      htmlPath: "/docs/tauri-updater/",
      markdownTwinPath: "/docs/tauri-updater.md",
    });
    expect(publicDocAssetPaths("/docs/future-guide/")).toEqual({
      htmlPath: "/docs/future-guide/",
      markdownTwinPath: "/docs/future-guide.md",
    });
  });

  it("rejects paths that are not generated article routes", () => {
    expect(publicDocAssetPaths("/docs/tauri-updater.md")).toBeNull();
    expect(publicDocAssetPaths("/docs//nested")).toBeNull();
    expect(publicDocAssetPaths("/api/docs")).toBeNull();
  });
});
