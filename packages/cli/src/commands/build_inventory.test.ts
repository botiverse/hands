import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";

const APP_ID = "11111111-2222-3333-4444-555555555555";
const MiB = 1024 * 1024;

const state = vi.hoisted(() => ({
  calls: [] as Array<{ method: string; path: string; query?: Record<string, unknown> }>,
  respond: (_path: string, _method: string): unknown => ({}),
}));

vi.mock("../lib/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api.js")>();
  return {
    ...actual,
    apiRequest: async (path: string, opts: { method?: string; query?: Record<string, unknown> } = {}) => {
      const method = (opts.method ?? "GET").toUpperCase();
      state.calls.push({ method, path, query: opts.query });
      return state.respond(path, method);
    },
  };
});

import { QuiverApiError } from "../lib/api.js";
import { formatDelta, renderDiff, renderInventory, type DiffResponse, type InventoryResponse } from "./build_inventory.js";

const inventoryResponse: InventoryResponse = {
  build: { build_id: "b2", version_name: "1.1.0", version_code: 110 },
  computed_at: 1,
  inventory: {
    schema: 1,
    platform: "android",
    total_bytes: 20 * MiB,
    uncompressed_bytes: 32 * MiB,
    file_count: 1200,
    app: {},
    categories: [
      { key: "dex", label: "DEX code", bytes: 14 * MiB, compressed_bytes: 6 * MiB, files: 2 },
      { key: "native/arm64-v8a", label: "Native libraries (arm64-v8a)", bytes: 9 * MiB, compressed_bytes: 9 * MiB, files: 3 },
    ],
    largest_files: [],
    components: { permissions: ["android.permission.CAMERA"], services: [] },
    libraries: [
      { name: "io.sentry", kind: "dex-package", bytes: 3 * MiB, compressed_bytes: MiB, estimated: true, sdk: "Sentry" },
      { name: "libsentry.so", kind: "native", bytes: 7 * MiB, compressed_bytes: 7 * MiB, abis: ["arm64-v8a", "armeabi-v7a"], sdk: "Sentry" },
    ],
    sdks: [{ name: "Sentry", bytes: 10 * MiB, compressed_bytes: 8 * MiB, kinds: ["dex-package", "native"] }],
    notes: [],
  },
};

const diffResponse: DiffResponse = {
  base: { build_id: "b1", version_name: "1.0.0", version_code: 100 },
  head: { build_id: "b2", version_name: "1.1.0", version_code: 110 },
  diff: {
    total: { before: 12 * MiB, after: 20 * MiB, delta: 8 * MiB },
    categories: [{ key: "native/arm64-v8a", label: "Native libraries (arm64-v8a)", compressed_before: 5 * MiB, compressed_after: 9 * MiB, compressed_delta: 4 * MiB }],
    components: { permissions: { added: ["android.permission.CAMERA"], removed: ["android.permission.READ_CONTACTS"] } },
    libraries: {
      added: [{ name: "libsentry.so", kind: "native", bytes: 7 * MiB, compressed_bytes: 7 * MiB }],
      removed: [],
      changed: [{ name: "Sentry", kind: "framework", delta: 0, compressed_delta: 0, version_before: "8.1.0", version_after: "8.2.0" }],
    },
    sdks: { added: [{ name: "Sentry", bytes: 10 * MiB, compressed_bytes: 8 * MiB, kinds: ["native"] }], removed: [], changed: [] },
    files: { grown: [{ path: "classes.dex", delta: 2 * MiB }], added: [{ path: "lib/arm64-v8a/libsentry.so", delta: 4 * MiB }] },
    notes: [],
  },
};

async function run(argv: string[]): Promise<string> {
  const { registerBuildCommands } = await import("./builds.js");
  const program = new Command();
  program.exitOverride();
  registerBuildCommands(program);
  const out: string[] = [];
  const log = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => { out.push(args.join(" ")); });
  try {
    await program.parseAsync(["node", "hands", ...argv]);
  } finally {
    log.mockRestore();
  }
  return out.join("\n");
}

describe("builds inventory / diff", () => {
  beforeEach(() => { state.calls = []; });
  afterEach(() => vi.restoreAllMocks());

  it("renders a readable inventory", () => {
    const text = renderInventory(inventoryResponse);
    expect(text).toContain("1.1.0 (110)  android  20.0 MiB package, 32.0 MiB uncompressed, 1200 files");
    expect(text).toMatch(/Native libraries \(arm64-v8a\)\s+9\.0 MiB\s+60%/);
    expect(text).toMatch(/Sentry\s+8\.0 MiB\s+\(dex-package, native\)/);
    expect(text).toMatch(/libsentry\.so\s+native\s+7\.0 MiB\s+arm64-v8a,armeabi-v7a\s+Sentry/);
    expect(text).toMatch(/io\.sentry\s+dex-package\s+~1\.0 MiB/);
    expect(text).toContain("permissions (1):\n  android.permission.CAMERA");
    expect(text).not.toContain("services");
  });

  it("renders a diff with growth, added and removed items", () => {
    const text = renderDiff(diffResponse);
    expect(text).toContain("1.0.0 (100) -> 1.1.0 (110)");
    expect(text).toContain("Package: 12.0 MiB -> 20.0 MiB (+8.0 MiB)");
    expect(text).toMatch(/Native libraries \(arm64-v8a\)\s+\+4\.0 MiB/);
    expect(text).toMatch(/\+ Sentry\s+\+8\.0 MiB/);
    expect(text).toMatch(/\+ libsentry\.so\s+native\s+\+7\.0 MiB/);
    expect(text).toMatch(/~ Sentry\s+framework\s+±0\s+v8\.1\.0 -> v8\.2\.0/);
    expect(text).toContain("permissions:\n  + android.permission.CAMERA\n  - android.permission.READ_CONTACTS");
    expect(text).toMatch(/\+4\.0 MiB\s+lib\/arm64-v8a\/libsentry\.so/);
    expect(formatDelta(-1536)).toBe("-1.5 KiB");
  });

  it("calls the inventory endpoint, POSTs with --refresh, and prints JSON with --json", async () => {
    state.respond = () => inventoryResponse;
    await run(["builds", "inventory", APP_ID, "b2"]);
    await run(["builds", "inventory", APP_ID, "b2", "--refresh"]);
    const json = await run(["builds", "inventory", APP_ID, "b2", "--json"]);
    expect(state.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      `GET /api/apps/${APP_ID}/builds/b2/inventory`,
      `POST /api/apps/${APP_ID}/builds/b2/inventory`,
      `GET /api/apps/${APP_ID}/builds/b2/inventory`,
    ]);
    expect(JSON.parse(json)).toEqual(inventoryResponse);
  });

  it("calls the diff endpoint with --against, defaulting to previous", async () => {
    state.respond = () => diffResponse;
    const text = await run(["builds", "diff", APP_ID, "b2"]);
    await run(["builds", "diff", APP_ID, "b2", "--against", "b0"]);
    expect(state.calls.map((c) => [c.path, c.query?.against])).toEqual([
      [`/api/apps/${APP_ID}/builds/b2/inventory/diff`, "previous"],
      [`/api/apps/${APP_ID}/builds/b2/inventory/diff`, "b0"],
    ]);
    expect(text).toContain("Package: 12.0 MiB -> 20.0 MiB (+8.0 MiB)");
  });

  it("tells how to backfill a build without an inventory", async () => {
    state.respond = () => {
      throw new QuiverApiError(404, { code: "INVENTORY_MISSING", build_id: "b1" }, "no inventory");
    };
    await expect(run(["builds", "diff", APP_ID, "b2"])).rejects.toThrow(
      `Build b1 has no content inventory yet. Compute it with: hands builds inventory ${APP_ID} b1 --refresh`,
    );
  });
});
