import { describe, expect, it, vi } from "vitest";
import { exportPKCS8, generateKeyPair } from "jose";
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
    const error = await createAccessToken(credential, vi.fn(async () => Response.json({ error: JSON.stringify(credential) }, { status }))).catch((e) => e);
    expect(JSON.stringify({ ...error, message: error.message })).not.toContain("private-refresh");
    expect(error.status).toBe(status === 401 ? 403 : 502);
  });
  it("asks for reconnection only when Google refuses the grant or client", async () => {
    const answer = (status: number, body: unknown) => createAccessToken(credential, vi.fn(async () => Response.json(body, { status }))).catch((e) => e);
    for (const code of ["invalid_grant", "invalid_client", "unauthorized_client"]) {
      expect(await answer(400, { error: code })).toMatchObject({ status: 403, code: "play_token_rejected" });
    }
    expect(await answer(401, {})).toMatchObject({ code: "play_token_rejected" });
    // Rate limits, outages and unnamed refusals are retried, not a reconnection.
    expect(await answer(429, { error: "rate_limit_exceeded" })).toMatchObject({ status: 502, code: "play_token_unavailable" });
    expect(await answer(503, { error: "backend_error" })).toMatchObject({ status: 502, code: "play_token_unavailable" });
    expect(await answer(400, { error: "invalid_request" })).toMatchObject({ status: 502, code: "play_token_unavailable" });
    expect(await answer(403, {})).toMatchObject({ status: 502, code: "play_token_unavailable" });
  });
  it("logs only Google's OAuth reason codes when a grant is refused", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await expect(createAccessToken(credential, vi.fn(async () => Response.json({
      error: "invalid_grant", error_subtype: "invalid_rapt", error_description: "reauth related error (invalid_rapt) for private-refresh",
    }, { status: 400 })))).rejects.toMatchObject({ code: "play_token_rejected" });
    await expect(createAccessToken(credential, vi.fn(async () => Response.json({ error: JSON.stringify(credential) }, { status: 400 }))))
      .rejects.toMatchObject({ code: "play_token_unavailable" });
    const lines = warn.mock.calls.filter((c) => c[0] === "hands_play_token_rejection").map((c) => JSON.parse(String(c[1])));
    expect(lines[0]).toEqual({ grant: "publishing", status: 400, error: "invalid_grant", error_subtype: "invalid_rapt", reauth_required: true, expired_or_revoked: false });
    expect(lines[1]).toMatchObject({ error: null, error_subtype: null });
    const logged = JSON.stringify(warn.mock.calls);
    for (const secret of ["private-refresh", "private-client-secret", "human@example.com"]) expect(logged).not.toContain(secret);
    warn.mockRestore();
  });
  it("hands Google's refusal text to the caller without the credential", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const refused = await createAccessToken(credential, vi.fn(async () => Response.json({
      error: "invalid_grant", error_subtype: "invalid_rapt",
      error_description: "reauth related error (invalid_rapt) for private-refresh / private-client-secret / human@example.com",
    }, { status: 400 }))).catch((e) => e);
    expect(refused).toMatchObject({ code: "play_token_rejected", cause_detail: {
      stage: "oauth_token", provider_http_status: 400,
      provider_identifiers: { errors_reasons: ["invalid_grant", "invalid_rapt"] },
    } });
    const said = refused.cause_detail.provider_message as string;
    expect(said).toContain("invalid_grant / invalid_rapt: reauth related error (invalid_rapt)");
    for (const secret of ["private-refresh", "private-client-secret", "human@example.com"]) expect(said).not.toContain(secret);
    warn.mockRestore();
  });
  it("scrubs a service account's identity and assertion from Google's refusal text", async () => {
    const pair = await generateKeyPair("RS256", { extractable: true });
    const sa = { type: "service_account" as const, client_email: "ci@proj.iam.gserviceaccount.com", private_key_id: "kid-123456",
      private_key: await exportPKCS8(pair.privateKey) };
    let sent = "";
    const refused = await createAccessToken(sa, vi.fn(async (_url, init) => {
      sent = new URLSearchParams(String(init.body)).get("assertion") ?? "";
      return Response.json({ error: "invalid_grant", error_description: `Invalid JWT ${sent.slice(0, 20)} kid-123456 for ci` }, { status: 400 });
    })).catch((e) => e);
    expect(refused).toMatchObject({ code: "play_token_rejected", cause_detail: { stage: "oauth_token", provider_http_status: 400 } });
    const said = refused.cause_detail.provider_message as string;
    expect(said).toContain("invalid_grant: Invalid JWT");
    expect(said).not.toContain("kid-123456");
    expect(said).not.toContain(sent.slice(0, 20));
    // Rate limits are retried, and still say what Google answered.
    const limited = await createAccessToken(credential, vi.fn(async () => Response.json({ error: "rate_limit_exceeded", error_description: "Slow down" }, { status: 429 }))).catch((e) => e);
    expect(limited).toMatchObject({ code: "play_token_unavailable", cause_detail: { provider_http_status: 429, provider_message: "rate_limit_exceeded: Slow down" } });
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
    const result = await service.verifyBinding({ credential, packageName: "build.raft.app", tracks: { internal: "internal", closed: "closed", open: "beta", production: "production" } }, { MAX_AAB_SIZE_BYTES: "209715200" });
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
