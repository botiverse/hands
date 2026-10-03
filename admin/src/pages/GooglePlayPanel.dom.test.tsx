// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  tracks: vi.fn(),
  get: vi.fn(),
  channels: vi.fn(),
  builds: vi.fn(),
  authorize: vi.fn(),
  save: vi.fn(),
  verify: vi.fn(),
  toggle: vi.fn(),
  remove: vi.fn(),
  toast: vi.fn(),
}));

vi.mock("../components/Toast", () => ({
  useToast: () => ({ show: mocks.toast }),
}));

vi.mock("../lib/api", async (importOriginal) => ({
  ...await importOriginal<typeof import("../lib/api")>(),
  listGooglePlayTracks: mocks.tracks,
  getGooglePlayBinding: mocks.get,
  listChannels: mocks.channels,
  listBuilds: mocks.builds,
  startGooglePlayOAuth: mocks.authorize,
  setGooglePlayBinding: mocks.save,
  verifyGooglePlayBinding: mocks.verify,
  setGooglePlayBindingEnabled: mocks.toggle,
  deleteGooglePlayBinding: mocks.remove,
}));

import { GooglePlayConnector } from "../components/integrations/GooglePlayConnector";

afterEach(cleanup);

function renderPanel() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <GooglePlayConnector appId="app-a" />
    </QueryClientProvider>,
  );
}

/** A connected connector starts collapsed; expand it to reach the actions. */
async function expandConnectedDetail() {
  fireEvent.click(await screen.findByRole("button", { name: "Expand" }));
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.channels.mockResolvedValue({ channels: [] });
  mocks.builds.mockResolvedValue({ builds: [] });
  mocks.tracks.mockImplementation(async (_app, body) => ({ package_name: body.package_name, tracks: ["internal", "actual-closed-7", "production"] }));
  mocks.save.mockResolvedValue({ google_play: {} });
  mocks.verify.mockResolvedValue({ ok: true });
  mocks.toggle.mockResolvedValue({ ok: true });
  mocks.remove.mockResolvedValue({ ok: true });
});

async function selectClosedTrack() {
  await waitFor(() => expect(screen.getByLabelText("Closed testing track").hasAttribute("disabled")).toBe(false));
  fireEvent.click(screen.getByLabelText("Closed testing track"));
  const option = await screen.findByRole("option", { name: "actual-closed-7" });
  fireEvent.pointerDown(option, { pointerType: "mouse" });
  fireEvent.mouseDown(option);
  fireEvent.mouseUp(option);
  fireEvent.click(option);
  await waitFor(() => expect(screen.getByLabelText("Closed testing track").textContent).toContain("actual-closed-7"));
}

describe("GooglePlayConnector", () => {
  const unconfigured = {
    google_play: {
      credential_kind: "authorized_user",
      enabled: false,
      verification_state: "stale",
      package_name: null,
      service_account_email: "human@example.com",
      internal_track: null,
      closed_track: null,
      production_track: null,
    },
    oauth_available: true,
  };

  it("offers the declared main build package in the post-connect configuration form", async () => {
    mocks.get.mockResolvedValue(unconfigured);
    mocks.channels.mockResolvedValue({ channels: [{ id: "main-id", slug: "main", bundle_id: null }] });
    mocks.builds.mockResolvedValue({ builds: [{ channel_id: "main-id", status: "succeeded", product_type: "android-apk", parsed_metadata_json: "{}", build_metadata_json: '{"package_name":"build.raft.app"}' }] });
    renderPanel();
    await waitFor(() =>
      expect(screen.getByLabelText("Choose an existing Android package").textContent).toContain("build.raft.app"),
    );
    expect(screen.getByLabelText("Choose an existing Android package").textContent).toContain("From upload details");
    expect(screen.getByText("Connected")).toBeTruthy();
    expect(screen.getByText("Needs configuration")).toBeTruthy();
  });

  it("saves the post-connect configuration with the saved OAuth credential and no JSON key", async () => {
    mocks.get.mockResolvedValue(unconfigured);
    mocks.channels.mockResolvedValue({ channels: [{ slug: "main", bundle_id: "build.raft.app" }] });
    mocks.save.mockResolvedValue({ google_play: {} });
    renderPanel();
    await waitFor(() =>
      expect(screen.getByLabelText("Choose an existing Android package").textContent).toContain("build.raft.app"),
    );
    expect(screen.queryByLabelText("Choose JSON file")).toBeNull();
    const save = screen.getByRole("button", { name: "Validate, save & enable" });
    await selectClosedTrack();
    expect(save.hasAttribute("disabled")).toBe(false);
    fireEvent.click(save);
    await waitFor(() =>
      expect(mocks.save).toHaveBeenCalledWith("app-a", {
        package_name: "build.raft.app",
        tracks: { internal: "internal", closed: "actual-closed-7", production: "production" },
      }),
    );
    expect(JSON.stringify(mocks.save.mock.calls[0]?.[1])).not.toContain("service_account_json");
  });

  it("keeps a manually entered package when the channel lookup finishes later", async () => {
    mocks.get.mockResolvedValue(unconfigured);
    let finish!: (value: unknown) => void;
    mocks.channels.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    renderPanel();
    const field = await screen.findByLabelText("Android package name");
    fireEvent.change(field, { target: { value: "custom.play.app" } });
    await act(async () => { finish({ channels: [{ slug: "main", bundle_id: "build.raft.app" }] }); });
    await waitFor(() => expect((screen.getByLabelText("Android package name") as HTMLInputElement).value).toBe("custom.play.app"));
  });

  it("does not use a preview package when main has no identity", async () => {
    mocks.get.mockResolvedValue(unconfigured);
    mocks.channels.mockResolvedValue({ channels: [{ slug: "preview", bundle_id: "build.raft.preview" }, { slug: "main", bundle_id: null }] });
    renderPanel();
    const save = await screen.findByRole("button", { name: "Validate, save & enable" });
    expect(save.hasAttribute("disabled")).toBe(true);
    expect(screen.getByLabelText("Android package name")).toBeTruthy();
    expect(screen.getByText(/No APK or credential file/)).toBeTruthy();
  });

  it("connects with a bare authorization call and respects server availability", async () => {
    mocks.get.mockResolvedValue({ google_play: null, oauth_available: true });
    mocks.authorize.mockRejectedValue(new Error("fixture rejection"));
    renderPanel();
    const connect = await screen.findByRole("button", { name: "Connect" });
    await waitFor(() => expect(connect.hasAttribute("disabled")).toBe(false));
    // Unconnected stays a single row: no authorization tabs or long help.
    expect(screen.getByRole("button", { name: "Service account" })).toBeTruthy();
    expect(screen.queryByText("Google account")).toBeNull();
    expect(screen.queryByText(/Sign in with a Google account/)).toBeNull();
    fireEvent.click(connect);
    await waitFor(() => expect(mocks.authorize).toHaveBeenCalledWith("app-a"));
    expect(mocks.save).not.toHaveBeenCalled();
    cleanup();
    mocks.get.mockResolvedValue({ google_play: null, oauth_available: false });
    renderPanel();
    const disabled = await screen.findByRole("button", { name: "Connect" });
    await waitFor(() => expect(disabled.hasAttribute("disabled")).toBe(true));
    expect(screen.getByText("Google authorization is not configured on this server.")).toBeTruthy();
  });

  it("keeps an authorization failure on the row with a retry action", async () => {
    mocks.get.mockResolvedValue({ google_play: null, oauth_available: true });
    window.history.replaceState(null, "", "/?google_play_oauth=failed");
    mocks.authorize.mockRejectedValue(new Error("fixture rejection"));
    renderPanel();
    expect(await screen.findByText(/Google authorization failed/)).toBeTruthy();
    const retry = screen.getByRole("button", { name: "Retry" });
    fireEvent.click(retry);
    await waitFor(() => expect(mocks.authorize).toHaveBeenCalledWith("app-a"));
    expect(window.location.search).not.toContain("google_play_oauth");
  });

  it("maps a known backend error code to specific copy and clears the URL", async () => {
    mocks.get.mockResolvedValue({ google_play: null, oauth_available: true });
    window.history.replaceState(null, "", "/?google_play_oauth=failed&google_play_oauth_error=play_permissions");
    renderPanel();
    expect(await screen.findByText(/Play app verification failed/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(window.location.search).not.toContain("google_play_oauth");
    expect(window.location.search).not.toContain("play_permissions");
  });

  it("explains offline-access failures distinctly", async () => {
    mocks.get.mockResolvedValue({ google_play: null, oauth_available: true });
    window.history.replaceState(null, "", "/?google_play_oauth=failed&google_play_oauth_error=offline_access");
    renderPanel();
    expect(await screen.findByText(/offline access/)).toBeTruthy();
  });

  it("falls back to the generic copy for unknown error codes without echoing them", async () => {
    mocks.get.mockResolvedValue({ google_play: null, oauth_available: true });
    window.history.replaceState(null, "", "/?google_play_oauth=failed&google_play_oauth_error=future_code");
    renderPanel();
    expect(await screen.findByText(/Google authorization failed\./)).toBeTruthy();
    expect(screen.queryByText(/future_code/)).toBeNull();
  });

  it.each(["__proto__", "toString", "constructor", "hasOwnProperty"])(
    "keeps the generic fallback for inherited-object keys (%s)",
    async (code) => {
      mocks.get.mockResolvedValue({ google_play: null, oauth_available: true });
      window.history.replaceState(null, "", `/?google_play_oauth=failed&google_play_oauth_error=${code}`);
      renderPanel();
      expect(await screen.findByText(/Google authorization failed\./)).toBeTruthy();
      expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    },
  );

  it("describes connection_changed as a Hands-side change", async () => {
    mocks.get.mockResolvedValue({ google_play: null, oauth_available: true });
    window.history.replaceState(null, "", "/?google_play_oauth=failed&google_play_oauth_error=connection_changed");
    renderPanel();
    expect(await screen.findByText(/changed in Hands during authorization/)).toBeTruthy();
  });

  it("labels a human OAuth identity and explains local disconnect", async () => {
    mocks.get.mockResolvedValue({ google_play: { credential_kind: "authorized_user", enabled: true, verification_state: "verified", package_name: "build.raft.app", service_account_email: "human@example.com", internal_track: "internal", closed_track: "closed", production_track: "production" } });
    renderPanel();
    await expandConnectedDetail();
    expect(await screen.findByText("Google account: human@example.com")).toBeTruthy();
    expect(screen.getByText(/Unbind deletes the credential stored by Hands/)).toBeTruthy();
  });

  it("shows app-scoped binding metadata and enables only through the explicit action", async () => {
    mocks.get.mockResolvedValue({
      google_play: {
        enabled: false,
        verification_state: "stale",
        package_name: "build.raft.app",
        service_account_email: "app@tenant.example",
        internal_track: "qa",
        closed_track: "closed",
        production_track: "production",
      },
    });
    renderPanel();

    expect(await screen.findByText("build.raft.app")).toBeTruthy();
    expect(screen.getByText("Disabled")).toBeTruthy();
    expect(screen.getByTestId("google-play-binding-panel").textContent).toContain("Needs verification");
    await expandConnectedDetail();
    fireEvent.click(screen.getByRole("button", { name: "Enable" }));
    await waitFor(() => expect(mocks.toggle).toHaveBeenCalledWith("app-a", true));
  });

  it("requires a complete service-account file and package before save", async () => {
    mocks.get.mockResolvedValue({ google_play: null });
    renderPanel();

    fireEvent.click(await screen.findByRole("button", { name: "Service account" }));
    const save = await screen.findByRole("button", { name: "Validate, save & enable" });
    expect(save.hasAttribute("disabled")).toBe(true);
    fireEvent.change(screen.getByLabelText("Android package name"), { target: { value: "build.raft.app" } });
    const file = new File(["fixture"], "service-account.json", { type: "application/json" });
    Object.defineProperty(file, "text", {
      value: async () => JSON.stringify({
        type: "service_account",
        client_email: "app@tenant.example",
        private_key: "-----BEGIN PRIVATE KEY-----\\ntest\\n-----END PRIVATE KEY-----",
      }),
    });
    fireEvent.change(screen.getByLabelText("Choose JSON file"), { target: { files: [file] } });

    await selectClosedTrack();
    await waitFor(() => expect(save.hasAttribute("disabled")).toBe(false));
    fireEvent.click(save);
    await waitFor(() => expect(mocks.save).toHaveBeenCalledWith("app-a", expect.objectContaining({
      package_name: "build.raft.app",
      tracks: { internal: "internal", closed: "actual-closed-7", production: "production" },
    })));
    expect(JSON.stringify(mocks.save.mock.calls[0]?.[1])).toContain("service_account");
  });

  it("refreshes binding state after a rejected verification disables it", async () => {
    mocks.get
      .mockResolvedValueOnce({
        google_play: {
          enabled: true,
          verification_state: "verified",
          package_name: "build.raft.app",
          service_account_email: "app@tenant.example",
          internal_track: "internal",
          closed_track: "closed",
          production_track: "production",
        },
      })
      .mockResolvedValue({
        google_play: {
          enabled: false,
          verification_state: "stale",
          package_name: "build.raft.app",
          service_account_email: "app@tenant.example",
          internal_track: "internal",
          closed_track: "closed",
          production_track: "production",
        },
      });
    mocks.verify.mockRejectedValue(new Error("permission denied"));
    renderPanel();
    await expandConnectedDetail();

    fireEvent.click(await screen.findByRole("button", { name: "Test connection" }));
    await waitFor(() => expect(mocks.get).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByTestId("google-play-binding-panel").textContent).toContain("Needs verification"));
    expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({ kind: "error" }));
  });

  it("keeps a connected connector collapsed until expanded", async () => {
    mocks.get.mockResolvedValue({
      google_play: {
        credential_kind: "authorized_user",
        enabled: true,
        verification_state: "verified",
        package_name: "build.raft.app",
        service_account_email: "human@example.com",
        internal_track: "internal",
        closed_track: "closed",
        production_track: "production",
      },
    });
    renderPanel();
    expect(await screen.findByText("Enabled")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Unbind" })).toBeNull();
    expect(mocks.tracks).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Expand" }));
    expect(await screen.findByRole("button", { name: "Unbind" })).toBeTruthy();
  });
  it("keeps save disabled when Play refuses discovery and offers retry", async () => {
    mocks.get.mockResolvedValue(unconfigured);
    mocks.channels.mockResolvedValue({ channels: [{ slug: "main", bundle_id: "build.raft.app" }] });
    mocks.tracks.mockRejectedValue(new Error("Play access denied"));
    renderPanel();
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Play access denied");
    expect(screen.getByRole("button", { name: "Validate, save & enable" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByLabelText("Closed testing track").hasAttribute("disabled")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Refresh tracks" }));
    await waitFor(() => expect(mocks.tracks).toHaveBeenCalledTimes(2));
  });
  it("ignores tracks from the previous package after the user switches apps", async () => {
    mocks.get.mockResolvedValue(unconfigured);
    let finish!: (result: unknown) => void;
    mocks.tracks.mockImplementation((_app, body) => body.package_name === "old.play.app"
      ? new Promise((resolve) => { finish = resolve; })
      : Promise.resolve({ package_name: body.package_name, tracks: ["internal", "new-closed", "production"] }));
    renderPanel();
    const field = await screen.findByLabelText("Android package name");
    fireEvent.change(field, { target: { value: "old.play.app" } });
    await waitFor(() => expect(mocks.tracks).toHaveBeenCalledTimes(1));
    fireEvent.change(field, { target: { value: "new.play.app" } });
    await waitFor(() => expect(mocks.tracks).toHaveBeenCalledTimes(2));
    await act(async () => { finish({ package_name: "old.play.app", tracks: ["wrong-closed"] }); });
    await waitFor(() => expect(screen.getByLabelText("Closed testing track").hasAttribute("disabled")).toBe(false));
    fireEvent.click(screen.getByLabelText("Closed testing track"));
    expect(await screen.findByRole("option", { name: "new-closed" })).toBeTruthy();
    expect(screen.queryByRole("option", { name: "wrong-closed" })).toBeNull();
  });

});
