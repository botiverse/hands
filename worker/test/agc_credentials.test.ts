import { describe, expect, it, vi } from "vitest";
import { decryptAgcCredential, encryptAgcCredential, fingerprintAgcCredential, parseAgcCredential } from "../src/lib/agc_credentials";
import { AgcApiError, addAgcTestPackage, bindAgcTestPackage, createAgcInvitationVersion, exchangeAgcApiClientToken, getAgcCompileStatus, requestAgcUpload, resolveAgcAppId, submitAgcTestVersion } from "../src/lib/agc_api";

const raw = JSON.stringify({ type: "api_client", developer_id: "dev", project_id: "project", client_id: "client", client_secret: "secret", configuration_version: "1.0", region: "CN" });

describe("AGC credentials", () => {
  it("parses the real api_client shape without dropping metadata", () => {
    expect(parseAgcCredential(raw)).toMatchObject({ type: "api_client", client_id: "client", region: "CN" });
  });
  it("accepts Huawei's project_client_id discriminator", () => {
    expect(parseAgcCredential(raw.replace("api_client", "project_client_id"))).toMatchObject({
      type: "project_client_id",
      client_id: "client",
    });
  });
  it("rejects malformed and unsupported credentials", () => {
    expect(() => parseAgcCredential("not json")).toThrow(/valid JSON/);
    expect(() => parseAgcCredential({ type: "service_account" })).toThrow(/unsupported/);
    expect(() => parseAgcCredential({ type: "api_client" })).toThrow(/developer_id/);
  });
  it("encrypts, decrypts, fingerprints, and uses fresh IVs", async () => {
    const a = await encryptAgcCredential(raw, "root-secret");
    const b = await encryptAgcCredential(raw, "root-secret");
    expect(a.iv_b64).not.toBe(b.iv_b64);
    expect(await decryptAgcCredential(a.ciphertext_b64, a.iv_b64, "root-secret")).toBe(raw);
    expect(await fingerprintAgcCredential(raw)).toMatch(/^[a-f0-9]{64}$/);
    await expect(decryptAgcCredential(a.ciphertext_b64, a.iv_b64, "wrong")).rejects.toThrow();
    await expect(encryptAgcCredential(raw, "")).rejects.toThrow(/AGC_CRED_ENC_KEY/);
  });
});

describe("AGC invitation testing API", () => {
  const auth = { clientId: "client", accessToken: "token" };
  it("resolves the app id and creates an invitation version", async () => {
    const responses = [
      { ret: { code: 0 }, appids: [{ key: "build.raft.mobile", value: "agc-app" }] },
      { ret: { code: 0 }, versionId: "version-1" },
    ];
    const requests: RequestInit[] = [];
    const mockFetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => { requests.push(init ?? {}); return new Response(JSON.stringify(responses.shift()), { status: 200 }); });
    expect(await resolveAgcAppId(auth, "build.raft.mobile", mockFetch as typeof fetch)).toBe("agc-app");
    expect(await createAgcInvitationVersion(auth, "agc-app", "Internal test", false, mockFetch as typeof fetch)).toBe("version-1");
    expect(requests[1]?.body).toContain('"testType":3');
  });
  it("requests upload metadata and registers the uploaded package", async () => {
    const responses = [
      { ret: { code: 0 }, urlInfo: { objectId: "CN/object.app", url: "https://upload.example/object", method: "PUT", headers: { Authorization: "signed" } } },
      { ret: { code: 0 }, pkgVersion: ["pkg-1"] },
    ];
    const mockFetch = vi.fn(async () => new Response(JSON.stringify(responses.shift()), { status: 200 }));
    const upload = await requestAgcUpload(auth, "agc-app", "raft.app", "abc", 42, mockFetch as typeof fetch);
    expect(upload.objectId).toBe("CN/object.app");
    expect(await addAgcTestPackage(auth, "agc-app", "raft.app", upload.objectId, mockFetch as typeof fetch)).toBe("pkg-1");
  });
  it("polls compilation, binds, then submits through separate calls", async () => {
    const responses = [
      { ret: { code: 0 }, pkgStateList: [{ pkgId: "pkg-1", successStatus: 0 }] },
      { ret: { code: 0 } },
      { ret: { code: 0 } },
    ];
    const methods: Array<string | undefined> = [];
    const mockFetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => { methods.push(init?.method); return new Response(JSON.stringify(responses.shift()), { status: 200 }); });
    expect(await getAgcCompileStatus(auth, "agc-app", "pkg-1", mockFetch as typeof fetch)).toMatchObject({ successStatus: 0 });
    await bindAgcTestPackage(auth, "agc-app", "version-1", "pkg-1", mockFetch as typeof fetch);
    await submitAgcTestVersion(auth, "agc-app", "version-1", mockFetch as typeof fetch);
    expect(methods[1]).toBe("PUT");
    expect(methods[2]).toBe("POST");
  });
  it("rejects provider business errors even on HTTP 200", async () => {
    const mockFetch = vi.fn(async () => new Response(JSON.stringify({ ret: { code: 204144688, msg: "invalid package" } }), { status: 200 }));
    await expect(resolveAgcAppId(auth, "build.raft.mobile", mockFetch as typeof fetch)).rejects.toThrow("invalid package (HTTP 200, code 204144688)");
  });
});

describe("AGC token exchange", () => {
  const credential = parseAgcCredential(raw);
  it("returns the token internally and expiry on success", async () => {
    let requestBody = "";
    const mockFetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestBody = String(init?.body ?? "");
      return new Response(JSON.stringify({ access_token: "token", expires_in: 172799 }), { status: 200, headers: { "content-type": "application/json" } });
    });
    await expect(exchangeAgcApiClientToken(credential, mockFetch as typeof fetch)).resolves.toEqual({ access_token: "token", expires_in: 172799 });
    expect(JSON.parse(requestBody)).toEqual({ client_id: "client", client_secret: "secret", grant_type: "client_credentials" });
  });
  it("redacts provider errors", async () => {
    const mockFetch = vi.fn(async () => new Response(JSON.stringify({ error: "contains provider details" }), { status: 401 }));
    await expect(exchangeAgcApiClientToken(credential, mockFetch as typeof fetch)).rejects.toEqual(expect.objectContaining<Partial<AgcApiError>>({ status: 401, message: "AGC rejected the API client credentials" }));
  });
  it("rejects malformed success responses", async () => {
    const mockFetch = vi.fn(async () => new Response(JSON.stringify({ expires_in: 10 }), { status: 200 }));
    await expect(exchangeAgcApiClientToken(credential, mockFetch as typeof fetch)).rejects.toThrow(/malformed/);
  });
});
