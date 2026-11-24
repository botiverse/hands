import { describe, expect, it } from "vitest";
import { formatRulePreview, formatRules } from "./feedback.js";

describe("hands feedback rules output", () => {
  it("summarises a preview", () => {
    const text = formatRulePreview({ days: 14, scanned: 300, scan_limit_reached: false, matched: 12, matched_open: 3,
      by_signature: [{ signature: "SystemKill@signaled", count: 12 }],
      sample: [{ id: "8d5fcb78-44be-4991-bc8e-83fe35145a65", status: "open", signature: "SystemKill@signaled", version_name: "1.29.0", device_model: "HUAWEI P60" }] });
    expect(text.split("\n")[0]).toBe("Would match 12 of 300 crash/error tickets in the last 14 days (3 still open).");
    expect(text).toContain("     12  SystemKill@signaled");
    expect(text).toContain("8d5fcb78  open        1.29.0  HUAWEI P60  SystemKill@signaled");
  });
  it("lists rules and flags unprotected ones", () => {
    const text = formatRules([{ id: "abcdef12-0000-0000-0000-000000000000", name: "Kills", enabled: false, action: "close",
      match: { exit_statuses: [9] }, protect_high_risk: false, hits: 2, last_hit_at: null }]);
    expect(text).toContain("abcdef12  off  close  Kills");
    expect(text).toContain("(high-risk exits NOT protected)");
    expect(formatRules([])).toBe("No rules.");
  });
});
