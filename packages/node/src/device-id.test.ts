import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DeviceIdError, deviceIdPath, getDeviceId, resetDeviceId } from "./device-id.js";

describe("Hands device id", () => {
  it("uses the Hands namespace on all supported platforms", () => {
    expect(deviceIdPath({ platform: "win32", homeDir: "C:\\Users\\u" })).toBe("HKCU\\Software\\hands.build\\deviceid");
    expect(deviceIdPath({ platform: "darwin", homeDir: "/u" })).toBe("/u/Library/Application Support/hands.build/deviceid");
    expect(deviceIdPath({ platform: "linux", homeDir: "/u", env: {} })).toBe("/u/.local/state/hands.build/deviceid");
  });

  it("atomically reuses, resets, and rejects malformed state", async () => {
    const home = await mkdtemp(join(tmpdir(), "hands-device-"));
    try {
      const options = { platform: "linux" as const, homeDir: home, env: {} };
      const ids = await Promise.all(Array.from({ length: 12 }, () => getDeviceId(options)));
      expect(new Set(ids).size).toBe(1);
      await resetDeviceId(options);
      expect(await getDeviceId(options)).not.toBe(ids[0]);
      await writeFile(deviceIdPath(options), "not-a-uuid\n");
      await expect(getDeviceId(options)).rejects.toBeInstanceOf(DeviceIdError);
    } finally { await rm(home, { recursive: true, force: true }); }
  });
});
