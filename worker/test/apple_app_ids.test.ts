import { describe, expect, it } from "vitest";
import { capabilitiesFor, validBundleId } from "../src/lib/apple_app_ids";

describe("capabilities from entitlements", () => {
  it("maps Deck's entitlements to Associated Domains and push, nothing else", () => {
    const out = capabilitiesFor({
      "com.apple.developer.associated-domains": ["applinks:deck.raft.build", "webcredentials:deck.raft.build"],
      "aps-environment": "development",
      "keychain-access-groups": ["$(AppIdentifierPrefix)build.raft.deck"],
      "get-task-allow": true,
    });
    expect(out.needs).toEqual([
      { capability: "PUSH_NOTIFICATIONS", entitlements: ["aps-environment"] },
      { capability: "ASSOCIATED_DOMAINS", entitlements: ["com.apple.developer.associated-domains"] },
    ]);
    expect(out.manual).toEqual([]);
    expect(out.unknown_entitlements).toEqual([]);
  });

  it("returns manual steps for objects the API cannot assign, settings where Apple needs them, and unknown keys", () => {
    const out = capabilitiesFor({
      "com.apple.security.application-groups": ["group.build.raft.deck"],
      "com.apple.developer.icloud-container-identifiers": ["iCloud.build.raft.deck"],
      "com.apple.developer.icloud-services": ["CloudKit"],
      "com.apple.developer.applesignin": ["Default"],
      "com.apple.developer.default-data-protection": "NSFileProtectionComplete",
      "com.apple.developer.healthkit": false,
      "com.example.private": true,
    });
    const caps = Object.fromEntries(out.needs.map((n) => [n.capability, n]));
    expect(Object.keys(caps).sort()).toEqual(["APPLE_ID_AUTH", "APP_GROUPS", "DATA_PROTECTION", "ICLOUD"]);
    expect(caps.ICLOUD!.entitlements).toEqual(["com.apple.developer.icloud-container-identifiers", "com.apple.developer.icloud-services"]);
    expect(caps.ICLOUD!.settings).toEqual([{ key: "ICLOUD_VERSION", options: [{ key: "XCODE_6" }] }]);
    expect(caps.DATA_PROTECTION!.settings).toEqual([{ key: "DATA_PROTECTION_PERMISSION_LEVEL", options: [{ key: "COMPLETE_PROTECTION" }] }]);
    expect(caps.APPLE_ID_AUTH!.settings).toEqual([{ key: "APPLE_ID_AUTH_APP_CONSENT", options: [{ key: "PRIMARY_APP_CONSENT" }] }]);
    expect(out.manual.map((m) => [m.capability, m.values])).toEqual([
      ["ICLOUD", ["iCloud.build.raft.deck"]],
      ["APP_GROUPS", ["group.build.raft.deck"]],
    ]);
    expect(out.unknown_entitlements).toEqual(["com.example.private"]);
  });

  it("accepts explicit bundle IDs only", () => {
    expect(validBundleId("build.raft.deck")).toBe(true);
    expect(validBundleId("build.raft.*")).toBe(false);
    expect(validBundleId("deck")).toBe(false);
    expect(validBundleId("build..deck")).toBe(false);
    expect(validBundleId(42)).toBe(false);
  });
});
