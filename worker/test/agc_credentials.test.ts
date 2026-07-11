import { describe, expect, it, vi } from "vitest";
import { decryptAgcCredential, encryptAgcCredential, fingerprintAgcCredential, parseAgcCredential } from "../src/lib/agc_credentials";
import { AgcApiError, exchangeAgcApiClientToken } from "../src/lib/agc_api";

const raw = JSON.stringify({ type: "api_client", developer_id: "dev", project_id: "project", client_id: "client", client_secret: "secret", configuration_version: "1.0", region: "CN" });

describe("AGC credentials", () => {
  it("parses the real api_client shape without dropping metadata", () => {
    expect(parseAgcCredential(raw)).toMatchObject({ type: "api_client", client_id: "client", region: "CN" });
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
