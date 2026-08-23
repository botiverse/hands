import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { requireHandsAdmin } from "../src/middleware/hands_admin";

// Unified admin auth: requireHandsAdmin gates on `authenticated_account` — the identity
// the session itself established — which authMiddleware sets ONLY for a valid,
// non-revoked, non-expired session. It must NOT gate on `admin_account`, which is that
// identity re-resolved through the client-supplied `x-hands-org-id` header (org
// switching). There is no per-request Raft re-check and no stored token any more — so
// these tests need no DB, no secret, and no fetch.
const baseAccount = {
  id: "account-1", provider: "raft" as const, provider_subject: "subject-1",
  server_id: "server-allowed", server_slug: "botiverse", principal_type: "human" as const,
  server_role: "admin", username: "person", display_name: "Person", avatar_url: null,
  raw_profile: "{}", created_at: 1, updated_at: 1, last_login_at: 1,
  org_id: "org-1", org_role: "admin" as const,
};

// authenticated = the identity authMiddleware sets from the session (null = no/invalid
// session). adminOverride = the org-switched admin_account (header-derived) — set it
// distinct from `authenticated` to prove the gate ignores it.
async function request(
  authenticated: Record<string, unknown> | null,
  adminOverride?: Record<string, unknown>,
) {
  const app = new Hono<any>();
  app.use("*", async (c, next) => {
    if (authenticated) c.set("authenticated_account", authenticated);
    if (authenticated || adminOverride) c.set("admin_account", adminOverride ?? authenticated);
    await next();
  });
  app.use("/admin/*", requireHandsAdmin);
  app.get("/admin/overview", (c) => c.json({ ok: true }));
  // Intentionally NO DB / RAFT_API_ORIGIN / secret in env: a valid admin must still pass,
  // proving the second (rotting-token) layer is gone.
  const env = { HANDS_ADMIN_ALLOWED_SERVER_IDS: "server-allowed" } as unknown as Env;
  return app.request("https://app.hands.build/admin/overview", {}, env);
}
const withRole = (server_role: string | null, server_id = "server-allowed") =>
  ({ ...baseAccount, server_role, server_id });

describe("requireHandsAdmin (unified — session identity's login-time role, no live re-check)", () => {
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

  it("returns 401 AUTH_REQUIRED when there is no valid session (no authenticated_account)", async () => {
    const res = await request(null);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized", code: "AUTH_REQUIRED" });
  });

  // The gate MUST use the session identity, not the org-switched admin_account: a client
  // switching orgs via x-hands-org-id must not be able to promote (or demote) its own
  // admin check.
  it("ignores an org-switched admin_account that claims admin when the session identity is not admin (403)", async () => {
    const res = await request(withRole("member"), withRole("admin"));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "forbidden", code: "HANDS_ADMIN_REQUIRED" });
  });

  it("allows on the session identity's admin role even if the org-switched admin_account looks like member (200)", async () =>
    expect((await request(withRole("admin"), withRole("member"))).status).toBe(200));

  it("does not touch the DB, decrypt, or call Raft — a valid admin passes with none of them in env", async () =>
    expect((await request(withRole("owner"))).status).toBe(200));

  // Contract (artin 2026-08-20): admin access is NOT restricted by principal_type — an
  // owner/admin AGENT identity is admitted, same as a human. This test locks that
  // decision: adding a human-only gate would fail here loudly.
  it.each(["owner", "admin"])("admits an %s AGENT identity (human/agent not distinguished)", async (role) =>
    expect((await request({ ...withRole(role), principal_type: "agent" })).status).toBe(200));
});
