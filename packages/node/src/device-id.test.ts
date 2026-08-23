import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getHandsDeviceId, handsDeviceIdLocation } from "./device-id.js";

describe("Hands device id", () => {
  it("uses the Hands namespace on all supported platforms", () => {
    expect(handsDeviceIdLocation({ platform: "win32", homeDir: "C:\\Users\\u" })).toBe("HKCU\\Software\\hands.build\\deviceid");
    expect(handsDeviceIdLocation({ platform: "darwin", homeDir: "/u" })).toBe("/u/Library/Application Support/hands.build/deviceid");
    expect(handsDeviceIdLocation({ platform: "linux", homeDir: "/u", env: {} })).toBe("/u/.local/state/hands.build/deviceid");
    expect(handsDeviceIdLocation({ platform: "linux", homeDir: "/u", env: { XDG_STATE_HOME: "" } })).toBe("/u/.local/state/hands.build/deviceid");
    expect(handsDeviceIdLocation({ platform: "linux", homeDir: "/u", env: { XDG_STATE_HOME: "/state" } })).toBe("/state/hands.build/deviceid");
  });

  it("uses process XDG_STATE_HOME for the real runtime default", () => {
    const previous = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = "/runtime-state";
    try {
      expect(handsDeviceIdLocation({ platform: "linux", homeDir: "/u" })).toBe("/runtime-state/hands.build/deviceid");
    } finally {
      if (previous === undefined) delete process.env.XDG_STATE_HOME;
      else process.env.XDG_STATE_HOME = previous;
    }
  });

  it("atomically reuses, resets, and rejects malformed state", async () => {
    const home = await mkdtemp(join(tmpdir(), "hands-device-"));
    try {
      const options = { platform: "linux" as const, homeDir: home, env: {} };
      const ids = await Promise.all(Array.from({ length: 12 }, () => getHandsDeviceId(options)));
      expect(new Set(ids).size).toBe(1);
      await rm(handsDeviceIdLocation(options));
      expect(await getHandsDeviceId(options)).not.toBe(ids[0]);
      await writeFile(handsDeviceIdLocation(options), "not-a-uuid\n");
      await expect(getHandsDeviceId(options)).rejects.toMatchObject({ code: "DEVICE_ID_INVALID" });
    } finally { await rm(home, { recursive: true, force: true }); }
  });
});
