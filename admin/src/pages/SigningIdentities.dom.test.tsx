// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  list: vi.fn(), apps: vi.fn(), grant: vi.fn(), ungrant: vi.fn(), generate: vi.fn(), toast: vi.fn(),
}));
vi.mock("../components/Toast", () => ({ useToast: () => ({ show: mocks.toast }) }));
vi.mock("../lib/api", async (importOriginal) => ({
  ...await importOriginal<typeof import("../lib/api")>(),
  listSigningIdentities: mocks.list,
  listApps: mocks.apps,
  grantSigningIdentity: mocks.grant,
  ungrantSigningIdentity: mocks.ungrant,
  generateAndroidSigningIdentity: mocks.generate,
}));

import { SigningTab } from "./SigningIdentities";

afterEach(() => { cleanup(); vi.clearAllMocks(); });

function renderTab(canManage = true) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={client}><SigningTab orgId="org" canManage={canManage} /></QueryClientProvider>);
}

describe("SigningTab", () => {
  it("shows identities without key material and toggles app grants", async () => {
    mocks.list.mockResolvedValue({ signing_identities: [{
      id: "si-1", org_id: "org", kind: "android_keystore", name: "Deck release", origin: "generated",
      metadata: { sha256_fingerprint: "ab".repeat(32), not_after: "2056", key_alias: "release" },
      backup_exported_at: null, created_by_actor: "x", created_at: 1, revoked_at: null, apps: [],
    }] });
    mocks.apps.mockResolvedValue({ apps: [{ id: "app-1", org_id: "org", slug: "raft-deck-android" }, { id: "app-x", org_id: "other", slug: "foreign" }] });
    mocks.grant.mockResolvedValue({});
    renderTab();
    expect(await screen.findByText("Deck release")).toBeTruthy();
    expect(screen.getByText(/Download backup/)).toBeTruthy();
    expect(screen.queryByText("foreign")).toBeNull();
    fireEvent.click(await screen.findByLabelText("raft-deck-android"));
    await waitFor(() => expect(mocks.grant).toHaveBeenCalledWith("org", "si-1", "app-1"));
  });

  it("generates a key from the form", async () => {
    mocks.list.mockResolvedValue({ signing_identities: [] });
    mocks.apps.mockResolvedValue({ apps: [] });
    mocks.generate.mockResolvedValue({ signing_identity: {} });
    renderTab();
    fireEvent.click(await screen.findByText("New Android key"));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Deck Android" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(mocks.generate).toHaveBeenCalledWith("org", { name: "Deck Android" }));
  });

  it("is admin-only", () => {
    renderTab(false);
    expect(screen.getByText(/Only organization admins/)).toBeTruthy();
    expect(mocks.list).not.toHaveBeenCalled();
  });
});
