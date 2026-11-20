// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  list: vi.fn(), apps: vi.fn(), grant: vi.fn(), ungrant: vi.fn(), generate: vi.fn(), toast: vi.fn(), keys: vi.fn(), upload: vi.fn(),
  genIos: vi.fn(), requests: vi.fn(), createRequest: vi.fn(), complete: vi.fn(), cancel: vi.fn(), appId: vi.fn(),
}));
vi.mock("../components/Toast", () => ({ useToast: () => ({ show: mocks.toast }) }));
vi.mock("../lib/api", async (importOriginal) => ({
  ...await importOriginal<typeof import("../lib/api")>(),
  listSigningIdentities: mocks.list,
  listApps: mocks.apps,
  grantSigningIdentity: mocks.grant,
  ungrantSigningIdentity: mocks.ungrant,
  generateAndroidSigningIdentity: mocks.generate,
  listSigningApiKeySources: mocks.keys,
  uploadSigningIdentity: mocks.upload,
  generateAppleIosSigningIdentity: mocks.genIos,
  listSigningCertificateRequests: mocks.requests,
  createSigningCertificateRequest: mocks.createRequest,
  completeSigningCertificateRequest: mocks.complete,
  cancelSigningCertificateRequest: mocks.cancel,
  registerAppleAppId: mocks.appId,
}));

import { SigningTab } from "./SigningIdentities";

afterEach(() => { cleanup(); vi.clearAllMocks(); });

function renderTab(canManage = true) {
  if (!mocks.requests.getMockImplementation()) mocks.requests.mockResolvedValue({ certificate_requests: [] });
  if (!mocks.keys.getMockImplementation()) mocks.keys.mockResolvedValue({ api_keys: [] });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={client}><SigningTab orgId="org" canManage={canManage} /></QueryClientProvider>);
}

const ORG_APPS = [
  { id: "app-ios", org_id: "org", slug: "raft-deck-ios", name: "Deck iOS", platform: "ios", archived: 0 },
  { id: "app-mac", org_id: "org", slug: "raft-deck", name: "Deck", platform: "electron", archived: 0 },
  { id: "app-and", org_id: "org", slug: "raft-deck-android", name: "Deck Android", platform: "android", archived: 0 },
  { id: "app-x", org_id: "other", slug: "foreign", name: "Foreign", platform: "ios", archived: 0 },
];
const identity = (over: Record<string, unknown>) => ({
  id: "si-1", org_id: "org", kind: "apple_ios_distribution", name: "Team Distribution", origin: "uploaded",
  metadata: { team_id: "XDAPXFY8FZ", sha256_fingerprint: "ab".repeat(32), not_after: "Jul  9 11:16:01 2099 GMT", asc_key_id: "TEAMKEY1", api_key_from_app: "raft-ios" },
  backup_exported_at: null, created_by_actor: "x", created_at: 1, revoked_at: null, apps: [], ...over,
});
const RAFT_IOS_KEY = { app_id: "app-raft-ios", slug: "raft-ios", name: "Raft", key_id: "TEAMKEY1", issuer_id: "ISS", updated_at: 1 };

describe("SigningTab", () => {
  it("groups identities by platform and grants only apps of that platform", async () => {
    mocks.list.mockResolvedValue({ signing_identities: [identity({})] });
    mocks.apps.mockResolvedValue({ apps: ORG_APPS });
    mocks.grant.mockResolvedValue({});
    renderTab();
    const row = await screen.findByText("Team Distribution");
    // macOS and Android have nothing yet and say so.
    expect(screen.getByText(/No Developer ID yet/)).toBeTruthy();
    expect(screen.getByText(/No key yet/)).toBeTruthy();
    fireEvent.click(row);
    const panel = await screen.findByRole("region", { name: "Team Distribution" }).catch(() => screen.getByLabelText("Team Distribution", { selector: "section,div,aside" }));
    expect(panel.textContent).toContain("XDAPXFY8FZ");
    expect(panel.textContent).toContain("TEAMKEY1");
    // Only the iOS app of this org is offered.
    expect(screen.queryByRole("switch", { name: "raft-deck" })).toBeNull();
    expect(screen.queryByRole("switch", { name: "foreign" })).toBeNull();
    fireEvent.click(screen.getByRole("switch", { name: "raft-deck-ios" }));
    await waitFor(() => expect(mocks.grant).toHaveBeenCalledWith("org", "si-1", "app-ios"));
  });

  it("creates an iOS certificate in Hands with an app's App Store Connect key", async () => {
    mocks.list.mockResolvedValue({ signing_identities: [] });
    mocks.apps.mockResolvedValue({ apps: ORG_APPS });
    mocks.keys.mockResolvedValue({ api_keys: [RAFT_IOS_KEY] });
    mocks.genIos.mockResolvedValue({ signing_identity: {} });
    renderTab();
    await screen.findByText(/No distribution certificate yet/);
    fireEvent.click(screen.getAllByText("Add certificate")[0]!);
    fireEvent.click(await screen.findByRole("button", { name: "Continue" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Botiverse, Inc. iOS" } });
    fireEvent.click(await screen.findByRole("radio", { name: "Use the key of raft-ios (Key ID TEAMKEY1)" }));
    fireEvent.click(screen.getByRole("button", { name: "Create certificate" }));
    await waitFor(() => expect(mocks.genIos).toHaveBeenCalledWith("org", { name: "Botiverse, Inc. iOS", asc: { from_app: "app-raft-ios" } }));
  });

  it("makes a Developer ID request, then takes the .cer back", async () => {
    mocks.list.mockResolvedValue({ signing_identities: [] });
    mocks.apps.mockResolvedValue({ apps: ORG_APPS });
    const request = {
      id: "req-1", kind: "apple_developer_id", name: "Deck Mac", csr_pem: "-----BEGIN CERTIFICATE REQUEST-----", metadata: {},
      identity_id: null, created_by_actor: "x", created_at: Date.now(), completed_at: null, cancelled_at: null,
    };
    mocks.requests.mockResolvedValueOnce({ certificate_requests: [] }).mockResolvedValue({ certificate_requests: [request] });
    mocks.createRequest.mockResolvedValue({ certificate_request: request });
    mocks.complete.mockResolvedValue({ signing_identity: {} });
    renderTab();
    await screen.findByText(/No Developer ID yet/);
    fireEvent.click(screen.getAllByText("Add certificate")[1]!);
    fireEvent.click(await screen.findByRole("button", { name: "Continue" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Deck Mac" } });
    fireEvent.click(screen.getByRole("button", { name: "Make request" }));
    await waitFor(() => expect(mocks.createRequest).toHaveBeenCalledWith("org", { kind: "apple_developer_id", name: "Deck Mac", notary: null }));
    // The request opens straight away: download, Apple, upload.
    expect(await screen.findByText("Finish Deck Mac")).toBeTruthy();
    expect(screen.getByText("Deck-Mac.certSigningRequest")).toBeTruthy();
    const add = screen.getByRole("button", { name: "Add certificate" }) as HTMLButtonElement;
    expect(add.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Choose .cer file"), { target: { files: [new File(["CER"], "developerID_application.cer")] } });
    expect(add.disabled).toBe(false);
    fireEvent.click(add);
    await waitFor(() => expect(mocks.complete).toHaveBeenCalledWith("org", "req-1", btoa("CER")));
    // The pending row stays in the list until Apple's certificate is in.
    expect(screen.getByText("Waiting for Apple")).toBeTruthy();
  });

  it("checks, then registers, an app's App ID with the certificate's API key", async () => {
    const granted = identity({ apps: [{ app_id: "app-ios", slug: "raft-deck-ios" }] });
    mocks.list.mockResolvedValue({ signing_identities: [granted] });
    mocks.apps.mockResolvedValue({ apps: ORG_APPS });
    const plan = {
      bundle_id: "build.raft.deck", app_id_resource_id: null, create_app_id: true,
      enable: [{ capability: "PUSH_NOTIFICATIONS", entitlements: ["aps-environment"] }], already_enabled: [],
      manual: [{ capability: "APP_GROUPS", entitlement: "com.apple.security.application-groups", values: ["group.build.raft"], step: "Create the App Group and assign it." }],
      unknown_entitlements: [],
    };
    mocks.appId
      .mockResolvedValueOnce({ plan, applied: null })
      .mockResolvedValueOnce({ plan, applied: {
        bundle_id: "build.raft.deck", app_id_resource_id: "R1", created_app_id: true, enabled: ["PUSH_NOTIFICATIONS"],
        profiles_removed: [], manual: plan.manual, unknown_entitlements: [],
      } });
    renderTab();
    fireEvent.click(await screen.findByText("Team Distribution"));
    fireEvent.click(await screen.findByRole("button", { name: "Register App ID for raft-deck-ios" }));
    const check = await screen.findByRole("button", { name: "Check" });
    expect((check as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByPlaceholderText("com.example.app"), { target: { value: "build.raft.deck" } });
    fireEvent.click(check);
    await waitFor(() => expect(mocks.appId).toHaveBeenCalledWith("app-ios", { bundle_id: "build.raft.deck", identity_id: "si-1", entitlements_b64: undefined, apply: false }));
    expect(await screen.findByText(/Turn on: PUSH_NOTIFICATIONS/)).toBeTruthy();
    expect(screen.getByText(/Create the App Group/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Register with Apple" }));
    await waitFor(() => expect(mocks.appId).toHaveBeenLastCalledWith("app-ios", expect.objectContaining({ apply: true })));
    expect(await screen.findByText(/Created the App ID build.raft.deck/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Done" })).toBeTruthy();
  });

  it("offers App IDs only on an iOS certificate with an API key", async () => {
    mocks.list.mockResolvedValue({ signing_identities: [identity({
      apps: [{ app_id: "app-ios", slug: "raft-deck-ios" }],
      metadata: { team_id: "XDAPXFY8FZ", not_after: "Jul  9 11:16:01 2099 GMT", provisioning_profile_count: 2 },
    })] });
    mocks.apps.mockResolvedValue({ apps: ORG_APPS });
    renderTab();
    fireEvent.click(await screen.findByText("Team Distribution"));
    await screen.findByText("2 uploaded");
    expect(screen.queryByRole("button", { name: "Register App ID for raft-deck-ios" })).toBeNull();
  });

  it("flags a certificate that expires within 30 days", async () => {
    mocks.list.mockResolvedValue({ signing_identities: [identity({ kind: "apple_developer_id", metadata: { not_after: new Date(Date.now() + 12 * 86_400_000).toUTCString() } })] });
    mocks.apps.mockResolvedValue({ apps: ORG_APPS });
    renderTab();
    expect(await screen.findByText(/Expires in 1[12] days/)).toBeTruthy();
  });

  it("generates an Android key", async () => {
    mocks.list.mockResolvedValue({ signing_identities: [] });
    mocks.apps.mockResolvedValue({ apps: ORG_APPS });
    mocks.generate.mockResolvedValue({ signing_identity: {} });
    renderTab();
    fireEvent.click(await screen.findByText("Add key"));
    fireEvent.click(await screen.findByRole("button", { name: "Continue" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Deck Android" } });
    fireEvent.click(screen.getByRole("button", { name: "Create key" }));
    await waitFor(() => expect(mocks.generate).toHaveBeenCalledWith("org", { name: "Deck Android" }));
  });

  it("tells members that only admins manage signing", async () => {
    mocks.apps.mockResolvedValue({ apps: [] });
    renderTab(false);
    expect(await screen.findByText(/Only organization admins/)).toBeTruthy();
  });
});
