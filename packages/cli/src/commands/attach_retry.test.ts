import { describe, expect, it, vi } from "vitest";
import { Command } from "commander";

const APP_ID = "11111111-2222-3333-4444-555555555555";
const BUILD_ID = "build-shipped";
let completeAttempts = 0;
let failMode: "transient-once" | "permanent" | "none" = "none";

vi.mock("../lib/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api.js")>();
  return {
    ...actual,
    apiRequest: async (path: string, opts: { method?: string } = {}) => {
      const p = String(path);
      if (p.endsWith("/assets/uploads")) {
        return { asset_id: "asset-1", state: "pending_upload", upload: { url: "https://r2.example.invalid/put", headers: {} } } as never;
      }
      if (p.includes("/upload/complete")) {
        completeAttempts += 1;
        // A network blip on the FIRST completion attempt, then success -- this is
        // exactly the shape that produced "fetch failed" during real use.
        if (failMode === "transient-once" && completeAttempts === 1) throw new Error("fetch failed");
        if (failMode === "permanent") throw new Error("fetch failed");
        return { asset_id: "asset-1", file_hash: "f".repeat(64), size_bytes: 3 } as never;
      }
      return {} as never;
    },
  };
});

async function run() {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 200 })));
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "retry-"));
  const mapping = path.join(dir, "mapping.txt");
  fs.writeFileSync(mapping, "map");
  const { registerBuildCommands } = await import("./builds.js");
  const program = new Command();
  program.exitOverride();
  registerBuildCommands(program);
  await program.parseAsync(["node", "hands", "builds", "attach-symbols", APP_ID, BUILD_ID, mapping]);
}

describe("attach-symbols completion retry", () => {
  it("retries a transient 'fetch failed' on the completion step", async () => {
    completeAttempts = 0;
    failMode = "transient-once";
    await expect(run()).resolves.toBeUndefined();
    expect(completeAttempts).toBe(2); // failed once, succeeded on retry
  });

  it("still surfaces a permanent failure instead of hiding it", async () => {
    completeAttempts = 0;
    failMode = "permanent";
    await expect(run()).rejects.toThrow(/fetch failed/);
    expect(completeAttempts).toBe(3); // bounded at three attempts
  });
});
