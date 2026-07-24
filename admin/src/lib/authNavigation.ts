import { loginUrl, type AuthAccount } from "./api";

export function dashboardHref(account?: AuthAccount): string {
  return account ? "/apps" : loginUrl("/apps");
}

export function consoleRootTarget(
  location: { hostname: string; pathname: string },
  account?: AuthAccount,
  confirmedUnauthorized = false,
): string | null {
  if (location.hostname !== "app.hands.build" || location.pathname !== "/") return null;
  if (account) return dashboardHref(account);
  return confirmedUnauthorized ? dashboardHref() : null;
}

export type ConsoleRootAuthState =
  | { kind: "not-console-root" }
  | { kind: "loading" }
  | { kind: "redirect"; href: string }
  | { kind: "error" };

export function consoleRootAuthState(input: {
  location: { hostname: string; pathname: string };
  account?: AuthAccount | undefined;
  isPending: boolean;
  errorStatus?: number | undefined;
}): ConsoleRootAuthState {
  const isConsoleRoot = input.location.hostname === "app.hands.build"
    && input.location.pathname === "/";
  if (!isConsoleRoot) return { kind: "not-console-root" };
  if (input.isPending) return { kind: "loading" };
  const href = consoleRootTarget(input.location, input.account, input.errorStatus === 401);
  return href ? { kind: "redirect", href } : { kind: "error" };
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
  apps?: Array<{ id: string; archived?: number | boolean | null }> | undefined;
  lastAppId?: string | null;
  isPending: boolean;
  isError: boolean;
}): DefaultAppResolverState {
  if (input.isPending) return { kind: "loading" };
  if (input.isError || !input.apps) return { kind: "error" };
  const href = defaultAppHref(input.apps, input.lastAppId);
  return href ? { kind: "redirect", href } : { kind: "onboarding" };
}
