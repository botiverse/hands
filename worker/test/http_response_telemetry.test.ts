import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import { httpResponseTelemetry } from "../src/middleware/http_response_telemetry";
import { registerReleaseRoutes } from "../src/openapi/releases";

afterEach(() => vi.restoreAllMocks());
const grantRoute = registerReleaseRoutes().find((r) => r.method === "post" && r.path === "/api/apps/{appId}/server-grants")!;

function harness() {
  const log = vi.spyOn(console, "info").mockImplementation(() => {});
  const app = new OpenAPIHono({ defaultHook: (result, c) => {
    if (!result.success) return c.json({ error: "invalid request" }, 400);
  } });
  app.use("*", httpResponseTelemetry);
  const handler = vi.fn((c) => c.json({ ok: true }, 201));
  app.openapi(createRoute(grantRoute), handler);
  return { app, log, handler };
}

describe("server grants validator and final HTTP telemetry", () => {
  it.each([
    { server_id: null, server_slug: "botiverse" },
    { server_id: "95f993fa-2a68-4797-b8ae-7beb7d984ada", server_slug: null },
    { server_slug: "botiverse" },
  ])("allows the UI's existing nullable/omitted identifiers: %j", async (body) => {
    const { app, handler, log } = harness();
    const response = await app.request("/api/apps/app-id/server-grants", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    expect(response.status).toBe(201);
    expect(handler).toHaveBeenCalledOnce();
    expect(JSON.parse(log.mock.calls[0]![1] as string).status).toBe(201);
  });

  it("counts a real validator 400 without entering the handler or leaking inputs", async () => {
    const { app, handler, log } = harness();
    const response = await app.request("/api/apps/private-app-id/server-grants?secret=private-query", {
      method: "POST", headers: { "content-type": "application/json", authorization: "Bearer private-token", "cf-ray": "a44e64ee3aee0f23-SIN" },
      body: JSON.stringify({ server_id: { secret: "private-body" }, server_slug: "botiverse" }),
    });
    expect(response.status).toBe(400);
    expect(handler).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledOnce();
    const record = JSON.parse(log.mock.calls[0]![1] as string);
    expect(record).toMatchObject({ method: "POST", status: 400, route: "/api/apps/:appId/server-grants", request_id: "a44e64ee3aee0f23-SIN" });
    expect(JSON.stringify(record)).not.toContain("private-");
  });

  it("captures auth refusal, handler error and unmatched requests once each", async () => {
    const { app, log } = harness();
    app.get("/api/auth-denied", (c) => c.json({ error: "secret-error" }, 403));
    app.get("/api/failure", () => { throw new Error("secret-exception"); });
    app.onError((_e, c) => c.json({ error: "server failure" }, 500));
    expect((await app.request("/api/auth-denied")).status).toBe(403);
    expect((await app.request("/api/failure")).status).toBe(500);
    expect((await app.request("/api/unmatched-private-id")).status).toBe(404);
    const records = log.mock.calls.map((row) => JSON.parse(row[1] as string));
    expect(records.map((r) => r.status)).toEqual([403, 500, 404]);
    expect(records[2].route).toBe("unmatched");
    expect(JSON.stringify(records)).not.toContain("secret");
    expect(JSON.stringify(records)).not.toContain("private-id");
  });
});
