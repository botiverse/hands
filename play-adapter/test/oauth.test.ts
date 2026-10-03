import { describe, expect, it, vi } from "vitest";
import { createAccessToken, parsePlayCredential } from "../src/auth";
import { createPlayAdapterService } from "../src/index";
const credential = { type: "authorized_user" as const, client_id: "client", client_secret: "private-client-secret", refresh_token: "private-refresh", client_email: "human@example.com" };
describe("Google OAuth refresh", () => {
  it("exchanges a refresh token only with Google's fixed endpoint", async () => {
    const fetch = vi.fn(async (url, init) => {
      expect(String(url)).toBe("https://oauth2.googleapis.com/token");
      expect(init.redirect).toBe("manual");
      expect(init.signal).toBeInstanceOf(AbortSignal);
      expect(new URLSearchParams(String(init.body)).get("grant_type")).toBe("refresh_token");
      return Response.json({ access_token: "short-lived", token_type: "Bearer" });
    });
    expect(await createAccessToken(credential, fetch)).toBe("short-lived");
    expect(fetch).toHaveBeenCalledOnce();
  });
  it.each([400, 401, 403, 500])("redacts Google credential errors for HTTP %s", async (status) => {
    await expect(createAccessToken(credential, vi.fn(async () => Response.json({ error: JSON.stringify(credential) }, { status }))))
      .rejects.toMatchObject({ status: status < 500 ? 403 : 502, message: "Google OAuth authorization needs reconnection" });
  });
  it("rejects malformed successful responses and missing credentials", async () => {
    await expect(createAccessToken(credential, vi.fn(async () => Response.json({ access_token: "access" })))).rejects.toMatchObject({ status: 502 });
    expect(() => parsePlayCredential({ ...credential, refresh_token: "" })).toThrow();
    expect(parsePlayCredential(credential)).toEqual(credential);
  });
  it("verifies package and all tracks with OAuth and removes the temporary edit without committing", async () => {
    const requests: string[] = [];
    const service = createPlayAdapterService({ fetchImpl: vi.fn(async (url, init = {}) => {
      const path = String(url); requests.push((init.method ?? "GET") + " " + path);
      if (path === "https://oauth2.googleapis.com/token") return Response.json({ access_token: "short-lived", token_type: "Bearer" });
      expect(new Headers(init.headers).get("authorization")).toBe("Bearer short-lived");
      if (init.method === "POST") return Response.json({ id: "edit" });
      if (init.method === "DELETE") return new Response(null, { status: 204 });
      return Response.json({ tracks: [{ track: "internal" }, { track: "closed" }, { track: "production" }] });
    }) } as any);
    const result = await service.verifyBinding({ credential, packageName: "build.raft.app", tracks: { internal: "internal", closed: "closed", production: "production" } }, { MAX_AAB_SIZE_BYTES: "209715200" });
    expect(result.ok).toBe(true);
    expect(requests.some((r) => r.startsWith("DELETE "))).toBe(true);
    expect(requests.some((r) => r.includes(":commit"))).toBe(false);
  });
});

describe("Play track discovery", () => {
  it("reads actual tracks, uses Workers-supported no-follow requests, and deletes the edit without publishing", async () => {
    const requests: string[] = [];
    const service = createPlayAdapterService({ fetchImpl: vi.fn(async (url, init = {}) => {
      expect(init.redirect).toBe("manual");
      const path = String(url); requests.push(`${init.method ?? "GET"} ${path}`);
      if (path.endsWith("/token")) return Response.json({ access_token: "access", token_type: "Bearer" });
      if (init.method === "POST") return Response.json({ id: "discovery-edit" });
      if (init.method === "DELETE") return new Response(null, { status: 204 });
      expect(path.endsWith("/edits/discovery-edit/tracks")).toBe(true);
      return Response.json({ tracks: [{ track: "internal" }, { track: "production" }, { track: "actual-closed-7" }, { track: "internal" }] });
    }) } as any);
    expect(await service.listTracks({ credential, packageName: "build.raft.app" }, { MAX_AAB_SIZE_BYTES: "209715200" }))
      .toEqual({ ok: true, value: { client_email: credential.client_email, package_name: "build.raft.app", tracks: ["actual-closed-7", "internal", "production"] } });
    expect(requests.at(-1)).toContain("DELETE ");
    expect(requests.some((r) => r.includes(":commit") || r.includes("/bundles"))).toBe(false);
  });
  it.each(["malformed", "redirect", "denied"])("cleans up failed discovery: %s", async (reason) => {
    const fetch = vi.fn(async (url, init = {}) => {
      expect(init.redirect).toBe("manual");
      if (String(url).endsWith("/token")) return Response.json({ access_token: "access", token_type: "Bearer" });
      if (init.method === "POST") return Response.json({ id: "edit" });
      if (init.method === "DELETE") return new Response(null, { status: 204 });
      if (reason === "redirect") return new Response(null, { status: 302, headers: { location: "https://untrusted.example" } });
      if (reason === "denied") return Response.json({ error: credential }, { status: 403 });
      return Response.json({ tracks: [{ track: "bad/track" }] });
    });
    const service = createPlayAdapterService({ fetchImpl: fetch } as any);
    const result = await service.listTracks({ credential, packageName: "build.raft.app" }, { MAX_AAB_SIZE_BYTES: "209715200" });
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain(credential.refresh_token);
    expect(fetch.mock.calls.at(-1)?.[1]?.method).toBe("DELETE");
    expect(fetch.mock.calls.some(([url]) => String(url).includes("untrusted"))).toBe(false);
  });
});
