import { afterEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({
  admit: vi.fn(),
  fresh: vi.fn(),
  force: vi.fn(),
}));
vi.mock("./agent_env.js", () => ({ admitAgent: auth.admit }));
vi.mock("./agent_refresh.js", () => ({ getFreshAgentAccessToken: auth.fresh, forceRefreshAgentToken: auth.force }));

import { agentAwareFetch, apiRequest, QuiverApiError, setApiBase } from "./api.js";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe("agent-aware 401 retry", () => {
  const env = { agentId: "agent", slockHome: "/tmp/not-used", transportDir: "/tmp/not-used", raftBin: "/tmp/not-used/raft" };
  it("does not resend a non-idempotent request after 401, while obtaining the proactively refreshed token first", async () => {
    auth.admit.mockReturnValue({ kind: "agent", env });
    auth.fresh.mockResolvedValue("proactively-refreshed");
    const send = vi.fn(async () => new Response("rejected", { status: 401 }));
    const response = await agentAwareFetch(send, { retryOnUnauthorized: false });
    expect(response.status).toBe(401);
    expect(auth.fresh).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith("proactively-refreshed");
    expect(auth.force).not.toHaveBeenCalled();
  });
  it("keeps the existing single reactive refresh for other calls", async () => {
    auth.admit.mockReturnValue({ kind: "agent", env });
    auth.fresh.mockResolvedValue("first"); auth.force.mockResolvedValue("refreshed");
    const send = vi.fn(async (_token: string | undefined) => new Response(null, { status: send.mock.calls.length === 1 ? 401 : 200 }));
    const response = await agentAwareFetch(send);
    expect(response.status).toBe(200);
    expect(send.mock.calls.map(([token]) => token)).toEqual(["first", "refreshed"]);
    expect(auth.force).toHaveBeenCalledOnce();
  });
  it("passes the retry opt-out through apiRequest and does not resend its POST body", async () => {
    auth.admit.mockReturnValue({ kind: "agent", env }); auth.fresh.mockResolvedValue("token");
    const fetch = vi.fn(async () => new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 }));
    vi.stubGlobal("fetch", fetch); setApiBase("https://hands.test");
    await expect(apiRequest("/write", { method: "POST", body: { name: "Test" }, retryOnUnauthorized: false })).rejects.toBeInstanceOf(QuiverApiError);
    expect(fetch).toHaveBeenCalledOnce(); expect(auth.force).not.toHaveBeenCalled();
    expect(JSON.parse(String((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body))).toEqual({ name: "Test" });
  });
});
