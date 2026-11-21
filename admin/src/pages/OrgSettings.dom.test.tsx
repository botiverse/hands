// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  me: vi.fn(),
  orgs: vi.fn(),
  members: vi.fn(),
  updateMember: vi.fn(),
  removeMember: vi.fn(),
  invites: vi.fn(),
  createInvite: vi.fn(),
  resendInvite: vi.fn(),
  revokeInvite: vi.fn(),
  audit: vi.fn(),
  webhooks: vi.fn(),
  createWebhook: vi.fn(),
  updateWebhook: vi.fn(),
  deleteWebhook: vi.fn(),
  deliveries: vi.fn(),
  rotateSecret: vi.fn(),
  testWebhook: vi.fn(),
  updateOrg: vi.fn(),
  transferOwnership: vi.fn(),
  toast: vi.fn(),
}));

vi.mock("../components/Toast", () => ({ useToast: () => ({ show: mocks.toast, update: vi.fn() }) }));
vi.mock("../lib/api", async (importOriginal) => ({
  ...await importOriginal<typeof import("../lib/api")>(),
  getAuthMe: mocks.me,
  listOrgs: mocks.orgs,
  listOrgMembers: mocks.members,
  updateOrgMember: mocks.updateMember,
  removeOrgMember: mocks.removeMember,
  listOrgInvites: mocks.invites,
  createOrgInvite: mocks.createInvite,
  resendOrgInvite: mocks.resendInvite,
  revokeOrgInvite: mocks.revokeInvite,
  listOrgAuditLogs: mocks.audit,
  listOrgWebhooks: mocks.webhooks,
  createOrgWebhook: mocks.createWebhook,
  updateOrgWebhook: mocks.updateWebhook,
  deleteOrgWebhook: mocks.deleteWebhook,
  listWebhookDeliveries: mocks.deliveries,
  rotateOrgWebhookSecret: mocks.rotateSecret,
  testOrgWebhook: mocks.testWebhook,
  updateOrg: mocks.updateOrg,
  transferOrgOwnership: mocks.transferOwnership,
}));

import { OrgSettings, type OrgSettingsTab } from "./OrgSettings";

globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;

const NOW = Date.now();
const D = 86_400_000;

const account = (role: string) => ({
  authenticated: true,
  account: {
    id: "acc-me", provider: "raft", server_id: "srv", server_slug: "raft", principal_type: "human", server_role: "member",
    org_id: "org-1", org_role: role, username: "me", display_name: "Me", avatar_url: null, actor: "raft:me",
  },
});

const member = (id: string, name: string, role: string, extra: Record<string, unknown> = {}) => ({
  id: `m-${id}`, org_id: "org-1", account_id: id, org_role: role, invited_by: null, joined_at: NOW - 30 * D,
  provider: "raft", provider_subject: `subject-${id}-0123456789`, server_id: "srv", server_slug: "raft",
  principal_type: "human", server_role: "member", username: name.toLowerCase(), display_name: name, avatar_url: null,
  last_login_at: NOW - D, ...extra,
});

const invite = (id: string, email: string, status = "pending", extra: Record<string, unknown> = {}) => ({
  id, org_id: "org-1", app_id: null, email, role: "member", status, message: null,
  created_at: NOW - D, expires_at: NOW + 6 * D, ...extra,
});

const webhook = (id: string, url: string, events: string[] = [], enabled = 1) => ({
  id, org_id: "org-1", app_id: null, url, secret_set: true, events_json: JSON.stringify(events), enabled,
  created_at: NOW - 10 * D, updated_at: NOW, archived_at: null,
});

function renderOrg(tab: OrgSettingsTab, path = `/orgs/org-1/${tab}`) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <MemoryRouter initialEntries={[path]}>
      <QueryClientProvider client={client}>
        <OrgSettings orgId="org-1" tab={tab} />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

let clipboard: string[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  clipboard = [];
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: (text: string) => { clipboard.push(text); return Promise.resolve(); } },
  });
  mocks.me.mockResolvedValue(account("owner"));
  mocks.orgs.mockResolvedValue({ orgs: [{ id: "org-1", slug: "botiverse", name: "Botiverse", external_provider: "raft", external_id: "srv", created_at: NOW - 400 * D, archived: 0, org_role: "owner" }] });
});
afterEach(() => cleanup());

describe("Organization › General", () => {
  it("shows the organization and your access as rows", async () => {
    renderOrg("general");
    expect(await screen.findByText("botiverse")).toBeTruthy();
    expect(screen.getAllByText("Botiverse").length).toBeGreaterThan(0);
    expect(screen.getByText("org-1")).toBeTruthy();
    expect(screen.getByText("Role in this organization")).toBeTruthy();
    expect(screen.getByText("Owner")).toBeTruthy();
  });

  it("renames the organization in a dialog and can hand the name back to Raft", async () => {
    mocks.updateOrg.mockResolvedValue({ ok: true });
    mocks.orgs.mockResolvedValue({ orgs: [{ id: "org-1", slug: "botiverse", name: "Botiverse", raft_name: "raft", name_customized: 1, external_provider: "raft", external_id: "srv", created_at: NOW - 400 * D, archived: 0, org_role: "owner" }] });
    renderOrg("general");
    expect(await screen.findByText("Set in Hands. The Raft server is called raft.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    const dialog = await screen.findByRole("dialog", { name: "Rename organization" });
    fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "  Botiverse Inc  " } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(mocks.updateOrg).toHaveBeenCalledWith("org-1", { name: "Botiverse Inc" }));
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Use the Raft server's name" }));
    await waitFor(() => expect(mocks.updateOrg).toHaveBeenLastCalledWith("org-1", { name: null }));
  });

  it("offers no rename to a member", async () => {
    mocks.me.mockResolvedValue(account("member"));
    mocks.orgs.mockResolvedValue({ orgs: [{ id: "org-1", slug: "botiverse", name: "Botiverse", external_provider: "raft", external_id: "srv", created_at: NOW - 400 * D, archived: 0, org_role: "member" }] });
    renderOrg("general");
    expect(await screen.findByText("Follows the Raft server's name.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Rename" })).toBeNull();
  });

  it("warns when the URL's organization is not the current one", async () => {
    mocks.me.mockResolvedValue({ ...account("owner"), account: { ...account("owner").account, org_id: "org-2" } });
    renderOrg("general");
    expect(await screen.findByText("This is not your current organization")).toBeTruthy();
  });
});

describe("Organization › Members", () => {
  beforeEach(() => {
    mocks.members.mockResolvedValue({ members: [
      member("acc-me", "Me", "owner"),
      member("acc-maya", "Maya", "member"),
      member("acc-bot", "Release bot", "member", { principal_type: "agent", username: "release-bot" }),
    ] });
    mocks.removeMember.mockResolvedValue({ ok: true });
  });

  it("lists members with their role and narrows them by search and type", async () => {
    renderOrg("members");
    expect(await screen.findByText("Maya")).toBeTruthy();
    expect(screen.getByText("(you)")).toBeTruthy();
    expect(screen.getByText("agent")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Search members"), { target: { value: "release" } });
    expect(screen.queryByText("Maya")).toBeNull();
    expect(screen.getByText("Release bot")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Search members"), { target: { value: "zzz" } });
    expect(screen.getByText("No members match")).toBeTruthy();
  });

  it("opens a member beside the list and removes them after a confirmation", async () => {
    renderOrg("members");
    fireEvent.click(await screen.findByText("Maya"));
    const column = screen.getByRole("region", { name: "Maya" });
    expect(within(column).getByRole("combobox", { name: "Role of Maya" })).toBeTruthy();
    fireEvent.click(within(column).getByText("Remove from organization"));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText("Remove this member?")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(mocks.removeMember).toHaveBeenCalledWith("org-1", "acc-maya"));
  });

  it("lets an owner hand ownership to a member after a confirmation", async () => {
    mocks.transferOwnership.mockResolvedValue({ ok: true });
    renderOrg("members");
    fireEvent.click(await screen.findByText("Maya"));
    const column = screen.getByRole("region", { name: "Maya" });
    fireEvent.click(within(column).getByText("Transfer ownership"));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText("Transfer ownership?")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Transfer ownership" }));
    await waitFor(() => expect(mocks.transferOwnership).toHaveBeenCalledWith("org-1", "acc-maya"));
  });

  it("offers an admin no ownership transfer", async () => {
    mocks.me.mockResolvedValue(account("admin"));
    renderOrg("members");
    fireEvent.click(await screen.findByText("Maya"));
    const column = screen.getByRole("region", { name: "Maya" });
    expect(within(column).getByText("Remove from organization")).toBeTruthy();
    expect(within(column).queryByText("Transfer ownership")).toBeNull();
  });

  it("lets nobody change their own role or remove themselves", async () => {
    renderOrg("members");
    fireEvent.click(await screen.findByText("Me"));
    const column = screen.getByRole("region", { name: "Me" });
    expect(within(column).queryByRole("combobox")).toBeNull();
    expect(within(column).getByText("You can't change your own role.")).toBeTruthy();
    expect(within(column).queryByText("Remove from organization")).toBeNull();
  });

  it("shows a viewer the members without any way to change them", async () => {
    mocks.me.mockResolvedValue(account("viewer"));
    renderOrg("members");
    fireEvent.click(await screen.findByText("Maya"));
    const column = screen.getByRole("region", { name: "Maya" });
    expect(within(column).queryByRole("combobox")).toBeNull();
    expect(within(column).queryByText("Remove from organization")).toBeNull();
    expect(screen.getByText(/you can see the members/)).toBeTruthy();
  });
});

describe("Organization › Invites", () => {
  beforeEach(() => {
    mocks.invites.mockResolvedValue({ invites: [
      invite("i1", "jordan@example.com", "pending", { message: "Welcome!" }),
      invite("i2", "old@example.com", "revoked", { revoked_at: NOW - D }),
    ] });
    mocks.revokeInvite.mockResolvedValue({ ok: true });
    mocks.resendInvite.mockResolvedValue({ ok: true, invite_url: "https://hands.example/invites/NEWTOKEN", expires_at: NOW + 7 * D });
    mocks.createInvite.mockResolvedValue({ ...invite("i3", "new@example.com"), invite_url: "https://hands.example/invites/CREATED" });
  });

  it("asks the server for the picked status", async () => {
    renderOrg("invites");
    expect(await screen.findByText("jordan@example.com")).toBeTruthy();
    expect(mocks.invites).toHaveBeenCalledWith("org-1", undefined);
    expect(screen.getByText("Revoked")).toBeTruthy();
  });

  it("creates an invite and ends on its link, copied", async () => {
    renderOrg("invites");
    await screen.findByText("jordan@example.com");
    fireEvent.click(screen.getByRole("button", { name: "New invite" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Email"), { target: { value: " New@Example.com " } });
    fireEvent.click(within(dialog).getByRole("radio", { name: /Viewer/ }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Create link" }));
    await waitFor(() => expect(mocks.createInvite).toHaveBeenCalledWith("org-1", { email: "new@example.com", role: "viewer", message: null }));
    expect(await within(dialog).findByText("https://hands.example/invites/CREATED")).toBeTruthy();
    expect(clipboard).toContain("https://hands.example/invites/CREATED");
  });

  it("gives a pending invite a new link and revokes it after a confirmation", async () => {
    renderOrg("invites");
    fireEvent.click(await screen.findByText("jordan@example.com"));
    const column = screen.getByRole("region", { name: "jordan@example.com" });
    expect(within(column).getByText("Welcome!")).toBeTruthy();
    fireEvent.click(within(column).getByText("Copy a new link"));
    expect(await within(column).findByText("https://hands.example/invites/NEWTOKEN")).toBeTruthy();
    expect(mocks.resendInvite).toHaveBeenCalledWith("org-1", "i1");
    expect(clipboard).toContain("https://hands.example/invites/NEWTOKEN");
    fireEvent.click(within(column).getByText("Revoke invite"));
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Revoke invite" }));
    await waitFor(() => expect(mocks.revokeInvite).toHaveBeenCalledWith("org-1", "i1"));
  });

  it("offers no actions on an invite that is no longer pending", async () => {
    renderOrg("invites");
    fireEvent.click(await screen.findByText("old@example.com"));
    const column = screen.getByRole("region", { name: "old@example.com" });
    expect(within(column).queryByText("Copy a new link")).toBeNull();
    expect(within(column).queryByText("Revoke invite")).toBeNull();
  });
});

describe("Organization › Audit", () => {
  const entry = (id: string, action: string, app: string, extra: Record<string, unknown> = {}) => ({
    id, app_id: `app-${app}`, app_slug: app, action, actor: "raft:artin", actor_id: "acc-artin", actor_type: "human",
    actor_display_name: "Artin", actor_username: "artin", actor_avatar_url: null, payload: JSON.stringify({ app }), created_at: NOW - 60_000, ...extra,
  });

  it("shows each entry's app and narrows the loaded entries by the app in the URL", async () => {
    mocks.audit.mockResolvedValue({ logs: [entry("e1", "release.publish", "raft-deck"), entry("e2", "share.create", "ferry")] });
    renderOrg("audit", "/orgs/org-1/audit?app=app-ferry");
    expect(await screen.findByText("share.create")).toBeTruthy();
    expect(screen.queryByText("release.publish")).toBeNull();
    expect(screen.getAllByText("ferry").length).toBeGreaterThan(0);
    expect(mocks.audit).toHaveBeenCalledWith("org-1", 100);
    fireEvent.click(screen.getByText("Clear all"));
    expect(await screen.findByText("release.publish")).toBeTruthy();
  });

  it("loads up to 500 entries when the first 100 are all there", async () => {
    mocks.audit.mockResolvedValue({ logs: Array.from({ length: 100 }, (_, i) => entry(`e${i}`, "app.update", "raft-deck")) });
    renderOrg("audit");
    fireEvent.click(await screen.findByText("Load the latest 500"));
    await waitFor(() => expect(mocks.audit).toHaveBeenLastCalledWith("org-1", 500));
  });

  it("tells a viewer the log is for members", async () => {
    mocks.me.mockResolvedValue(account("viewer"));
    renderOrg("audit");
    expect(await screen.findByText("Members only")).toBeTruthy();
    expect(mocks.audit).not.toHaveBeenCalled();
  });
});

describe("Organization › Webhooks", () => {
  beforeEach(() => {
    mocks.webhooks.mockResolvedValue({ webhooks: [
      webhook("w1", "https://ci.example.com/hooks", ["build:failed", "release:published"]),
      webhook("w2", "https://old.example.com/in", [], 0),
    ] });
    mocks.deliveries.mockResolvedValue({ deliveries: [
      { id: "d1", webhook_id: "w1", event_type: "build:failed", status: "failed", attempts: 3, max_attempts: 3, last_attempt_at: NOW, next_attempt_at: null, last_response_status: null, last_response_body: null, last_error: "connect ECONNREFUSED", created_at: NOW - 60_000, completed_at: NOW },
    ] });
    mocks.updateWebhook.mockResolvedValue({ ok: true });
    mocks.deleteWebhook.mockResolvedValue({ ok: true });
    mocks.createWebhook.mockResolvedValue(webhook("w9", "https://new.example.com/h"));
  });

  it("lists webhooks with their events and marks a paused one", async () => {
    renderOrg("webhooks");
    expect(await screen.findByText("ci.example.com/hooks")).toBeTruthy();
    expect(screen.getByText("build:failed, release:published")).toBeTruthy();
    expect(screen.getByText("All events")).toBeTruthy();
    expect(screen.getByText("Paused")).toBeTruthy();
  });

  it("pauses deliveries at once, shows the deliveries, and archives after a confirmation", async () => {
    renderOrg("webhooks");
    fireEvent.click(await screen.findByText("ci.example.com/hooks"));
    const column = screen.getByRole("region", { name: "ci.example.com/hooks" });
    expect(await within(column).findByText("connect ECONNREFUSED")).toBeTruthy();
    expect(mocks.deliveries).toHaveBeenCalledWith("org-1", "w1");
    fireEvent.click(within(column).getByRole("switch", { name: "Send deliveries" }));
    await waitFor(() => expect(mocks.updateWebhook).toHaveBeenCalledWith("org-1", "w1", { enabled: false }));
    fireEvent.click(within(column).getByText("Archive webhook"));
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Archive webhook" }));
    await waitFor(() => expect(mocks.deleteWebhook).toHaveBeenCalledWith("org-1", "w1"));
  });

  it("replaces the secret after a confirmation and shows the new one once", async () => {
    mocks.rotateSecret.mockResolvedValue({ id: "w1", secret: "whsec_new" });
    renderOrg("webhooks");
    fireEvent.click(await screen.findByText("ci.example.com/hooks"));
    const column = screen.getByRole("region", { name: "ci.example.com/hooks" });
    fireEvent.click(within(column).getByRole("button", { name: "Replace" }));
    const confirm = await screen.findByRole("alertdialog");
    fireEvent.click(within(confirm).getByRole("button", { name: "Replace secret" }));
    await waitFor(() => expect(mocks.rotateSecret).toHaveBeenCalledWith("org-1", "w1"));
    const shown = await screen.findByRole("dialog", { name: "New secret" });
    expect(within(shown).getByText("whsec_new")).toBeTruthy();
  });

  it("sends a test delivery and reports what the endpoint answered", async () => {
    mocks.testWebhook.mockResolvedValue({ delivery: { id: "d2", webhook_id: "w1", event_type: "ping", status: "failed", attempts: 1, max_attempts: 1, last_attempt_at: NOW, next_attempt_at: null, last_response_status: 500, last_response_body: "", last_error: "webhook_http_error", created_at: NOW, completed_at: NOW } });
    renderOrg("webhooks");
    fireEvent.click(await screen.findByText("ci.example.com/hooks"));
    const column = screen.getByRole("region", { name: "ci.example.com/hooks" });
    fireEvent.click(within(column).getByRole("button", { name: "Send test delivery" }));
    await waitFor(() => expect(mocks.testWebhook).toHaveBeenCalledWith("org-1", "w1"));
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({ kind: "error", title: "Test delivery failed", description: "HTTP 500" })));
    await waitFor(() => expect(mocks.deliveries).toHaveBeenCalledTimes(2));
  });

  it("edits the URL in a dialog", async () => {
    renderOrg("webhooks");
    fireEvent.click(await screen.findByText("ci.example.com/hooks"));
    const column = screen.getByRole("region", { name: "ci.example.com/hooks" });
    fireEvent.click(within(column).getAllByRole("button", { name: "Edit" })[0]!);
    const dialog = await screen.findByRole("dialog", { name: "Edit URL" });
    fireEvent.change(within(dialog).getByLabelText("URL"), { target: { value: "https://ci.example.com/v2" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(mocks.updateWebhook).toHaveBeenCalledWith("org-1", "w1", { url: "https://ci.example.com/v2" }));
  });

  it("adds a webhook with a generated secret and picked events", async () => {
    renderOrg("webhooks");
    await screen.findByText("ci.example.com/hooks");
    fireEvent.click(screen.getByRole("button", { name: "Add webhook" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("URL"), { target: { value: "https://new.example.com/h" } });
    fireEvent.click(within(dialog).getByText("Generate"));
    const secret = (within(dialog).getByLabelText("Secret") as HTMLInputElement).value;
    expect(secret).toMatch(/^[0-9a-f]{64}$/);
    fireEvent.click(within(dialog).getByRole("radio", { name: "Only the events I pick" }));
    const add = within(dialog).getByRole("button", { name: "Add webhook" }) as HTMLButtonElement;
    // Picking "only" with nothing ticked can't be saved.
    expect(add.disabled).toBe(true);
    fireEvent.click(within(dialog).getByRole("checkbox", { name: "build:failed" }));
    fireEvent.click(add);
    await waitFor(() => expect(mocks.createWebhook).toHaveBeenCalledWith("org-1", { url: "https://new.example.com/h", secret, events: ["build:failed"] }));
  });

  it("keeps webhooks from members", async () => {
    mocks.me.mockResolvedValue(account("member"));
    renderOrg("webhooks");
    expect(await screen.findByText("Owners and admins only")).toBeTruthy();
    expect(mocks.webhooks).not.toHaveBeenCalled();
  });
});

