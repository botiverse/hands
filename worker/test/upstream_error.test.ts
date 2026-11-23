import { describe, expect, it } from "vitest";
import { redactUpstreamText, upstreamDetail, upstreamFromPlayCause, withPlayUpstream } from "../src/lib/upstream_error";

describe("upstream error relay", () => {
  it("redacts credential shapes and bounds the text", () => {
    const out = redactUpstreamText(`Bearer ya29.a0AfB_x for me@corp.example, refresh 1//0gAbC, jwt eyJhbGciOi.eyJzdWIi.sig, key ${"Z".repeat(40)}\u0007 ${"x".repeat(400)}`);
    for (const secret of ["ya29.", "me@corp.example", "1//0g", "eyJhbGci", "ZZZZZZZZ", "\u0007"]) expect(out).not.toContain(secret);
    expect(out.length).toBeLessThanOrEqual(300);
    expect(redactUpstreamText("Package build.raft.app versionCode 12800012 on track production")).toBe("Package build.raft.app versionCode 12800012 on track production");
  });

  it("names the service from the adapter's stage and drops empty or odd values", () => {
    expect(upstreamFromPlayCause({ stage: "oauth_token", provider_message: "invalid_grant", provider_http_status: 400 }))
      .toEqual({ service: "google_oauth", http_status: 400, message: "invalid_grant" });
    expect(upstreamFromPlayCause({ stage: "reports_storage", provider_message: "denied" })).toEqual({ service: "google_cloud_storage", message: "denied" });
    expect(upstreamFromPlayCause({ stage: "commit_edit", provider_message: "nope", provider_http_status: 99 })).toEqual({ service: "google_play", message: "nope" });
    expect(upstreamFromPlayCause({ stage: "commit_edit", provider_message: "   " })).toBeUndefined();
    expect(upstreamFromPlayCause(null)).toBeUndefined();
    expect(upstreamDetail("google_play", 42)).toBeUndefined();
    expect(withPlayUpstream({ cause: { provider_message: "x" } })).toEqual({ upstream: { service: "google_play", message: "x" } });
    expect(withPlayUpstream(undefined)).toEqual({});
  });
});
