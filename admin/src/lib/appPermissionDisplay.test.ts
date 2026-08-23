import { describe, expect, it } from "vitest";
import type { AppPermissionModel } from "./api";
import { buildTokenGrantDisplay, resolveGrantPreview } from "./appPermissionDisplay";

const model: AppPermissionModel = {
  permissions: [
    { permission: "app:read", label: "App read", description: "Read app data." },
    { permission: "app:publish", label: "Publish releases", description: "Publish releases." },
    { permission: "app:admin", label: "App administration", description: "Administer the app." },
    { permission: "feedback:write", label: "Feedback write", description: "Submit feedback." },
  ],
  roles: [
    { role: "viewer", permissions: ["app:read"] },
    { role: "publisher", permissions: ["app:read", "app:publish", "feedback:write"] },
    { role: "admin", permissions: ["app:read", "app:publish", "app:admin", "feedback:write"] },
  ],
};

describe("app permission display", () => {
  it("expands role bundles and marks only permissions outside the bundle as extra", () => {
    expect(resolveGrantPreview(model, "viewer", ["app:read", "feedback:write"])).toEqual({
      bundled: ["app:read"],
      effective: ["app:read", "feedback:write"],
      extras: ["feedback:write"],
    });
  });

  it("renders role, additive, custom-only, and invalid grants without conflating them", () => {
    expect(buildTokenGrantDisplay({
      app_role: "viewer",
      scopes: ["feedback:write"],
      grant_valid: true,
      effective_permissions: ["app:read", "feedback:write"],
    }, model)).toMatchObject({
      valid: true,
      roleLabel: "Role · viewer",
      permissions: [
        { label: "App read", extra: false },
        { label: "Feedback write", extra: true },
      ],
    });

    expect(buildTokenGrantDisplay({
      app_role: null,
      scopes: ["feedback:write"],
      grant_valid: true,
      effective_permissions: ["feedback:write"],
    }, model).roleLabel).toBe("Custom only");

    expect(buildTokenGrantDisplay({
      app_role: "viewer",
      scopes: [],
      grant_valid: false,
      effective_permissions: [],
    }, model)).toMatchObject({
      valid: false,
      permissions: [],
    });
  });
});
