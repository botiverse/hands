// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { BuildAsset } from "../lib/api";
import { BuildAssetIdentitySummary } from "./BuildAssetIdentitySummary";

afterEach(cleanup);

const asset: BuildAsset = {
  id: "3b445f1e-cf82-42ae-a5cf-f8842b4a93f6",
  build_id: "d8fb5fc5-edc1-4cb4-8ce6-5205c4265cd6",
  artifact_kind: "delta-patch",
  platform: "android",
  arch: "arm64-v8a",
  variant: null,
  filetype: "patch",
  r2_key:
    "apps/98b90005-90a7-4eee-9fd1-1569a1f5d18b/pending/efc3bdcecd439fa66dc3106e07b71e7b3ab6178cd82cc9af9b103de6073b5163.gz",
  file_hash:
    "efc3bdcecd439fa66dc3106e07b71e7b3ab6178cd82cc9af9b103de6073b5163",
  size_bytes: 11_295_525,
  signature: null,
  signing_credential_id: null,
  metadata_json: JSON.stringify({
    original_filename: "valid-1000002-to-1000003.patch.gz",
  }),
  download_count: 0,
  created_at: 0,
};

describe("BuildAssetIdentitySummary", () => {
  it("renders every exact identifier needed to verify a destructive action", () => {
    render(<BuildAssetIdentitySummary asset={asset} />);

    expect(
      screen.getByText("valid-1000002-to-1000003.patch.gz"),
    ).toBeTruthy();
    expect(screen.getByText(asset.id)).toBeTruthy();
    expect(screen.getByText(asset.build_id)).toBeTruthy();
    expect(screen.getByText(asset.artifact_kind)).toBeTruthy();
    expect(screen.getByText(asset.file_hash)).toBeTruthy();
    expect(screen.getByText(asset.r2_key)).toBeTruthy();
    expect(screen.getByText("10.77 MiB (11,295,525 bytes)")).toBeTruthy();
    expect(screen.getByLabelText("Copy asset id")).toBeTruthy();
    expect(screen.getByLabelText("Copy build id")).toBeTruthy();
    expect(screen.getByLabelText("Copy sha256")).toBeTruthy();
    expect(screen.getByLabelText("Copy r2 key")).toBeTruthy();
  });
});
