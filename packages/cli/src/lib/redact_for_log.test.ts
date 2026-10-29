import { redactForLog } from "./redact_for_log.js";
import { describe, expect, it } from "vitest";

describe("redaction of a non-JSON 5xx body", () => {
  it("keeps the part that identifies a Cloudflare error page", () => {
    const html = "<html><head><title>503 Service Temporarily Unavailable</title></head><body>cloudflare</body></html>";
    const out = redactForLog(html);
    expect(out).toContain("cloudflare");
    expect(out).toContain("503");
  });

  it("strips a signed URL's query string, which is the credential", () => {
    const text = "failed: https://abc.r2.cloudflarestorage.com/bucket/key?X-Amz-Signature=deadbeef&X-Amz-Credential=AKIA";
    const out = redactForLog(text);
    expect(out).not.toContain("deadbeef");
    expect(out).not.toContain("X-Amz-Credential");
    expect(out).toContain("https://abc.r2.cloudflarestorage.com/bucket/key?<redacted>");
  });

  it("strips bearer-like tokens and long hex", () => {
    const out = redactForLog("token=abcdef123456 secret: hunter2 0f1e2d3c4b5a69788796a5b4c3d2e1f0");
    expect(out).not.toContain("abcdef123456");
    expect(out).not.toContain("hunter2");
    expect(out).not.toContain("0f1e2d3c4b5a69788796a5b4c3d2e1f0");
  });

  it("bounds what is printed by slicing after redaction, not before", () => {
    // Slicing first could cut a secret in half and leave the redaction unable to match it.
    const text = "x".repeat(400) + " https://h/p?token=SUPERSECRET";
    const printed = redactForLog(text).slice(0, 500);
    expect(printed).not.toContain("SUPERSECRET");
  });
});

describe("redaction covers a Bearer header echoed into the body", () => {
  it("strips a bare Bearer token", () => {
    const out = redactForLog("upstream said: Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig");
    expect(out).not.toContain("eyJhbGciOiJIUzI1NiJ9");
    expect(out).toContain("Bearer <redacted>");
  });

  it("strips the authorization key/value form", () => {
    expect(redactForLog('authorization="xyz123"')).not.toContain("xyz123");
    expect(redactForLog("authorization: xyz123")).not.toContain("xyz123");
  });
});
