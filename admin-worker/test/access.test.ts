import { describe, expect, it, vi } from "vitest";
import { app } from "../src/index";

describe("Hands admin access gate", () => {
  it("rejects an unauthenticated overview before calling product RPC or audit storage", async () => {
    const getOverview = vi.fn();
    const prepare = vi.fn();
    const response = await app.request("https://admin.example/api/overview", {}, {
      HANDS_OBSERVABILITY: { getOverview },
      AUDIT_DB: { prepare },
      SESSION_SECRET: "test-secret",
      RAFT_ALLOWED_SERVER_IDS: "server-1",
      RAFT_CLIENT_ID: "client",
      RAFT_CLIENT_SECRET: "secret",
      RAFT_ORIGIN: "https://app.raft.build",
      RAFT_API_ORIGIN: "https://api.raft.build",
    } as never);

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthorized", code: "AUTH_REQUIRED" });
    expect(getOverview).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
  });
});
