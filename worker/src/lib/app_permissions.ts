export type AppRole = "admin" | "publisher" | "viewer";

export const APP_PERMISSIONS = [
  "app:read",
  "app:publish",
  "app:admin",
  "feedback:write",
  "feedback:read",
  "feedback:comment",
  "feedback:route",
  "feedback:triage",
] as const;

export type AppPermission = (typeof APP_PERMISSIONS)[number];

export const APP_PERMISSION_LABELS: Record<AppPermission, string> = {
  "app:read": "App read",
  "app:publish": "Publish releases",
  "app:admin": "App administration",
  "feedback:write": "Feedback write",
  "feedback:read": "Reporter feedback read",
  "feedback:comment": "Reporter feedback comment",
  "feedback:route": "Reporter route binding",
  "feedback:triage": "Feedback triage",
};

export const APP_PERMISSION_DESCRIPTIONS: Record<AppPermission, string> = {
  "app:read": "Read app data, builds, releases, feedback, and analytics.",
  "app:publish": "Create and publish builds, releases, and distribution assets.",
  "app:admin": "Manage app settings, members, credentials, and destructive operations.",
  "feedback:write": "Submit feedback tickets for this app.",
  "feedback:read": "Read feedback tickets. A token bound to a reporter integration sees only that integration's tickets; an unbound token sees the app's.",
  "feedback:comment": "Post a public reply the reporter sees, and — for a token bound to a reporter integration — close that reporter's own ticket. Scope follows the token's binding.",
  "feedback:route": "Bind an opaque route subject to a reporter integration.",
  "feedback:triage": "Change ticket status and assignee, and write internal notes.",
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

export const APP_PERMISSION_MINIMUM_ROLE: Partial<Record<AppPermission, AppRole>> = {
  "app:read": "viewer",
  "app:publish": "publisher",
  "app:admin": "admin",
  "feedback:write": "publisher",
  "feedback:triage": "publisher",
};

export const FEEDBACK_TOKEN_PERMISSIONS = [
  "feedback:write",
  "feedback:read",
  "feedback:comment",
  "feedback:route",
] as const satisfies readonly AppPermission[];

/**
 * Feedback permissions that only make sense for a reporter-integration proxy,
 * and so require the token to be bound to one: submitting on a user's behalf,
 * and binding a route subject.
 *
 * The rest — read, comment, triage — are also used by console-side service
 * tokens, which are deliberately unbound. Scope there comes from the binding's
 * absence, not from the permission name.
 */
export const REPORTER_BOUND_ONLY_PERMISSIONS = [
  "feedback:write",
  "feedback:route",
] as const satisfies readonly AppPermission[];

export function requiresReporterBinding(scope: AppPermission): boolean {
  return (REPORTER_BOUND_ONLY_PERMISSIONS as readonly AppPermission[]).includes(scope);
}

export type FeedbackTokenPermission = (typeof FEEDBACK_TOKEN_PERMISSIONS)[number];

export function isFeedbackTokenPermission(value: unknown): value is FeedbackTokenPermission {
  return typeof value === "string"
    && (FEEDBACK_TOKEN_PERMISSIONS as readonly string[]).includes(value);
}

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
