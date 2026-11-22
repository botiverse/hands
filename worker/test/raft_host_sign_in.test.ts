import { describe, expect, it, vi } from "vitest";
vi.mock("@cloudflare/containers", () => ({ Container: class {} }));
const { default: worker } = await import("../src/index");

function page(path: string, headers: Record<string, string> = {}, method = "GET") {
  const fetch = vi.fn(async () => new Response("<html>console</html>", {
    headers: { "content-type": "text/html", vary: "Accept-Encoding" },
  }));
  const response = worker.fetch(
    new Request(`https://app.hands.test${path}`, { method, headers: { accept: "text/html", ...headers } }),
    { ASSETS: { fetch } } as unknown as Env,
    { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext,
  );
  return { fetch, response };
}

describe("console pages opened from Raft (Raft-Host)", () => {
  it("sends a visitor without a session to Login with Raft, keeping the page", async () => {
    const { fetch, response } = page("/apps/a1/builds?tab=ios", { "raft-host": "desktop" });
    const res = await response;
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(
      `/api/auth/login?return=${encodeURIComponent("/apps/a1/builds?tab=ios")}`,
    );
    expect(res.headers.get("set-cookie")).toMatch(/^raft_host_signin_guard=/);
    expect(res.headers.get("vary")).toContain("Raft-Host");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    ["a signed-in browser", "/apps", { cookie: "hands_signed_in=1" }],
    ["a cancelled consent", "/apps?error=access_denied", {}],
    ["the request right after a redirect", "/apps", { cookie: "raft_host_signin_guard=1" }],
  ])("serves the page as usual for %s", async (_label, path, extra) => {
    const { fetch, response } = page(path, { "raft-host": "ios", ...extra });
    const res = await response;
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("<html>console</html>");
    expect(res.headers.get("vary")).toMatch(/^Accept-Encoding, Raft-Host/);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("leaves pages without Raft-Host unchanged apart from Vary", async () => {
    const { response } = page("/apps");
    const res = await response;
    expect(res.status).toBe(200);
    expect(res.headers.get("vary")).toMatch(/^Accept-Encoding, Raft-Host/);
  });

  it("does not redirect static assets or HEAD requests", async () => {
    const asset = await page("/assets/index.js", { "raft-host": "android", accept: "*/*", "sec-fetch-dest": "script" }).response;
    expect(asset.status).toBe(200);
    expect(asset.headers.get("vary")).not.toContain("Raft-Host");
    const head = await page("/apps", { "raft-host": "android" }, "HEAD").response;
    expect(head.status).toBe(200);
  });

  it("does not treat a different hint value as signed in", async () => {
    const res = await page("/apps", { "raft-host": "desktop", cookie: "hands_signed_in=0; other=1" }).response;
    expect(res.status).toBe(302);
  });
});
