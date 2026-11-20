// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listApps: vi.fn(),
  getAuthMe: vi.fn(),
  listChannels: vi.fn(),
  updateAppDeltaUpdates: vi.fn(),
  listDeviceGroups: vi.fn(),
  deleteDeviceGroup: vi.fn(),
  getRaftNotificationConfig: vi.fn(),
  getAppClientKey: vi.fn(),
  toast: vi.fn(),
}));

vi.mock("../components/Toast", () => ({ useToast: () => ({ show: mocks.toast }) }));
vi.mock("./AppAccess", () => ({ AppAccess: () => null }));
vi.mock("../lib/api", async (importOriginal) => ({
  ...await importOriginal<typeof import("../lib/api")>(),
  ...mocks,
}));

import { AppSettings } from "./AppSettings";

afterEach(() => cleanup());

function renderSettings() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <AppSettings appId="app-1" />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

describe("App settings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listApps.mockResolvedValue({
      apps: [{ id: "app-1", org_id: "o", slug: "deck-android", name: "Deck", platform: "android", description: null, archived: 0, archived_at: null, created_at: 1, delta_updates_enabled: 0 }],
    });
    mocks.getAuthMe.mockResolvedValue({ authenticated: true, account: { org_role: "owner" } });
    mocks.listChannels.mockResolvedValue({ channels: [] });
    mocks.getAppClientKey.mockResolvedValue({ client_key: "hck_1" });
    mocks.getRaftNotificationConfig.mockResolvedValue({ bot: { connected: false }, events: [], subscriptions: [] });
    mocks.listDeviceGroups.mockResolvedValue({
      groups: [{ id: "qa", app_id: "app-1", name: "QA team", description: null, member_count: 1, members: [{ group_id: "qa", device_id: "dev-1", label: "Pixel", created_at: 1 }], created_at: 1, updated_at: 1 }],
    });
  });

  it("groups the settings into sections with the danger zone last", async () => {
    renderSettings();
    await screen.findByRole("heading", { name: "General" });
    const headings = screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent);
    expect(headings[0]).toBe("General");
    expect(headings.at(-1)).toBe("Danger zone");
    expect(headings).toContain("Device groups");
  });

  it("applies a switch at once, with no Save, and says so under the row when it fails", async () => {
    mocks.updateAppDeltaUpdates.mockRejectedValue(new Error("boom"));
    renderSettings();
    const toggle = await screen.findByRole("switch", { name: "Delta updates" });
    fireEvent.click(toggle);
    await waitFor(() => expect(mocks.updateAppDeltaUpdates).toHaveBeenCalledWith("app-1", true));
    expect(await screen.findByText(/Not saved: boom/)).toBeTruthy();
    // The switch shows the stored value again.
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(mocks.toast).not.toHaveBeenCalled();
  });

  it("opens a device group beside the page and deletes it only after confirming", async () => {
    mocks.deleteDeviceGroup.mockResolvedValue({ ok: true });
    renderSettings();
    fireEvent.click(await screen.findByRole("button", { name: /QA team/ }));
    const column = await screen.findByRole("region", { name: /Device group: QA team/ });
    expect(within(column).getByText("dev-1")).toBeTruthy();
    fireEvent.click(within(column).getByRole("button", { name: /Delete group/ }));
    expect(mocks.deleteDeviceGroup).not.toHaveBeenCalled();
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete group" }));
    await waitFor(() => expect(mocks.deleteDeviceGroup).toHaveBeenCalledWith("app-1", "qa"));
  });
});
