import type { Context, MiddlewareHandler } from "hono";

export const INSTALLER_CLIENT_ID = "hands-installer";
export const INSTALLER_ACCESS_TTL_MS = 15 * 60 * 1000;
export const INSTALLER_REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export type InstallerAccount = {
  id: string;
  provider_subject: string;
  server_id: string;
  principal_type: "human" | "agent";
  display_name: string;
};

export type InstallerVariables = {
  installer_account: InstallerAccount;
  installer_client_id: string;
  installer_token_id: string;
};

export function randomOpaqueToken(bytes = 32): string {
  const data = new Uint8Array(bytes);
  crypto.getRandomValues(data);
  let binary = "";
  for (const byte of data) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  let binary = "";
  for (const byte of new Uint8Array(digest)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function isPkceChallenge(value: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(value);
}

export function isPkceVerifier(value: string): boolean {
  return /^[A-Za-z0-9._~-]{43,128}$/.test(value);
}

export function isAllowedRedirectUri(value: string, registeredHttps: string[] = []): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.username || url.password || url.hash) return false;
  if (url.protocol === "hands-installer:") return url.hostname === "auth" && url.pathname === "/callback";
  if (url.protocol === "https:") return registeredHttps.includes(url.toString());
  if (url.protocol !== "http:") return false;
  return (url.hostname === "127.0.0.1" || url.hostname === "[::1]" || url.hostname === "localhost") &&
    /^\/callback\/?$/.test(url.pathname);
}

export function configuredInstallerRedirectUris(env: Env): string[] {
  return (env.INSTALLER_REDIRECT_URIS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function bearer(c: Context): string | null {
  const header = c.req.header("authorization") || "";
  if (!header.startsWith("Bearer ")) return null;
  const token = header.slice(7).trim();
  return token || null;
}

export const installerAuthMiddleware: MiddlewareHandler<{
  Bindings: Env;
  Variables: InstallerVariables;
}> = async (c, next) => {
  c.header("cache-control", "no-store");
  const token = bearer(c);
  if (!token) return c.json({ error: "unauthenticated", code: "unauthenticated" }, 401);
  const hash = await sha256Hex(token);
  const timestamp = Date.now();
  const row = await c.env.DB.prepare(
    `SELECT t.id AS token_id, t.client_id,
            a.id, a.provider_subject, a.server_id, a.principal_type, a.display_name
     FROM installer_access_tokens t
     JOIN raft_accounts a ON a.id = t.account_id
     WHERE t.token_hash = ?1 AND t.revoked_at IS NULL AND t.expires_at > ?2
       AND a.principal_type = 'human'
     LIMIT 1`,
  ).bind(hash, timestamp).first<InstallerAccount & { token_id: string; client_id: string }>();
  if (!row || row.client_id !== INSTALLER_CLIENT_ID) {
    return c.json({ error: "unauthenticated", code: "unauthenticated" }, 401);
  }
  c.set("installer_account", row);
  c.set("installer_client_id", row.client_id);
  c.set("installer_token_id", row.token_id);
  await next();
};
