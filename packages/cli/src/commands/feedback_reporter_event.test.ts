import { describe, expect, it } from "vitest";
import { reporterEventNote } from "./feedback.js";

describe("hands feedback comment: what the reporter hears", () => {
  it("says whether the reporter's app is notified", () => {
    expect(reporterEventNote("queued")).toBe("The reporter's app is notified of this reply.");
    expect(reporterEventNote("no_reporter_channel")).toMatch(/^Note: this ticket has no channel back to the reporter/);
    expect(reporterEventNote("reporter_inactive")).toMatch(/integration is inactive/);
    expect(reporterEventNote("internal")).toBeNull();
    expect(reporterEventNote(undefined)).toBeNull();
  });
});
