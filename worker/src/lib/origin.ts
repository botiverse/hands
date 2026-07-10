import type { Context } from "hono";

export const BUSINESS_ORIGIN = "https://hands.build";
export const DASHBOARD_ORIGIN = "https://app.hands.build";

function headerScheme(c: Context<any>): string | null {
  const header = typeof c.req.header === "function" ? c.req.header.bind(c.req) : null;
  const cfVisitor = header?.("cf-visitor");
  if (cfVisitor) {
    try {
      const parsed = JSON.parse(cfVisitor) as { scheme?: unknown };
      if (parsed.scheme === "http" || parsed.scheme === "https") {
        return parsed.scheme;
      }
    } catch {
      // Ignore malformed proxy metadata and fall back to the request URL.
    }
  }
  const forwarded = header?.("x-forwarded-proto")?.split(",")[0]?.trim();
  return forwarded === "http" || forwarded === "https" ? forwarded : null;
}

function isLocalHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

function requestScheme(c: Context<any>, url: URL): string {
  return headerScheme(c) ?? url.protocol.replace(/:$/, "");
}

export function requestOrigin(c: Context<any>): string {
  const url = new URL(c.req.url);
  let scheme = requestScheme(c, url);
  if (scheme === "http" && !isLocalHost(url.hostname)) {
    scheme = "https";
  }
  return `${scheme}://${url.host}`;
}

export function isSecureRequest(c: Context<any>): boolean {
  return requestOrigin(c).startsWith("https://");
}

export function httpsRedirectUrl(c: Context<any>): string | null {
  const url = new URL(c.req.url);
  if (requestScheme(c, url) !== "http" || isLocalHost(url.hostname)) {
    return null;
  }
  url.protocol = "https:";
  return url.toString();
}

function isPublicBusinessPath(pathname: string): boolean {
  return pathname === "/health" ||
    pathname === "/openapi.json" ||
    pathname === "/api-docs" ||
    pathname === "/docs" ||
    pathname === "/docs.md" ||
    pathname.startsWith("/docs/") ||
    pathname.startsWith("/public/") ||
    pathname.startsWith("/electron/") ||
    pathname.startsWith("/share/") ||
    pathname.startsWith("/notes/") ||
    pathname.startsWith("/.well-known/") ||
    /^\/apps\/[^/]+\/history(?:\/|$)/.test(pathname);
}

function isDashboardPath(pathname: string): boolean {
  return pathname === "/apps" ||
    pathname.startsWith("/apps/") ||
    pathname === "/settings" ||
    pathname.startsWith("/settings/") ||
    pathname.startsWith("/orgs/") ||
    pathname.startsWith("/invites/") ||
    pathname === "/cli/callback";
}

export function canonicalDomainRedirectUrl(c: Context<any>): string | null {
  const method = String(c.req.method ?? "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD") return null;

  const url = new URL(c.req.url);
  if (url.hostname === "hands.build") {
    const acceptsHtml = (c.req.header?.("accept") ?? "").includes("text/html");
    if (
      (isDashboardPath(url.pathname) && !isPublicBusinessPath(url.pathname)) ||
      (url.pathname === "/api/auth/login" && acceptsHtml)
    ) {
      return `${DASHBOARD_ORIGIN}${url.pathname}${url.search}`;
    }
    return null;
  }

  if (url.hostname === "app.hands.build") {
    if (url.pathname === "/") {
      return `${DASHBOARD_ORIGIN}/apps${url.search}`;
    }
    if (isPublicBusinessPath(url.pathname)) {
      return `${BUSINESS_ORIGIN}${url.pathname}${url.search}`;
    }
  }

  return null;
}
