import { loginUrl, type AuthAccount } from "./api";

export function dashboardHref(account?: AuthAccount): string {
  return account ? "/apps" : loginUrl("/apps");
}

export function consoleRootTarget(
  location: { hostname: string; pathname: string },
  account?: AuthAccount,
): string | null {
  if (location.hostname !== "app.hands.build" || location.pathname !== "/") return null;
  return dashboardHref(account);
}

export function defaultAppHref(
  apps: Array<{ id: string; archived?: number | boolean | null }>,
  lastAppId?: string | null,
): string | null {
  const active = apps.filter((app) => !app.archived);
  if (active.length === 0) return null;
  const target = lastAppId && active.some((app) => app.id === lastAppId)
    ? lastAppId
    : active[0]!.id;
  return `/apps/${target}`;
}

export type DefaultAppResolverState =
  | { kind: "loading" }
  | { kind: "error" }
  | { kind: "redirect"; href: string }
  | { kind: "onboarding" };

export function defaultAppResolverState(input: {
  apps?: Array<{ id: string; archived?: number | boolean | null }>;
  lastAppId?: string | null;
  isPending: boolean;
  isError: boolean;
}): DefaultAppResolverState {
  if (input.isPending) return { kind: "loading" };
  if (input.isError || !input.apps) return { kind: "error" };
  const href = defaultAppHref(input.apps, input.lastAppId);
  return href ? { kind: "redirect", href } : { kind: "onboarding" };
}
