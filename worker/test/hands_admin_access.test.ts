import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { requireHandsAdmin } from "../src/middleware/hands_admin";

// Unified admin auth: requireHandsAdmin gates on the login-time role carried by the
// session's account (admin_account), which authMiddleware sets ONLY for a valid,
// non-revoked, non-expired session. There is no per-request Raft re-check and no stored
// per-session token any more — so these tests need no DB, no secret, and no fetch.
const baseAccount = {
  id: "account-1", provider: "raft" as const, provider_subject: "subject-1",
  server_id: "server-allowed", server_slug: "botiverse", principal_type: "human" as const,
  server_role: "admin", username: "person", display_name: "Person", avatar_url: null,
  raw_profile: "{}", created_at: 1, updated_at: 1, last_login_at: 1,
  org_id: "org-1", org_role: "admin" as const,
};

// account = the admin_account authMiddleware would have set, or null for no/invalid session.
async function request(account: Record<string, unknown> | null) {
  const app = new Hono<any>();
  app.use("*", async (c, next) => { if (account) c.set("admin_account", account); await next(); });
  app.use("/admin/*", requireHandsAdmin);
  app.get("/admin/overview", (c) => c.json({ ok: true }));
  // Intentionally NO DB / RAFT_API_ORIGIN / secret in env: a valid admin must still pass,
  // proving the second (rotting-token) layer is gone.
  const env = { HANDS_ADMIN_ALLOWED_SERVER_IDS: "server-allowed" } as unknown as Env;
  return app.request("https://app.hands.build/admin/overview", {}, env);
}
const withRole = (server_role: string | null, server_id = "server-allowed") =>
  ({ ...baseAccount, server_role, server_id });

describe("requireHandsAdmin (unified — login-time role, no live re-check)", () => {
  it.each(["owner", "admin"])("allows login-time server role %s on an allowed server", async (role) =>
    expect((await request(withRole(role))).status).toBe(200));

  it.each(["member", "viewer"])("denies non-admin login-time role %s with 403 HANDS_ADMIN_REQUIRED", async (role) => {
    const res = await request(withRole(role));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "forbidden", code: "HANDS_ADMIN_REQUIRED" });
  });

  it("denies a null/empty login-time role (403)", async () => {
    expect((await request(withRole(null))).status).toBe(403);
    expect((await request(withRole(""))).status).toBe(403);
  });

  it("denies an admin whose server is not in the allow-list (403)", async () =>
    expect((await request(withRole("admin", "other-server"))).status).toBe(403));

  it("returns 401 AUTH_REQUIRED when there is no valid session (no admin_account)", async () => {
    const res = await request(null);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized", code: "AUTH_REQUIRED" });
  });

  it("does not touch the DB, decrypt, or call Raft — a valid admin passes with none of them in env", async () =>
    expect((await request(withRole("owner"))).status).toBe(200));
});
