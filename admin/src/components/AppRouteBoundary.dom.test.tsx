// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppRouteBoundary } from "./AppRouteBoundary";
const mocks = vi.hoisted(() => ({ listApps: vi.fn(), child: vi.fn() }));
vi.mock("../lib/api", () => ({ listApps: mocks.listApps }));
const id = "849173ce-c3ae-4c2d-8674-d54661c1eb8e";
function Child() { mocks.child(); return <div>Settings controls</div>; }
function open(appId: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><MemoryRouter>
    <AppRouteBoundary appId={appId}><Child /></AppRouteBoundary>
  </MemoryRouter></QueryClientProvider>);
}
beforeEach(() => { vi.clearAllMocks(); localStorage.clear(); });
afterEach(cleanup);
describe("application route boundary", () => {
  it.each(["invalid", "ferry-ios"])("rejects %s without mounting settings or persisting it", (appId) => {
    open(appId);
    expect(screen.getByRole("alert").textContent).toContain("full application UUID");
    expect(screen.getByRole("link").getAttribute("href")).toBe("/apps");
    expect(mocks.listApps).not.toHaveBeenCalled();
    expect(mocks.child).not.toHaveBeenCalled();
    expect(localStorage.getItem("quiver:last-app-id")).toBeNull();
  });
  it("does not mount controls for an absent or inaccessible UUID", async () => {
    mocks.listApps.mockResolvedValue({ apps: [] });
    open(id);
    expect((await screen.findByRole("alert")).textContent).toContain("Application unavailable");
    expect(mocks.child).not.toHaveBeenCalled();
    expect(localStorage.getItem("quiver:last-app-id")).toBeNull();
  });
  it("waits for membership discovery before mounting controls", async () => {
    let resolve!: (value: { apps: Array<{ id: string }> }) => void;
    mocks.listApps.mockReturnValue(new Promise((done) => { resolve = done; }));
    open(id);
    expect(screen.getByRole("status").textContent).toContain("Loading application");
    expect(mocks.child).not.toHaveBeenCalled();
    resolve({ apps: [{ id }] });
    await screen.findByText("Settings controls");
    await waitFor(() => expect(localStorage.getItem("quiver:last-app-id")).toBe(id));
  });
  it("shows a recoverable message on discovery failure", async () => {
    mocks.listApps.mockRejectedValue(new Error("network failure"));
    open(id);
    expect((await screen.findByRole("alert")).textContent).toContain("could not load");
    expect(mocks.child).not.toHaveBeenCalled();
  });
});
