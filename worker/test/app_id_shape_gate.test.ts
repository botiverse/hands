import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { requireAppRole } from "../src/lib/permissions";

// A short/partial app id (the 8-char form `hands apps list` used to print) must
// fail at the resolution boundary with an explicit "use the full app id", NOT
// fall through to the role check and return a misleading INSUFFICIENT_APP_ROLE.
// The gate is SHAPE-only: it adds no existence signal of its own — a well-formed
// UUID is left to the normal role path exactly as before, and synthetic slug-like
// ids are untouched. (Whether that role path itself distinguishes existing vs
// absent apps is a SEPARATE pre-existing concern — the org_id echo in the
// forbidden response — tracked outside this gate; not asserted here.)

const account = {
  id: "account-1", provider: "raft", provider_subject: "subject-1",
  server_id: "s", server_slug: "s", principal_type: "human",
  server_role: "member", username: "u", display_name: "U", avatar_url: null,
  raw_profile: "{}", created_at: 1, updated_at: 1, last_login_at: 1,
  org_id: null, org_role: null,
};

// DB that resolves no org and no role for anyone → any request that clears the
// shape gate lands on the normal 403 role error.
function emptyDb() {
  return {
    prepare: () => ({ bind: () => ({ first: async () => null, all: async () => ({ results: [] }) }) }),
  } as unknown as D1Database;
}

async function hit(appId: string) {
  const app = new Hono<any>();
  app.use("*", async (c, next) => { c.set("admin_account", account); await next(); });
  app.use("/api/apps/:appId/*", requireAppRole("viewer"));
  app.get("/api/apps/:appId/thing", (c) => c.json({ ok: true }));
  const env = { DB: emptyDb(), DASHBOARD_ORIGIN: "https://dashboard.example" } as unknown as Env;
  return app.request(`https://app.hands.build/api/apps/${appId}/thing`, {}, env);
}

describe("app id shape gate (requireAppRole / ensureAppRole)", () => {
  it("rejects an 8-char truncated UUID with 400 EXACT_APP_ID_REQUIRED before the role check", async () => {
    const res = await hit("76304f16");
    expect(res.status).toBe(400);
    const body = await res.json<{ code: string; app_id: string }>();
    expect(body.code).toBe("EXACT_APP_ID_REQUIRED");
    expect(body.app_id).toBe("76304f16");
  });

  it("rejects a dashed partial UUID (hex+dash only, not a full UUID) with 400", async () => {
    const res = await hit("76304f16-fbf7");
    expect(res.status).toBe(400);
    expect((await res.json<{ code: string }>()).code).toBe("EXACT_APP_ID_REQUIRED");
  });

  it("does NOT shape-gate a full UUID — it passes through to the normal role check (here 403 INSUFFICIENT_APP_ROLE)", async () => {
    // emptyDb() resolves no role, so this only proves the gate lets a well-formed
    // UUID through to the role path. It intentionally does NOT assert existence
    // indistinguishability of that role path (the org_id echo makes exists-vs-absent
    // distinguishable today — a separate follow-up, not this gate's concern).
    const res = await hit("76304f16-fbf7-488f-8445-e16ffdd6cef8");
    expect(res.status).toBe(403);
    expect((await res.json<{ code: string }>()).code).toBe("INSUFFICIENT_APP_ROLE");
  });

  it("does NOT shape-reject synthetic slug-like ids (contain non-hex chars) — they reach the normal role check", async () => {
    for (const id of ["app-1", "guard-app", "legacy-app", "other"]) {
      const res = await hit(id);
      expect(res.status, `id ${id}`).toBe(403);
      expect((await res.json<{ code: string }>()).code, `id ${id}`).toBe("INSUFFICIENT_APP_ROLE");
    }
  });
});
