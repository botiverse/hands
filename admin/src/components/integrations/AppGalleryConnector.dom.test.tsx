// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getAgc: vi.fn(),
  saveAgc: vi.fn(),
  deleteAgc: vi.fn(),
  verifyAgc: vi.fn(),
  toast: vi.fn(),
}));

vi.mock("../Toast", () => ({
  useToast: () => ({ show: mocks.toast }),
}));

vi.mock("../../lib/api", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../lib/api")>(),
  getAgcCredentials: mocks.getAgc,
  setAgcCredentials: mocks.saveAgc,
  deleteAgcCredentials: mocks.deleteAgc,
  verifyAgcCredentials: mocks.verifyAgc,
}));

import { AppGalleryConnector } from "./AppGalleryConnector";

afterEach(cleanup);

function renderConnector() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <AppGalleryConnector appId="app-a" />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.saveAgc.mockResolvedValue({ ok: true });
  mocks.deleteAgc.mockResolvedValue({ ok: true });
});

describe("AppGalleryConnector", () => {
  it("keeps the unconnected state on one row and opens the file form on Configure", async () => {
    mocks.getAgc.mockResolvedValue({ agc_credentials: null });
    renderConnector();
    const configure = await screen.findByRole("button", { name: "Configure" });
    await waitFor(() => expect(configure.hasAttribute("disabled")).toBe(false));
    expect(screen.queryByText("AGC Service Account private JSON")).toBeNull();
    fireEvent.click(configure);
    expect(await screen.findByText("AGC Service Account private JSON")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Choose JSON file/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Save credential" }).hasAttribute("disabled")).toBe(true);
  });

  it("shows credential metadata on the configured row and expands to actions", async () => {
    mocks.getAgc.mockResolvedValue({
      agc_credentials: {
        credential_kind: "service_account",
        sub_account: "agc@project.iam",
        key_id: "agckey_9f2",
        project_id: "hands-preview",
        region: "cn-north",
        credential_fingerprint: "9f2c41ab77d0e5c3",
        updated_at: 1759200000000,
      },
    });
    renderConnector();
    expect(await screen.findByText("Configured")).toBeTruthy();
    expect(screen.getByText(/Sub-account agc@project.iam/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Expand" }));
    expect(await screen.findByRole("button", { name: "Test connection" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Replace credential" }));
    expect(await screen.findByText("AGC Service Account private JSON")).toBeTruthy();
  });

  it("removes the credential after confirmation", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    mocks.getAgc.mockResolvedValue({
      agc_credentials: {
        credential_kind: "service_account",
        sub_account: "agc@project.iam",
        key_id: "agckey_9f2",
        project_id: "hands-preview",
        region: "cn-north",
        credential_fingerprint: "9f2c41ab77d0e5c3",
        updated_at: 1759200000000,
      },
    });
    renderConnector();
    fireEvent.click(await screen.findByRole("button", { name: "Expand" }));
    fireEvent.click(await screen.findByRole("button", { name: "Remove" }));
    await waitFor(() => expect(mocks.deleteAgc).toHaveBeenCalledWith("app-a"));
  });
});
