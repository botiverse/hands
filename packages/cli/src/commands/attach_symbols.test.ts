import { describe, expect, it, vi } from "vitest";
import { Command } from "commander";

const APP_ID = "11111111-2222-3333-4444-555555555555";
const BUILD_ID = "build-shipped";

vi.mock("../lib/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api.js")>();
  return {
    ...actual,
    apiRequest: async (path: string, opts: { method?: string; body?: any } = {}) => {
      const calls = (globalThis as unknown as { __CALLS: Array<{ method: string; path: string; body?: any }> }).__CALLS;
      calls.push({ method: (opts.method ?? "GET").toUpperCase(), path: String(path), body: opts.body });
      if (String(path) === `/api/apps/${APP_ID}/builds/${BUILD_ID}`) {
        return { product_type: (globalThis as unknown as { __PRODUCT_TYPE: string }).__PRODUCT_TYPE } as never;
      }
      if (String(path).endsWith("/assets/uploads")) {
        return { asset_id: "asset-1", state: "pending_upload", upload: { url: "https://r2.example.invalid/put", headers: {} } } as never;
      }
      if (String(path).includes("/upload/complete")) {
        return { asset_id: "asset-1", file_hash: "f".repeat(64), size_bytes: 3 } as never;
      }
      return {} as never;
    },
  };
});

async function run(argv: string[], productType = "android-apk") {
  // The command streams the file straight to the presigned URL, so stub that PUT.
  vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 200 })));
  const calls: Array<{ method: string; path: string; body?: any }> = [];
  (globalThis as unknown as { __CALLS: typeof calls }).__CALLS = calls;
  (globalThis as unknown as { __PRODUCT_TYPE: string }).__PRODUCT_TYPE = productType;
  const { registerBuildCommands } = await import("./builds.js");
  const program = new Command();
  program.exitOverride();
  registerBuildCommands(program);
  await program.parseAsync(["node", "hands", ...argv]);
  return calls;
}

describe("builds attach-symbols", () => {
  it("declares a proguard-mapping slot on an existing build via the direct-upload path", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sym-"));
    const mapping = path.join(dir, "mapping.txt");
    fs.writeFileSync(mapping, "map");

    const calls = await run(["builds", "attach-symbols", APP_ID, BUILD_ID, mapping]);
    const declared = calls.find((c) => c.path.endsWith("/assets/uploads"));
    expect(declared, "declared a direct upload").toBeDefined();
    expect(declared!.method).toBe("POST");
    expect(declared!.path).toBe(`/api/apps/${APP_ID}/builds/${BUILD_ID}/assets/uploads`);
    // The server keys symbols by kind + platform + filetype; a mapping is Android-only.
    expect(declared!.body).toMatchObject({
      artifact_kind: "proguard-mapping",
      platform: "android",
      filetype: "mapping.txt",
    });
  });

  it("refuses a non-symbol kind instead of sending it", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sym-"));
    const apk = path.join(dir, "app.apk");
    fs.writeFileSync(apk, "apk");

    await expect(run(["builds", "attach-symbols", APP_ID, BUILD_ID, apk, "--kind", "installable"]))
      .rejects.toThrow(/Only debug symbols/);
  });

  it.each([["android-apk", "android"], ["ohos-app", "ohos"], ["ios-ipa", "ios"]])(
    "uses the build type for native symbols on %s", async (productType, platform) => {
      const { mkdtempSync, writeFileSync } = await import("node:fs");
      const { tmpdir } = await import("node:os");
      const { join } = await import("node:path");
      const file = join(mkdtempSync(join(tmpdir(), "sym-native-")), "mapping.zip");
      writeFileSync(file, "zip");
      const calls = await run(["builds", "attach-symbols", APP_ID, BUILD_ID, file, "--kind", "native-symbols"], productType);
      expect(calls.find(c => c.path.endsWith("/assets/uploads"))?.body).toMatchObject({ artifact_kind: "native-symbols", platform, filetype: "symbols.zip" });
    },
  );

  it.each([["proguard-mapping", "android"], ["dsym", "ios"]])(
    "uses the explicit %s kind instead of the filename to choose platform", async (kind, platform) => {
      const { mkdtempSync, writeFileSync } = await import("node:fs");
      const { tmpdir } = await import("node:os");
      const { join } = await import("node:path");
      const file = join(mkdtempSync(join(tmpdir(), "sym-explicit-")), "mapping.zip");
      writeFileSync(file, "zip");
      const calls = await run(["builds", "attach-symbols", APP_ID, BUILD_ID, file, "--kind", kind]);
      expect(calls.find(c => c.path.endsWith("/assets/uploads"))?.body).toMatchObject({ artifact_kind: kind, platform });
    },
  );

  it("accepts an explicit native-symbol platform for a custom build", async () => {
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const file = join(mkdtempSync(join(tmpdir(), "sym-custom-")), "symbols.zip");
    writeFileSync(file, "zip");
    const calls = await run(["builds", "attach-symbols", APP_ID, BUILD_ID, file, "--platform", "linux-x64"], "desktop-installer");
    expect(calls.find(c => c.path.endsWith("/assets/uploads"))?.body).toMatchObject({ artifact_kind: "native-symbols", platform: "linux-x64" });
  });

  it("does not allow a platform override for a mapping", async () => {
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const file = join(mkdtempSync(join(tmpdir(), "sym-mapping-")), "mapping.txt");
    writeFileSync(file, "mapping");
    await expect(run(["builds", "attach-symbols", APP_ID, BUILD_ID, file, "--platform", "ios"])).rejects.toThrow(/only valid for native-symbols/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects an unknown native-symbol platform before declaring or uploading", async () => {
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const file = join(mkdtempSync(join(tmpdir(), "sym-native-")), "symbols.zip");
    writeFileSync(file, "zip");
    await expect(run(["builds", "attach-symbols", APP_ID, BUILD_ID, file], "desktop-installer")).rejects.toThrow(/Cannot determine/);
    const calls = (globalThis as unknown as { __CALLS: Array<{ method: string; path: string }> }).__CALLS;
    expect(calls.some(c => c.method === "POST")).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });
});
