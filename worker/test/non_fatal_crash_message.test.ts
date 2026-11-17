import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CRASH_TYPES } from "../src/routes/feedback";
import { formatRaftNotificationMessage } from "../src/lib/raft_notification_content";

describe("non-fatal crash group notice", () => {
  it("says the group is non-fatal and not counted, and leaves fatal groups unchanged", () => {
    const base = { app: { name: "Raft Android" }, signature: "WebViewRendererGone@renderer", crash_type: "webview_renderer_gone", version_name: "1.26.0", version_code: 12600003 };
    const nonFatal = formatRaftNotificationMessage({ event: "crash:new_group", payload: { ...base, fatal: false } });
    expect(nonFatal).toContain("New non-fatal crash group");
    expect(nonFatal).toContain("Non-fatal: webview\\_renderer\\_gone · not counted as a crash");
    const fatal = formatRaftNotificationMessage({ event: "crash:new_group", payload: base });
    expect(fatal).toContain("New crash group");
    expect(fatal).not.toContain("Non-fatal");
  });
});

describe("crash_type query parameters", () => {
  it("accept every crash type the server classifies", () => {
    const schema = readFileSync(fileURLToPath(new URL("../src/openapi/feedback.ts", import.meta.url)), "utf8");
    const enums = [...schema.matchAll(/crash_type: z\.enum\(\[([^\]]*)\]\)/g)].map((m) => m[1] ?? "");
    expect(enums.length).toBeGreaterThanOrEqual(2);
    for (const list of enums) for (const type of CRASH_TYPES) expect([type, list.includes(`"${type}"`)]).toEqual([type, true]);
  });
});
