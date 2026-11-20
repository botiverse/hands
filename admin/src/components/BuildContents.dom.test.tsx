// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getBuildInventory: vi.fn(),
  getBuildInventoryDiff: vi.fn(),
  refreshBuildInventory: vi.fn(),
  toast: vi.fn(),
}));

vi.mock("./Toast", () => ({
  useToast: () => ({ show: mocks.toast, update: vi.fn() }),
}));

vi.mock("../lib/api", async (importOriginal) => ({
  ...await importOriginal<typeof import("../lib/api")>(),
  getBuildInventory: mocks.getBuildInventory,
  getBuildInventoryDiff: mocks.getBuildInventoryDiff,
  refreshBuildInventory: mocks.refreshBuildInventory,
}));

import { ApiError, type BuildInventory, type InventoryDiff } from "../lib/api";
import { BuildContents, formatSignedSize } from "./BuildContents";

const MiB = 1024 * 1024;

const inventory: BuildInventory = {
  schema: 1,
  platform: "android",
  total_bytes: 20 * MiB,
  uncompressed_bytes: 32 * MiB,
  file_count: 1234,
  app: { package_id: "dev.hands.app" },
  categories: [
    { key: "dex", label: "DEX code", bytes: 14 * MiB, compressed_bytes: 6 * MiB, files: 2 },
    { key: "native/arm64-v8a", label: "Native libraries (arm64-v8a)", bytes: 9 * MiB, compressed_bytes: 9 * MiB, files: 3 },
  ],
  largest_files: [],
  components: {
    permissions: ["android.permission.CAMERA", "android.permission.INTERNET"],
    services: [],
  },
  libraries: [
    { name: "io.sentry", kind: "dex-package", bytes: 3 * MiB, compressed_bytes: MiB, classes: 900, sdk: "Sentry", estimated: true },
    { name: "libsentry.so", kind: "native", bytes: 7 * MiB, compressed_bytes: 7 * MiB, abis: ["arm64-v8a", "armeabi-v7a"], sdk: "Sentry" },
  ],
  sdks: [{ name: "Sentry", bytes: 10 * MiB, compressed_bytes: 8 * MiB, kinds: ["dex-package", "native"] }],
  notes: [],
  truncated: false,
};

const diff: InventoryDiff = {
  schema: 1,
  platform: "android",
  total: { before: 12 * MiB, after: 20 * MiB, delta: 8 * MiB, uncompressed_before: 0, uncompressed_after: 0, uncompressed_delta: 0 },
  categories: [
    { key: "native/arm64-v8a", label: "Native libraries (arm64-v8a)", before: 5 * MiB, after: 9 * MiB, delta: 4 * MiB, compressed_before: 5 * MiB, compressed_after: 9 * MiB, compressed_delta: 4 * MiB },
  ],
  components: { permissions: { added: ["android.permission.CAMERA"], removed: ["android.permission.READ_CONTACTS"] } },
  libraries: {
    added: [{ name: "libsentry.so", kind: "native", bytes: 7 * MiB, compressed_bytes: 7 * MiB, sdk: "Sentry" }],
    removed: [],
    changed: [{ name: "androidx.compose", kind: "dex-package", sdk: "Jetpack Compose", before: 1, after: 2, delta: 1, compressed_delta: MiB / 2, version_before: null, version_after: null }],
  },
  sdks: { added: [{ name: "Sentry", bytes: 10 * MiB, compressed_bytes: 8 * MiB, kinds: ["native"] }], removed: [], changed: [] },
  files: { grown: [], shrunk: [], added: [{ path: "lib/arm64-v8a/libsentry.so", category: "native/arm64-v8a", before: 0, after: 4 * MiB, delta: 4 * MiB }], removed: [] },
  notes: [],
};

function renderContents() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <BuildContents appId="app-1" buildId="b2" />
    </QueryClientProvider>,
  );
}

afterEach(() => { cleanup(); localStorage.clear(); });

describe("BuildContents", () => {
  beforeEach(() => vi.clearAllMocks());

  it("formats signed size deltas", () => {
    expect(formatSignedSize(8 * MiB, "en")).toBe("+8.00 MiB");
    expect(formatSignedSize(-2048, "en")).toBe("−2.00 KiB");
    expect(formatSignedSize(0, "en")).toBe("no change");
  });

  it("shows the size breakdown, SDKs, libraries and components of the build", async () => {
    mocks.getBuildInventory.mockResolvedValue({ build: { build_id: "b2", version_name: "1.1.0", version_code: 110, product_type: "android-apk" }, computed_at: 1, source_asset_id: "a", source_file_hash: null, inventory });
    renderContents();
    expect(await screen.findByText(/20\.00 MiB package/)).toBeTruthy();
    const breakdown = screen.getByRole("list", { name: "Size by category" });
    expect(breakdown.textContent).toContain("DEX code");
    expect(breakdown.textContent).toContain("Native libraries (arm64-v8a)");
    expect(breakdown.textContent).toContain("60%");
    expect(screen.getByText("Sentry · 8.00 MiB")).toBeTruthy();
    expect(screen.getByText("libsentry.so")).toBeTruthy();
    expect(screen.getByText(/arm64-v8a, armeabi-v7a/)).toBeTruthy();
    expect(screen.getByText("≈ 1.00 MiB")).toBeTruthy();
    expect(screen.getByText("Permissions · 2")).toBeTruthy();
    expect(screen.getByText("android.permission.CAMERA")).toBeTruthy();
    // Empty component lists are not shown.
    expect(screen.queryByText(/^Services/)).toBeNull();
  });

  it("says when names were restored with the R8 mapping", async () => {
    const mapped = { ...inventory, dex: { files: 1, classes: 10, methods: 1, size_estimate: "", obfuscated: true }, mapping: { used: true as const, classes_mapped: 1234, classes_unmapped: 5 } };
    mocks.getBuildInventory.mockResolvedValue({ build: { build_id: "b2" }, computed_at: 1, source_asset_id: null, source_file_hash: null, inventory: mapped });
    renderContents();
    expect(await screen.findByText("Names restored with the R8 mapping (1,234 classes).")).toBeTruthy();
    expect(screen.queryByText(/Upload its mapping\.txt/)).toBeNull();
  });

  it("asks for the mapping when an obfuscated build has none", async () => {
    const obfuscated = { ...inventory, dex: { files: 1, classes: 10, methods: 1, size_estimate: "", obfuscated: true } };
    mocks.getBuildInventory.mockResolvedValue({ build: { build_id: "b2" }, computed_at: 1, source_asset_id: null, source_file_hash: null, inventory: obfuscated });
    renderContents();
    expect(await screen.findByText(/Upload its mapping\.txt to see library names/)).toBeTruthy();
    expect(screen.queryByText(/Names restored/)).toBeNull();
  });

  it("offers to read an older build's contents", async () => {
    mocks.getBuildInventory.mockRejectedValueOnce(new ApiError(404, { code: "INVENTORY_MISSING", build_id: "b2" }, "missing"));
    mocks.refreshBuildInventory.mockResolvedValue({});
    mocks.getBuildInventory.mockResolvedValue({ build: { build_id: "b2" }, computed_at: 1, source_asset_id: null, source_file_hash: null, inventory });
    renderContents();
    fireEvent.click(await screen.findByRole("button", { name: "Read contents" }));
    await waitFor(() => expect(mocks.refreshBuildInventory).toHaveBeenCalledWith("app-1", "b2"));
    expect(await screen.findByText(/20\.00 MiB package/)).toBeTruthy();
  });

  it("compares with the previous build: growth, added SDKs, libraries and permissions", async () => {
    mocks.getBuildInventory.mockResolvedValue({ build: { build_id: "b2" }, computed_at: 1, source_asset_id: null, source_file_hash: null, inventory });
    mocks.getBuildInventoryDiff.mockResolvedValue({
      base: { build_id: "b1", version_name: "1.0.0", version_code: 100, product_type: "android-apk" },
      head: { build_id: "b2", version_name: "1.1.0", version_code: 110, product_type: "android-apk" },
      diff,
    });
    renderContents();
    fireEvent.click(await screen.findByRole("radio", { name: "Compare with previous" }));
    expect(await screen.findByText("1.0.0 (100)")).toBeTruthy();
    expect(mocks.getBuildInventoryDiff).toHaveBeenCalledWith("app-1", "b2", "previous");
    expect(screen.getByText(/12\.00 MiB → 20\.00 MiB/)).toBeTruthy();
    const growth = screen.getAllByText("+8.00 MiB")[0]!;
    expect(growth.className).toContain("text-warning-strong");
    expect(screen.getByText("Native libraries (arm64-v8a)")).toBeTruthy();
    expect(screen.getByText("Sentry")).toBeTruthy();
    expect(screen.getByText("androidx.compose")).toBeTruthy();
    expect(screen.getByText("android.permission.CAMERA")).toBeTruthy();
    expect(screen.getByText("android.permission.READ_CONTACTS")).toBeTruthy();
    expect(screen.getAllByText("Added").length).toBeGreaterThanOrEqual(3);
    expect(screen.getAllByText("Removed")).toHaveLength(1);
    expect(screen.getByText("lib/arm64-v8a/libsentry.so")).toBeTruthy();
  });

  it("asks to read the previous build when it has no contents", async () => {
    mocks.getBuildInventory.mockResolvedValue({ build: { build_id: "b2" }, computed_at: 1, source_asset_id: null, source_file_hash: null, inventory });
    mocks.getBuildInventoryDiff.mockRejectedValue(new ApiError(404, { code: "INVENTORY_MISSING", build_id: "b1" }, "missing"));
    mocks.refreshBuildInventory.mockResolvedValue({});
    renderContents();
    fireEvent.click(await screen.findByRole("radio", { name: "Compare with previous" }));
    fireEvent.click(await screen.findByRole("button", { name: "Read previous build" }));
    await waitFor(() => expect(mocks.refreshBuildInventory).toHaveBeenCalledWith("app-1", "b1"));
  });
});
