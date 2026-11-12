import { afterEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";

const APP_ID = "11111111-2222-3333-4444-555555555555";

type Call = { method: string; path: string; body?: unknown; query?: unknown };

vi.mock("../lib/api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api.js")>();
  return {
    ...actual,
    apiRequest: async (path: string, opts: { method?: string; body?: unknown; query?: unknown } = {}) => {
      const calls = (globalThis as unknown as { __CALLS: Call[] }).__CALLS;
      const method = (opts.method ?? "GET").toUpperCase();
      calls.push({ method, path, body: opts.body, query: opts.query });
      if (path === "/api/auth/me") return { account: { org_id: "org-current" } } as never;
      if (path === "/api/apps") return { apps: [{ id: APP_ID, slug: "alpha" }] } as never;
      if (method === "POST") {
        return {
          token: "qvot_prefix_secret_once",
          access_token: {
            id: "ot-1", name: "sync", token_prefix: "qvot_prefix", scopes: ["feedback:read"],
            all_apps: false, apps: [{ id: APP_ID, slug: "alpha", name: "Alpha" }],
            created_by_actor: "raft:me@srv", created_at: 1, expires_at: null, last_used_at: null, revoked_at: null,
          },
        } as never;
      }
      if (method === "GET") return { access_tokens: [] } as never;
      return { ok: true } as never;
    },
  };
});

async function run(argv: string[]): Promise<{ lines: string[]; calls: Call[] }> {
  const calls: Call[] = [];
  (globalThis as unknown as { __CALLS: Call[] }).__CALLS = calls;
  const lines: string[] = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  });
  const { registerOrgTokenCommands } = await import("./org_tokens.js");
  const program = new Command();
  program.exitOverride();
  registerOrgTokenCommands(program);
  await program.parseAsync(["node", "hands", ...argv]);
  return { lines, calls };
}

describe("org-tokens", () => {
  afterEach(() => vi.restoreAllMocks());

  it("create resolves slugs to ids and POSTs to the org's access-tokens route", async () => {
    const { calls, lines } = await run([
      "org-tokens", "create", "--org", "org-1", "--name", "sync",
      "--scope", "feedback:read", "app:read", "--app", "alpha", "--expires-in-days", "30",
    ]);
    expect(calls).toContainEqual({
      method: "POST",
      path: "/api/orgs/org-1/access-tokens",
      body: { name: "sync", scopes: ["feedback:read", "app:read"], app_ids: [APP_ID], expires_in_days: 30 },
      query: undefined,
    });
    expect(calls.some((c) => c.path === "/api/auth/me")).toBe(false);
    const joined = lines.join("\n");
    expect(joined).toContain("qvot_prefix_secret_once");
    expect(joined).toContain("shown once");
  });

  it("create --all-apps defaults to the current org and emits only JSON with --json", async () => {
    const { calls, lines } = await run([
      "org-tokens", "create", "--name", "all", "--scope", "app:read", "--all-apps", "--json",
    ]);
    const post = calls.find((c) => c.method === "POST");
    expect(post).toMatchObject({
      path: "/api/orgs/org-current/access-tokens",
      body: { name: "all", scopes: ["app:read"], all_apps: true },
    });
    expect(JSON.parse(lines.join("\n")).token).toBe("qvot_prefix_secret_once");
  });

  it("list and revoke reach the org routes", async () => {
    const listed = await run(["org-tokens", "list", "--org", "org-1", "--include-revoked"]);
    expect(listed.calls).toContainEqual({
      method: "GET", path: "/api/orgs/org-1/access-tokens", body: undefined, query: { include_revoked: "1" },
    });
    const revoked = await run(["org-tokens", "revoke", "ot-1", "--org", "org-1"]);
    expect(revoked.calls).toContainEqual({
      method: "DELETE", path: "/api/orgs/org-1/access-tokens/ot-1", body: undefined, query: undefined,
    });
  });
});
