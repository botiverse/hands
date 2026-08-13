import { describe, expect, it, vi } from "vitest";
import { EncryptJWT } from "jose";
import { app } from "../src/index";

const SESSION_SECRET = "0123456789abcdef0123456789abcdef";

async function sessionCookie() {
  const value = await new EncryptJWT({
    sub: "user-1",
    server_id: "server-1",
    role: "owner",
    name: "Reviewer",
    access_token: "access-token",
  }).setProtectedHeader({ alg: "dir", enc: "A256GCM" }).setIssuedAt().setExpirationTime("8h")
    .encrypt(new TextEncoder().encode(SESSION_SECRET));
  return `hands_admin_session=${value}`;
}

function env(getOverview: ReturnType<typeof vi.fn>, prepare: ReturnType<typeof vi.fn>) {
  return {
    HANDS_OBSERVABILITY: { getOverview },
    AUDIT_DB: { prepare },
    SESSION_SECRET,
    RAFT_ALLOWED_SERVER_IDS: "server-1",
    RAFT_CLIENT_ID: "client",
    RAFT_CLIENT_SECRET: "secret",
    RAFT_ORIGIN: "https://app.raft.build",
    RAFT_API_ORIGIN: "https://api.raft.build",
  } as never;
}

describe("Hands admin access gate", () => {
  it("rejects an unauthenticated overview before calling product RPC or audit storage", async () => {
    const getOverview = vi.fn();
    const prepare = vi.fn();
    const response = await app.request("https://admin.example/api/overview", {}, env(getOverview, prepare));

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthorized", code: "AUTH_REQUIRED" });
    expect(getOverview).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
  });

  it.each([
    ["a server outside the allowlist", { sub: "user-1", server_id: "server-2", server_role: "owner" }],
    ["a different live principal", { sub: "user-2", server_id: "server-1", server_role: "owner" }],
  ])("rejects %s before calling product RPC or audit storage", async (_name, userinfo) => {
    const getOverview = vi.fn();
    const prepare = vi.fn();
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(JSON.stringify(userinfo), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));

    const response = await app.request("https://admin.example/api/overview", {
      headers: { cookie: await sessionCookie() },
    }, env(getOverview, prepare));

    expect(response.status).toBe(403);
    expect(await response.text()).toBe("Hands staff access required");
    expect(getOverview).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it.each(["member", "viewer", "admin", "owner"])(
    "allows an authenticated %s from an allowlisted server",
    async (serverRole) => {
      const overview = {
        measured_at: 1,
        summary: { users: 0, organizations: 0, apps: 0, active_apps: 0, builds: 0, releases: 0 },
        users_by_type: [],
        apps_by_platform: [],
        builds_by_product_type: [],
        releases_by_status: [],
        releases_by_week: [],
        storage: {
          r2: { object_count: 0, size_bytes: 0 },
          registered: { object_count: 0, size_bytes: 0 },
          note: "test",
        },
      };
      const getOverview = vi.fn().mockResolvedValue(overview);
      const run = vi.fn().mockResolvedValue({ success: true });
      const bind = vi.fn().mockReturnValue({ run });
      const prepare = vi.fn().mockReturnValue({ bind });
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(JSON.stringify({
        sub: "user-1",
        server_id: "server-1",
        server_role: serverRole,
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }));

      const response = await app.request("https://admin.example/api/overview", {
        headers: { cookie: await sessionCookie() },
      }, env(getOverview, prepare));

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(overview);
      expect(getOverview).toHaveBeenCalledOnce();
      expect(prepare).toHaveBeenCalledOnce();
      expect(run).toHaveBeenCalledOnce();
      vi.restoreAllMocks();
    },
  );
});
