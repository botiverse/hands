// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { ThemeProvider } from "@botiverse/raft-ui";

const mocks = vi.hoisted(() => ({
  me: vi.fn(),
  orgs: vi.fn(),
  overview: vi.fn(),
  accept: vi.fn(),
  toast: vi.fn(),
}));

vi.mock("../components/Toast", () => ({ useToast: () => ({ show: mocks.toast, update: vi.fn() }) }));
vi.mock("../lib/api", async (importOriginal) => ({
  ...await importOriginal<typeof import("../lib/api")>(),
  getAuthMe: mocks.me,
  listOrgs: mocks.orgs,
  getHandsAdminOverview: mocks.overview,
  acceptInvite: mocks.accept,
}));

import { ApiError } from "../lib/api";
import { LocaleProvider } from "../lib/locale";
import { Settings } from "./Settings";
import { HandsAdmin } from "./HandsAdmin";
import { AcceptInvite } from "./AcceptInvite";

globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;

beforeAll(() => {
  if (typeof window.matchMedia !== "function") {
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      configurable: true,
      value: (query: string) => ({
        matches: false, media: query, onchange: null,
        addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
      }) as unknown as MediaQueryList,
    });
  }
});

const NOW = Date.now();
const D = 86_400_000;
const ACCOUNT = {
  id: "acc", provider: "raft", server_id: "srv", server_slug: "raft", principal_type: "human", server_role: "admin",
  org_id: "org-1", org_role: "owner", username: "artin", display_name: "Artin", avatar_url: null, actor: "raft:artin",
};

function renderAt(node: ReactNode, path = "/", routePath = "*") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <ThemeProvider defaultMode="light" storageKey="account-pages-test">
      <LocaleProvider>
        <MemoryRouter initialEntries={[path]}>
          <QueryClientProvider client={client}>
            <Routes>
              <Route path={routePath} element={node} />
              <Route path="/apps/:appId" element={<p>App page</p>} />
              <Route path="/" element={<p>Home page</p>} />
            </Routes>
          </QueryClientProvider>
        </MemoryRouter>
      </LocaleProvider>
    </ThemeProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  mocks.me.mockResolvedValue({ authenticated: true, account: ACCOUNT });
  mocks.orgs.mockResolvedValue({ orgs: [{ id: "org-1", slug: "botiverse", name: "Botiverse", external_provider: "raft", external_id: "srv", created_at: 1, archived: 0 }] });
});
afterEach(() => cleanup());

describe("Settings", () => {
  it("shows appearance, the account and sign-in as rows", async () => {
    renderAt(<Settings />, "/settings");
    expect(screen.getByRole("heading", { level: 1, name: "Settings" })).toBeTruthy();
    expect(screen.getByTestId("appearance-mode-dark")).toBeTruthy();
    expect(await screen.findByText("Artin")).toBeTruthy();
    expect(await screen.findByText("Botiverse")).toBeTruthy();
    expect(screen.getByText("Owner")).toBeTruthy();
    expect(screen.getByText(/\/login\/raft\/callback$/)).toBeTruthy();
    const org = screen.getByText("Botiverse").closest("a");
    expect(org?.getAttribute("href")).toBe("/orgs/org-1/general");
  });

  it("applies the mode at once", () => {
    renderAt(<Settings />, "/settings");
    fireEvent.click(screen.getByTestId("appearance-mode-dark"));
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    fireEvent.click(screen.getByTestId("appearance-mode-light"));
  });
});

describe("Hands admin", () => {
  it("shows the totals and the breakdowns", async () => {
    mocks.overview.mockResolvedValue({
      measured_at: NOW,
      summary: { users: 1284, organizations: 37, apps: 212, active_apps: 168, builds: 48210, releases: 9132 },
      users_by_type: [{ type: "human", count: 1102 }, { type: "agent", count: 182 }],
      apps_by_platform: [{ type: "android", count: 81 }],
      builds_by_product_type: [],
      releases_by_status: [{ status: "superseded", count: 8011 }],
      storage: { r2: { object_count: 10, size_bytes: 2048 }, registered: { object_count: 9, size_bytes: 1024 }, note: "x" },
    });
    renderAt(<HandsAdmin />, "/admin");
    expect(await screen.findByText("1,284")).toBeTruthy();
    expect(screen.getByText("Agent")).toBeTruthy();
    expect(screen.getByText("Superseded")).toBeTruthy();
    expect(screen.getByText("2.0 KB")).toBeTruthy();
    expect(screen.getByText("No builds yet")).toBeTruthy();
  });

  it("says when the visitor is not an administrator", async () => {
    mocks.overview.mockRejectedValue(new ApiError(403, {}, "forbidden"));
    renderAt(<HandsAdmin />, "/admin");
    expect(await screen.findByText("Administrator access required")).toBeTruthy();
  });

  it("offers to sign in again when the session is gone", async () => {
    mocks.overview.mockRejectedValue(new ApiError(401, {}, "unauthorized"));
    renderAt(<HandsAdmin />, "/admin");
    const link = (await screen.findByText("Continue with Raft")).closest("a")!;
    expect(link.getAttribute("href")).toBe("/api/auth/login?return=%2Fadmin");
  });
});

describe("Accept invite", () => {
  const invite = (extra: Record<string, unknown> = {}) => ({
    id: "i1", org_id: "org-1", app_id: null, email: "jordan@example.com", role: "member", status: "pending",
    message: "Welcome aboard!", created_at: NOW - D, expires_at: NOW + 6 * D, invited_by_display_name: "Artin", org_name: "Botiverse", ...extra,
  });
  const serve = (body: unknown, status = 200) => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status })));
  };
  afterEach(() => vi.unstubAllGlobals());

  it("names the organization, the inviter and the role, and accepts with one button", async () => {
    serve(invite());
    mocks.accept.mockResolvedValue({ ok: true, org_id: "org-1", app_id: null });
    renderAt(<AcceptInvite token="tok123" />, "/invites/tok123", "/invites/:token");
    expect(await screen.findByRole("heading", { name: "Join Botiverse" })).toBeTruthy();
    expect(screen.getByText("Artin invited you as member.")).toBeTruthy();
    expect(screen.getByText("Welcome aboard!")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Accept invite" }));
    await waitFor(() => expect(mocks.accept).toHaveBeenCalledWith("tok123"));
    expect(await screen.findByText("Home page")).toBeTruthy();
  });

  it("opens the app after accepting an app invite", async () => {
    serve(invite({ app_id: "app-9", app_name: "Raft Deck", role: "publisher" }));
    mocks.accept.mockResolvedValue({ ok: true, org_id: "org-1", app_id: "app-9" });
    renderAt(<AcceptInvite token="tok123" />, "/invites/tok123", "/invites/:token");
    expect(await screen.findByText("Artin invited you to Raft Deck as publisher.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Accept invite" }));
    expect(await screen.findByText("App page")).toBeTruthy();
  });

  it("asks a signed-out visitor to sign in first", async () => {
    serve(invite());
    mocks.me.mockResolvedValue({ authenticated: false });
    renderAt(<AcceptInvite token="tok123" />, "/invites/tok123", "/invites/:token");
    const link = (await screen.findByText("Sign in with Raft to accept")).closest("a")!;
    expect(link.getAttribute("href")).toContain("/api/auth/login?return=%2Finvites%2Ftok123");
  });

  it("says an expired or revoked invite can't be accepted", async () => {
    serve(invite({ expires_at: NOW - D }));
    renderAt(<AcceptInvite token="tok123" />, "/invites/tok123", "/invites/:token");
    expect(await screen.findByText("This invite has expired")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Accept invite" })).toBeNull();
    cleanup();
    serve(invite({ status: "revoked" }));
    renderAt(<AcceptInvite token="tok123" />, "/invites/tok123", "/invites/:token");
    expect(await screen.findByText("This invite was revoked")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Accept invite" })).toBeNull();
  });

  it("says when the link can't be opened", async () => {
    serve({ error: "invite not found" }, 404);
    renderAt(<AcceptInvite token="nope" />, "/invites/nope", "/invites/:token");
    expect(await screen.findByText("This invite can't be opened")).toBeTruthy();
    expect(screen.getByText("invite not found")).toBeTruthy();
  });
});
