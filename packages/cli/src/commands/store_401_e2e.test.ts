import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { agentAuthPath, HANDS_SERVICE } from "../lib/agent_env.js";
import { writeAgentSession } from "../lib/agent_auth.js";

const APP = "11111111-2222-3333-4444-555555555555";
const json = (value: unknown) => JSON.stringify(value);

// Real CLI process, real agent token store and refresh code, localhost server only.
// Fixture credentials are disposable and never leave the process or test directory.
describe("401 handling through the CLI entrypoint", () => {
  for (const { command, path, status, failure } of [
    { command: ["store-listing", "pull", APP, "--json"], path: `/api/apps/${APP}/distributions/play/store-listing`, status: 401, failure: { code: "UNAUTHORIZED", error: "unauthorized" } },
    { command: ["api", "GET", `/api/apps/${APP}/distributions/play/store-listing`, "--json"], path: `/api/apps/${APP}/distributions/play/store-listing`, status: 401, failure: { code: "UNAUTHORIZED", error: "unauthorized" } },
    { command: ["agc", "upload", APP, "build1", "--package-name", "build.example"], path: `/api/apps/${APP}/builds/build1/agc-invitation-test`, status: 502, failure: { error: "AppGallery invitation upload failed", submission_id: "submission1" } },
    { command: ["agc", "upload", APP, "build1", "--package-name", "build.example"], path: `/api/apps/${APP}/builds/build1/agc-invitation-test`, status: 502, failure: { error: "AppGallery invitation upload failed", submission_id: "-x'$(touch bad)\u001b[31m" } },
  ]) {
    it(`refreshes before ${command[0]}, sends once, and prints an actionable error`, async () => {
      const dir = await mkdtemp(join(tmpdir(), "hands-retry-e2e-"));
      const transport = join(dir, "transport");
      await mkdir(transport);
      const raft = join(transport, "raft");
      await writeFile(raft, "#!/bin/sh\nexit 1\n");
      await chmod(raft, 0o700);
      const requests: Array<{ path: string; bearer?: string; body: string }> = [];
      const now = Date.now();
      const session = {
        schema: "raft-cli-agent-session.v1" as const,
        token_type: "Bearer" as const,
        access_token: "fixture-new-access",
        access_expires_at: new Date(now + 20 * 60_000).toISOString(),
        refresh_token: "fixture-new-refresh",
        refresh_expires_at: new Date(now + 60 * 60_000).toISOString(),
      };
      const server = createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => {
          requests.push({ path: req.url ?? "", bearer: req.headers.authorization, body: Buffer.concat(chunks).toString() });
          res.setHeader("content-type", "application/json");
          if (req.url === "/api/auth/agent/refresh") res.end(json(session));
          else { res.statusCode = status; res.end(json(failure)); }
        });
      });
      try {
        await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("missing localhost address");
        const base = `http://127.0.0.1:${address.port}`;
        const env = { transportDir: transport, slockHome: dir, agentId: "test-agent", raftBin: raft };
        writeAgentSession(env, HANDS_SERVICE, {
          ...session, access_token: "fixture-old-access", refresh_token: "fixture-old-refresh",
          access_expires_at: new Date(now + 30_000).toISOString(),
        }, base);
        const tsx = createRequire(import.meta.url).resolve("tsx/cli");
        const entry = fileURLToPath(new URL("../index.ts", import.meta.url));
        const child = spawn(process.execPath, [tsx, entry, "--api", base, ...command], {
          env: { PATH: process.env.PATH, ...(process.platform === "win32" ? { SystemRoot: process.env.SystemRoot } : {}), HOME: dir, XDG_CONFIG_HOME: join(dir, "config"), HANDS_LOG_DIR: join(dir, "logs"), SLOCK_HOME: dir, SLOCK_AGENT_ID: env.agentId, SLOCK_CLI_TRANSPORT_DIR: transport },
          stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "", stderr = "";
        child.stdout.on("data", chunk => { stdout += String(chunk); });
        child.stderr.on("data", chunk => { stderr += String(chunk); });
        const code = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
        expect(code).toBe(1);
        expect(requests.map(r => r.path)).toEqual(["/api/auth/agent/refresh", path]);
        expect(JSON.parse(requests[0]!.body)).toMatchObject({ refresh_token: "fixture-old-refresh" });
        expect(requests[1]!.bearer).toBe("Bearer fixture-new-access");
        expect(JSON.parse(await readFile(agentAuthPath(env), "utf8")).access_token).toBe("fixture-new-access");
        if (status === 401) {
          expect(stderr).toContain("No automatic 401 retry was attempted");
          expect(stderr).toContain("outcome may be unknown");
          if (command[0] === "api") expect(JSON.parse(stdout)).toMatchObject({ code: "UNAUTHORIZED" });
          else expect(stderr).toContain("Code: UNAUTHORIZED");
        } else {
          expect(stderr).toContain("Error: AppGallery invitation upload failed");
          if (failure.submission_id === "submission1") {
            expect(stderr).toContain(`hands agc status -- ${APP} submission1`);
          } else {
            expect(stderr).toContain("template only, not an executable command: hands agc status -- {appId} {submissionId}");
            expect(stderr).not.toContain(failure.submission_id);
            const data = JSON.parse(stderr.match(/: (\{.*?\}) and check Huawei/s)?.[1] ?? "null");
            expect(data).toEqual({ appId: APP, submissionId: failure.submission_id });
          }
          expect(stderr).toContain("check Huawei before retrying upload");
        }
        expect(`${stdout}\n${stderr}`).not.toContain("fixture-old-refresh");
        expect(`${stdout}\n${stderr}`).not.toContain("fixture-new-access");
      } finally {
        await new Promise<void>(resolve => server.close(() => resolve()));
        await rm(dir, { recursive: true, force: true });
      }
    }, 20_000);
  }
});
