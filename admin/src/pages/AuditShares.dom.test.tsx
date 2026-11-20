// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

const mocks = vi.hoisted(() => ({
  listAuditLogs: vi.fn(),
  listAppShares: vi.fn(),
  listReleases: vi.fn(),
  revokeReleaseShare: vi.fn(),
  renewReleaseShare: vi.fn(),
  toast: vi.fn(),
}));

vi.mock("../components/Toast", () => ({
  useToast: () => ({ show: mocks.toast, update: vi.fn() }),
}));

vi.mock("../lib/api", async (importOriginal) => ({
  ...await importOriginal<typeof import("../lib/api")>(),
  listAuditLogs: mocks.listAuditLogs,
  listAppShares: mocks.listAppShares,
  listReleases: mocks.listReleases,
  revokeReleaseShare: mocks.revokeReleaseShare,
  renewReleaseShare: mocks.renewReleaseShare,
}));

import { AuditLog, actionArea, payloadSummary } from "./AuditLog";
import { AppShares } from "./Shares";

globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;

const NOW = Date.now();

function renderPage(node: ReactNode, path = "/") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <MemoryRouter initialEntries={[path]}>
      <QueryClientProvider client={client}>{node}</QueryClientProvider>
    </MemoryRouter>,
  );
}

const entry = (id: string, action: string, payload: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  id, app_id: "app-1", action, actor: "raft:artin", actor_id: "acc-artin", actor_type: "human",
  actor_display_name: "Artin", actor_username: "artin", actor_avatar_url: null, actor_server_slug: "raft",
  payload: JSON.stringify(payload), created_at: NOW - 60_000, ...extra,
});

const share = (id: string, extra: Record<string, unknown> = {}) => ({
  id, release_id: `r-${id}`, channel_id: "c1", share_url: `https://hands.example/s/${id}`, created_by: "raft:artin",
  created_at: NOW - 3_600_000, expires_at: null, revoked_at: null, has_password: 0, release_status: "active",
  channel_slug: "main", version_name: "1.8.2", version_code: 182, view_count: 40, unique_view_count: 12,
  download_count: 9, unique_download_count: 7, ...extra,
});

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => cleanup());

describe("Audit", () => {
  beforeEach(() => {
    mocks.listAuditLogs.mockResolvedValue({ logs: [
      entry("e1", "release.publish", { version_name: "1.9.0", channel: "preview", rollout: 25 }),
      entry("e2", "release_check.record", { source: "e2e" }),
      entry("e3", "channel.create", { slug: "nightly" }, { actor_type: "agent", actor_display_name: "Release bot", actor_username: "release-bot", actor_id: "acc-bot" }),
    ] });
  });

  it("shows one row per entry with the action as a tag and a payload summary", async () => {
    renderPage(<AuditLog appId="app-1" />);
    expect(await screen.findByText("release.publish")).toBeTruthy();
    expect(screen.getByText("version_name 1.9.0 · channel preview · rollout 25")).toBeTruthy();
    expect(screen.getByText("channel.create")).toBeTruthy();
    expect(screen.getByText("agent")).toBeTruthy();
    expect(mocks.listAuditLogs).toHaveBeenCalledWith("app-1", {});
  });

  it("shows the whole payload when a row is pressed, and hides it again", async () => {
    renderPage(<AuditLog appId="app-1" />);
    const row = (await screen.findByText("channel.create")).closest("button")!;
    expect(row.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(row);
    expect(row.getAttribute("aria-expanded")).toBe("true");
    const panelId = row.getAttribute("aria-controls")!;
    const payload = document.getElementById(panelId);
    expect(payload?.querySelector("pre")?.textContent).toContain('"slug": "nightly"');
    fireEvent.click(row);
    expect(document.getElementById(panelId)).toBeNull();
  });

  it("sends the filters in the URL to the server and keeps only the exact action area", async () => {
    renderPage(<AuditLog appId="app-1" />, "/?action=release&since=7d");
    await screen.findByText("release.publish");
    const [, filters] = mocks.listAuditLogs.mock.calls[0]!;
    expect(filters.actionPrefix).toBe("release");
    expect(Math.abs(filters.since - (Date.now() - 7 * 86_400_000))).toBeLessThan(5_000);
    // The server's prefix also matches release_check.*; the page drops it.
    expect(screen.queryByText("release_check.record")).toBeNull();
    expect(screen.queryByText("channel.create")).toBeNull();
    fireEvent.click(screen.getByText("Clear all"));
    await waitFor(() => expect(mocks.listAuditLogs).toHaveBeenLastCalledWith("app-1", {}));
  });

  it("searches the loaded entries and says when nothing matches", async () => {
    renderPage(<AuditLog appId="app-1" />);
    await screen.findByText("release.publish");
    fireEvent.change(screen.getByLabelText("Search the audit log"), { target: { value: "nightly" } });
    expect(screen.queryByText("release.publish")).toBeNull();
    expect(screen.getByText("channel.create")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Search the audit log"), { target: { value: "zzz" } });
    expect(screen.getByText("No entries match")).toBeTruthy();
  });

  it("has an empty state", async () => {
    mocks.listAuditLogs.mockResolvedValue({ logs: [] });
    renderPage(<AuditLog appId="app-1" />);
    expect(await screen.findByText("Nothing recorded yet")).toBeTruthy();
  });

  it("derives the area and the summary", () => {
    expect(actionArea("google_play.binding.enable")).toBe("google_play");
    expect(payloadSummary({ a: 1, nested: { x: 1 }, b: null, c: "x", d: true, e: 5 })).toBe("a 1 · c x · d true");
    expect(payloadSummary("raw")).toBe("");
  });
});

describe("Shares", () => {
  beforeEach(() => {
    mocks.listAppShares.mockResolvedValue({ shares: [
      share("s1", { has_password: 1 }),
      share("s2", { version_name: "1.7.0", version_code: 170, revoked_at: NOW - 86_400_000 }),
      share("s3", { version_name: "1.6.0", version_code: 160, expires_at: NOW - 1000, share_url: null }),
    ] });
    mocks.listReleases.mockResolvedValue({ releases: [] });
    mocks.revokeReleaseShare.mockResolvedValue({ ok: true });
  });

  it("lists the shares with their state", async () => {
    renderPage(<AppShares appId="app-1" />);
    expect(await screen.findByText("1.8.2 (182)")).toBeTruthy();
    expect(screen.getByText("Active")).toBeTruthy();
    expect(screen.getByText("Revoked")).toBeTruthy();
    expect(screen.getByText("Expired")).toBeTruthy();
    expect(screen.getByText("Legacy")).toBeTruthy();
  });

  it("opens a share in the column with its link and details", async () => {
    renderPage(<AppShares appId="app-1" />);
    fireEvent.click(await screen.findByText("1.8.2 (182)"));
    const column = screen.getByRole("region", { name: "1.8.2 (182)" });
    expect(within(column).getByText("https://hands.example/s/s1")).toBeTruthy();
    expect(within(column).getByText("Required")).toBeTruthy();
    expect(within(column).getByText("Revoke share")).toBeTruthy();
    fireEvent.click(within(column).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("region", { name: "1.8.2 (182)" })).toBeNull();
  });

  it("asks before revoking, and revokes on confirm", async () => {
    renderPage(<AppShares appId="app-1" />);
    fireEvent.click(await screen.findByText("1.8.2 (182)"));
    fireEvent.click(screen.getByText("Revoke share"));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText("Revoke this share?")).toBeTruthy();
    expect(mocks.revokeReleaseShare).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Revoke share" }));
    await waitFor(() => expect(mocks.revokeReleaseShare).toHaveBeenCalledWith("app-1", "r-s1", "s1"));
  });

  it("offers no actions on a revoked share", async () => {
    renderPage(<AppShares appId="app-1" />);
    fireEvent.click(await screen.findByText("1.7.0 (170)"));
    const column = screen.getByRole("region", { name: "1.7.0 (170)" });
    expect(within(column).queryByText("Revoke share")).toBeNull();
    expect(within(column).getByText("A revoked link can't be changed.")).toBeTruthy();
  });

  it("clears the expiry from its dialog when the days are left empty", async () => {
    mocks.renewReleaseShare.mockResolvedValue({ ok: true });
    renderPage(<AppShares appId="app-1" />);
    fireEvent.click(await screen.findByText("1.8.2 (182)"));
    fireEvent.click(screen.getByText("Set an expiry"));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText(/Days until the link expires/), { target: { value: "-2" } });
    expect((within(dialog).getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(within(dialog).getByLabelText(/Days until the link expires/), { target: { value: "" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(mocks.renewReleaseShare).toHaveBeenCalledWith("app-1", "r-s1", "s1", { expires_at: null }));
  });

  it("has an empty state", async () => {
    mocks.listAppShares.mockResolvedValue({ shares: [] });
    renderPage(<AppShares appId="app-1" />);
    expect(await screen.findByText("No shares yet")).toBeTruthy();
  });
});
