// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  save: vi.fn(),
  verify: vi.fn(),
  toggle: vi.fn(),
  remove: vi.fn(),
  toast: vi.fn(),
}));

vi.mock("../components/Toast", () => ({
  useToast: () => ({ show: mocks.toast }),
}));

vi.mock("../lib/api", async (importOriginal) => ({
  ...await importOriginal<typeof import("../lib/api")>(),
  getGooglePlayBinding: mocks.get,
  setGooglePlayBinding: mocks.save,
  verifyGooglePlayBinding: mocks.verify,
  setGooglePlayBindingEnabled: mocks.toggle,
  deleteGooglePlayBinding: mocks.remove,
}));

import { GooglePlayPanel } from "./AppDetail";

afterEach(cleanup);

function renderPanel() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <GooglePlayPanel appId="app-a" />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.save.mockResolvedValue({ google_play: {} });
  mocks.verify.mockResolvedValue({ ok: true });
  mocks.toggle.mockResolvedValue({ ok: true });
  mocks.remove.mockResolvedValue({ ok: true });
});

describe("GooglePlayPanel", () => {
  it("shows app-scoped binding metadata and enables only through the explicit action", async () => {
    mocks.get.mockResolvedValue({
      google_play: {
        enabled: false,
        verification_state: "stale",
        package_name: "build.raft.app",
        service_account_email: "app@tenant.example",
        internal_track: "qa",
        closed_track: "closed",
        production_track: "production",
      },
    });
    renderPanel();

    expect(await screen.findByText("build.raft.app")).toBeTruthy();
    expect(screen.getByText("Disabled")).toBeTruthy();
    expect(screen.getByTestId("google-play-binding-panel").textContent).toContain("Needs verification");
    fireEvent.click(screen.getByRole("button", { name: "Enable" }));
    await waitFor(() => expect(mocks.toggle).toHaveBeenCalledWith("app-a", true));
  });

  it("requires a complete service-account file and package before save", async () => {
    mocks.get.mockResolvedValue({ google_play: null });
    renderPanel();

    const save = await screen.findByRole("button", { name: "Validate, save & enable" });
    expect(save.hasAttribute("disabled")).toBe(true);
    fireEvent.change(screen.getByLabelText("Android package name"), { target: { value: "build.raft.app" } });
    const file = new File(["fixture"], "service-account.json", { type: "application/json" });
    Object.defineProperty(file, "text", {
      value: async () => JSON.stringify({
        type: "service_account",
        client_email: "app@tenant.example",
        private_key: "-----BEGIN PRIVATE KEY-----\\ntest\\n-----END PRIVATE KEY-----",
      }),
    });
    fireEvent.change(screen.getByLabelText("Choose JSON file"), { target: { files: [file] } });

    await waitFor(() => expect(save.hasAttribute("disabled")).toBe(false));
    fireEvent.click(save);
    await waitFor(() => expect(mocks.save).toHaveBeenCalledWith("app-a", expect.objectContaining({
      package_name: "build.raft.app",
      tracks: { internal: "internal", closed: "closed", production: "production" },
    })));
    expect(JSON.stringify(mocks.save.mock.calls[0]?.[1])).toContain("service_account");
  });

  it("refreshes binding state after a rejected verification disables it", async () => {
    mocks.get
      .mockResolvedValueOnce({
        google_play: {
          enabled: true,
          verification_state: "verified",
          package_name: "build.raft.app",
          service_account_email: "app@tenant.example",
          internal_track: "internal",
          closed_track: "closed",
          production_track: "production",
        },
      })
      .mockResolvedValue({
        google_play: {
          enabled: false,
          verification_state: "stale",
          package_name: "build.raft.app",
          service_account_email: "app@tenant.example",
          internal_track: "internal",
          closed_track: "closed",
          production_track: "production",
        },
      });
    mocks.verify.mockRejectedValue(new Error("permission denied"));
    renderPanel();

    fireEvent.click(await screen.findByRole("button", { name: "Test connection" }));
    await waitFor(() => expect(mocks.get).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByTestId("google-play-binding-panel").textContent).toContain("Needs verification"));
    expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({ kind: "error" }));
  });
});
