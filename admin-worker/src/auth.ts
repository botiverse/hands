import { EncryptJWT, jwtDecrypt } from "jose";
import type { Context, MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { AdminWorkerEnv } from "./env";

const SESSION = "hands_admin_session";
const STATE = "hands_admin_oauth_state";
export type AdminSession = { sub: string; server_id: string; role: string; name: string; access_token: string };
type Userinfo = { sub: string; server_id: string; server_role?: string; name?: string; preferred_username?: string };
const key = (secret: string) => new TextEncoder().encode(secret);
type AdminAppEnv = { Bindings: AdminWorkerEnv; Variables: { session: AdminSession } };

async function readSession(c: Context<AdminAppEnv>) {
  const token = getCookie(c, SESSION);
  if (!token) return null;
  try {
    const verified = await jwtDecrypt(token, key(c.env.SESSION_SECRET), { keyManagementAlgorithms: ["dir"], contentEncryptionAlgorithms: ["A256GCM"] });
    return verified.payload as unknown as AdminSession;
  } catch { return null; }
}

export const requireAdmin: MiddlewareHandler<{ Bindings: AdminWorkerEnv; Variables: { session: AdminSession } }> =
  async (c, next) => {
    const session = await readSession(c);
    if (!session) {
      return c.req.path.startsWith("/api/")
        ? c.json({ error: "unauthorized", code: "AUTH_REQUIRED" }, 401)
        : c.redirect("/login", 302);
    }
    const response = await fetch(new URL("/api/oauth/userinfo", c.env.RAFT_API_ORIGIN), {
      headers: { authorization: `Bearer ${session.access_token}` },
    });
    if (!response.ok) {
      return c.req.path.startsWith("/api/")
        ? c.json({ error: "unauthorized", code: "AUTH_EXPIRED" }, 401)
        : c.redirect("/login", 302);
    }
    const user = await response.json<Userinfo>();
    const allowed = c.env.RAFT_ALLOWED_SERVER_IDS.split(",").map((value) => value.trim()).filter(Boolean);
    const role = (user.server_role ?? "").toLowerCase();
    if (user.sub !== session.sub || !allowed.includes(user.server_id) || !["owner", "admin"].includes(role)) {
      return c.text("Hands staff access required", 403);
    }
    c.set("session", { ...session, server_id: user.server_id, role, name: user.name ?? user.preferred_username ?? user.sub });
    await next();
  };

export async function login(c: Context<{ Bindings: AdminWorkerEnv }>) {
  const state = crypto.randomUUID();
  setCookie(c, STATE, state, { httpOnly: true, secure: true, sameSite: "Lax", maxAge: 600, path: "/" });
  const callback = new URL("/auth/callback", c.req.url).toString();
  const url = new URL("/oauth/authorize", c.env.RAFT_ORIGIN);
  for (const [name, value] of Object.entries({ response_type: "code", client_id: c.env.RAFT_CLIENT_ID, redirect_uri: callback, scope: "openid profile", state })) url.searchParams.set(name, value);
  return c.redirect(url.toString(), 302);
}

export async function callback(c: Context<{ Bindings: AdminWorkerEnv }>) {
  const code = c.req.query("code");
  const state = c.req.query("state");
  if (!code || !state || state !== getCookie(c, STATE)) return c.text("Invalid OAuth state", 400);
  deleteCookie(c, STATE, { path: "/" });
  const redirectUri = new URL("/auth/callback", c.req.url).toString();
  const tokenResponse = await fetch(new URL("/api/oauth/token", c.env.RAFT_API_ORIGIN), {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Basic ${btoa(`${c.env.RAFT_CLIENT_ID}:${c.env.RAFT_CLIENT_SECRET}`)}` },
    body: JSON.stringify({ grant_type: "authorization_code", code, redirect_uri: redirectUri }),
  });
  if (!tokenResponse.ok) return c.text("Raft token exchange failed", 502);
  const { access_token } = await tokenResponse.json<{ access_token: string }>();
  const userResponse = await fetch(new URL("/api/oauth/userinfo", c.env.RAFT_API_ORIGIN), { headers: { authorization: `Bearer ${access_token}` } });
  if (!userResponse.ok) return c.text("Raft user lookup failed", 502);
  const user = await userResponse.json<Userinfo>();
  const allowed = c.env.RAFT_ALLOWED_SERVER_IDS.split(",").map((v) => v.trim()).filter(Boolean);
  const role = (user.server_role ?? "").toLowerCase();
  if (!allowed.includes(user.server_id) || !["owner", "admin"].includes(role)) return c.text("Hands staff access required", 403);
  const token = await new EncryptJWT({ sub: user.sub, server_id: user.server_id, role, name: user.name ?? user.preferred_username ?? user.sub, access_token })
    .setProtectedHeader({ alg: "dir", enc: "A256GCM" }).setIssuedAt().setExpirationTime("8h").encrypt(key(c.env.SESSION_SECRET));
  setCookie(c, SESSION, token, { httpOnly: true, secure: true, sameSite: "Lax", maxAge: 28_800, path: "/" });
  return c.redirect("/", 302);
}

export function logout(c: Context<{ Bindings: AdminWorkerEnv }>) {
  deleteCookie(c, SESSION, { path: "/" });
  return c.redirect("/", 302);
}
