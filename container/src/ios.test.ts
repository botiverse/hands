import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
  EntitlementError,
  appStoreEntitlements,
  parseBinaryPlist,
  parsePlist,
  parseXmlPlist,
  profileCoversBundle,
  profileInfo,
  toXmlPlist,
  type PlistDict,
} from "./ios.js";

// Written by Python's plistlib (FMT_BINARY), as Xcode writes Info.plist.
const BINARY_INFO = "YnBsaXN0MDDaAQIDBAUGBwgJCgsMDQ4PEBESExhTQmlnXxASQ0ZCdW5kbGVJZGVudGlmaWVyXxAaQ0ZCdW5kbGVTaG9ydFZlcnNpb25TdHJpbmdfEA9DRkJ1bmRsZVZlcnNpb25RRFFGXxASTFNSZXF1aXJlc0lQaG9uZU9TU05lZ1ZOZXN0ZWReVUlEZXZpY2VGYW1pbHkTAAABAAAAAABfEA9idWlsZC5yYWZ0LmRlY2tVMS4yLjBSNDIzQctGxlKAAAAjP/gAAAAAAAAJE//////////90hQVFhdRa2EA/FF2YmXlZyyiGRoQARACCB0hNlNlZ2l+gomYobO5vMXOz9jd3+Lk6ezuAAAAAAAAAQEAAAAAAAAAGwAAAAAAAAAAAAAAAAAAAPA=";

const sha = (der: Uint8Array) => createHash("sha256").update(der).digest("hex");
const CERT = Buffer.from("distribution-certificate-der");

function profilePlist(entitlements: PlistDict, extra: PlistDict = {}) {
  return toXmlPlist({
    Name: "Deck App Store",
    UUID: "11111111-2222-3333-4444-555555555555",
    TeamIdentifier: ["XDAPXFY8FZ"],
    ExpirationDate: new Date("2027-11-20T00:00:00Z"),
    DeveloperCertificates: [Uint8Array.from(CERT)],
    Entitlements: { "application-identifier": "XDAPXFY8FZ.build.raft.deck", "beta-reports-active": true, "get-task-allow": false, ...entitlements },
    ...extra,
  });
}

test("reads a binary Info.plist", () => {
  const info = parseBinaryPlist(Buffer.from(BINARY_INFO, "base64")) as PlistDict;
  assert.equal(info.CFBundleIdentifier, "build.raft.deck");
  assert.equal(info.CFBundleShortVersionString, "1.2.0");
  assert.equal(info.CFBundleVersion, "42");
  assert.deepEqual(info.UIDeviceFamily, [1, 2]);
  assert.equal(info.LSRequiresIPhoneOS, true);
  assert.deepEqual(info.Nested, { k: "v", "ü": "日本" });
  assert.equal(info.Big, 2 ** 40);
  assert.equal(info.Neg, -3);
  assert.equal(info.F, 1.5);
  assert.equal((info.D as Date).toISOString(), "2030-01-02T03:04:05.000Z");
  assert.throws(() => parseBinaryPlist(Buffer.from("bplist00 too short")));
});

test("round-trips XML property lists, keeping whitespace in strings", () => {
  const value = { a: " spaced  text ", b: ["x", true, false, 3, 1.25], c: { "<k>": "a & b" }, d: Uint8Array.from([1, 2, 3]), e: "" };
  const parsed = parseXmlPlist(toXmlPlist(value)) as PlistDict;
  assert.equal(parsed.a, " spaced  text ");
  assert.deepEqual(parsed.b, ["x", true, false, 3, 1.25]);
  assert.deepEqual(parsed.c, { "<k>": "a & b" });
  assert.deepEqual(Array.from(parsed.d as Uint8Array), [1, 2, 3]);
  assert.equal(parsed.e, "");
  assert.equal((parsePlist(Buffer.from("<plist><dict><key>k</key><string/></dict></plist>")) as PlistDict).k, "");
  assert.throws(() => parseXmlPlist("<plist><dict><string>no key</string></dict></plist>"));
});

test("reads a profile and checks which bundles it covers", () => {
  const info = profileInfo(parseXmlPlist(profilePlist({})), sha);
  assert.equal(info.team_id, "XDAPXFY8FZ");
  assert.deepEqual(info.certificate_sha256, [sha(CERT)]);
  assert.equal(info.devices, 0);
  assert.equal(profileCoversBundle(info, "build.raft.deck"), true);
  assert.equal(profileCoversBundle(info, "build.raft.deck.widget"), false);
  const wildcard = profileInfo(parseXmlPlist(profilePlist({ "application-identifier": "XDAPXFY8FZ.build.raft.*" })), sha);
  assert.equal(profileCoversBundle(wildcard, "build.raft.deck"), true);
  assert.equal(profileCoversBundle(wildcard, "build.other"), false);
});

test("signs with what the app asks for, only if the profile allows it", () => {
  const profile = profileInfo(parseXmlPlist(profilePlist({
    "com.apple.developer.associated-domains": "*",
    "keychain-access-groups": ["XDAPXFY8FZ.*"],
    "aps-environment": "production",
  })), sha);
  const out = appStoreEntitlements(profile, "build.raft.deck", {
    "com.apple.developer.associated-domains": ["applinks:app.raft.build"],
    "keychain-access-groups": ["$(AppIdentifierPrefix)build.raft.deck"],
    "aps-environment": "development",
    "get-task-allow": true,
  });
  assert.deepEqual(out, {
    "com.apple.developer.associated-domains": ["applinks:app.raft.build"],
    "keychain-access-groups": ["XDAPXFY8FZ.build.raft.deck"],
    "aps-environment": "production",
    "application-identifier": "XDAPXFY8FZ.build.raft.deck",
    "com.apple.developer.team-identifier": "XDAPXFY8FZ",
    "get-task-allow": false,
    "beta-reports-active": true,
  });
  assert.throws(
    () => appStoreEntitlements(profile, "build.raft.deck", { "com.apple.developer.icloud-services": ["CloudKit"] }),
    (e: Error) => e instanceof EntitlementError && /icloud-services/.test(e.message),
  );
  const dev = profileInfo(parseXmlPlist(profilePlist({ "get-task-allow": true })), sha);
  assert.throws(() => appStoreEntitlements(dev, "build.raft.deck", {}), /development profile/);
  const adhoc = profileInfo(parseXmlPlist(profilePlist({}, { ProvisionedDevices: ["00008110-0001"] })), sha);
  assert.throws(() => appStoreEntitlements(adhoc, "build.raft.deck", {}), /ad hoc/);
});
