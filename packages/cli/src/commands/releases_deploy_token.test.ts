import { createServer, type Server } from "node:http";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/agent_env.js", () => ({ admitAgent: () => ({ kind: "none" }) }));

const TOKEN = "qvdt_ci_token";
const ME = {
  authenticated: true,
  account: null,
  deploy_token: {
    id: "tok-1",
    name: "desktop-publish",
    app_id: "11111111-2222-3333-4444-555555555555",
    app_slug: "raft-desktop",
    role: "publisher",
    permissions: ["release:publish", "release:read"],
    expires_at: null,
  },
};

describe("CI deploy tokens with whoami and releases", () => {
  let server: Server;
  let requests: Array<{ method: string; url: string; auth: string | undefined }>;
  const saved = { api: process.env.HANDS_API, token: process.env.HANDS_BEARER_TOKEN };
  let logs: string[];

  beforeEach(async () => {
    requests = [];
    logs = [];
    vi.spyOn(console, "log").mockImplementation((...args) => { logs.push(args.join(" ")); });
    server = createServer((req, res) => {
      requests.push({ method: req.method ?? "", url: req.url ?? "", auth: req.headers.authorization });
      res.setHeader("content-type", "application/json");
      if (req.url === "/api/auth/me") return res.end(JSON.stringify(ME));
      if (req.url === "/api/apps") {
        // A scoped deploy token is refused outside its own app.
        res.statusCode = 403;
        return res.end(JSON.stringify({ error: "scoped_token_app_boundary" }));
      }
      if (req.url?.startsWith(`/api/apps/${ME.deploy_token.app_id}/releases/rel-1`)) {
        return res.end(JSON.stringify({ release: { id: "rel-1", status: req.method === "DELETE" ? "cancelled" : "active" } }));
      }
      res.statusCode = 404;
      return res.end(JSON.stringify({ error: "not found" }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("bad address");
    process.env.HANDS_API = `http://127.0.0.1:${address.port}`;
    process.env.HANDS_BEARER_TOKEN = TOKEN;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (saved.api === undefined) delete process.env.HANDS_API; else process.env.HANDS_API = saved.api;
    if (saved.token === undefined) delete process.env.HANDS_BEARER_TOKEN; else process.env.HANDS_BEARER_TOKEN = saved.token;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  async function run(...args: string[]) {
    const { registerReleaseCommands } = await import("./releases.js");
    const { registerWhoamiCommand } = await import("./whoami.js");
    const program = new Command().option("--json", "JSON output", false);
    registerReleaseCommands(program);
    registerWhoamiCommand(program);
    await program.parseAsync(["node", "hands", ...args]);
  }

  it("whoami describes the deploy token instead of failing", async () => {
    await run("whoami", "--json");
    expect(JSON.parse(logs.join("\n"))).toMatchObject({ account: null, deploy_token: { app_slug: "raft-desktop" } });
  });

  it.each([
    ["show", "GET", ""],
    ["cancel", "DELETE", ""],
    ["restore", "POST", "/rollback"],
  ])("releases %s resolves the token's own app by slug", async (command, method, suffix) => {
    await run("releases", command, "raft-desktop", "rel-1", "--json");
    const call = requests.find((r) => r.url.startsWith(`/api/apps/${ME.deploy_token.app_id}/releases/rel-1`));
    expect(call).toMatchObject({ method, url: `/api/apps/${ME.deploy_token.app_id}/releases/rel-1${suffix}`, auth: `Bearer ${TOKEN}` });
    expect(requests.some((r) => r.url === "/api/apps")).toBe(false);
  });
});
