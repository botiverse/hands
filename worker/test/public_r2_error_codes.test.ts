import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { handlePublicR2Download } from "../src/routes/public_v2";

/**
 * Route-level assertion (task #119, Gogo's finding on #437): the #437 test
 * hand-rolls a Context and calls a handler directly, which proves the handler
 * *returns* a code but not that the code survives Hono routing + response
 * serialization into the actual HTTP body a consumer reads. This dispatches
 * through app.request — real router, real Response — and asserts the code is
 * present in the body. /public/r2/:key has no auth middleware, so a minimal
 * app mounting only this route is a faithful stand-in for its production
 * dispatch.
 *
 * The chosen case (missing `expires`) returns before any DB/R2 access, so it
 * needs no fixture: the point is the transport of `code`, not the branch.
 */
describe("public r2 download — code survives HTTP routing", () => {
  const app = new Hono();
  app.get("/public/r2/:key", handlePublicR2Download as any);

  it("carries `code` in the HTTP response body, not just the handler return", async () => {
    const res = await app.request("/public/r2/testkey", {}, {} as any);
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ code: "expires_invalid" });
  });

  it("keeps the human `error` string alongside the machine code (additive)", async () => {
    const res = await app.request("/public/r2/testkey", {}, {} as any);
    const body = (await res.json()) as { error?: string; code?: string };
    expect(typeof body.error).toBe("string"); // prose preserved for humans
    expect(body.code).toBe("expires_invalid"); // machine discriminator added
  });
});
