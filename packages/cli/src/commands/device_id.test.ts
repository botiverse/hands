import { describe, expect, it } from "vitest";
import { deviceJson, deviceText } from "./device_id.js";
const ID = "123e4567-e89b-4d3a-a456-426614174000";
describe("device-id output", () => {
  it("uses the stable JSON contract", () => expect(deviceJson(ID)).toEqual({ device: { id: ID, scope: "os_user", namespace: "hands.build" } }));
  it("uses explicit human-readable labels", () => expect(deviceText(ID)).toBe(`device_id: ${ID}\ndevice_scope: os_user\ndevice_namespace: hands.build`));
});
