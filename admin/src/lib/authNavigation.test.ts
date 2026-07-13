import { describe, expect, it } from "vitest";
import { dashboardHref } from "./authNavigation";
import type { AuthAccount } from "./api";

describe("dashboardHref", () => {
  it("starts Login with Raft for unauthenticated visitors", () => {
    expect(dashboardHref()).toBe("/api/auth/login?return=%2Fapps");
  });

  it("opens the dashboard directly for authenticated accounts", () => {
    expect(dashboardHref({} as AuthAccount)).toBe("/apps");
  });
});
