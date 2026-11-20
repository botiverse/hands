// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

const mocks = vi.hoisted(() => ({
  listApps: vi.fn(),
  listChannels: vi.fn(),
  listReleases: vi.fn(),
  listProductTypes: vi.fn(),
  listReleaseApprovals: vi.fn(),
  getRelease: vi.fn(),
  publishRelease: vi.fn(),
  deleteChannel: vi.fn(),
  listBuilds: vi.fn(),
  listBuildAssets: vi.fn(),
  getBuildAssetDownloadUrl: vi.fn(),
  toast: vi.fn(),
}));

vi.mock("../components/Toast", () => ({
  useToast: () => ({ show: mocks.toast, update: vi.fn() }),
}));

vi.mock("../lib/api", async (importOriginal) => ({
  ...await importOriginal<typeof import("../lib/api")>(),
  listApps: mocks.listApps,
  listChannels: mocks.listChannels,
  listReleases: mocks.listReleases,
  listProductTypes: mocks.listProductTypes,
  listReleaseApprovals: mocks.listReleaseApprovals,
  getRelease: mocks.getRelease,
  publishRelease: mocks.publishRelease,
  deleteChannel: mocks.deleteChannel,
  listBuilds: mocks.listBuilds,
  listBuildAssets: mocks.listBuildAssets,
  getBuildAssetDownloadUrl: mocks.getBuildAssetDownloadUrl,
}));

import { Releases } from "./Releases";
import { AppChannels } from "./Channels";
import { Builds } from "./Builds";

const NOW = Date.now();
const channel = (id: string, slug: string, name: string) => ({ id, app_id: "app-1", slug, name, bundle_id: null, password: null, git_url: null, enabled_product_types_json: "[]", metadata_json: "{}", created_at: 1 });
const release = (id: string, channel_id: string, version_name: string, status: string, extra: Record<string, unknown> = {}) => ({
  id, app_id: "app-1", build_id: `b-${id}`, channel_id, product_type: "android-apk", release_type: "stable", status,
  activated_at: status === "draft" ? null : NOW - 60_000, revision: 3, is_full: 1, superseded_by_release_id: null,
  rollout_cohort_count: null, rollout_target_cohorts_json: "[]", availability_at: null, should_force_update: 0,
  changelog: null, provenance_json: "{}", created_by: "x", created_at: NOW - 60_000, updated_at: NOW,
  version_name, version_code: 10, ...extra,
});

function renderPage(node: ReactNode, path = "/") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <MemoryRouter initialEntries={[path]}>
      <QueryClientProvider client={client}>{node}</QueryClientProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listApps.mockResolvedValue({ apps: [{ id: "app-1", slug: "deck", name: "Deck", platform: "android", default_channel_id: "c1", release_requires_human_approval: 0 }] });
  mocks.listChannels.mockResolvedValue({ channels: [channel("c1", "main", "Main"), channel("c2", "beta", "Beta")] });
  mocks.listProductTypes.mockResolvedValue({ product_types: [] });
  mocks.listReleaseApprovals.mockResolvedValue({ approvals: [] });
  mocks.listReleases.mockResolvedValue({ releases: [
    release("r1", "c1", "2.0.0", "draft"),
    release("r2", "c2", "1.9.0", "active", { rollout_cohort_count: 25 }),
  ] });
});
afterEach(() => { cleanup(); localStorage.clear(); });

describe("Releases page", () => {
  it("lists releases as rows with their state and rollout share", async () => {
    renderPage(<Releases appId="app-1" />);
    expect(await screen.findByText("2.0.0")).toBeTruthy();
    expect(screen.getByText("Draft")).toBeTruthy();
    expect(screen.getByText("Active · 25%")).toBeTruthy();
  });

  it("filters by the channel in the URL", async () => {
    renderPage(<Releases appId="app-1" />, "/?channel=beta");
    expect(await screen.findByText("1.9.0")).toBeTruthy();
    await waitFor(() => expect(screen.queryByText("2.0.0")).toBeNull());
  });

  it("opens a draft beside the list and publishes it with its scopes and revision", async () => {
    mocks.getRelease.mockResolvedValue({
      release: release("r1", "c1", "2.0.0", "draft"),
      build: { version_name: "2.0.0", version_code: 10 },
      assets: [],
      scopes: [{ id: "s1", release_id: "r1", scope_type: "full", scope_value: "all", created_at: 1 }],
      checks: [],
    });
    mocks.listBuildAssets.mockResolvedValue({ assets: [] });
    mocks.publishRelease.mockResolvedValue({});
    renderPage(<Releases appId="app-1" />);
    fireEvent.click(await screen.findByText("2.0.0"));
    const panel = await screen.findByRole("region", { name: "2.0.0 · main" });
    const publish = await within(panel).findByRole("button", { name: "Publish" });
    await waitFor(() => expect(publish.hasAttribute("disabled")).toBe(false));
    fireEvent.click(publish);
    await waitFor(() => expect(mocks.publishRelease).toHaveBeenCalledWith("app-1", "r1", [{ scope_type: "full", scope_value: "all" }], 3));
    // Cancelling a release stays reachable from the panel's danger zone.
    expect(within(panel).getByRole("button", { name: /Delete draft/ })).toBeTruthy();
  });
});

describe("Channels page", () => {
  it("shows each channel's live release and deletes one only after the slug is typed", async () => {
    mocks.deleteChannel.mockResolvedValue({ ok: true });
    renderPage(<AppChannels appId="app-1" />);
    expect(await screen.findByText("1.9.0 (10) · android-apk")).toBeTruthy();
    expect(screen.getByText("25% rollout")).toBeTruthy();
    expect(screen.getByText("default")).toBeTruthy();

    fireEvent.click(screen.getByText("Beta"));
    const panel = await screen.findByRole("region", { name: "Beta" });
    fireEvent.click(within(panel).getByRole("button", { name: /Delete channel/ }));
    const dialog = await screen.findByRole("alertdialog");
    const confirm = within(dialog).getByRole("button", { name: "Delete channel" });
    expect(confirm.hasAttribute("disabled")).toBe(true);
    fireEvent.change(within(dialog).getByPlaceholderText("beta"), { target: { value: "beta" } });
    fireEvent.click(confirm);
    await waitFor(() => expect(mocks.deleteChannel).toHaveBeenCalledWith("app-1", "c2"));
  });
});

describe("Builds page", () => {
  it("shows each build's files and downloads one from the open build", async () => {
    mocks.listBuilds.mockResolvedValue({ builds: [{
      id: "b1", app_id: "app-1", channel_id: "c1", product_type: "android-apk", release_type: "stable", version_name: "3.1.0",
      version_code: 31, changelog: null, source: "ci", status: "succeeded", build_metadata_json: "{}", parsed_metadata_json: "{}",
      should_force_update: 0, availability_at: null, provenance_json: "{}", created_at: NOW, updated_at: NOW, completed_at: NOW,
    }] });
    mocks.listBuildAssets.mockResolvedValue({ assets: [{
      id: "a1", build_id: "b1", artifact_kind: "installable", platform: "android", arch: "arm64-v8a", variant: null, filetype: "apk",
      r2_key: "k/app.apk", file_hash: "f".repeat(64), size_bytes: 2048, signature: null, signing_credential_id: null,
      metadata_json: JSON.stringify({ filename: "app-release.apk" }), download_count: 0, created_at: 1,
    }] });
    mocks.getBuildAssetDownloadUrl.mockResolvedValue({ download_url: "about:blank#signed" });
    renderPage(<Builds appId="app-1" />);
    expect(await screen.findByText("1 file · 2.00 KiB")).toBeTruthy();
    expect(screen.getByText("Succeeded")).toBeTruthy();

    fireEvent.click(screen.getByText("3.1.0"));
    const panel = await screen.findByRole("region", { name: "3.1.0 (31)" });
    expect(within(panel).getByRole("button", { name: "Prepare release" })).toBeTruthy();
    fireEvent.click(await within(panel).findByRole("button", { name: "Download app-release.apk" }));
    await waitFor(() => expect(mocks.getBuildAssetDownloadUrl).toHaveBeenCalledWith("app-1", "b1", "a1"));
  });
});
