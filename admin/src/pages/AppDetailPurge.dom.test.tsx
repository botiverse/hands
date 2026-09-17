// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listApps: vi.fn(),
  getAuthMe: vi.fn(),
  purgeApp: vi.fn(),
  listChannels: vi.fn(),
  toast: vi.fn(),
}));

vi.mock("../components/Toast", () => ({
  useToast: () => ({ show: mocks.toast }),
}));

vi.mock("../lib/api", async (importOriginal) => ({
  ...await importOriginal<typeof import("../lib/api")>(),
  listApps: mocks.listApps,
  getAuthMe: mocks.getAuthMe,
  purgeApp: mocks.purgeApp,
  listChannels: mocks.listChannels,
}));

import { AppSettings } from "./AppDetail";

afterEach(cleanup);

function renderApp() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <AppSettings appId="app-1" />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

describe("AppDetail purge confirmation gate", () => {
  // The gate lives in the CALLER, not in the dialog: ConfirmActionDialog renders the field but
  // owns no state, so it is the caller that must supply confirmDisabled and must submit the
  // typed value. An earlier version of this suite tested a local harness that hard-coded a
  // correct caller, so reverting the real caller to its defective state left every test green -
  // it could not see the bug it claimed to guard. These tests drive the REAL component.
  beforeEach(() => {
    vi.clearAllMocks();
    // The purge button is offered only to an org admin for an ARCHIVED app; both facts come
    // from separate queries, so both are mocked here to reach the real dialog.
    mocks.listApps.mockResolvedValue({
      apps: [{
        id: "app-1",
        slug: "myapp-android",
        name: "My App",
        platform: "android",
        archived: 1,
        archived_at: 1,
        created_at: 1,
      }],
    });
    mocks.getAuthMe.mockResolvedValue({ authenticated: true, account: { org_role: "owner" } });
    mocks.listChannels.mockResolvedValue({ channels: [] });
    mocks.purgeApp.mockResolvedValue({ ok: true, purged_app_id: "app-1", r2_objects_deleted: 3 });
  });

  async function openPurgeDialog() {
    renderApp();
    // Purge is offered only for an archived app.
    const open = await screen.findByRole("button", { name: /purge permanently/i });
    fireEvent.click(open);
    return screen.findByRole("alertdialog");
  }

  it("keeps Confirm disabled until the typed slug matches exactly", async () => {
    await openPurgeDialog();
    const field = screen.getByRole("textbox");
    const confirm = screen.getByRole("button", { name: /purge permanently/i });

    // Nothing typed: the destructive action must be unreachable.
    expect((field as HTMLInputElement).value).toBe("");
    expect((confirm as HTMLButtonElement).disabled).toBe(true);

    // Typing must reach the field (the original defect was a no-op onChange).
    fireEvent.change(field, { target: { value: "myapp-androi" } });
    expect((field as HTMLInputElement).value).toBe("myapp-androi");
    expect((confirm as HTMLButtonElement).disabled).toBe(true);

    // Only the exact slug arms it.
    fireEvent.change(field, { target: { value: "myapp-android" } });
    expect((confirm as HTMLButtonElement).disabled).toBe(false);
  });

  it("wires the gate and the submitted value to the SAME state", async () => {
    // Driving this through the UI cannot separate the two implementations: the gate opens only on
    // an exact match, so an enabled submit carries the same string whether it comes from the typed
    // value or straight off the app object. They diverge exactly when the gate is broken - which is
    // the case worth guarding - so the property is asserted structurally: both the disabled
    // condition and the submitted argument must read the ONE state the dialog writes.
    const src = readFileSync("src/pages/AppDetail.tsx", "utf8");
    // The purge dialog's gate reads the typed state, not the app object.
    expect(src).toContain("confirmDisabled={purgeTyped !== app.slug}");
    // ...and the mutation submits that same state.
    expect(src).toMatch(/mutationFn: \(\) => purgeApp\(appId, purgeTyped\)/);
    // The typed state is what the dialog writes into.
    expect(src).toContain("onTypedChange={setPurgeTyped}");
  });

  it("does not arm the gate again when the dialog is reopened", async () => {
    await openPurgeDialog();
    const field = screen.getByRole("textbox");
    expect((field as HTMLInputElement).value).toBe("");

    fireEvent.change(field, { target: { value: "myapp-android" } });
    fireEvent.click(screen.getByRole("button", { name: /^cancel$/i }));

    const reopened = await screen.findByRole("button", { name: /purge permanently/i });
    fireEvent.click(reopened);
    const fieldAgain = await screen.findByRole("textbox");
    expect((fieldAgain as HTMLInputElement).value).toBe("");
    expect(
      (screen.getByRole("button", { name: /purge permanently/i }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});
