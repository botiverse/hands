// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getAuthMe: vi.fn(),
  listApps: vi.fn(),
  listAppMembers: vi.fn(),
  listAppServerGrants: vi.fn(),
  listAppDeployTokens: vi.fn(),
  getAppPermissionModel: vi.fn(),
  revokeAppDeployToken: vi.fn(),
  removeAppMember: vi.fn(),
  listTrustedPublishers: vi.fn(),
  toast: vi.fn(),
}));

vi.mock("../components/Toast", () => ({ useToast: () => ({ show: mocks.toast }) }));
vi.mock("../lib/api", async (importOriginal) => ({
  ...await importOriginal<typeof import("../lib/api")>(),
  ...mocks,
}));

import { AppAccess } from "./AppAccess";

afterEach(() => cleanup());

const member = (account_id: string, display_name: string, app_role: "admin" | "publisher" | "viewer") => ({
  id: account_id, app_id: "app-1", account_id, app_role, invited_by: null, joined_at: 1, provider: "raft", provider_subject: `subj-${account_id}`,
  server_id: "s", server_slug: "raft", principal_type: "human", server_role: null, username: account_id, display_name, avatar_url: null, last_login_at: null,
});

function renderAccess() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={client}><AppAccess appId="app-1" /></QueryClientProvider>);
}

describe("App access", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getAuthMe.mockResolvedValue({ authenticated: true, account: { id: "me", org_id: "o", org_role: "owner", server_id: "s", server_slug: "raft" } });
    mocks.listApps.mockResolvedValue({ apps: [{ id: "app-1", org_id: "o", slug: "deck", name: "Deck", platform: "ios", description: null, archived: 0, archived_at: null, created_at: 1 }] });
    mocks.listAppMembers.mockResolvedValue({ members: [member("me", "Artin", "admin"), member("lin", "Lin", "publisher")] });
    mocks.listAppServerGrants.mockResolvedValue({ server_grants: [] });
    mocks.listTrustedPublishers.mockResolvedValue({ trusted_publishers: [] });
    mocks.getAppPermissionModel.mockResolvedValue({ permissions: [], roles: [] });
    mocks.listAppDeployTokens.mockResolvedValue({ deploy_tokens: [{
      id: "t1", app_id: "app-1", name: "ci-main", token_prefix: "hdt_ab", app_role: "publisher", scopes: null, grant_valid: true,
      effective_permissions: ["app:read"], created_by: null, created_by_actor: "raft:artin", created_at: 1, expires_at: null, last_used_at: null, revoked_at: null, reporter_integration_id: null,
    }] });
    mocks.revokeAppDeployToken.mockResolvedValue({ ok: true });
    mocks.removeAppMember.mockResolvedValue({ ok: true });
  });

  it("shows members as rows and removes one only after confirming", async () => {
    renderAccess();
    expect(await screen.findByText("Lin")).toBeTruthy();
    // No role select or Remove for yourself.
    expect(screen.getAllByRole("button", { name: "Remove" })).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(mocks.removeAppMember).not.toHaveBeenCalled();
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(mocks.removeAppMember).toHaveBeenCalledWith("app-1", "lin"));
  });

  it("revokes a deploy token only after confirming", async () => {
    renderAccess();
    fireEvent.click(await screen.findByRole("button", { name: "Revoke" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText("ci-main")).toBeTruthy();
    expect(mocks.revokeAppDeployToken).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Revoke token" }));
    await waitFor(() => expect(mocks.revokeAppDeployToken).toHaveBeenCalledWith("app-1", "t1"));
  });
});
