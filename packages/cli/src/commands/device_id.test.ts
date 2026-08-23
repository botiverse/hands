import { describe, expect, it } from "vitest";
import { Command } from "commander";
import { deviceJson, deviceText, jsonRequested, registerDeviceIdCommand } from "./device_id.js";
const ID = "123e4567-e89b-4d3a-a456-426614174000";
describe("device-id output", () => {
  it("uses the stable JSON contract", () => expect(deviceJson(ID)).toEqual({ device: { id: ID, scope: "os_user", namespace: "hands.build" } }));
  it("uses explicit human-readable labels", () => expect(deviceText(ID)).toBe(`device_id: ${ID}\ndevice_scope: os_user\ndevice_namespace: hands.build`));

  it("honors --json on the real root argv path", async () => {
    const output: string[] = [];
    const write = console.log;
    console.log = (value?: unknown) => output.push(String(value));
    try {
      const root = new Command().option("--json", "Output machine-readable JSON", false);
      registerDeviceIdCommand(root);
      const device = root.commands[0];
      expect(jsonRequested(device, device.opts())).toBe(false);
      await root.parseAsync(["node", "hands", "--json", "device-id"]);
      expect(JSON.parse(output.at(-1)!)).toEqual({
        device: { id: expect.any(String), scope: "os_user", namespace: "hands.build" },
      });
    } finally {
      console.log = write;
    }
  });
});
