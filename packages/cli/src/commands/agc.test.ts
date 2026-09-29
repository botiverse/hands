import { describe, expect, it } from "vitest";
import { formatSubmission, type AgcSubmission } from "./agc.js";

const base: AgcSubmission = {
  id: "sub-1", build_id: "b-1", state: "rejected", external_app_id: "a", external_version_id: "v",
  external_package_id: "p", error_message: null, provider_state: {}, created_at: 1, updated_at: 2,
};

describe("agc status output", () => {
  it("shows Huawei state, opinion and groups", () => {
    const out = formatSubmission({ ...base, provider_state: { release_state: 1, audit_opinion: "图标不合规", group_ids: ["g1"] } });
    expect(out).toContain("sub-1\trejected\tbuild b-1");
    expect(out).toContain("huawei releaseState: 1");
    expect(out).toContain("huawei opinion:     图标不合规");
    expect(out).toContain("groups:             g1");
  });
  it("surfaces errors and sync failures", () => {
    const out = formatSubmission({ ...base, state: "failed", error_message: "compile failed" }, "timeout");
    expect(out).toContain("error:              compile failed");
    expect(out).toContain("could not refresh from Huawei: timeout");
  });
});
