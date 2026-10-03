// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getAsc: vi.fn(),
  saveAsc: vi.fn(),
  deleteAsc: vi.fn(),
  verifyAsc: vi.fn(),
  toast: vi.fn(),
}));

vi.mock("../Toast", () => ({
  useToast: () => ({ show: mocks.toast }),
}));

vi.mock("../../lib/api", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../lib/api")>(),
  getAscCredentials: mocks.getAsc,
  setAscCredentials: mocks.saveAsc,
  deleteAscCredentials: mocks.deleteAsc,
  verifyAscCredentials: mocks.verifyAsc,
}));

import { TestFlightConnector } from "./TestFlightConnector";

afterEach(cleanup);

function renderConnector() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <TestFlightConnector appId="app-a" />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.saveAsc.mockResolvedValue({ ok: true });
  mocks.deleteAsc.mockResolvedValue({ ok: true });
});

describe("TestFlightConnector", () => {
  it("keeps the unconnected state on one row and opens the form on Configure", async () => {
    mocks.getAsc.mockResolvedValue({ asc_credentials: null });
    renderConnector();
    const configure = await screen.findByRole("button", { name: "Configure" });
    await waitFor(() => expect(configure.hasAttribute("disabled")).toBe(false));
    expect(screen.queryByPlaceholderText("ABC123DEFG")).toBeNull();
    fireEvent.click(configure);
    expect(await screen.findByPlaceholderText("ABC123DEFG")).toBeTruthy();
  });

  it("saves trimmed credentials from the opened form", async () => {
    mocks.getAsc.mockResolvedValue({ asc_credentials: null });
    renderConnector();
    const configure = await screen.findByRole("button", { name: "Configure" });
    await waitFor(() => expect(configure.hasAttribute("disabled")).toBe(false));
    fireEvent.click(configure);
    fireEvent.change(await screen.findByPlaceholderText("ABC123DEFG"), { target: { value: " KEY123 " } });
    fireEvent.change(screen.getByPlaceholderText("12345678-90ab-cdef-1234-567890abcdef"), { target: { value: " ISS-1 " } });
    fireEvent.change(screen.getByPlaceholderText(/BEGIN PRIVATE KEY/), { target: { value: "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----" } });
    const save = screen.getByRole("button", { name: "Save & enable" });
    await waitFor(() => expect(save.hasAttribute("disabled")).toBe(false));
    fireEvent.click(save);
    await waitFor(() =>
      expect(mocks.saveAsc).toHaveBeenCalledWith("app-a", {
        key_id: "KEY123",
        issuer_id: "ISS-1",
        p8: "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----",
      }),
    );
  });

  it("shows the configured row collapsed with an expand affordance", async () => {
    mocks.getAsc.mockResolvedValue({
      asc_credentials: { key_id: "ABC123DEFG", issuer_id: "ISS-1", updated_at: 1759200000000 },
    });
    renderConnector();
    expect(await screen.findByText("Configured")).toBeTruthy();
    const expand = screen.getByRole("button", { name: "Expand" });
    fireEvent.click(expand);
    expect(await screen.findByRole("button", { name: "Test connection" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Replace key" }));
    expect(await screen.findByPlaceholderText("ABC123DEFG")).toBeTruthy();
  });

  it("removes the key after confirmation", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    mocks.getAsc.mockResolvedValue({
      asc_credentials: { key_id: "ABC123DEFG", issuer_id: "ISS-1", updated_at: 1759200000000 },
    });
    renderConnector();
    fireEvent.click(await screen.findByRole("button", { name: "Expand" }));
    fireEvent.click(await screen.findByRole("button", { name: "Remove" }));
    await waitFor(() => expect(mocks.deleteAsc).toHaveBeenCalledWith("app-a"));
  });
});
