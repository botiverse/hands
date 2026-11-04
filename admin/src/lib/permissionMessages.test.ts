import { expect, it } from "vitest";
import { APP_PERMISSIONS } from "../../../worker/src/lib/app_permissions";
import { PERMISSION_ZH } from "./permissionMessages";

it("covers every server permission without changing its identifier", () => {
  expect(Object.keys(PERMISSION_ZH).sort()).toEqual([...APP_PERMISSIONS].sort());
  for (const permission of APP_PERMISSIONS) {
    expect(PERMISSION_ZH[permission].label).toMatch(/[\u4e00-\u9fff]/);
    expect(PERMISSION_ZH[permission].description).toMatch(/[\u4e00-\u9fff]/);
  }
  expect(PERMISSION_ZH["feedback:read"].description).toContain("未绑定");
  expect(PERMISSION_ZH["feedback:comment"].description).toContain("绑定报告人集成");
});
