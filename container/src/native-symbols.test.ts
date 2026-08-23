import assert from "node:assert/strict";
import test from "node:test";
import { selectNativeSymbolCandidate } from "./native-symbols.js";

test("selects the exact BuildId when an archive contains the same soname for several ABIs", () => {
  assert.deepEqual(
    selectNativeSymbolCandidate(
      [
        { path: "symbols/armeabi-v7a/libhandscrash.so", buildId: "127cdaa1e71909f5" },
        { path: "symbols/arm64-v8a/libhandscrash.so", buildId: "54e47f291d6289f0" },
        { path: "symbols/x86_64/libhandscrash.so", buildId: "a4c82974933de559" },
      ],
      "54E47F291D6289F0",
      "libhandscrash.so",
    ),
    { ok: true, path: "symbols/arm64-v8a/libhandscrash.so" },
  );
});

test("fails closed when the crash BuildId is absent", () => {
  assert.deepEqual(
    selectNativeSymbolCandidate(
      [{ path: "symbols/arm64-v8a/libhandscrash.so", buildId: "54e47f291d6289f0" }],
      undefined,
      "libhandscrash.so",
    ),
    { ok: false, error: "missing crash BuildId (fail-closed)" },
  );
});

test("fails closed on mismatched and unreadable archive BuildIds", () => {
  assert.deepEqual(
    selectNativeSymbolCandidate(
      [{ path: "symbols/arm64-v8a/libhandscrash.so", buildId: "54e47f291d6289f0" }],
      "aaaaaaaaaaaaaaaa",
      "libhandscrash.so",
    ),
    {
      ok: false,
      error: "BuildId mismatch: crash aaaaaaaaaaaaaaaa, archive 54e47f291d6289f0",
    },
  );
  assert.deepEqual(
    selectNativeSymbolCandidate(
      [{ path: "symbols/arm64-v8a/libhandscrash.so", buildId: "" }],
      "aaaaaaaaaaaaaaaa",
      "libhandscrash.so",
    ),
    { ok: false, error: "BuildId unverifiable for libhandscrash.so (fail-closed)" },
  );
});
