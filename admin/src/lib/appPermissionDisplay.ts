import type {
  AppDeployToken,
  AppPermission,
  AppPermissionModel,
} from "./api";

type DeployTokenRole = Exclude<AppDeployToken["app_role"], null>;

function rolePermissions(
  model: AppPermissionModel | undefined,
  role: DeployTokenRole | null,
): AppPermission[] {
  if (!role) return [];
  return [...(model?.roles.find((entry) => entry.role === role)?.permissions ?? [])];
}

export function resolveGrantPreview(
  model: AppPermissionModel | undefined,
  role: DeployTokenRole | null,
  explicitPermissions: readonly AppPermission[],
) {
  const bundled = rolePermissions(model, role);
  const effective = [...new Set([...bundled, ...explicitPermissions])];
  const bundledSet = new Set(bundled);
  return {
    bundled,
    effective,
    extras: explicitPermissions.filter((permission) => !bundledSet.has(permission)),
  };
}

export function buildTokenGrantDisplay(
  token: Pick<
    AppDeployToken,
    "app_role" | "scopes" | "grant_valid" | "effective_permissions"
  >,
  model: AppPermissionModel | undefined,
) {
  const bundled = new Set(rolePermissions(model, token.app_role));
  const explicit = new Set(token.scopes ?? []);
  const labels = new Map(
    (model?.permissions ?? []).map((entry) => [entry.permission, entry.label]),
  );
  return {
    valid: token.grant_valid,
    roleLabel: token.app_role ? `Role · ${token.app_role}` : "Custom only",
    permissions: token.effective_permissions.map((permission) => ({
      permission,
      label: labels.get(permission) ?? permission,
      extra: explicit.has(permission) && !bundled.has(permission),
    })),
  };
}
