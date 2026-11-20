// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  list: vi.fn(), apps: vi.fn(), grant: vi.fn(), ungrant: vi.fn(), generate: vi.fn(), toast: vi.fn(), keys: vi.fn(), upload: vi.fn(),
  genIos: vi.fn(), requests: vi.fn(), createRequest: vi.fn(), complete: vi.fn(), cancel: vi.fn(),
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
}));

import { SigningTab } from "./SigningIdentities";

afterEach(() => { cleanup(); vi.clearAllMocks(); });

function renderTab(canManage = true) {
  if (!mocks.requests.getMockImplementation()) mocks.requests.mockResolvedValue({ certificate_requests: [] });
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

  it("guides the iOS upload and reuses an app's App Store Connect key", async () => {
    mocks.list.mockResolvedValue({ signing_identities: [] });
    mocks.apps.mockResolvedValue({ apps: [] });
    mocks.keys.mockResolvedValue({ api_keys: [{ app_id: "app-ios", slug: "raft-ios", name: "Raft", key_id: "TEAMKEY1", issuer_id: "ISS", updated_at: 1 }] });
    mocks.upload.mockResolvedValue({ signing_identity: {} });
    renderTab();
    fireEvent.click(await screen.findByText("Upload Apple Distribution (iOS)"));
    expect(screen.getByText("How to get these files")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Identifiers" }).getAttribute("href")).toContain("developer.apple.com");
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Deck iOS" } });
    fireEvent.change(screen.getByLabelText("Apple Distribution certificate (.p12)"), { target: { files: [new File(["ABC"], "dist.p12")] } });
    fireEvent.change(screen.getByLabelText(".p12 password"), { target: { value: "pw" } });
    // Without a key or a profile there is nothing to sign with yet.
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(await screen.findByLabelText("Use the key of raft-ios (Key ID TEAMKEY1)"));
    const save = screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
    expect(save.disabled).toBe(false);
    // jsdom cannot fill a required file input, so submit the form directly.
    fireEvent.submit(save.closest("form")!);
    await waitFor(() => expect(mocks.upload).toHaveBeenCalledWith("org", {
      kind: "apple_ios_distribution", name: "Deck iOS", p12_b64: btoa("ABC"), p12_password: "pw",
      asc: { from_app: "app-ios" }, provisioning_profiles_b64: [],
    }));
  });

  it("is admin-only", () => {
    renderTab(false);
    expect(screen.getByText(/Only organization admins/)).toBeTruthy();
    expect(mocks.list).not.toHaveBeenCalled();
  });

  it("creates an iOS certificate in Hands through App Store Connect", async () => {
    mocks.list.mockResolvedValue({ signing_identities: [] });
    mocks.apps.mockResolvedValue({ apps: [] });
    mocks.keys.mockResolvedValue({ api_keys: [{ app_id: "app-ios", slug: "raft-ios", name: "Raft", key_id: "TEAMKEY1", issuer_id: "ISS", updated_at: 1 }] });
    mocks.genIos.mockResolvedValue({ signing_identity: {} });
    mocks.createRequest.mockResolvedValue({ certificate_request: {} });
    renderTab();
    fireEvent.click(await screen.findByText("New Apple Distribution certificate (iOS)"));
    expect(screen.getByText("The private key is created inside Hands and never leaves it.")).toBeTruthy();
    // iOS always needs a key: there is no "no key" choice here.
    expect(screen.queryByText(/No key: I upload/)).toBeNull();
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Botiverse, Inc. iOS" } });
    fireEvent.click(await screen.findByLabelText("Use the key of raft-ios (Key ID TEAMKEY1)"));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(mocks.genIos).toHaveBeenCalledWith("org", { name: "Botiverse, Inc. iOS", asc: { from_app: "app-ios" } }));
    expect(mocks.createRequest).not.toHaveBeenCalled();

    // Without an Admin key: a request file instead.
    fireEvent.click(await screen.findByText("New Apple Distribution certificate (iOS)"));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Deck iOS" } });
    fireEvent.click(screen.getByLabelText(/I take a request file/));
    fireEvent.click(await screen.findByLabelText("Use the key of raft-ios (Key ID TEAMKEY1)"));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(mocks.createRequest).toHaveBeenCalledWith("org", { kind: "apple_ios_distribution", name: "Deck iOS", asc: { from_app: "app-ios" } }));
  });

  it("makes a Developer ID request, offers it for download and takes the .cer back", async () => {
    mocks.list.mockResolvedValue({ signing_identities: [] });
    mocks.apps.mockResolvedValue({ apps: [] });
    mocks.keys.mockResolvedValue({ api_keys: [] });
    mocks.createRequest.mockResolvedValue({ certificate_request: {} });
    mocks.requests.mockResolvedValue({ certificate_requests: [{
      id: "req-1", kind: "apple_developer_id", name: "Deck Mac", csr_pem: "-----BEGIN CERTIFICATE REQUEST-----", metadata: {},
      identity_id: null, created_by_actor: "x", created_at: 1, completed_at: null, cancelled_at: null,
    }] });
    mocks.complete.mockResolvedValue({ signing_identity: {} });
    renderTab();
    fireEvent.click(await screen.findByText("New Developer ID certificate (macOS)"));
    expect(screen.getByText(/only the Account Holder/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Deck Mac" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(mocks.createRequest).toHaveBeenCalledWith("org", { kind: "apple_developer_id", name: "Deck Mac", notary: null }));

    const pending = await screen.findByRole("form", { name: "Deck Mac" });
    expect(pending.textContent).toContain("Download the request (.certSigningRequest)");
    const add = screen.getByRole("button", { name: "Add certificate" }) as HTMLButtonElement;
    expect(add.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Upload the .cer here:"), { target: { files: [new File(["CER"], "developerID_application.cer")] } });
    expect(add.disabled).toBe(false);
    fireEvent.click(add);
    await waitFor(() => expect(mocks.complete).toHaveBeenCalledWith("org", "req-1", btoa("CER")));
  });

  it("flags a certificate that expires within 30 days", async () => {
    mocks.list.mockResolvedValue({ signing_identities: [{
      id: "si-2", org_id: "org", kind: "apple_developer_id", name: "Old Dev ID", origin: "uploaded",
      metadata: { not_after: new Date(Date.now() + 5 * 86400_000).toUTCString() },
      backup_exported_at: null, created_by_actor: "x", created_at: 1, revoked_at: null, apps: [],
    }] });
    mocks.apps.mockResolvedValue({ apps: [] });
    renderTab();
    expect(await screen.findByText(/expires soon/)).toBeTruthy();
  });
});
