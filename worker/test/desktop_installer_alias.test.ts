/**
 * `electron-installer` was renamed `desktop-installer` once a non-Electron desktop
 * target existed. The rename is safe only if BOTH names keep resolving: every release
 * already in the database carries the old name, and any client in the field asks for it.
 * These tests pin that equivalence at the resolver, which is the single place every
 * public surface goes through.
 */
import { describe, expect, it } from "vitest";
import {
  DESKTOP_INSTALLER,
  LEGACY_ELECTRON_INSTALLER,
  equivalentsOf,
} from "../src/lib/release_resolver";

describe("desktop installer product_type equivalence", () => {
  it("treats both names as the same product, whichever is asked for", () => {
    expect(equivalentsOf(DESKTOP_INSTALLER)).toEqual([DESKTOP_INSTALLER, LEGACY_ELECTRON_INSTALLER]);
    expect(equivalentsOf(LEGACY_ELECTRON_INSTALLER)).toEqual([DESKTOP_INSTALLER, LEGACY_ELECTRON_INSTALLER]);
  });

  it("leaves every other product type alone", () => {
    // A generic passthrough, not a wildcard: android-apk must not start matching
    // desktop releases merely because equivalence exists for one family.
    expect(equivalentsOf("android-apk")).toEqual(["android-apk"]);
    expect(equivalentsOf("ios-ipa")).toEqual(["ios-ipa"]);
    expect(equivalentsOf("cli-binary")).toEqual(["cli-binary"]);
  });

  it("treats a missing product type as no filter rather than as a name", () => {
    expect(equivalentsOf(null)).toEqual([]);
    expect(equivalentsOf(undefined)).toEqual([]);
    expect(equivalentsOf("")).toEqual([]);
  });
});
