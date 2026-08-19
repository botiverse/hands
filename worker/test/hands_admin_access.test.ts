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

async function request(
  role: string,
  serverId = "server-allowed",
  ciphertext?: string | null,
  opts: { userinfoOk?: boolean; secret?: string | null; principalType?: "human" | "agent" } = {},
) {
  const secret = "test-secret";
  const encrypted = ciphertext === undefined ? await encryptAdminRaftToken(secret, "raft-token") : ciphertext;
  const userinfoOk = opts.userinfoOk !== false;
  vi.stubGlobal("fetch", vi.fn(async () => new Response(
    userinfoOk
      ? JSON.stringify({ sub: account.provider_subject, server_id: serverId, server_role: role })
      : "unauthorized",
    { status: userinfoOk ? 200 : 401, headers: { "content-type": "application/json" } },
  )));
  const app = new Hono<any>();
  app.use("*", async (c, next) => {
    c.set("admin_account", { ...account, principal_type: opts.principalType ?? account.principal_type });
    await next();
  });
  app.use("/admin/*", requireHandsAdmin);
  app.get("/admin/overview", (c) => c.json({ ok: true }));
  const env = {
    DB: database(encrypted),
    SIGNED_URL_SECRET: opts.secret === undefined ? secret : (opts.secret ?? undefined),
    RAFT_API_ORIGIN: "https://api.raft.build",
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
  it("renews a HUMAN browser session with no stored credential (legacy/missing-ciphertext — the current lock-out shape)", async () => {
    const res = await request("admin", "server-allowed", null, { principalType: "human" });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized", code: "SESSION_REAUTH_REQUIRED" });
  });
  it("does NOT tell an AGENT/CLI session to re-auth (NULL ciphertext is legitimate for agents — never browser-renew)", async () => {
    const res = await request("admin", "server-allowed", null, { principalType: "agent" });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized", code: "ADMIN_RELOGIN_REQUIRED" });
  });
  it("renews the browser session when the stored credential can't be decrypted (key rotated)", async () => {
    const wrongKey = await encryptAdminRaftToken("rotated-secret", "raft-token");
    const res = await request("admin", "server-allowed", wrongKey);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized", code: "SESSION_REAUTH_REQUIRED" });
  });
  it("renews the browser session when Raft rejects the token (expired, or member removed)", async () => {
    const res = await request("admin", "server-allowed", undefined, { userinfoOk: false });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized", code: "SESSION_REAUTH_REQUIRED" });
  });
  it("reports config-unavailable (not a re-login) when the admin secret is missing", async () => {
    const res = await request("admin", "server-allowed", "irrelevant-ciphertext", { secret: null });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized", code: "ADMIN_AUTH_UNAVAILABLE" });
  });
  it("does not confuse app admin role with Raft server admin role", async () => {
    // The stored account is an org/app admin, but live Raft says only member.
    const response = await request("member");
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "forbidden", code: "HANDS_ADMIN_REQUIRED" });
  });
});
