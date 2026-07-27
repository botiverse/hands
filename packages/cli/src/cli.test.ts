/**
 * Smoke tests for the quiver CLI.
 *
 * Run: `pnpm --filter @botiverse/hands-cli test`
 *
 * v1 tests cover: config load/save (without leaking the real file),
 * + apiRequest routing (against a tiny local http.createServer stub).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { gzipSync } from "node:zlib";
import { Command } from "commander";
import fixturePolicy from "./fixtures/collect-policy.json";

describe("config round-trip", () => {
  let dir: string;
  let originalXdg: string | undefined;
  let originalHandsApi: string | undefined;
  let originalQuiverApi: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "quiver-cli-"));
    originalXdg = process.env.XDG_CONFIG_HOME;
    originalHandsApi = process.env.HANDS_API;
    originalQuiverApi = process.env.QUIVER_API;
    process.env.XDG_CONFIG_HOME = dir;
    delete process.env.HANDS_API;
    delete process.env.QUIVER_API;
  });

  afterEach(() => {
    if (originalXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = originalXdg;
    if (originalHandsApi === undefined) delete process.env.HANDS_API;
    else process.env.HANDS_API = originalHandsApi;
    if (originalQuiverApi === undefined) delete process.env.QUIVER_API;
    else process.env.QUIVER_API = originalQuiverApi;
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  });

  it("returns empty config when no file exists", async () => {
    const { getConfig, resolveApiBase } = await import("../src/lib/config.js");
    expect(getConfig()).toEqual({});
    expect(resolveApiBase()).toBe("https://hands.build");
  });

  it("saveConfig persists to the XDG path", async () => {
    const { saveConfig, getConfig } = await import("../src/lib/config.js");
    saveConfig({ apiBase: "https://example.test", sessionCookie: "tok123" });
    const path = join(dir, "quiver", "auth.json");
    expect(existsSync(path)).toBe(true);
    const raw = JSON.parse(readFileSync(path, "utf8"));
    expect(raw.apiBase).toBe("https://example.test");
    expect(raw.sessionCookie).toBe("tok123");
    expect(getConfig().apiBase).toBe("https://example.test");
  });
});

describe("apiRequest", () => {
  let server: ReturnType<typeof createServer>;
  let baseUrl: string;
  let lastCookie: string | null = null;
  let lastAuthorization: string | null = null;

  beforeEach(async () => {
    server = createServer((req, res) => {
      lastCookie = req.headers.cookie ?? null;
      lastAuthorization = req.headers.authorization ?? null;
      res.setHeader("content-type", "application/json");
      if (req.url === "/api/auth/me") {
        res.end(JSON.stringify({ account: { id: "u1", display_name: "Test" } }));
        return;
      }
      if (req.url?.startsWith("/api/apps")) {
        res.end(JSON.stringify({ apps: [] }));
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ error: "not found" }));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("bad address");
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  it("treats the legacy QUIVER_SESSION_COOKIE env var as bearer auth", async () => {
    process.env.QUIVER_SESSION_COOKIE = "abc123";
    process.env.QUIVER_API = baseUrl;
    const { apiRequest } = await import("../src/lib/api.js");
    const me = await apiRequest<{ account: { id: string } }>("/api/auth/me");
    expect(me.account.id).toBe("u1");
    expect(lastAuthorization).toBe("Bearer abc123");
    expect(lastCookie).toBeNull();
    delete process.env.QUIVER_SESSION_COOKIE;
    delete process.env.QUIVER_API;
  });

  it("prefers QUIVER_AUTH_TOKEN over the legacy session variable", async () => {
    process.env.QUIVER_SESSION_COOKIE = "cookie-token";
    process.env.QUIVER_AUTH_TOKEN = "bearer-token";
    process.env.QUIVER_API = baseUrl;
    const { apiRequest } = await import("../src/lib/api.js");
    const me = await apiRequest<{ account: { id: string } }>("/api/auth/me");
    expect(me.account.id).toBe("u1");
    expect(lastAuthorization).toBe("Bearer bearer-token");
    expect(lastCookie).toBeNull();
    delete process.env.QUIVER_SESSION_COOKIE;
    delete process.env.QUIVER_AUTH_TOKEN;
    delete process.env.QUIVER_API;
  });

  it("throws QuiverApiError on non-2xx", async () => {
    process.env.QUIVER_API = baseUrl;
    const { apiRequest, QuiverApiError } = await import("../src/lib/api.js");
    await expect(apiRequest("/api/missing")).rejects.toBeInstanceOf(QuiverApiError);
    delete process.env.QUIVER_API;
  });
});

describe("app provisioning commands", () => {
  it("creates a web app and explicitly reads its client key without verbose-log leakage", async () => {
    const requests: Array<{ method: string; url: string; body?: unknown }> = [];
    const clientKey = "qk_test_client_key_value";
    const server = createServer(async (req, res) => {
      let body: unknown;
      if (req.headers["content-type"]?.includes("application/json")) {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      }
      requests.push({ method: req.method ?? "GET", url: req.url ?? "", body });
      res.setHeader("content-type", "application/json");
      if (req.url === "/api/apps" && req.method === "POST") {
        res.statusCode = 201;
        return res.end(JSON.stringify({
          id: "11111111-1111-4111-8111-111111111111",
          org_id: "raft_target",
          slug: "hands-example-web",
          name: "Hands Example Web",
          platform: "web",
        }));
      }
      if (req.url === "/api/apps" && req.method === "GET") {
        return res.end(JSON.stringify({
          apps: [{
            id: "11111111-1111-4111-8111-111111111111",
            slug: "hands-example-web",
            name: "Hands Example Web",
            platform: "web",
            archived: 0,
            default_channel_slug: "main",
            created_at: 1,
          }],
        }));
      }
      if (req.url === "/api/apps/11111111-1111-4111-8111-111111111111/client-key") {
        return res.end(JSON.stringify({
          app_id: "11111111-1111-4111-8111-111111111111",
          client_key: clientKey,
        }));
      }
      res.statusCode = 404;
      return res.end(JSON.stringify({ error: "not found" }));
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("bad address");
    const originalApi = process.env.HANDS_API;
    const originalToken = process.env.HANDS_BEARER_TOKEN;
    const originalVerbose = process.env.HANDS_VERBOSE;
    process.env.HANDS_API = `http://127.0.0.1:${address.port}`;
    process.env.HANDS_BEARER_TOKEN = "test-token";
    process.env.HANDS_VERBOSE = "1";
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      const { registerAppCommands } = await import("../src/commands/apps.js");
      const createProgram = new Command();
      registerAppCommands(createProgram);
      await createProgram.parseAsync([
        "node", "hands", "apps", "create",
        "--slug", "hands-example-web",
        "--name", "Hands Example Web",
        "--platform", "web",
        "--description", "Hands web app example",
      ]);

      const keyProgram = new Command();
      registerAppCommands(keyProgram);
      await keyProgram.parseAsync([
        "node", "hands", "apps", "client-key", "hands-example-web",
      ]);

      expect(requests.find((request) => request.method === "POST")).toMatchObject({
        url: "/api/apps",
        body: {
          slug: "hands-example-web",
          name: "Hands Example Web",
          platform: "web",
          description: "Hands web app example",
        },
      });
      expect(requests.map((request) => request.url)).toContain(
        "/api/apps/11111111-1111-4111-8111-111111111111/client-key",
      );
      expect(log.mock.calls.flat().join("\n")).toContain(clientKey);
      expect(error.mock.calls.flat().join("\n")).not.toContain(clientKey);
    } finally {
      log.mockRestore();
      error.mockRestore();
      if (originalApi === undefined) delete process.env.HANDS_API;
      else process.env.HANDS_API = originalApi;
      if (originalToken === undefined) delete process.env.HANDS_BEARER_TOKEN;
      else process.env.HANDS_BEARER_TOKEN = originalToken;
      if (originalVerbose === undefined) delete process.env.HANDS_VERBOSE;
      else process.env.HANDS_VERBOSE = originalVerbose;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe("device-group rollout commands", () => {
  it("creates and updates a device group, then applies it as a release scope", async () => {
    const requests: Array<{ method: string; url: string; body?: any }> = [];
    const server = createServer(async (req, res) => {
      let body: any = undefined;
      if (req.headers["content-type"]?.includes("application/json")) {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      }
      requests.push({ method: req.method ?? "GET", url: req.url ?? "", body });
      res.setHeader("content-type", "application/json");
      if (req.url === "/api/apps") {
        return res.end(JSON.stringify({ apps: [{ id: "app-1", slug: "raft-android" }] }));
      }
      if (req.url === "/api/apps/app-1/device-groups" && req.method === "POST") {
        return res.end(JSON.stringify({ id: "group-1", name: "Artin test devices", member_count: 0, members: [] }));
      }
      if (req.url === "/api/apps/app-1/device-groups/group-1" && req.method === "PATCH") {
        return res.end(JSON.stringify({
          id: "group-1",
          name: "Artin test tablets",
          description: "Physical acceptance devices",
          member_count: 0,
          members: [],
        }));
      }
      if (req.url === "/api/apps/app-1/releases/release-1" && req.method === "PATCH") {
        return res.end(JSON.stringify({ id: "release-1", status: "draft" }));
      }
      if (req.url === "/api/apps/app-1/releases/release-1" && req.method === "GET") {
        return res.end(JSON.stringify({
          release: { id: "release-1", status: "draft", revision: 7 },
          scopes: [{ scope_type: "device_group", scope_value: "group-1" }],
        }));
      }
      if (req.url === "/api/apps/app-1/releases/release-1/publish" && req.method === "POST") {
        return res.end(JSON.stringify({ id: "release-1", status: "active" }));
      }
      res.statusCode = 404;
      return res.end(JSON.stringify({ error: "not found" }));
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("bad address");
    const originalApi = process.env.HANDS_API;
    const originalToken = process.env.HANDS_BEARER_TOKEN;
    process.env.HANDS_API = `http://127.0.0.1:${address.port}`;
    process.env.HANDS_BEARER_TOKEN = "test-token";

    try {
      const { registerDeviceGroupCommands } = await import("../src/commands/device_groups.js");
      const { registerReleaseCommands } = await import("../src/commands/releases.js");

      const groupsProgram = new Command();
      registerDeviceGroupCommands(groupsProgram);
      await groupsProgram.parseAsync([
        "node", "hands", "device-groups", "create", "raft-android",
        "--name", "Artin test devices",
      ]);
      const updateProgram = new Command();
      registerDeviceGroupCommands(updateProgram);
      await updateProgram.parseAsync([
        "node", "hands", "device-groups", "update", "raft-android", "group-1",
        "--name", "Artin test tablets",
        "--description", "Physical acceptance devices",
      ]);

      const releasesProgram = new Command();
      registerReleaseCommands(releasesProgram);
      await releasesProgram.parseAsync([
        "node", "hands", "releases", "update", "raft-android", "release-1",
        "--device-group", "group-1",
      ]);
      const publishProgram = new Command();
      registerReleaseCommands(publishProgram);
      await publishProgram.parseAsync([
        "node", "hands", "releases", "publish", "raft-android", "release-1",
        "--device-group", "group-1",
      ]);

      expect(requests.find((request) => request.url.endsWith("/device-groups"))).toMatchObject({
        method: "POST",
        body: { name: "Artin test devices" },
      });
      expect(requests.find((request) => request.url.endsWith("/device-groups/group-1"))).toMatchObject({
        method: "PATCH",
        body: {
          name: "Artin test tablets",
          description: "Physical acceptance devices",
        },
      });
      expect(requests.find((request) =>
        request.url.endsWith("/releases/release-1") && request.method === "PATCH"
      )).toMatchObject({
        method: "PATCH",
        body: {
          scopes: [{ scope_type: "device_group", scope_value: "group-1" }],
          expected_revision: 7,
        },
      });
      expect(requests.find((request) => request.url.endsWith("/releases/release-1/publish"))).toMatchObject({
        method: "POST",
        body: {
          expected_scopes: [{ scope_type: "device_group", scope_value: "group-1" }],
          expected_revision: 7,
        },
      });
    } finally {
      if (originalApi === undefined) delete process.env.HANDS_API;
      else process.env.HANDS_API = originalApi;
      if (originalToken === undefined) delete process.env.HANDS_BEARER_TOKEN;
      else process.env.HANDS_BEARER_TOKEN = originalToken;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("creates, rebinds, and revokes a stable test-device enrollment", async () => {
    const requests: Array<{ method: string; url: string; body?: any }> = [];
    const server = createServer(async (req, res) => {
      let body: any = undefined;
      if (req.headers["content-type"]?.includes("application/json")) {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      }
      requests.push({ method: req.method ?? "GET", url: req.url ?? "", body });
      res.setHeader("content-type", "application/json");
      if (req.url === "/api/apps") {
        return res.end(JSON.stringify({ apps: [{ id: "app-1", slug: "raft-android" }] }));
      }
      const enrollment = {
        id: "enroll-1",
        alias: "artin-huawei-tablet",
        label: "Artin tablet",
        current_device_id: body?.device_id ?? null,
        status: req.url?.endsWith("/revoke") ? "revoked" : "active",
        revision: req.url?.endsWith("/rebind") ? 2 : req.url?.endsWith("/revoke") ? 3 : 1,
      };
      if (req.url === "/api/apps/app-1/device-enrollments" && req.method === "POST") {
        return res.end(JSON.stringify({ enrollment, operation: { kind: "create" }, replayed: false }));
      }
      if (req.url === "/api/apps/app-1/device-enrollments/enroll-1/rebind" && req.method === "POST") {
        return res.end(JSON.stringify({
          enrollment,
          operation: { migrated_group_memberships: 1, migrated_feature_flags: 1 },
          replayed: false,
        }));
      }
      if (req.url === "/api/apps/app-1/device-enrollments/enroll-1/revoke" && req.method === "POST") {
        return res.end(JSON.stringify({ enrollment, operation: {}, replayed: false }));
      }
      res.statusCode = 404;
      return res.end(JSON.stringify({ error: "not found" }));
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("bad address");
    const originalApi = process.env.HANDS_API;
    const originalToken = process.env.HANDS_BEARER_TOKEN;
    process.env.HANDS_API = `http://127.0.0.1:${address.port}`;
    process.env.HANDS_BEARER_TOKEN = "test-token";

    const run = async (args: string[]) => {
      const program = new Command();
      const { registerDeviceGroupCommands } = await import("../src/commands/device_groups.js");
      registerDeviceGroupCommands(program);
      return program.parseAsync(["node", "hands", ...args]);
    };

    try {
      await run([
        "device-enrollments", "create", "raft-android",
        "--alias", "artin-huawei-tablet",
        "--device-id", "install-old",
        "--label", "Artin tablet",
      ]);
      await run([
        "device-enrollments", "rebind", "raft-android", "enroll-1",
        "--device-id", "install-new",
        "--expected-revision", "1",
        "--operation-id", "op-rebind-1",
      ]);
      await run([
        "device-enrollments", "revoke", "raft-android", "enroll-1",
        "--expected-revision", "2",
        "--operation-id", "op-revoke-2",
      ]);

      expect(requests.find((request) =>
        request.url === "/api/apps/app-1/device-enrollments" && request.method === "POST"
      )).toMatchObject({
        body: {
          alias: "artin-huawei-tablet",
          device_id: "install-old",
          label: "Artin tablet",
        },
      });
      expect(requests.find((request) => request.url.endsWith("/rebind"))).toMatchObject({
        body: {
          device_id: "install-new",
          expected_revision: 1,
          operation_id: "op-rebind-1",
        },
      });
      expect(requests.find((request) => request.url.endsWith("/revoke"))).toMatchObject({
        body: { expected_revision: 2, operation_id: "op-revoke-2" },
      });
    } finally {
      if (originalApi === undefined) delete process.env.HANDS_API;
      else process.env.HANDS_API = originalApi;
      if (originalToken === undefined) delete process.env.HANDS_BEARER_TOKEN;
      else process.env.HANDS_BEARER_TOKEN = originalToken;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("updates a full percentage rollout with mandatory groups and preserves full reset semantics", async () => {
    const requests: Array<{ method: string; url: string; body?: any }> = [];
    const server = createServer(async (req, res) => {
      let body: any = undefined;
      if (req.headers["content-type"]?.includes("application/json")) {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      }
      requests.push({ method: req.method ?? "GET", url: req.url ?? "", body });
      res.setHeader("content-type", "application/json");
      if (req.url === "/api/apps") {
        return res.end(JSON.stringify({ apps: [{ id: "app-1", slug: "raft-android" }] }));
      }
      if (req.url?.startsWith("/api/apps/app-1/releases/") && req.method === "GET") {
        return res.end(JSON.stringify({
          release: { id: req.url.split("/").at(-1), status: "draft", revision: 11 },
        }));
      }
      if (req.url?.startsWith("/api/apps/app-1/releases/") && req.method === "PATCH") {
        return res.end(JSON.stringify({ id: req.url.split("/").at(-1), status: "draft" }));
      }
      res.statusCode = 404;
      return res.end(JSON.stringify({ error: "not found" }));
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("bad address");
    const originalApi = process.env.HANDS_API;
    const originalToken = process.env.HANDS_BEARER_TOKEN;
    process.env.HANDS_API = `http://127.0.0.1:${address.port}`;
    process.env.HANDS_BEARER_TOKEN = "test-token";

    const runUpdate = async (releaseId: string, extra: string[]) => {
      const program = new Command();
      const { registerReleaseCommands } = await import("../src/commands/releases.js");
      registerReleaseCommands(program);
      return program.parseAsync([
        "node", "hands", "releases", "update", "raft-android", releaseId, ...extra,
      ]);
    };

    try {
      await runUpdate("release-mixed", [
        "--full",
        "--always-include-group", "group-z",
        "--always-include-group", "group-a",
        "--rollout-percent", "25",
      ]);
      await runUpdate("release-full", ["--full", "--rollout-percent", "100"]);

      const patches = Object.fromEntries(
        requests
          .filter((request) => request.method === "PATCH")
          .map((request) => [request.url.split("/").at(-1), request.body]),
      );
      expect(patches).toEqual({
        "release-mixed": {
          scopes: [
            { scope_type: "full", scope_value: "all" },
            { scope_type: "device_group", scope_value: "group-a" },
            { scope_type: "device_group", scope_value: "group-z" },
          ],
          rollout_cohort_count: 25,
          expected_revision: 11,
        },
        "release-full": {
          scopes: [{ scope_type: "full", scope_value: "all" }],
          rollout_cohort_count: null,
          expected_revision: 11,
        },
      });

      const patchesBeforeInvalid = requests.filter((request) => request.method === "PATCH").length;
      await expect(runUpdate("release-conflict", [
        "--device-group", "group-a", "--full",
      ])).rejects.toThrow("cannot be combined");
      await expect(runUpdate("release-duplicate", [
        "--always-include-group", "group-a",
        "--always-include-group", "group-a",
      ])).rejects.toThrow("may not repeat");
      await expect(runUpdate("release-percent", [
        "--rollout-percent", "101",
      ])).rejects.toThrow("integer from 0 to 100");
      expect(requests.filter((request) => request.method === "PATCH")).toHaveLength(patchesBeforeInvalid);
    } finally {
      if (originalApi === undefined) delete process.env.HANDS_API;
      else process.env.HANDS_API = originalApi;
      if (originalToken === undefined) delete process.env.HANDS_BEARER_TOKEN;
      else process.env.HANDS_BEARER_TOKEN = originalToken;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("derives every exact scoped publish precondition from detail and refuses invalid stored scopes", async () => {
    const requests: Array<{ method: string; url: string; body?: any }> = [];
    const details: Record<string, unknown[]> = {
      "release-platform": [{ scope_type: "platform", scope_value: "android" }],
      "release-cohort": [{ scope_type: "user_cohort", scope_value: "internal-qa" }],
      "release-ip": [{ scope_type: "ip_range", scope_value: "203.0.113.0/24" }],
      "release-full": [{ scope_type: "full", scope_value: "all" }],
      "release-zero": [],
      "release-mixed": [
        { scope_type: "platform", scope_value: "android" },
        { scope_type: "user_cohort", scope_value: "internal-qa" },
      ],
      "release-full-groups": [
        { scope_type: "device_group", scope_value: "group-z" },
        { scope_type: "full", scope_value: "all" },
        { scope_type: "device_group", scope_value: "group-a" },
      ],
      "release-full-platform": [
        { scope_type: "full", scope_value: "all" },
        { scope_type: "platform", scope_value: "android" },
      ],
      "release-duplicate": [
        { scope_type: "device_group", scope_value: "group-a" },
        { scope_type: "device_group", scope_value: "group-a" },
      ],
      "release-unknown": [{ scope_type: "future_scope", scope_value: "value" }],
    };
    const server = createServer(async (req, res) => {
      let body: any = undefined;
      if (req.headers["content-type"]?.includes("application/json")) {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      }
      requests.push({ method: req.method ?? "GET", url: req.url ?? "", body });
      res.setHeader("content-type", "application/json");
      if (req.url === "/api/apps") {
        return res.end(JSON.stringify({ apps: [{ id: "app-1", slug: "raft-android" }] }));
      }
      const detailMatch = req.url?.match(/^\/api\/apps\/app-1\/releases\/([^/]+)$/);
      if (detailMatch && req.method === "GET") {
        const releaseId = detailMatch[1] ?? "";
        return res.end(JSON.stringify({
          release: { id: releaseId, status: "draft", revision: 17 },
          scopes: details[releaseId],
        }));
      }
      const publishMatch = req.url?.match(/^\/api\/apps\/app-1\/releases\/([^/]+)\/publish$/);
      if (publishMatch && req.method === "POST") {
        return res.end(JSON.stringify({ id: publishMatch[1], status: "active" }));
      }
      res.statusCode = 404;
      return res.end(JSON.stringify({ error: "not found" }));
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("bad address");
    const originalApi = process.env.HANDS_API;
    const originalToken = process.env.HANDS_BEARER_TOKEN;
    process.env.HANDS_API = `http://127.0.0.1:${address.port}`;
    process.env.HANDS_BEARER_TOKEN = "test-token";

    const runPublish = async (releaseId: string, extra: string[] = []) => {
      const program = new Command();
      const { registerReleaseCommands } = await import("../src/commands/releases.js");
      registerReleaseCommands(program);
      return program.parseAsync([
        "node", "hands", "releases", "publish", "raft-android", releaseId, ...extra,
      ]);
    };

    try {
      for (const releaseId of ["release-platform", "release-cohort", "release-ip", "release-full", "release-mixed"]) {
        await runPublish(releaseId);
      }
      await runPublish("release-full-groups", [
        "--device-group", "group-z",
        "--device-group", "group-a",
      ]);
      const publishBodies = Object.fromEntries(
        requests
          .filter((request) => request.method === "POST" && request.url.endsWith("/publish"))
          .map((request) => [request.url.split("/").at(-2), request.body]),
      );
      expect(publishBodies).toEqual({
        "release-platform": { expected_scopes: [{ scope_type: "platform", scope_value: "android" }], expected_revision: 17 },
        "release-cohort": { expected_scopes: [{ scope_type: "user_cohort", scope_value: "internal-qa" }], expected_revision: 17 },
        "release-ip": { expected_scopes: [{ scope_type: "ip_range", scope_value: "203.0.113.0/24" }], expected_revision: 17 },
        "release-full": { expected_scopes: [{ scope_type: "full", scope_value: "all" }], expected_revision: 17 },
        "release-mixed": {
          expected_scopes: [
            { scope_type: "platform", scope_value: "android" },
            { scope_type: "user_cohort", scope_value: "internal-qa" },
          ],
          expected_revision: 17,
        },
        "release-full-groups": {
          expected_scopes: [
            { scope_type: "full", scope_value: "all" },
            { scope_type: "device_group", scope_value: "group-a" },
            { scope_type: "device_group", scope_value: "group-z" },
          ],
          expected_revision: 17,
        },
      });

      const postsBeforeInvalid = requests.filter(
        (request) => request.method === "POST" && request.url.endsWith("/publish"),
      ).length;
      for (const releaseId of ["release-zero", "release-full-platform", "release-duplicate", "release-unknown"]) {
        await expect(runPublish(releaseId)).rejects.toThrow(/refusing|duplicates/);
      }
      await expect(runPublish("release-platform", ["--device-group", "group-wrong"]))
        .rejects.toThrow("do not match stored []");
      await expect(runPublish("release-full-groups", ["--device-group", "group-a"]))
        .rejects.toThrow("do not match stored [group-a, group-z]");
      await expect(runPublish("release-full-groups", [
        "--device-group", "group-a", "--device-group", "group-a",
      ])).rejects.toThrow("may not repeat");
      expect(requests.filter(
        (request) => request.method === "POST" && request.url.endsWith("/publish"),
      )).toHaveLength(postsBeforeInvalid);
    } finally {
      if (originalApi === undefined) delete process.env.HANDS_API;
      else process.env.HANDS_API = originalApi;
      if (originalToken === undefined) delete process.env.HANDS_BEARER_TOKEN;
      else process.env.HANDS_BEARER_TOKEN = originalToken;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe("electron build helpers", () => {
  it("infers Electron platforms from metadata and artifact filenames", async () => {
    const { inferElectronPlatform } = await import("../src/commands/builds.js");
    expect(inferElectronPlatform("dist/latest.yml")).toBe("win32");
    expect(inferElectronPlatform("dist/latest-mac.yml")).toBe("darwin");
    expect(inferElectronPlatform("dist/latest-linux.yml")).toBe("linux");
    expect(inferElectronPlatform("dist/Raft-1.2.3.AppImage")).toBe("linux");
    expect(inferElectronPlatform("dist/Raft-1.2.3.dmg")).toBe("darwin");
  });

  it("infers Electron filetypes without lowercasing AppImage", async () => {
    const { inferElectronFiletype } = await import("../src/commands/builds.js");
    expect(inferElectronFiletype("dist/latest.yml")).toBe("yml");
    expect(inferElectronFiletype("dist/Raft Setup 1.2.3.exe")).toBe("exe");
    expect(inferElectronFiletype("dist/Raft-1.2.3.AppImage")).toBe("AppImage");
    expect(inferElectronFiletype("dist/Raft Setup 1.2.3.exe.blockmap")).toBe("blockmap");
  });
});

describe("Android delta patch metadata", () => {
  it("marks metadata as gzip and rejects raw or truncated PatchGen output", async () => {
    const {
      ANDROID_DELTA_PATCH_ALGORITHM,
      assertGzipAndroidDeltaPatch,
      androidDeltaPatchMetadata,
    } = await import("../src/commands/builds.js");

    expect(ANDROID_DELTA_PATCH_ALGORITHM).toBe("archive-patcher-v1+gzip");
    expect(
      androidDeltaPatchMetadata({
        fromVersionCode: 1000002,
        toVersionCode: 1000003,
        targetSha256: "a".repeat(64),
      }),
    ).toEqual({
      from_version_code: 1000002,
      to_version_code: 1000003,
      algorithm: "archive-patcher-v1+gzip",
      target_sha256: "a".repeat(64),
    });

    const dir = mkdtempSync(join(tmpdir(), "hands-android-delta-"));
    const gzipPatch = join(dir, "valid.patch.gz");
    const rawPatch = join(dir, "raw.patch");
    const truncatedPatch = join(dir, "truncated.patch.gz");
    try {
      const complete = gzipSync(Buffer.from("GFbFv1_0patch-body", "ascii"));
      writeFileSync(gzipPatch, complete);
      writeFileSync(rawPatch, Buffer.from("GFbFv1_0", "ascii"));
      writeFileSync(truncatedPatch, complete.subarray(0, complete.length - 4));
      await expect(assertGzipAndroidDeltaPatch(gzipPatch)).resolves.toBeUndefined();
      await expect(assertGzipAndroidDeltaPatch(rawPatch)).rejects.toThrow(
        "must be a complete gzip-compressed official PatchGen output",
      );
      await expect(assertGzipAndroidDeltaPatch(truncatedPatch)).rejects.toThrow(
        "must be a complete gzip-compressed official PatchGen output",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("preflights before HTTP and sends the exact gzip asset metadata", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hands-android-publish-"));
    const apk = join(dir, "app.apk");
    const validPatch = join(dir, "valid.patch.gz");
    const rawPatch = join(dir, "raw.patch");
    const truncatedPatch = join(dir, "truncated.patch.gz");
    const complete = gzipSync(Buffer.from("GFbFv1_0patch-body", "ascii"));
    writeFileSync(apk, "apk-bytes");
    writeFileSync(validPatch, complete);
    writeFileSync(rawPatch, Buffer.from("GFbFv1_0patch-body", "ascii"));
    writeFileSync(truncatedPatch, complete.subarray(0, complete.length - 4));

    const requests: Array<{ method: string; url: string; body?: any }> = [];
    let uploadCount = 0;
    const server = createServer(async (req, res) => {
      let body: any = undefined;
      if (req.headers["content-type"]?.includes("application/json")) {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } else {
        for await (const _chunk of req) {
          // Drain multipart uploads before responding.
        }
      }
      requests.push({ method: req.method ?? "GET", url: req.url ?? "", body });
      res.setHeader("content-type", "application/json");
      if (req.method === "GET" && req.url === "/api/apps") {
        return res.end(JSON.stringify({ apps: [{ id: "app-1", slug: "android-app" }] }));
      }
      if (req.method === "GET" && req.url === "/api/apps/app-1/channels") {
        return res.end(JSON.stringify({ channels: [{ id: "channel-1", slug: "main", name: "Main" }] }));
      }
      if (req.method === "POST" && req.url === "/api/apps/app-1/builds") {
        return res.end(JSON.stringify({ id: "build-1" }));
      }
      if (req.method === "POST" && req.url === "/api/apps/app-1/upload") {
        uploadCount += 1;
        return res.end(JSON.stringify({
          file_hash: uploadCount === 1 ? "a".repeat(64) : "b".repeat(64),
          r2_key: `apps/app-1/upload-${uploadCount}`,
          size_bytes: uploadCount === 1 ? 9 : complete.length,
          original_filename: uploadCount === 1 ? "app.apk" : "valid.patch.gz",
        }));
      }
      if (req.method === "POST" && req.url === "/api/apps/app-1/builds/build-1/assets") {
        return res.end(JSON.stringify({ id: `asset-${uploadCount}` }));
      }
      if (req.method === "POST" && req.url === "/api/apps/app-1/releases") {
        return res.end(JSON.stringify({ id: "release-1" }));
      }
      res.statusCode = 404;
      return res.end(JSON.stringify({ error: "not found" }));
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("bad address");
    const originalApi = process.env.HANDS_API;
    const originalToken = process.env.HANDS_BEARER_TOKEN;
    process.env.HANDS_API = `http://127.0.0.1:${address.port}`;
    process.env.HANDS_BEARER_TOKEN = "test-token";

    const runPublish = async (patchPath: string) => {
      const { registerBuildCommands } = await import("../src/commands/builds.js");
      const program = new Command().version("0.5.13").option("--json", "JSON output", false);
      registerBuildCommands(program);
      await program.parseAsync([
        "node", "hands", "builds", "publish-android", "android-app",
        "--apk", apk,
        "--version-name", "1.0.0-alpha",
        "--version-code", "1000003",
        "--delta-patch", `1000002=${patchPath}`,
        "--draft",
      ]);
    };

    try {
      await runPublish(validPatch);
      const deltaAsset = requests.find(
        (request) =>
          request.method === "POST" &&
          request.url.endsWith("/assets") &&
          request.body?.artifact_kind === "delta-patch",
      );
      expect(deltaAsset?.body).toMatchObject({
        artifact_kind: "delta-patch",
        platform: "android",
        arch: "arm64-v8a",
        filetype: "patch",
        file_hash: "b".repeat(64),
        metadata_json: {
          from_version_code: 1000002,
          to_version_code: 1000003,
          algorithm: "archive-patcher-v1+gzip",
          target_sha256: "a".repeat(64),
        },
      });

      requests.length = 0;
      await expect(runPublish(rawPatch)).rejects.toThrow(
        "must be a complete gzip-compressed official PatchGen output",
      );
      expect(requests).toEqual([]);

      requests.length = 0;
      await expect(runPublish(truncatedPatch)).rejects.toThrow(
        "must be a complete gzip-compressed official PatchGen output",
      );
      expect(requests).toEqual([]);
    } finally {
      if (originalApi === undefined) delete process.env.HANDS_API;
      else process.env.HANDS_API = originalApi;
      if (originalToken === undefined) delete process.env.HANDS_BEARER_TOKEN;
      else process.env.HANDS_BEARER_TOKEN = originalToken;
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("Tauri build helpers", () => {
  it("accepts only updater bundle formats produced by Tauri v2", async () => {
    const { inferTauriFiletype } = await import("../src/commands/builds.js");
    expect(inferTauriFiletype("App.app.tar.gz")).toBe("tar.gz");
    expect(inferTauriFiletype("App_1.2.3_x64-setup.nsis.zip")).toBe("nsis.zip");
    expect(inferTauriFiletype("App_1.2.3_x64_en-US.msi.zip")).toBe("msi.zip");
    expect(inferTauriFiletype("App_1.2.3_amd64.AppImage")).toBe("AppImage");
    expect(inferTauriFiletype("App_1.2.3_x64-setup.exe")).toBe("exe");
    expect(inferTauriFiletype("App_1.2.3_x64_en-US.msi")).toBe("msi");
    expect(() => inferTauriFiletype("App.dmg")).toThrow("unsupported Tauri updater bundle");
  });

  it("maps official Tauri targets to Hands platform storage", async () => {
    const { splitTauriTarget } = await import("../src/commands/builds.js");
    expect(splitTauriTarget("windows-x86_64")).toEqual({ platform: "win32", arch: "x86_64" });
    expect(splitTauriTarget("darwin-aarch64")).toEqual({ platform: "darwin", arch: "aarch64" });
    expect(() => splitTauriTarget("win32-arm64")).toThrow("Tauri target must be");
  });

  it("publishes a signed target through the full draft-first API flow", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hands-tauri-publish-"));
    const bundle = join(dir, "App.AppImage");
    const signature = `${bundle}.sig`;
    writeFileSync(bundle, "bundle-bytes");
    writeFileSync(signature, "detached-signature\n");

    const requests: Array<{ method: string; url: string; body?: any }> = [];
    const server = createServer(async (req, res) => {
      let body: any = undefined;
      if (req.headers["content-type"]?.includes("application/json")) {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      }
      requests.push({ method: req.method ?? "GET", url: req.url ?? "", body });
      res.setHeader("content-type", "application/json");
      if (req.url === "/api/apps") return res.end(JSON.stringify({ apps: [{ id: "app-1", slug: "desktop" }] }));
      if (req.url === "/api/apps/app-1/channels") return res.end(JSON.stringify({ channels: [{ id: "channel-1", slug: "main", name: "Main" }] }));
      if (req.url === "/api/apps/app-1/builds") return res.end(JSON.stringify({ id: "build-1" }));
      if (req.url === "/api/apps/app-1/upload") return res.end(JSON.stringify({
        file_hash: "hash-1", r2_key: "apps/app-1/App.AppImage", size_bytes: 12, original_filename: "App.AppImage",
      }));
      if (req.url === "/api/apps/app-1/builds/build-1/assets") return res.end(JSON.stringify({ id: "asset-1" }));
      if (req.url === "/api/apps/app-1/releases") return res.end(JSON.stringify({ id: "release-1" }));
      res.statusCode = 404;
      return res.end(JSON.stringify({ error: "not found" }));
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("bad address");
    const originalApi = process.env.HANDS_API;
    const originalToken = process.env.HANDS_BEARER_TOKEN;
    process.env.HANDS_API = `http://127.0.0.1:${address.port}`;
    process.env.HANDS_BEARER_TOKEN = "test-token";

    try {
      const { registerBuildCommands } = await import("../src/commands/builds.js");
      const program = new Command().version("0.5.9").option("--json", "JSON output", false);
      registerBuildCommands(program);
      await program.parseAsync([
        "node", "hands", "builds", "publish-tauri", "desktop",
        "--version-name", "1.2.3",
        "--bundle", bundle,
        "--signature", signature,
        "--target", "linux-x86_64",
      ]);

      const assetRequest = requests.find((request) => request.url.endsWith("/assets"));
      expect(assetRequest?.body).toMatchObject({
        artifact_kind: "tauri-updater",
        platform: "linux",
        arch: "x86_64",
        filetype: "AppImage",
        signature: "detached-signature",
      });
      const releaseRequest = requests.find((request) => request.url.endsWith("/releases"));
      expect(releaseRequest?.body).toMatchObject({
        status: "draft",
        product_type: "tauri-updater",
        scopes: [{ scope_type: "full", scope_value: "all" }],
      });
    } finally {
      if (originalApi === undefined) delete process.env.HANDS_API;
      else process.env.HANDS_API = originalApi;
      if (originalToken === undefined) delete process.env.HANDS_BEARER_TOKEN;
      else process.env.HANDS_BEARER_TOKEN = originalToken;
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("external build publish helpers", () => {
  it("splits the public target into the existing platform/arch storage shape", async () => {
    const { splitBuildTarget } = await import("../src/commands/builds.js");
    expect(splitBuildTarget("darwin-arm64")).toEqual({ platform: "darwin", arch: "arm64" });
    expect(splitBuildTarget("linux-x64")).toEqual({ platform: "linux", arch: "x64" });
    expect(() => splitBuildTarget("node")).toThrow("--target must be");
  });

  it("derives an ordering code for numeric semantic versions", async () => {
    const { versionCodeFromVersion } = await import("../src/commands/builds.js");
    expect(versionCodeFromVersion("0.72.12")).toBe(72_012);
    expect(versionCodeFromVersion("1.2.3-beta.1")).toBe(1_002_003);
    expect(() => versionCodeFromVersion("nightly")).toThrow("--version-code is required");
  });

  it("publishes through the true root command without colliding with --version", async () => {
    const requests: Array<{ url: string; body?: any }> = [];
    const server = createServer(async (req, res) => {
      let body: any = undefined;
      if (req.headers["content-type"]?.includes("application/json")) {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      }
      requests.push({ url: req.url ?? "", body });
      res.setHeader("content-type", "application/json");
      if (req.url === "/api/apps") return res.end(JSON.stringify({ apps: [{ id: "app-1", slug: "computer" }] }));
      if (req.url === "/api/apps/app-1/channels") return res.end(JSON.stringify({ channels: [{ id: "channel-1", slug: "shadow", name: "Shadow" }] }));
      if (req.url === "/api/apps/app-1/builds/publish-version") return res.end(JSON.stringify({
        app_id: "app-1", build_id: "build-1", target_id: "target-1", version: "1.0.5",
        target: "darwin-arm64", platform: "darwin", arch: "arm64", replayed: false,
      }));
      res.statusCode = 404;
      return res.end(JSON.stringify({ error: "not found" }));
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("bad address");
    const originalApi = process.env.HANDS_API;
    const originalToken = process.env.HANDS_BEARER_TOKEN;
    process.env.HANDS_API = `http://127.0.0.1:${address.port}`;
    process.env.HANDS_BEARER_TOKEN = "test-token";

    try {
      const { registerBuildCommands } = await import("../src/commands/builds.js");
      const program = new Command().version("0.5.12").option("--json", "JSON output", false);
      registerBuildCommands(program);
      await program.parseAsync([
        "node", "hands", "builds", "publish-version", "computer",
        "--version-name", "1.0.5",
        "--target", "darwin-arm64",
        "--source-url", "https://cdn.example.test/computer/1.0.5/darwin-arm64",
        "--raw-sha256", "a".repeat(64),
        "--raw-size", "123",
        "--channel", "shadow",
      ]);

      expect(requests.find((request) => request.url.endsWith("/publish-version"))?.body).toMatchObject({
        channel_id: "channel-1",
        version_name: "1.0.5",
        version_code: 1_000_005,
        target: "darwin-arm64",
        raw_size_bytes: 123,
      });
    } finally {
      if (originalApi === undefined) delete process.env.HANDS_API;
      else process.env.HANDS_API = originalApi;
      if (originalToken === undefined) delete process.env.HANDS_BEARER_TOKEN;
      else process.env.HANDS_BEARER_TOKEN = originalToken;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe("iOS build helper contract", () => {
  it("documents signed IPA as the installable artifact shape", async () => {
    const { inferIosFiletype } = await import("../src/commands/builds.js");
    expect(inferIosFiletype("build/App.ipa")).toBe("ipa");
    expect(inferIosFiletype("build/App.dSYM.zip")).toBe("dsym.zip");
    expect(inferIosFiletype("build/metadata.json")).toBe("metadata.json");
  });

  it("serializes localized publish changelogs like release updates", async () => {
    const { parseChangelogOptions } = await import("../src/commands/builds.js");
    expect(
      parseChangelogOptions({
        changelog: ["zh=中文更新", "en=English update"],
      }),
    ).toBe(JSON.stringify({ "zh-CN": "中文更新", en: "English update" }));
    expect(parseChangelogOptions({ changelog: ["plain update"] })).toBe("plain update");
    expect(parseChangelogOptions({})).toBeNull();
    expect(() =>
      parseChangelogOptions({ changelog: ["plain update", "en=English update"] }),
    ).toThrow("mix of plain and lang= changelog entries");
  });

  it("parses repeatable localized What to Test text and files", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hands-testflight-notes-"));
    const zh = join(dir, "zh.txt");
    writeFileSync(zh, "验证登录和活动页。\n");
    try {
      const { parseWhatToTestOptions } = await import("../src/commands/builds.js");
      expect(
        parseWhatToTestOptions({
          whatToTest: ["en-US=Verify login and Activity."],
          whatToTestFile: [`zh-Hans=${zh}`],
        }),
      ).toEqual({
        "en-US": "Verify login and Activity.",
        "zh-Hans": "验证登录和活动页。",
      });
      expect(() =>
        parseWhatToTestOptions({ whatToTest: ["missing-locale-separator"] }),
      ).toThrow("must use locale=text");
      expect(() =>
        parseWhatToTestOptions({
          whatToTest: ["en-US=First", "en-US=Second"],
        }),
      ).toThrow("duplicate What to Test locale: en-US");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sends the TestFlight publish action with stable groups and metadata", async () => {
    const requests: Array<{ method: string; url: string; body?: any }> = [];
    const server = createServer(async (req, res) => {
      let body: any = undefined;
      if (req.headers["content-type"]?.includes("application/json")) {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      }
      requests.push({ method: req.method ?? "GET", url: req.url ?? "", body });
      res.setHeader("content-type", "application/json");
      if (req.url === "/api/apps") {
        return res.end(JSON.stringify({ apps: [{ id: "app-1", slug: "raft-ios" }] }));
      }
      if (req.url === "/api/apps/app-1/builds/build-1/testflight-publish") {
        return res.end(
          JSON.stringify({
            hands_build_id: "build-1",
            bundle_id: "build.raft.app",
            asc_app_id: "asc-app-1",
            asc_build_id: "asc-build-1",
            version: "1.0.0",
            build_number: "1000005",
            state: "waiting_for_review",
            distribution: "external",
            beta_review: { state: "WAITING_FOR_REVIEW" },
            notification: "scheduled",
          }),
        );
      }
      res.statusCode = 404;
      return res.end(JSON.stringify({ error: "not found" }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("bad address");
    const originalApi = process.env.HANDS_API;
    const originalToken = process.env.HANDS_BEARER_TOKEN;
    process.env.HANDS_API = `http://127.0.0.1:${address.port}`;
    process.env.HANDS_BEARER_TOKEN = "test-token";

    try {
      const { registerBuildCommands } = await import("../src/commands/builds.js");
      const program = new Command().version("0.5.12").option("--json", "JSON output", false);
      registerBuildCommands(program);
      await program.parseAsync([
        "node",
        "hands",
        "builds",
        "testflight-publish",
        "raft-ios",
        "build-1",
        "--distribution",
        "external",
        "--group-id",
        "group-1",
        "--group-id",
        "group-2",
        "--what-to-test",
        "en-US=Verify release candidate.",
        "--notify-testers",
      ]);

      const publish = requests.find(
        (request) =>
          request.method === "POST" && request.url.endsWith("/testflight-publish"),
      );
      expect(publish?.body).toEqual({
        distribution: "external",
        group_ids: ["group-1", "group-2"],
        what_to_test: { "en-US": "Verify release candidate." },
        notify_testers: true,
      });
    } finally {
      if (originalApi === undefined) delete process.env.HANDS_API;
      else process.env.HANDS_API = originalApi;
      if (originalToken === undefined) delete process.env.HANDS_BEARER_TOKEN;
      else process.env.HANDS_BEARER_TOKEN = originalToken;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("waits for the exact ASC build before publishing and then polls review state", async () => {
    const requests: string[] = [];
    let statusReads = 0;
    const server = createServer(async (req, res) => {
      requests.push(`${req.method ?? "GET"} ${req.url ?? ""}`);
      res.setHeader("content-type", "application/json");
      if (req.url === "/api/apps") {
        return res.end(
          JSON.stringify({ apps: [{ id: "app-1", slug: "raft-ios" }] }),
        );
      }
      if (
        req.method === "GET" &&
        req.url?.startsWith(
          "/api/apps/app-1/builds/build-1/testflight-publish",
        )
      ) {
        statusReads += 1;
        if (statusReads === 1) {
          return res.end(
            JSON.stringify({
              hands_build_id: "build-1",
              bundle_id: "build.raft.app",
              asc_app_id: "asc-app-1",
              asc_build_id: null,
              version: "1.0.0",
              build_number: "1000005",
              state: "waiting_for_processing",
              distribution: "external",
            }),
          );
        }
        const approved = statusReads >= 3;
        return res.end(
          JSON.stringify({
            hands_build_id: "build-1",
            bundle_id: "build.raft.app",
            asc_app_id: "asc-app-1",
            asc_build_id: "asc-build-1",
            version: "1.0.0",
            build_number: "1000005",
            processing_state: "VALID",
            state: approved ? "approved_not_notified" : "ready_for_beta_submission",
            distribution: "external",
            beta_review: approved ? { state: "APPROVED" } : null,
          }),
        );
      }
      if (
        req.method === "POST" &&
        req.url === "/api/apps/app-1/builds/build-1/testflight-publish"
      ) {
        for await (const _chunk of req) {
          // Drain the request body before responding.
        }
        return res.end(
          JSON.stringify({
            hands_build_id: "build-1",
            bundle_id: "build.raft.app",
            asc_app_id: "asc-app-1",
            asc_build_id: "asc-build-1",
            version: "1.0.0",
            build_number: "1000005",
            state: "waiting_for_review",
            distribution: "external",
            beta_review: { state: "WAITING_FOR_REVIEW" },
          }),
        );
      }
      res.statusCode = 404;
      return res.end(JSON.stringify({ error: "not found" }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("bad address");
    const originalApi = process.env.HANDS_API;
    const originalToken = process.env.HANDS_BEARER_TOKEN;
    process.env.HANDS_API = `http://127.0.0.1:${address.port}`;
    process.env.HANDS_BEARER_TOKEN = "test-token";

    try {
      const { registerBuildCommands } = await import("../src/commands/builds.js");
      const program = new Command()
        .version("0.5.12")
        .option("--json", "JSON output", false);
      registerBuildCommands(program);
      await program.parseAsync([
        "node",
        "hands",
        "--json",
        "builds",
        "testflight-publish",
        "raft-ios",
        "build-1",
        "--distribution",
        "external",
        "--group-id",
        "external-1",
        "--what-to-test",
        "en-US=Verify release.",
        "--wait",
        "--poll-interval-seconds",
        "0.001",
        "--timeout-seconds",
        "1",
      ]);

      expect(statusReads).toBe(3);
      const postIndex = requests.findIndex((request) => request.startsWith("POST "));
      const statusBeforePost = requests
        .slice(0, postIndex)
        .filter((request) => request.includes("testflight-publish"));
      expect(statusBeforePost).toHaveLength(2);
    } finally {
      if (originalApi === undefined) delete process.env.HANDS_API;
      else process.env.HANDS_API = originalApi;
      if (originalToken === undefined) delete process.env.HANDS_BEARER_TOKEN;
      else process.env.HANDS_BEARER_TOKEN = originalToken;
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe("OHOS build helper contract", () => {
  it("preserves the App Pack, HAP, symbols, and metadata asset types", async () => {
    const { inferOhosFiletype } = await import("../src/commands/builds.js");
    expect(inferOhosFiletype("build/Raft.app")).toBe("app");
    expect(inferOhosFiletype("build/entry-default-signed.hap")).toBe("hap");
    expect(inferOhosFiletype("build/ohos-symbols.tar.gz")).toBe("symbols.tar.gz");
    expect(inferOhosFiletype("build/ohos-release-metadata.json")).toBe("metadata.json");
  });

  it("honors the root --json flag for nested build commands", async () => {
    const { shouldOutputJson } = await import("../src/commands/builds.js");
    const program = new Command().option("--json", "JSON output", false);
    program.parse(["node", "hands", "--json"]);
    expect(shouldOutputJson(program, false)).toBe(true);
    expect(shouldOutputJson(new Command(), true)).toBe(true);
  });
});

describe("build publish changelog options", () => {
  it("supports repeatable lang=file changelogs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "quiver-changelog-"));
    try {
      const zh = join(dir, "zh.md");
      const en = join(dir, "en.md");
      writeFileSync(zh, "中文更新\n");
      writeFileSync(en, "English update\n");
      const { parseChangelogOptions } = await import("../src/commands/builds.js");
      expect(
        parseChangelogOptions({
          changelogFile: [`zh=${zh}`, `en=${en}`],
        }),
      ).toBe(JSON.stringify({ "zh-CN": "中文更新", en: "English update" }));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("Hands logging integration", () => {
  it("validates the CLI collect-policy fixture against hands-node schema", async () => {
    const { validateCollectPolicy } = await import("@botiverse/hands-node/logs/schema");
    expect(validateCollectPolicy(fixturePolicy)).toEqual({ valid: true, errors: [] });
  });

  it("never throws when the configured log directory cannot be created", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hands-cli-logging-"));
    const blocked = join(dir, "not-a-directory");
    writeFileSync(blocked, "file");
    const original = process.env.HANDS_LOG_DIR;
    process.env.HANDS_LOG_DIR = blocked;
    try {
      const { recordCliEvent, resetCliLoggerForTests } = await import("./lib/logging.js");
      resetCliLoggerForTests();
      expect(() => recordCliEvent("info", "test", "test event")).not.toThrow();
      resetCliLoggerForTests();
    } finally {
      if (original === undefined) delete process.env.HANDS_LOG_DIR;
      else process.env.HANDS_LOG_DIR = original;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
