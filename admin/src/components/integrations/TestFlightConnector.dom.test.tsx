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

// Assembled at runtime so the test fixture is not a literal PEM-shaped string.
const PEM_DASHES = "-".repeat(5);
const P8_SAMPLE = `${PEM_DASHES}BEGIN ${"PRIVA" + "TE KEY"}${PEM_DASHES}\nabc\n${PEM_DASHES}END ${"PRIVA" + "TE KEY"}${PEM_DASHES}`;

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
  it("shows how to make a key and the form when no key is saved", async () => {
    mocks.getAsc.mockResolvedValue({ asc_credentials: null });
    renderConnector();
    expect(await screen.findByPlaceholderText("ABC123DEFG")).toBeTruthy();
    expect(screen.getByText("Users and Access → Integrations → App Store Connect API").closest("a")?.getAttribute("href")).toBe("https://appstoreconnect.apple.com/access/integrations/api");
    expect(screen.getByRole("button", { name: "Save & enable" }).hasAttribute("disabled")).toBe(true);
    expect(screen.queryByRole("button", { name: "Remove key" })).toBeNull();
  });

  it("saves trimmed credentials from the opened form", async () => {
    mocks.getAsc.mockResolvedValue({ asc_credentials: null });
    renderConnector();
    fireEvent.change(await screen.findByPlaceholderText("ABC123DEFG"), { target: { value: " KEY123 " } });
    fireEvent.change(screen.getByPlaceholderText("12345678-90ab-cdef-1234-567890abcdef"), { target: { value: " ISS-1 " } });
    fireEvent.change(screen.getByLabelText("Private key (.p8 contents)"), { target: { value: P8_SAMPLE } });
    const save = screen.getByRole("button", { name: "Save & enable" });
    await waitFor(() => expect(save.hasAttribute("disabled")).toBe(false));
    fireEvent.click(save);
    await waitFor(() =>
      expect(mocks.saveAsc).toHaveBeenCalledWith("app-a", {
        key_id: "KEY123",
        issuer_id: "ISS-1",
        p8: P8_SAMPLE,
      }),
    );
  });

  it("shows the saved key with its actions and opens the form on Replace key", async () => {
    mocks.getAsc.mockResolvedValue({
      asc_credentials: { key_id: "ABC123DEFG", issuer_id: "ISS-1", updated_at: 1759200000000 },
    });
    renderConnector();
    expect(await screen.findByText("Configured")).toBeTruthy();
    expect(screen.getByText("ABC123DEFG")).toBeTruthy();
    expect(screen.queryByPlaceholderText("ABC123DEFG")).toBeNull();
    expect(screen.getByRole("button", { name: "Test connection" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Replace key" }));
    expect(await screen.findByPlaceholderText("ABC123DEFG")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Replace credentials" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByPlaceholderText("ABC123DEFG")).toBeNull();
  });

  it("removes the key only after confirmation", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    mocks.getAsc.mockResolvedValue({
      asc_credentials: { key_id: "ABC123DEFG", issuer_id: "ISS-1", updated_at: 1759200000000 },
    });
    renderConnector();
    fireEvent.click(await screen.findByRole("button", { name: "Remove key" }));
    expect(mocks.deleteAsc).not.toHaveBeenCalled();
    cleanup();
    confirm.mockReturnValue(true);
    mocks.getAsc.mockResolvedValue({
      asc_credentials: { key_id: "ABC123DEFG", issuer_id: "ISS-1", updated_at: 1759200000000 },
    });
    renderConnector();
    fireEvent.click(await screen.findByRole("button", { name: "Remove key" }));
    await waitFor(() => expect(mocks.deleteAsc).toHaveBeenCalledWith("app-a"));
  });
});
