import { describe, expect, it } from "vitest";
import { upstreamFromBody, upstreamLine } from "./upstream.js";

describe("upstream line", () => {
  it("names the service and keeps the text on one bounded line", () => {
    expect(upstreamLine({ service: "google_oauth", http_status: 400, message: "invalid_grant / invalid_rapt:\nreauth related error" }))
      .toBe("Google sign-in said (HTTP 400): invalid_grant / invalid_rapt: reauth related error");
    expect(upstreamLine({ service: "something_new", message: "x".repeat(500) })).toBe(`The upstream service said: ${"x".repeat(300)}`);
    expect(upstreamLine({ service: "google_play", message: " " })).toBeNull();
    expect(upstreamLine("text")).toBeNull();
  });

  it("finds upstream at the top level or under error", () => {
    const upstream = { service: "google_play", message: "no" };
    expect(upstreamFromBody({ upstream })).toBe(upstream);
    expect(upstreamFromBody({ error: { code: "play_api_error", upstream } })).toBe(upstream);
    expect(upstreamFromBody({ error: "plain" })).toBeUndefined();
    expect(upstreamFromBody("html")).toBeUndefined();
  });
});
