// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listApps: vi.fn(),
  getAuthMe: vi.fn(),
  listChannels: vi.fn(),
  listProductTypes: vi.fn(),
  createApp: vi.fn(),
  toast: vi.fn(() => "t1"),
  toastUpdate: vi.fn(),
}));

vi.mock("../components/Toast", () => ({
  useToast: () => ({ show: mocks.toast, update: mocks.toastUpdate }),
}));

vi.mock("../lib/api", async (importOriginal) => ({
  ...await importOriginal<typeof import("../lib/api")>(),
  listApps: mocks.listApps,
  getAuthMe: mocks.getAuthMe,
  listChannels: mocks.listChannels,
  listProductTypes: mocks.listProductTypes,
  createApp: mocks.createApp,
}));

import { AppsList } from "./AppsList";

const app = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
  id, org_id: "org-1", slug: name.toLowerCase().replace(/\s+/g, "-"), name, platform: "android",
  description: null, archived: 0, archived_at: null, created_at: 1, ...extra,
});

function renderList(props: { initialShowCreate?: boolean } = {}) {
  const onSelectApp = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <AppsList onSelectApp={onSelectApp} {...props} />
      </QueryClientProvider>
    </MemoryRouter>,
  );
  return { onSelectApp };
}

afterEach(() => { cleanup(); localStorage.clear(); });

describe("AppsList", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listApps.mockResolvedValue({
      apps: [
        app("a1", "Raft Deck", { platform: "electron", description: "Desktop app" }),
        app("a2", "Old Deck", { archived: 1, archived_at: 1 }),
      ],
    });
    mocks.getAuthMe.mockResolvedValue({ authenticated: true, account: { org_id: "org-1" } });
    mocks.listChannels.mockResolvedValue({ channels: [{ id: "c1" }, { id: "c2" }] });
    mocks.listProductTypes.mockResolvedValue({ product_types: [{ id: "p1" }] });
    mocks.createApp.mockResolvedValue({ id: "a3" });
  });

  it("lists active apps as rows with the platform tag and opens one", async () => {
    const { onSelectApp } = renderList();
    const row = await screen.findByRole("button", { name: /Raft Deck/ });
    expect(row.textContent).toContain("Electron");
    expect(row.textContent).toContain("raft-deck");
    expect(await screen.findByText(/2 channels · 1 product type$/)).toBeTruthy();
    expect(screen.queryByText("Old Deck")).toBeNull();
    fireEvent.click(row);
    expect(onSelectApp).toHaveBeenCalledWith("a1");
  });

  it("shows archived apps under the Archived scope", async () => {
    renderList();
    await screen.findByText("Raft Deck");
    fireEvent.click(screen.getByRole("radio", { name: /Archived/ }));
    expect(await screen.findByText("Old Deck")).toBeTruthy();
    expect(screen.getAllByText("Archived").length).toBeGreaterThan(1);
    expect(screen.queryByText("Raft Deck")).toBeNull();
  });

  it("says when every app is archived", async () => {
    mocks.listApps.mockResolvedValue({ apps: [app("a2", "Old Deck", { archived: 1 })] });
    renderList();
    expect(await screen.findByText("No active apps")).toBeTruthy();
  });

  it("creates an app from the New app dialog with the derived slug", async () => {
    renderList();
    await screen.findByText("Raft Deck");
    fireEvent.click(screen.getByRole("button", { name: "New app" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "My Cool App" } });
    expect((screen.getByLabelText("Slug") as HTMLInputElement).value).toBe("my-cool-app");
    fireEvent.click(screen.getByRole("button", { name: "Create app" }));
    await waitFor(() => expect(mocks.createApp).toHaveBeenCalledWith({
      slug: "my-cool-app", name: "My Cool App", platform: "android", description: undefined,
    }));
    await waitFor(() => expect(dialog.isConnected).toBe(false));
  });

  it("opens the dialog at once for the ?new=1 flow", async () => {
    renderList({ initialShowCreate: true });
    expect(await screen.findByRole("dialog")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Create app" }).hasAttribute("disabled")).toBe(true);
  });
});
