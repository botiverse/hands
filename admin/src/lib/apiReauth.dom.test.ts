// @vitest-environment jsdom
//
// The shared request layer renews the browser session on SESSION_REAUTH_REQUIRED
// (the admin console's "one layer, no half-session" fix). These tests lock the four
// gates: it redirects only on that code, carries the return path, is single-flight /
// loop-guarded, and never redirects on config errors or 403.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let hrefLog: string[] = [];

function setLocation(pathname: string, search = "") {
  Object.defineProperty(window, "location", {
    configurable: true,
    value: {
      pathname,
      search,
      hash: "",
      get href() {
        return hrefLog[hrefLog.length - 1] ?? "";
      },
      set href(v: string) {
        hrefLog.push(v);
      },
    },
  });
}

function mockJson(status: number, body: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })),
  );
}

// Fresh module per test so the module-load consumeAuthTokenFromUrl() and closures reset.
async function loadApi() {
  vi.resetModules();
  return import("./api");
}

beforeEach(() => {
  hrefLog = [];
  setLocation("/admin", "?x=1");
  window.sessionStorage.clear();
  window.localStorage.clear();
});
afterEach(() => vi.unstubAllGlobals());

describe("SESSION_REAUTH_REQUIRED renewal (shared request layer)", () => {
  it("redirects to Login with Raft carrying the current path as return", async () => {
    const api = await loadApi();
    mockJson(401, { error: "unauthorized", code: "SESSION_REAUTH_REQUIRED" });
    // The renewal returns a never-resolving promise; assert the side effect instead.
    void api.getHandsAdminOverview();
    await vi.waitFor(() => expect(hrefLog.length).toBe(1));
    expect(hrefLog[0]).toBe(`/api/auth/login?return=${encodeURIComponent("/admin?x=1")}`);
  });

  it("is single-flight / loop-guarded: a second SESSION_REAUTH_REQUIRED within the window does not redirect again, it errors", async () => {
    const api = await loadApi();
    mockJson(401, { error: "unauthorized", code: "SESSION_REAUTH_REQUIRED" });
    void api.getHandsAdminOverview();
    await vi.waitFor(() => expect(hrefLog.length).toBe(1));
    // Second call, still SESSION_REAUTH_REQUIRED: the 30s guard blocks a re-redirect,
    // so it surfaces the error (→ the manual "Sign in again" fallback) instead of looping.
    await expect(api.getHandsAdminOverview()).rejects.toMatchObject({ status: 401 });
    expect(hrefLog.length).toBe(1);
  });

  it("does NOT redirect on ADMIN_AUTH_UNAVAILABLE (server config, not a login problem)", async () => {
    const api = await loadApi();
    mockJson(401, { error: "unauthorized", code: "ADMIN_AUTH_UNAVAILABLE" });
    await expect(api.getHandsAdminOverview()).rejects.toMatchObject({ status: 401 });
    expect(hrefLog.length).toBe(0);
  });

  it("does NOT redirect on 403 (not an administrator)", async () => {
    const api = await loadApi();
    mockJson(403, { error: "forbidden", code: "HANDS_ADMIN_REQUIRED" });
    await expect(api.getHandsAdminOverview()).rejects.toMatchObject({ status: 403 });
    expect(hrefLog.length).toBe(0);
  });

  it("does NOT redirect on the legacy ADMIN_RELOGIN_REQUIRED (agent/no-credential — never browser-renew)", async () => {
    const api = await loadApi();
    mockJson(401, { error: "unauthorized", code: "ADMIN_RELOGIN_REQUIRED" });
    await expect(api.getHandsAdminOverview()).rejects.toMatchObject({ status: 401 });
    expect(hrefLog.length).toBe(0);
  });
});
