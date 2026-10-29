import { describe, expect, it } from "vitest";
import { sameOriginAscPath } from "../src/lib/asc_api";

// Apple's `links.next` is followed with the API token attached, so only the
// App Store Connect origin itself may be followed. A prefix check would accept a
// host that merely starts with the same characters.
describe("App Store Connect pagination links", () => {
  it("follows a next link on the App Store Connect origin", () => {
    expect(sameOriginAscPath("https://api.appstoreconnect.apple.com/v1/apps/1/appStoreVersions?cursor=AB&limit=200"))
      .toBe("/v1/apps/1/appStoreVersions?cursor=AB&limit=200");
  });

  it.each([
    "https://api.appstoreconnect.apple.com.evil.example/v1/apps",
    "https://api.appstoreconnect.apple.com@evil.example/v1/apps",
    "http://api.appstoreconnect.apple.com/v1/apps",
    "https://api.appstoreconnect.apple.com:8443/v1/apps",
    "/v1/apps",
    "not a url",
  ])("refuses %s", (link) => {
    expect(sameOriginAscPath(link)).toBeNull();
  });
});
