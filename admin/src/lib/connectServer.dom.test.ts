// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { ACTIVE_ORG_STORAGE_KEY, AUTH_TOKEN_STORAGE_KEY, consumeAuthTokenFromUrl, loginUrl } from "./api";

describe("adding a Raft server", () => {
  beforeEach(() => {
    localStorage.clear();
    history.replaceState(null, "", "/apps");
  });

  it("sends the user through the existing Raft authorization with a return marker", () => {
    expect(loginUrl("/apps?hands_connect_server=1"))
      .toBe("/api/auth/login?return=%2Fapps%3Fhands_connect_server%3D1");
  });

  it("switches to the newly authenticated server only after a successful callback", () => {
    localStorage.setItem(ACTIVE_ORG_STORAGE_KEY, "old-org");
    history.replaceState(null, "", "/apps?hands_connect_server=1&keep=value#access_token=new-token&expires_at=123&tab=activity");
    expect(consumeAuthTokenFromUrl()).toBe("new-token");
    expect(localStorage.getItem(AUTH_TOKEN_STORAGE_KEY)).toBe("new-token");
    expect(localStorage.getItem(ACTIVE_ORG_STORAGE_KEY)).toBeNull();
    expect(location.pathname + location.search + location.hash).toBe("/apps?keep=value#tab=activity");
  });

  it("keeps the existing selection if the flow is cancelled or an ordinary login returns", () => {
    localStorage.setItem(ACTIVE_ORG_STORAGE_KEY, "old-org");
    history.replaceState(null, "", "/apps?hands_connect_server=1");
    expect(consumeAuthTokenFromUrl()).toBeNull();
    expect(localStorage.getItem(ACTIVE_ORG_STORAGE_KEY)).toBe("old-org");
    history.replaceState(null, "", "/apps#access_token=another-token");
    expect(consumeAuthTokenFromUrl()).toBe("another-token");
    expect(localStorage.getItem(ACTIVE_ORG_STORAGE_KEY)).toBe("old-org");
  });
});
