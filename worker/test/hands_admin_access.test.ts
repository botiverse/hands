import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { encryptAdminRaftToken } from "../src/lib/admin_raft_token";
import { requireHandsAdmin } from "../src/middleware/hands_admin";

const account = {
  id: "account-1", provider: "raft" as const, provider_subject: "subject-1",
  server_id: "server-allowed", server_slug: "botiverse", principal_type: "human" as const,
  server_role: "admin", username: "person", display_name: "Person", avatar_url: null,
  raw_profile: "{}", created_at: 1, updated_at: 1, last_login_at: 1,
  org_id: "org-1", org_role: "admin" as const,
};

function database(ciphertext: string | null) {
  return {
    prepare: vi.fn(() => ({ bind: vi.fn(() => ({ first: vi.fn(async () => ({ raft_access_token_ciphertext: ciphertext })) })) })),
  } as unknown as D1Database;
}

async function request(role: string, serverId = "server-allowed", ciphertext?: string | null) {
  const secret = "test-secret";
  const encrypted = ciphertext === undefined ? await encryptAdminRaftToken(secret, "raft-token") : ciphertext;
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
    sub: account.provider_subject, server_id: serverId, server_role: role,
  }), { headers: { "content-type": "application/json" } })));
  const app = new Hono<any>();
  app.use("*", async (c, next) => { c.set("admin_account", account); await next(); });
  app.use("/admin/*", requireHandsAdmin);
  app.get("/admin/overview", (c) => c.json({ ok: true }));
  const env = {
    DB: database(encrypted), SIGNED_URL_SECRET: secret, RAFT_API_ORIGIN: "https://api.raft.build",
    HANDS_ADMIN_ALLOWED_SERVER_IDS: "server-allowed",
  } as unknown as Env;
  return app.request("https://app.hands.build/admin/overview", { headers: { authorization: "Bearer hands-session" } }, env);
}

describe("requireHandsAdmin", () => {
  beforeEach(() => vi.unstubAllGlobals());
  it.each(["owner", "admin"])("allows live server role %s", async (role) => expect((await request(role)).status).toBe(200));
  it.each(["member", "viewer"])("denies live server role %s before the handler", async (role) => expect((await request(role)).status).toBe(403));
  it("denies another Raft server", async () => expect((await request("admin", "other-server")).status).toBe(403));
  it("requires a fresh login for sessions without a live Raft credential", async () => expect((await request("admin", "server-allowed", null)).status).toBe(401));
  it("does not confuse app admin role with Raft server admin role", async () => {
    // The stored account is an org/app admin, but live Raft says only member.
    const response = await request("member");
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "forbidden", code: "HANDS_ADMIN_REQUIRED" });
  });
});
