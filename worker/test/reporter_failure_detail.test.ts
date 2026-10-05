import { afterEach, describe, expect, it, vi } from "vitest";
import { generateKeyPairSync, privateDecrypt, createDecipheriv, constants } from "node:crypto";
import { readFileSync } from "node:fs";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { reporterErrorHandler, httpResponseTelemetry } from "../src/middleware/http_response_telemetry";
import { sealedReporterFailure } from "../src/lib/reporter_failure_detail";
afterEach(() => vi.restoreAllMocks());

describe("sealed reporter exception details", () => {
  it("recovers exact message and cause with the intended key while emitting no plaintext", async () => {
    const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const testKey = await crypto.subtle.importKey("spki", pair.publicKey.export({ format: "der", type: "spki" }), { name: "RSA-OAEP", hash: "SHA-256" }, false, ["encrypt"]);
    const encrypt = crypto.subtle.encrypt.bind(crypto.subtle);
    vi.spyOn(crypto.subtle, "encrypt").mockImplementation((algorithm, key, data) => encrypt(algorithm, algorithm === "RSA-OAEP" ? testKey : key, data));
    const error = new Error("D1_ERROR private-token", { cause: new Error("specific-cause private-body") });
    const sealed = await sealedReporterFailure(error);
    expect(sealed).not.toBeNull();
    expect(JSON.stringify(sealed)).not.toContain("private");
    const key = privateDecrypt({ key: pair.privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, Buffer.from(sealed!.encrypted_key, "base64"));
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(sealed!.iv, "base64"));
    decipher.setAuthTag(Buffer.from(sealed!.tag, "base64"));
    const plaintext = Buffer.concat([decipher.update(Buffer.from(sealed!.ciphertext, "base64")), decipher.final()]).toString();
    expect(JSON.parse(plaintext)).toEqual({ exceptions: [{ name: "Error", message: "D1_ERROR private-token" }, { name: "Error", message: "specific-cause private-body" }] });
    const another = await sealedReporterFailure(error);
    expect(another!.iv).not.toBe(sealed!.iv);
    expect(another!.encrypted_key).not.toBe(sealed!.encrypted_key);
  });
  it("uses the same incident recipient as the historical query", () => {
    const source = readFileSync(new URL("../src/lib/reporter_failure_detail.ts", import.meta.url), "utf8");
    const pem = readFileSync(new URL("../../scripts/monitoring/reporter-query-public.pem", import.meta.url), "utf8");
    expect(source).toContain(pem);
    expect(source).not.toContain("PRIVATE KEY");
  });
  it("suppresses crypto/access failures", async () => {
    const error = new Error("x".repeat(10000)); error.cause = error;
    vi.spyOn(crypto.subtle, "encrypt").mockRejectedValue(new Error("private-crypto-error"));
    expect(await sealedReporterFailure(error)).toBeNull();
    const getter = new Error("private"); Object.defineProperty(getter, "cause", { get: () => { throw new Error("private-access-error"); } });
    expect(await sealedReporterFailure(getter)).toBeNull();
    expect(await sealedReporterFailure("private-raw-string")).toBeNull();
  });
});


describe("reporter error boundary", () => {
  it("keeps other routes and explicit HTTP responses compatible", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const app = new Hono(); app.onError(reporterErrorHandler); app.use("*", httpResponseTelemetry);
    app.get("/api/other", () => { throw new Error("other failure"); });
    app.get("/api/apps/:appId/reporter-feedback", () => { throw new HTTPException(401, { res: new Response("denied", { status: 401, headers: { "X-Error": "retained" } }) }); });
    expect((await app.request("/api/other")).status).toBe(500);
    expect(log).toHaveBeenCalledTimes(1);
    const response = await app.request("/api/apps/app/reporter-feedback");
    expect(response.status).toBe(401); expect(await response.text()).toBe("denied"); expect(response.headers.get("X-Error")).toBe("retained");
    expect(info.mock.calls.some(call => call[0] === "hands_reporter_failure_detail")).toBe(false);
  });
  it("keeps the 500 response even if diagnostic encryption fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(crypto.subtle, "encrypt").mockRejectedValue(new Error("private-crypto-error"));
    const app = new Hono(); app.onError(reporterErrorHandler); app.use("*", httpResponseTelemetry);
    app.get("/api/apps/:appId/reporter-feedback", () => { throw new Error("private-message"); });
    const response = await app.request("/api/apps/app/reporter-feedback");
    expect(response.status).toBe(500); expect(await response.text()).toBe("Internal Server Error");
    expect(info.mock.calls.some(call => call[0] === "hands_reporter_failure_detail")).toBe(false);
    expect(JSON.stringify(info.mock.calls)).not.toContain("private");
  });
});
