// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

const mocks = vi.hoisted(() => ({
  listApps: vi.fn(),
  listOperations: vi.fn(),
  getAscCredentials: vi.fn(),
  getTestflightUploadStatus: vi.fn(),
  getTestflightPublishStatus: vi.fn(),
  getAppStoreReview: vi.fn(),
}));

vi.mock("../lib/api", async (importOriginal) => ({
  ...await importOriginal<typeof import("../lib/api")>(),
  ...mocks,
}));

import { Testflight } from "./Testflight";
import { AppStoreReview } from "./AppStoreReview";

const NOW = Date.now();
const app = (platform: string) => ({ id: "app-1", org_id: "o", slug: "deck-ios", name: "Deck iOS", platform, description: null, archived: 0, archived_at: null, created_at: 1 });
const op = (id: string, kind: string, status: string, input: object, output: object, error: string | null = null) => ({
  id, app_id: "app-1", kind, status, parent_op_id: null, step_number: null, actor: "x",
  input: JSON.stringify(input), output: JSON.stringify(output), error, progress: 1, retry_count: 0,
  created_at: NOW - 60_000, updated_at: NOW, completed_at: NOW,
});

function renderPage(node: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={client}>{node}</QueryClientProvider>
    </MemoryRouter>,
  );
}

afterEach(() => cleanup());
beforeEach(() => {
  vi.clearAllMocks();
  mocks.listApps.mockResolvedValue({ apps: [app("ios")] });
  mocks.getAscCredentials.mockResolvedValue({ asc_credentials: { key_id: "K", issuer_id: "I", updated_at: 1 } });
});

describe("TestFlight page", () => {
  it("shows uploads and distributions as rows with their Apple state", async () => {
    mocks.listOperations.mockResolvedValue({ operations: [
      op("u1", "testflight-upload", "success", { version_name: "2.4.0", version_code: 240, bundle_id: "build.deck" }, { build_upload_id: "bu-1", asc_app_id: "123" }),
      op("u2", "testflight-upload", "failed", { version_name: "2.3.9", version_code: 239 }, {}, JSON.stringify({ error: "asc_upload_failed", detail: "Invalid signature" })),
      op("p1", "testflight-publish", "success", { hands_build_id: "build-1", distribution: "external" }, { version: "2.4.0", build_number: "240", state: "pending" }),
    ] });
    mocks.getTestflightUploadStatus.mockResolvedValue({ build_upload_id: "bu-1", state: { state: "COMPLETE" }, version: "2.4.0", build_number: "240", uploaded_at: null });
    mocks.getTestflightPublishStatus.mockResolvedValue({ state: "testing", assigned_groups: [{ id: "g1", name: "Beta testers" }], beta_review: { id: "r", state: "APPROVED", submitted_at: null } });
    renderPage(<Testflight appId="app-1" />);

    const uploads = await screen.findAllByTestId("testflight-upload");
    expect(uploads).toHaveLength(2);
    expect(within(uploads[0]!).getByText("2.4.0 (240)")).toBeTruthy();
    expect(within(uploads[0]!).getByText("build.deck")).toBeTruthy();
    expect(await within(uploads[0]!).findByText("Processed")).toBeTruthy();
    expect(mocks.getTestflightUploadStatus).toHaveBeenCalledWith("app-1", "bu-1");
    expect(within(uploads[1]!).getByText("Upload failed")).toBeTruthy();

    const [distribution] = screen.getAllByTestId("testflight-distribution");
    expect(await within(distribution!).findByText("Testing")).toBeTruthy();
    expect(within(distribution!).getByText("External")).toBeTruthy();
    expect(within(distribution!).getByText(/Beta testers/)).toBeTruthy();
    expect(mocks.getTestflightPublishStatus).toHaveBeenCalledWith("app-1", "build-1", { distribution: "external" });
  });

  it("points to Integrations when no App Store Connect key is set and nothing was uploaded", async () => {
    mocks.listOperations.mockResolvedValue({ operations: [] });
    mocks.getAscCredentials.mockResolvedValue({ asc_credentials: null });
    renderPage(<Testflight appId="app-1" />);
    expect(await screen.findByText("Connect App Store Connect first")).toBeTruthy();
    const link = screen.getByText("Open Integrations").closest("a")!;
    expect(link.getAttribute("href")).toBe("/apps/app-1/integrations");
  });
});

describe("App Store page", () => {
  it("lists versions and beta reviews with their state", async () => {
    mocks.getAppStoreReview.mockResolvedValue({
      configured: true, applicable: true, bundle_id: "build.deck", asc_app_id: "123",
      app_store_versions: [
        { versionString: "2.4.0", appStoreState: "WAITING_FOR_REVIEW", platform: "IOS", createdDate: "2026-11-18T10:00:00Z" },
        { versionString: "2.3.9", appStoreState: "REJECTED", platform: "IOS", createdDate: "2026-11-10T10:00:00Z" },
      ],
      testflight_builds: [{ version: "240", processingState: "PROCESSING", uploadedDate: null, betaReviewState: null }],
    });
    renderPage(<AppStoreReview appId="app-1" />);
    const versions = await screen.findAllByTestId("appstore-version");
    expect(within(versions[0]!).getByText("Waiting for review")).toBeTruthy();
    expect(within(versions[0]!).getByText("Latest")).toBeTruthy();
    expect(within(versions[1]!).getByText("Rejected")).toBeTruthy();
    expect(within(versions[1]!).getByText(/See App Store Connect for why/)).toBeTruthy();
    const [build] = screen.getAllByTestId("appstore-build");
    expect(within(build!).getByText("No beta review")).toBeTruthy();
    expect(within(build!).getByText("Apple: processing")).toBeTruthy();
  });

  it("points to Integrations when App Store Connect is not configured", async () => {
    mocks.getAppStoreReview.mockResolvedValue({ configured: false });
    renderPage(<AppStoreReview appId="app-1" />);
    expect(await screen.findByText("App Store Connect not configured")).toBeTruthy();
    expect(screen.getByText("Open Integrations").closest("a")!.getAttribute("href")).toBe("/apps/app-1/integrations");
  });

  it("points to Channels when the main channel has no bundle ID", async () => {
    mocks.getAppStoreReview.mockResolvedValue({ configured: true, bundle_id: null, error: "no bundle id" });
    renderPage(<AppStoreReview appId="app-1" />);
    expect(await screen.findByText("No App Store bundle ID configured")).toBeTruthy();
    expect(screen.getByText("Open Channels").closest("a")!.getAttribute("href")).toBe("/apps/app-1/channels");
  });

  it("shows Apple's error with the bundle ID", async () => {
    mocks.getAppStoreReview.mockResolvedValue({ configured: true, bundle_id: "build.deck", error: "ASC 401 NOT_AUTHORIZED" });
    renderPage(<AppStoreReview appId="app-1" />);
    expect(await screen.findByText("ASC 401 NOT_AUTHORIZED")).toBeTruthy();
    expect(screen.getByText("build.deck")).toBeTruthy();
  });

  it("does not ask App Store Connect for a non-iOS app", async () => {
    mocks.listApps.mockResolvedValue({ apps: [app("android")] });
    renderPage(<AppStoreReview appId="app-1" />);
    expect(await screen.findByText("Only for iOS apps")).toBeTruthy();
    await waitFor(() => expect(mocks.getAppStoreReview).not.toHaveBeenCalled());
  });
});
