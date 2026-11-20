// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listApps: vi.fn(),
  listChannels: vi.fn(),
  listReleases: vi.fn(),
  getReleaseHealth: vi.fn(),
  getDeviceAnalytics: vi.fn(),
  getVersionMetrics: vi.fn(),
  listOperations: vi.fn(),
  retryOperation: vi.fn(),
  streamOperations: vi.fn(() => ({ close: () => {} })),
}));

vi.mock("../components/Toast", () => ({
  useToast: () => ({ show: vi.fn(() => "t"), update: vi.fn() }),
}));

vi.mock("../lib/api", async (importOriginal) => ({
  ...await importOriginal<typeof import("../lib/api")>(),
  ...mocks,
}));

import { AppDetail } from "./AppDetail";
import { latestReleaseByChannel } from "../components/LatestReleases";
import type { Release } from "../lib/api";

const NOW = Date.now();
const release = (id: string, channel_id: string, product_type: string, at: number, status = "active") =>
  ({ id, channel_id, product_type, status, activated_at: at, created_at: at, version_name: id, version_code: 1 } as unknown as Release);

function renderOverview() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <AppDetail appId="app-1" />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

afterEach(() => { cleanup(); localStorage.clear(); });

describe("latestReleaseByChannel", () => {
  it("keeps the newest active release per channel and counts live product types", () => {
    const map = latestReleaseByChannel([
      release("old", "c1", "android-apk", 1),
      release("new", "c1", "ios-ipa", 5),
      release("gone", "c1", "android-apk", 9, "superseded"),
      release("p", "c2", "android-apk", 3),
    ]);
    expect(map.get("c1")?.latest.id).toBe("new");
    expect(map.get("c1")?.liveTypes).toBe(2);
    expect(map.get("c2")?.latest.id).toBe("p");
  });
});

describe("App overview", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listApps.mockResolvedValue({ apps: [{ id: "app-1", slug: "deck", name: "Deck", platform: "android", archived: 0, org_id: null, description: null, archived_at: null, created_at: 1 }] });
    mocks.getReleaseHealth.mockResolvedValue({ window_days: 30, since: 0, totals: { sessions: 0, crashed_sessions: 0, crash_free_sessions_pct: null, devices: 0, crashed_devices: 0, crash_free_devices_pct: null }, versions: [] });
    mocks.getDeviceAnalytics.mockResolvedValue({ active_devices: 0, window_start: 0, by_version: [], by_platform: [], by_channel: [] });
    mocks.getVersionMetrics.mockResolvedValue({ window_start: 0, window_days: 30, window_minutes: 0, versions: [] });
    mocks.listReleases.mockResolvedValue({ releases: [] });
  });

  it("shows an empty state per section and offers Create channel when there is none", async () => {
    mocks.listChannels.mockResolvedValue({ channels: [] });
    mocks.listOperations.mockResolvedValue({ operations: [] });
    renderOverview();
    expect(await screen.findByRole("heading", { level: 1, name: "Overview" })).toBeTruthy();
    expect(await screen.findByText("No channels yet")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Create channel" }).getAttribute("href")).toBe("/apps/app-1/channels");
    expect(screen.queryByRole("link", { name: "Publish release" })).toBeNull();
    expect(await screen.findByText("No session data yet")).toBeTruthy();
    expect(await screen.findByText("No devices yet")).toBeTruthy();
    expect(await screen.findByText("No operations yet")).toBeTruthy();
  });

  it("lists the latest release per channel and retries a failed operation", async () => {
    mocks.listChannels.mockResolvedValue({ channels: [{ id: "c1", slug: "main", name: "Main" }, { id: "c2", slug: "nightly", name: "Nightly" }] });
    mocks.listReleases.mockResolvedValue({ releases: [{ ...release("r1", "c1", "android-apk", NOW - 60_000), version_name: "1.2.0", version_code: 120, rollout_cohort_count: 25 }] });
    mocks.listOperations.mockResolvedValue({ operations: [{ id: "op1", app_id: "app-1", kind: "upload", status: "failed", parent_op_id: null, step_number: null, actor: "x", input: "{}", output: "{}", error: "timed out", progress: 0, retry_count: 0, created_at: NOW, updated_at: NOW, completed_at: null }] });
    mocks.retryOperation.mockResolvedValue({ retry_count: 1 });
    renderOverview();
    expect(await screen.findByText(/1\.2\.0 \(120\) · android-apk/)).toBeTruthy();
    expect(screen.getByText("25% rollout")).toBeTruthy();
    expect(screen.getByText("No release yet")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Publish release" }).getAttribute("href")).toBe("/apps/app-1/releases");
    expect(await screen.findByText("timed out")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(mocks.retryOperation).toHaveBeenCalledWith("app-1", "op1"));
  });
});
