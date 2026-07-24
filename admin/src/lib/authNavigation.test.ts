import { describe, expect, it } from "vitest";
import { consoleRootTarget, dashboardHref, defaultAppHref, defaultAppResolverState } from "./authNavigation";
import type { AuthAccount } from "./api";

describe("dashboardHref", () => {
  it("starts Login with Raft for unauthenticated visitors", () => {
    expect(dashboardHref()).toBe("/api/auth/login?return=%2Fapps");
  });

  it("opens the dashboard directly for authenticated accounts", () => {
    expect(dashboardHref({} as AuthAccount)).toBe("/apps");
  });
});

describe("consoleRootTarget", () => {
  it("turns the exact console-domain root into the dashboard or Raft login", () => {
    const root = { hostname: "app.hands.build", pathname: "/" };
    expect(consoleRootTarget(root, {} as AuthAccount)).toBe("/apps");
    expect(consoleRootTarget(root)).toBe("/api/auth/login?return=%2Fapps");
  });

  it("does not redirect the public site, previews, localhost, or deep links", () => {
    for (const location of [
      { hostname: "hands.build", pathname: "/" },
      { hostname: "www.app.hands.build", pathname: "/" },
      { hostname: "preview.app.hands.build", pathname: "/" },
      { hostname: "localhost", pathname: "/" },
      { hostname: "app.hands.build", pathname: "/docs" },
      { hostname: "app.hands.build", pathname: "/apps/app-1" },
    ]) expect(consoleRootTarget(location, {} as AuthAccount)).toBeNull();
  });
});

describe("defaultAppHref", () => {
  const apps = [
    { id: "archived", archived: 1 },
    { id: "first", archived: 0 },
    { id: "last", archived: 0 },
  ];

  it("returns the last active app without exposing an Apps landing page", () => {
    expect(defaultAppHref(apps, "last")).toBe("/apps/last");
  });

  it("falls back to the first active app when the stored app is unavailable", () => {
    expect(defaultAppHref(apps, "missing")).toBe("/apps/first");
    expect(defaultAppHref(apps, "archived")).toBe("/apps/first");
  });

  it("returns null only when onboarding is required", () => {
    expect(defaultAppHref([{ id: "archived", archived: true }], "archived")).toBeNull();
    expect(defaultAppHref([], null)).toBeNull();
  });
});

describe("defaultAppResolverState", () => {
  it("keeps only the loading state blank", () => {
    expect(defaultAppResolverState({ isPending: true, isError: false })).toEqual({ kind: "loading" });
  });

  it("makes a terminal app-list error observable instead of leaving a blank shell", () => {
    expect(defaultAppResolverState({ isPending: false, isError: true })).toEqual({ kind: "error" });
    expect(defaultAppResolverState({ isPending: false, isError: false })).toEqual({ kind: "error" });
  });

  it("redirects once on success and reserves onboarding for a real empty list", () => {
    expect(defaultAppResolverState({
      apps: [{ id: "first" }, { id: "last" }], lastAppId: "last", isPending: false, isError: false,
    })).toEqual({ kind: "redirect", href: "/apps/last" });
    expect(defaultAppResolverState({ apps: [], isPending: false, isError: false })).toEqual({ kind: "onboarding" });
  });
});
