import { describe, expect, it } from "vitest";
import { deviceGroupUpdatePayload } from "./deviceGroupForm";

describe("device-group form contract", () => {
  it("trims renamed groups and explicitly clears an empty description", () => {
    expect(deviceGroupUpdatePayload("  QA tablets  ", "   ")).toEqual({
      name: "QA tablets",
      description: null,
    });
    expect(deviceGroupUpdatePayload("QA phones", " physical devices ")).toEqual({
      name: "QA phones",
      description: "physical devices",
    });
  });
});
