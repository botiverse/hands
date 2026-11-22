import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/agent_env.js", () => ({ admitAgent: () => ({ kind: "none" }) }));

const APP = "11111111-2222-3333-4444-555555555555";
const BASE = `/api/apps/${APP}/releases/rel-1/electron-metadata`;

describe("hands releases electron-metadata", () => {
  let server: Server;
  let requests: Array<{ method: string; url: string; type: string | undefined; body: string }>;
  let out: string[];
  const saved = { api: process.env.HANDS_API, token: process.env.HANDS_BEARER_TOKEN };

  beforeEach(async () => {
    requests = [];
    out = [];
    vi.spyOn(console, "log").mockImplementation((...args) => { out.push(args.join(" ")); });
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: any) => { out.push(String(chunk)); return true; });
    server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      requests.push({ method: req.method ?? "", url: req.url ?? "", type: req.headers["content-type"], body: Buffer.concat(chunks).toString("utf8") });
      if (req.method === "GET" && req.url === `${BASE}/latest-mac.yml`) {
        res.setHeader("content-type", "text/yaml");
        return res.end("version: 1.35.0\n");
      }
      res.setHeader("content-type", "application/json");
      if (req.method === "PUT") return res.end(JSON.stringify({ current: { id: "ov-1", sha256: "abc" } }));
      if (req.method === "POST") return res.end(JSON.stringify({ reverted: { id: "ov-1" }, current: null }));
      res.statusCode = 404;
      return res.end(JSON.stringify({ error: "not found" }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("bad address");
    process.env.HANDS_API = `http://127.0.0.1:${address.port}`;
    process.env.HANDS_BEARER_TOKEN = "session-token";
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (saved.api === undefined) delete process.env.HANDS_API; else process.env.HANDS_API = saved.api;
    if (saved.token === undefined) delete process.env.HANDS_BEARER_TOKEN; else process.env.HANDS_BEARER_TOKEN = saved.token;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  async function run(...args: string[]) {
    const { registerReleaseCommands } = await import("./releases.js");
    const program = new Command().option("--json", "JSON output", false);
    registerReleaseCommands(program);
    await program.parseAsync(["node", "hands", "releases", "electron-metadata", ...args]);
  }

  it("get prints the served YAML", async () => {
    await run("get", APP, "rel-1", "latest-mac.yml");
    expect(out.join("")).toBe("version: 1.35.0\n");
  });

  it("set uploads the file as YAML text", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "hands-meta-")), "latest-mac.yml");
    writeFileSync(file, "version: 1.35.0\nstagingPercentage: 5\n");
    await run("set", APP, "rel-1", "latest-mac.yml", "--from", file);
    expect(requests[0]).toMatchObject({
      method: "PUT",
      url: `${BASE}/latest-mac.yml`,
      type: "text/yaml; charset=utf-8",
      body: "version: 1.35.0\nstagingPercentage: 5\n",
    });
    expect(out.join("\n")).toContain("ov-1");
  });

  it("revert says which file is served now", async () => {
    await run("revert", APP, "rel-1", "latest-mac.yml");
    expect(requests[0]).toMatchObject({ method: "POST", url: `${BASE}/latest-mac.yml/revert` });
    expect(out.join("\n")).toContain("the build's own file");
  });
});
