// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
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
    expect(await screen.findByTestId("google-play-binding-panel")).toBeTruthy();
    const inactive = await screen.findAllByText(/^Only for .* apps$/);
    expect(inactive.map((el) => el.textContent)).toEqual([
      "Only for iOS apps",
      "Only for HarmonyOS apps",
    ]);
    expect(screen.getByTestId("connector-inactive-testflight")).toBeTruthy();
    expect(screen.getByTestId("connector-inactive-appgallery")).toBeTruthy();
  });

  it("keeps the other platforms visible but inactive for an iOS app", async () => {
    mocks.listApps.mockResolvedValue(appWith("ios"));
    renderPage();
    expect(await screen.findByTestId("testflight-connector")).toBeTruthy();
    const inactive = await screen.findAllByText(/^Only for .* apps$/);
    expect(inactive.map((el) => el.textContent)).toEqual([
      "Only for Android apps",
      "Only for HarmonyOS apps",
    ]);
    expect(screen.getByTestId("connector-inactive-google-play")).toBeTruthy();
    expect(screen.queryByTestId("google-play-binding-panel")).toBeNull();
  });
});
