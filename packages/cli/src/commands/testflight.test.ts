import { describe, expect, it } from "vitest";
import { formatCrashTable } from "./testflight.js";

describe("testflight crashes output", () => {
  it("renders build label, device, comment and saved path", () => {
    const out = formatCrashTable(
      [
        {
          id: "crash-1",
          created_at: "2026-09-27T19:00:00Z",
          asc_build_id: "b",
          build_number: "11200001",
          version: "1.12.0",
          device_model: "iPhone16,1",
          os_version: "26.0",
          architecture: null,
          locale: null,
          connection_type: null,
          battery_percentage: null,
          app_uptime_ms: null,
          comment: "crashed on open",
        },
      ],
      { "crash-1": "./testflight-crash-crash-1.ips" },
    );
    expect(out).toContain("1.12.0 (11200001)");
    expect(out).toContain("iPhone16,1\tiOS 26.0\tcrash-1");
    expect(out).toContain("comment: crashed on open");
    expect(out).toContain("saved:   ./testflight-crash-crash-1.ips");
    expect(formatCrashTable([])).toBe("No TestFlight crash submissions.");
  });
});
