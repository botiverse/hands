import { describe, it, expect, vi } from "vitest";

// The worker module eagerly imports @cloudflare/containers (index.ts:13 + the
// ApkParserContainer Durable Object class), which pulls `cloudflare:workers` —
// unavailable outside workerd, so a plain `import "../src/index"` fails to load.
// Stub only that binding: it is not on the path this test exercises (the request
// returns at the expires check, long before any container use). Everything else —
// routing and the global middleware chain — is the real worker.
vi.mock("@cloudflare/containers", () => ({
  Container: class {},
  getRandom: () => {
    throw new Error("container not used on this path");
  },
}));

const { default: worker } = await import("../src/index");

/**
 * Route-level assertion (task #119, Gogo's finding on #437): the #437 test
 * hand-rolls a Context and calls a handler directly, proving the handler
 * *returns* a code but not that the code survives Hono routing + the global
 * middleware chain + response serialization into the HTTP body a consumer reads.
 *
 * Dispatched through the REAL worker (`worker.fetch`), NOT a minimal
 * reconstruction. An earlier version mounted only the handler on a fresh Hono
 * app and called it a "faithful stand-in because there is no auth middleware" —
 * but /public/r2/:key sits behind two global app.use("*") middlewares (index.ts
 * :389 HTTPS redirect, :424 cors). "No auth middleware" is not "no middleware",
 * and a reconstruction that omits them would stay green if production's dispatch
 * drifted (e.g. a new body-rewriting or short-circuiting middleware). Going
 * through the real worker removes the reconstruction, so there is no
 * faithful-stand-in assumption to pin — and no false pin to write (Gogo/Sentinel,
 * #439 rule: pin the runtime property, not a registration proxy; if you can
 * eliminate the reconstruction, don't keep it to pin its assumption).
 *
 * The request is https:// so the :389 redirect does not fire; the chosen case
 * (missing `expires`) returns before any DB/R2/container access, so it needs no
 * fixture — the point is that `code` transits the real chain into the body.
 */
describe("public r2 download — code survives the real routing + middleware chain", () => {
  const env = { CORS_ALLOWED_ORIGINS: "" } as unknown as Parameters<typeof worker.fetch>[1];
  const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

  const fetchR2 = () =>
    worker.fetch(new Request("https://hands.test/public/r2/testkey"), env, ctx);

  it("carries `code` in the HTTP response body, not just the handler return", async () => {
    const res = await fetchR2();
    expect(res.status).toBe(400); // reached the handler through the real chain (no 308 on https)
    await expect(res.json()).resolves.toMatchObject({ code: "expires_invalid" });
  });

  it("keeps the human `error` string alongside the machine code (additive)", async () => {
    const res = await fetchR2();
    const body = (await res.json()) as { error?: string; code?: string };
    expect(typeof body.error).toBe("string"); // prose preserved for humans
    expect(body.code).toBe("expires_invalid"); // machine discriminator added
  });
});
