export type AppRole = "admin" | "publisher" | "viewer";

export const APP_PERMISSIONS = [
  "app:read",
  "app:publish",
  "app:admin",
  "feedback:write",
] as const;

export type AppPermission = (typeof APP_PERMISSIONS)[number];

export const APP_PERMISSION_LABELS: Record<AppPermission, string> = {
  "app:read": "App read",
  "app:publish": "Publish releases",
  "app:admin": "App administration",
  "feedback:write": "Feedback write",
};

export const APP_PERMISSION_DESCRIPTIONS: Record<AppPermission, string> = {
  "app:read": "Read app data, builds, releases, feedback, and analytics.",
  "app:publish": "Create and publish builds, releases, and distribution assets.",
  "app:admin": "Manage app settings, members, credentials, and destructive operations.",
  "feedback:write": "Submit feedback tickets for this app.",
};

export const APP_ROLE_PERMISSIONS: Record<AppRole, readonly AppPermission[]> = {
  viewer: ["app:read"],
  publisher: ["app:read", "app:publish", "feedback:write"],
  admin: ["app:read", "app:publish", "app:admin", "feedback:write"],
};

export const APP_ROLE_REQUIRED_PERMISSION: Record<AppRole, AppPermission> = {
  viewer: "app:read",
  publisher: "app:publish",
  admin: "app:admin",
};

export const APP_PERMISSION_MINIMUM_ROLE: Record<AppPermission, AppRole> = {
  "app:read": "viewer",
  "app:publish": "publisher",
  "app:admin": "admin",
  "feedback:write": "publisher",
};

const APP_ROLE_PRIORITY: Record<AppRole, number> = {
  viewer: 1,
  publisher: 2,
  admin: 3,
};

export function isAppRole(value: unknown): value is AppRole {
  return value === "admin" || value === "publisher" || value === "viewer";
}

export function isAppPermission(value: unknown): value is AppPermission {
  return typeof value === "string" && (APP_PERMISSIONS as readonly string[]).includes(value);
}

export function permissionsForAppRole(role: AppRole): ReadonlySet<AppPermission> {
  return new Set(APP_ROLE_PERMISSIONS[role]);
}

export function isAppAtLeast(role: AppRole | null | undefined, minimum: AppRole): boolean {
  if (!role) return false;
  return permissionsForAppRole(role).has(APP_ROLE_REQUIRED_PERMISSION[minimum]);
}

export function strongestAppRole(roles: readonly AppRole[]): AppRole | null {
  return [...roles].sort((left, right) => APP_ROLE_PRIORITY[right] - APP_ROLE_PRIORITY[left])[0] ?? null;
}
