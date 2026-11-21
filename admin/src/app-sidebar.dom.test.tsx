// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { ThemeProvider } from "@botiverse/raft-ui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Header, MobileTopNav, isWorkspacePage } from "./App";
import { LocaleProvider, LOCALE_STORAGE } from "./lib/locale";
import type { AuthAccount } from "./lib/api";

const APP_ID = "11111111-1111-4111-8111-000000000001";

const account: AuthAccount = {
  id: "acc",
  provider: "raft",
  server_id: "srv",
  server_slug: "raft",
  principal_type: "human",
  server_role: "owner",
  org_id: "org-1",
  org_role: "owner",
  username: "artin",
  display_name: "artin",
  avatar_url: null,
  actor: "raft:artin",
};

function renderSidebar(path: string, who: AuthAccount = account) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(["orgs"], {
    orgs: [{ id: "org-1", slug: "raft", name: "Raft HQ", external_provider: "raft", external_id: "srv", created_at: 1 }],
  });
  client.setQueryData(["apps"], {
    apps: [{ id: APP_ID, org_id: "org-1", slug: "deck", name: "Deck", platform: "android", archived: 0 }],
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <ThemeProvider>
          <LocaleProvider>
            <Header account={who} />
          </LocaleProvider>
        </ThemeProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("app sidebar", () => {
  beforeEach(() => {
    // jsdom ships without matchMedia, which raft-ui's ThemeProvider reads.
    Object.defineProperty(window, "matchMedia", { configurable: true, value: () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }) });
    localStorage.setItem(LOCALE_STORAGE, "en");
    localStorage.removeItem("hands:sidebar-collapsed");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({}));
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("lists the app's sections and marks the current one", () => {
    renderSidebar(`/apps/${APP_ID}/releases`);
    const nav = screen.getByRole("navigation", { name: "Hands" });
    const releases = within(nav).getByRole("link", { name: "Releases" });
    expect(releases.getAttribute("href")).toBe(`/apps/${APP_ID}/releases`);
    expect(releases.getAttribute("aria-current")).toBe("page");
    expect(releases.hasAttribute("data-active")).toBe(true);
    expect(within(nav).getByRole("link", { name: "Builds" }).hasAttribute("data-active")).toBe(false);
    // iOS-only sections are filtered out for an Android app.
    expect(within(nav).queryByRole("link", { name: "TestFlight" })).toBeNull();
    expect(within(nav).getByRole("button", { name: "Switch app: Deck" })).toBeTruthy();
  });

  it("shows the organization entry, linking to the org page", () => {
    renderSidebar(`/apps/${APP_ID}/releases`);
    expect(screen.getByText("Organization")).toBeTruthy();
    const org = screen.getByRole("link", { name: "Raft HQ" });
    expect(org.getAttribute("href")).toBe("/orgs/org-1/general");
    expect(org.hasAttribute("data-active")).toBe(false);
    expect(org.getAttribute("aria-current")).toBeNull();
  });

  it("lists the organization's own pages on an org route", () => {
    renderSidebar("/orgs/org-1/signing");
    const nav = screen.getByRole("navigation", { name: "Hands" });
    // The org's pages replace the app nav, under a group named after the org.
    expect(within(nav).getByText("Raft HQ")).toBeTruthy();
    expect(within(nav).queryByRole("link", { name: "Releases" })).toBeNull();
    const tabs = ["general", "members", "invites", "audit", "webhooks", "signing"];
    const names = ["General", "Members", "Invites", "Audit", "Webhooks", "Signing"];
    names.forEach((name, i) => {
      const link = within(nav).getByRole("link", { name });
      expect(link.getAttribute("href")).toBe(`/orgs/org-1/${tabs[i]}`);
      const current = tabs[i] === "signing";
      expect(link.hasAttribute("data-active")).toBe(current);
      expect(link.getAttribute("aria-current")).toBe(current ? "page" : null);
    });
    // One way to the org: the bottom Organization entry steps aside here.
    expect(within(nav).queryByRole("link", { name: "Raft HQ" })).toBeNull();
    // The header still leads back to the apps.
    expect(within(nav).getByRole("button", { name: "Open an app" })).toBeTruthy();
  });

  it("marks General active on the bare org route", () => {
    renderSidebar("/orgs/org-1");
    const general = screen.getByRole("link", { name: "General" });
    expect(general.getAttribute("aria-current")).toBe("page");
  });

  it("hides the organization entry without an org", () => {
    renderSidebar(`/apps/${APP_ID}`, { ...account, org_id: null });
    expect(screen.queryByText("Organization")).toBeNull();
    expect(screen.queryByRole("link", { name: "Raft HQ" })).toBeNull();
  });

  it("collapses to icon-only rows that keep their names", () => {
    localStorage.setItem("hands:sidebar-collapsed", "1");
    renderSidebar(`/apps/${APP_ID}/releases`);
    expect(screen.queryByText("Distribute")).toBeNull();
    expect(screen.queryByText("Organization")).toBeNull();
    expect(screen.getByRole("link", { name: "Releases" }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("link", { name: "Raft HQ" }).getAttribute("href")).toBe("/orgs/org-1/general");
    expect(screen.getByRole("button", { name: "Expand sidebar" })).toBeTruthy();
  });
});

describe("workspace pages", () => {
  beforeEach(() => {
    Object.defineProperty(window, "matchMedia", { configurable: true, value: () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }) });
    localStorage.setItem(LOCALE_STORAGE, "en");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({}));
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("drops the sidebar only off apps and organizations", () => {
    for (const path of ["/", "/apps", "/settings", "/admin", "/invites/abc"]) {
      expect(isWorkspacePage(path)).toBe(true);
    }
    for (const path of [`/apps/${APP_ID}`, `/apps/${APP_ID}/releases`, "/orgs/org-1/general"]) {
      expect(isWorkspacePage(path)).toBe(false);
    }
  });

  it("shows the top bar at every width when persistent", () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    client.setQueryData(["orgs"], { orgs: [{ id: "org-1", slug: "raft", name: "Raft HQ", external_provider: "raft", external_id: "srv", created_at: 1 }] });
    client.setQueryData(["apps"], { apps: [] });
    const view = (persistent: boolean) => (
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={["/apps?all=1"]}>
          <ThemeProvider>
            <LocaleProvider>
              <MobileTopNav account={account} persistent={persistent} />
            </LocaleProvider>
          </ThemeProvider>
        </MemoryRouter>
      </QueryClientProvider>
    );
    const { container, rerender } = render(view(true));
    const header = container.querySelector("header")!;
    expect(header.className).not.toContain("md:hidden");
    expect(within(header).getByRole("button", { name: "Organization Raft HQ" })).toBeTruthy();
    expect(within(header).getByRole("button", { name: "artin" })).toBeTruthy();
    rerender(view(false));
    expect(container.querySelector("header")!.className).toContain("md:hidden");
  });
});
