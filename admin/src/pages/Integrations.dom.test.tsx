// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listApps: vi.fn(),
  binding: vi.fn(),
  channels: vi.fn(),
  builds: vi.fn(),
  asc: vi.fn(),
  agc: vi.fn(),
  toast: vi.fn(),
}));

vi.mock("react-router-dom", () => ({
  useParams: () => ({ appId: "app-a" }),
}));

vi.mock("../components/Toast", () => ({
  useToast: () => ({ show: mocks.toast }),
}));

vi.mock("../lib/api", async (importOriginal) => ({
  ...await importOriginal<typeof import("../lib/api")>(),
  listApps: mocks.listApps,
  getGooglePlayBinding: mocks.binding,
  listChannels: mocks.channels,
  listBuilds: mocks.builds,
  getAscCredentials: mocks.asc,
  getAgcCredentials: mocks.agc,
}));

import { Integrations } from "./Integrations";

afterEach(cleanup);

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <Integrations appId="app-a" />
    </QueryClientProvider>,
  );
}

function appWith(platform: "android" | "ios" | "ohos") {
  return {
    apps: [
      {
        id: "app-a",
        org_id: "org-1",
        slug: "preview",
        name: "Preview",
        platform,
        description: null,
        archived: 0,
        archived_at: null,
        created_at: 0,
        release_requires_human_approval: 0,
      },
    ],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.binding.mockResolvedValue({ google_play: null, oauth_available: true });
  mocks.channels.mockResolvedValue({ channels: [] });
  mocks.builds.mockResolvedValue({ builds: [] });
  mocks.asc.mockResolvedValue({ asc_credentials: null });
  mocks.agc.mockResolvedValue({ agc_credentials: null });
});

describe("Integrations page", () => {
  it("lists every connector for an Android app and only activates Google Play", async () => {
    mocks.listApps.mockResolvedValue(appWith("android"));
    renderPage();
    expect(await screen.findByTestId("connector-row-google-play")).toBeTruthy();
    const inactive = await screen.findAllByText(/^Only for .* apps$/);
    expect(inactive.map((el) => el.textContent)).toEqual([
      "Only for iOS apps",
      "Only for HarmonyOS apps",
    ]);
    expect(screen.getByTestId("connector-inactive-testflight")).toBeTruthy();
    expect(screen.getByTestId("connector-inactive-appgallery")).toBeTruthy();
    expect(screen.queryByTestId("connector-row-testflight")).toBeNull();
    // Inactive rows are not buttons: nothing opens for another platform.
    expect(screen.getByTestId("connector-inactive-testflight").tagName).not.toBe("BUTTON");
  });

  it("keeps the other platforms visible but inactive for an iOS app", async () => {
    mocks.listApps.mockResolvedValue(appWith("ios"));
    renderPage();
    expect(await screen.findByTestId("connector-row-testflight")).toBeTruthy();
    const inactive = await screen.findAllByText(/^Only for .* apps$/);
    expect(inactive.map((el) => el.textContent)).toEqual([
      "Only for Android apps",
      "Only for HarmonyOS apps",
    ]);
    expect(screen.getByTestId("connector-inactive-google-play")).toBeTruthy();
    expect(screen.queryByTestId("google-play-binding-panel")).toBeNull();
  });

  it("says on each row whether the connector is connected or needs attention", async () => {
    mocks.listApps.mockResolvedValue(appWith("android"));
    mocks.binding.mockResolvedValue({
      google_play: { credential_kind: "authorized_user", enabled: true, verification_state: "stale", package_name: "build.raft.app", service_account_email: "human@example.com", internal_track: "internal", closed_track: "closed", production_track: "production" },
      reports_grant: null,
      oauth_available: true,
    });
    renderPage();
    const row = await screen.findByTestId("connector-row-google-play");
    expect(await within(row).findByText("Needs attention")).toBeTruthy();
    expect(within(row).getAllByText(/build\.raft\.app · Needs verification/).length).toBeGreaterThan(0);
    cleanup();
    mocks.binding.mockResolvedValue({ google_play: null, oauth_available: true });
    renderPage();
    expect(await within(await screen.findByTestId("connector-row-google-play")).findByText("Not connected")).toBeTruthy();
    cleanup();
    mocks.listApps.mockResolvedValue(appWith("ios"));
    mocks.asc.mockResolvedValue({ asc_credentials: { key_id: "ABC123DEFG", issuer_id: "ISS-1", updated_at: 1759200000000 } });
    renderPage();
    const tf = await screen.findByTestId("connector-row-testflight");
    expect(await within(tf).findByText("Connected")).toBeTruthy();
  });

  it("opens a connector's configuration beside the list and closes it", async () => {
    mocks.listApps.mockResolvedValue(appWith("ios"));
    renderPage();
    const row = await screen.findByTestId("connector-row-testflight");
    expect(screen.queryByTestId("testflight-connector")).toBeNull();
    fireEvent.click(row);
    const column = await screen.findByRole("region", { name: "TestFlight" });
    expect(within(column).getByTestId("testflight-connector")).toBeTruthy();
    expect(await within(column).findByPlaceholderText("ABC123DEFG")).toBeTruthy();
    expect(row.getAttribute("aria-current")).toBe("true");
    fireEvent.click(within(column).getByRole("button", { name: "Close" }));
    expect(screen.queryByTestId("testflight-connector")).toBeNull();
  });

  it("opens Google Play when Google returns from authorization", async () => {
    window.history.replaceState(null, "", "/apps/app-a/integrations?google_play_oauth=failed");
    mocks.listApps.mockResolvedValue(appWith("android"));
    renderPage();
    expect(await screen.findByTestId("google-play-binding-panel")).toBeTruthy();
    expect(await screen.findByText(/Google authorization failed/)).toBeTruthy();
    window.history.replaceState(null, "", "/");
  });
});
