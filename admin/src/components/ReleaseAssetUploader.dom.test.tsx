// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ list: vi.fn(), presign: vi.fn(), toast: vi.fn() }));
vi.mock("./Toast", () => ({ useToast: () => ({ show: mocks.toast }) }));
vi.mock("../lib/api", async (importOriginal) => ({
  ...await importOriginal<typeof import("../lib/api")>(),
  listBuildAssets: mocks.list,
  getBuildAssetDownloadUrl: mocks.presign,
}));

import { ReleaseAssetUploader } from "./ReleaseAssetUploader";

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe("ReleaseAssetUploader panel", () => {
  it("offers a download for each existing asset through a presigned URL", async () => {
    mocks.list.mockResolvedValue({ assets: [{
      id: "asset-1", build_id: "build-1", artifact_kind: "installable", platform: "android", arch: "universal",
      variant: null, filetype: "apk", r2_key: "k", file_hash: "x", size_bytes: 4_000_000, signature: null,
      signing_credential_id: null, metadata_json: JSON.stringify({ filename: "app-release.apk" }), download_count: 0, created_at: 1,
    }] });
    mocks.presign.mockResolvedValue({ download_url: "about:blank#signed" });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <ReleaseAssetUploader variant="panel" appId="app-1" buildId="build-1" releaseId="rel-1" productTypeHint="android-apk" />
      </QueryClientProvider>,
    );
    const button = await screen.findByRole("button", { name: /^Download / });
    expect(screen.getByRole("button", { name: /^Remove / })).toBeTruthy();
    fireEvent.click(button);
    await waitFor(() => expect(mocks.presign).toHaveBeenCalledWith("app-1", "build-1", "asset-1"));
  });
});
