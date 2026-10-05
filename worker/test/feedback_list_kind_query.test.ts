import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import { feedbackRoutes } from "../src/openapi/feedback";
import { handleListFeedback } from "../src/routes/feedback";
import { httpResponseTelemetry } from "../src/middleware/http_response_telemetry";
vi.mock("@cloudflare/containers", () => ({ Container: class {}, getRandom: () => { throw new Error("unused"); } }));
const { default: worker } = await import("../src/index");
afterEach(() => vi.restoreAllMocks());
const spec = Object.values(feedbackRoutes).find((r) => r.method === "get" && r.path === "/api/apps/{appId}/feedback")!;

describe("feedback list kind query", () => {
  it.each(["feedback,bug", "crash,error", "feedback", "bug", "crash", "error"])("accepts %s and binds every selected kind", async (kind) => {
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    let sql = "";
    const bind = vi.fn(() => ({ all: async () => ({ results: [] }) }));
    const DB = { prepare: (query: string) => { sql = query; return { bind }; } };
    const app = new OpenAPIHono<{ Bindings: Env }>({ defaultHook: (result, c) => {
      if (!result.success) return c.json({ error: "invalid request" }, 400);
    } });
    app.use("*", httpResponseTelemetry);
    app.openapi(createRoute(spec), handleListFeedback as any);
    const response = await app.request(`/api/apps/app-id/feedback?kind=${encodeURIComponent(kind)}`, {}, { DB } as unknown as Env);
    expect(response.status).toBe(200);
    expect(bind).toHaveBeenCalledWith("app-id", ...kind.split(","));
    expect(sql).toContain("AND kind IN (");
    expect(sql).toContain(`AND kind IN (${kind.split(",").map((_, i) => `?${i + 2}`).join(", ")})`);
    expect(JSON.parse(log.mock.calls[0]![1] as string).status).toBe(200);
  });

  it.each(["unknown", "feedback,unknown", "feedback,", ",bug", "feedback,,bug"])("rejects invalid lists before the list handler: %s", async (kind) => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const handler = vi.fn((c) => c.json({ tickets: [] }));
    const app = new OpenAPIHono({ defaultHook: (result, c) => {
      if (!result.success) return c.json({ error: "invalid request" }, 400);
    } });
    app.openapi(createRoute(spec), handler);
    const response = await app.request(`/api/apps/app-id/feedback?kind=${encodeURIComponent(kind)}`);
    expect(response.status).toBe(400);
    expect(handler).not.toHaveBeenCalled();
  });

  it.each(["feedback,bug", "crash,error"])("keeps authentication on real multi-kind requests: %s", async (kind) => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const response = await worker.fetch(new Request(`https://hands.test/api/apps/app-id/feedback?kind=${encodeURIComponent(kind)}`), {} as Env, { waitUntil() {}, passThroughOnException() {} } as any);
    expect(response.status).toBe(401);
  });
});
