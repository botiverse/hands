/**
 * Range support on the Electron download route.
 *
 * electron-updater downloads only the blocks whose checksums changed by sending
 * `Range`. Without a 206 it re-downloads the whole installer (157 MB on macOS
 * instead of ~27 MB). These tests pin both the header contract and that the
 * bytes actually returned are the requested slice — a 206 whose body is the
 * whole object would corrupt the client's block assembly while looking correct
 * in a status-only assertion.
 */
import { describe, expect, it } from "vitest";
import { parseSingleByteRange } from "../src/routes/electron";

const SIZE = 1000;

describe("parseSingleByteRange", () => {
  it("returns null when there is no Range header", () => {
    expect(parseSingleByteRange(undefined, SIZE)).toBeNull();
    expect(parseSingleByteRange("", SIZE)).toBeNull();
  });

  it("honours a closed range", () => {
    expect(parseSingleByteRange("bytes=0-99", SIZE)).toEqual({ start: 0, length: 100 });
    expect(parseSingleByteRange("bytes=100-199", SIZE)).toEqual({ start: 100, length: 100 });
  });

  it("runs to the end for an open range", () => {
    expect(parseSingleByteRange("bytes=900-", SIZE)).toEqual({ start: 900, length: 100 });
  });

  it("reads a suffix range as the final N bytes", () => {
    expect(parseSingleByteRange("bytes=-100", SIZE)).toEqual({ start: 900, length: 100 });
    // A suffix longer than the object means the whole object.
    expect(parseSingleByteRange("bytes=-5000", SIZE)).toEqual({ start: 0, length: 1000 });
  });

  it("clamps an end past the object rather than rejecting it", () => {
    expect(parseSingleByteRange("bytes=990-99999", SIZE)).toEqual({ start: 990, length: 10 });
  });

  it("reports an unsatisfiable range only when it is syntactically understood", () => {
    expect(parseSingleByteRange("bytes=1000-1099", SIZE)).toBe("unsatisfiable");
    expect(parseSingleByteRange("bytes=5000-", SIZE)).toBe("unsatisfiable");
    expect(parseSingleByteRange("bytes=-0", SIZE)).toBe("unsatisfiable");
  });

  it("falls back to the full object for multi-interval and unknown units", () => {
    // Multi-interval would need multipart/byteranges to be correct; serving a single
    // slice as if it were the answer would be wrong, so this must not produce a range.
    expect(parseSingleByteRange("bytes=0-99,200-299", SIZE)).toBeNull();
    expect(parseSingleByteRange("items=0-99", SIZE)).toBeNull();
    expect(parseSingleByteRange("bytes=abc", SIZE)).toBeNull();
    expect(parseSingleByteRange("bytes=99-0", SIZE)).toBeNull();
  });
});
