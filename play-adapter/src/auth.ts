import { importPKCS8, SignJWT } from "jose";
import { PlayAdapterError } from "./errors";
import type { ServiceAccountCredential, GooglePlayCredential } from "./types";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const ANDROID_PUBLISHER_SCOPE = "https://www.googleapis.com/auth/androidpublisher";

export function parseServiceAccount(raw: unknown): ServiceAccountCredential {
  let value: unknown;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      throw new PlayAdapterError(400, "play_credentials_invalid", "Google Play credentials are invalid");
    }
  } else {
    value = raw;
  }
  const object = value as Record<string, unknown> | null;
  const clientEmail = object?.client_email;
  const privateKey = object?.private_key;
  const privateKeyId = object?.private_key_id;
  if (
    !object
    || object.type !== "service_account"
    || typeof clientEmail !== "string"
    || !/^[^@\s]+@[^@\s]+$/.test(clientEmail)
    || typeof privateKey !== "string"
    || !privateKey.includes("BEGIN PRIVATE KEY")
    || (privateKeyId !== undefined && typeof privateKeyId !== "string")
  ) {
    throw new PlayAdapterError(400, "play_credentials_invalid", "Google Play credentials are invalid");
  }
  return {
    type: "service_account",
    ...(typeof object.project_id === "string" && object.project_id ? { project_id: object.project_id } : {}),
    client_email: clientEmail,
    private_key: privateKey,
    ...(privateKeyId ? { private_key_id: privateKeyId } : {}),
  };
}

export function parsePlayCredential(raw: unknown): GooglePlayCredential {
  const o = raw as Record<string, unknown> | null;
  if (o?.type !== "authorized_user") return parseServiceAccount(raw);
  if (["client_id", "client_secret", "refresh_token", "client_email"].some((k) => typeof o[k] !== "string" || !o[k])) {
    throw new PlayAdapterError(400, "play_credentials_invalid", "Google Play credentials are invalid");
  }
  return { type: "authorized_user", client_id: o.client_id as string, client_secret: o.client_secret as string,
    refresh_token: o.refresh_token as string, client_email: o.client_email as string };
}

export async function createAccessToken(
  credential: GooglePlayCredential,
  fetchImpl: typeof fetch,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<string> {
  if (credential.type === "authorized_user") {
    let response: Response;
    try {
      response = await fetchImpl(TOKEN_URL, {
        method: "POST", redirect: "manual", signal: AbortSignal.timeout(30_000),
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "refresh_token", client_id: credential.client_id,
          client_secret: credential.client_secret, refresh_token: credential.refresh_token }),
      });
    } catch { throw new PlayAdapterError(502, "play_token_unavailable", "Google OAuth token request failed"); }
    const body = await response.json().catch(() => null) as Record<string, unknown> | null;
    if (!response.ok) throw new PlayAdapterError(response.status < 500 ? 403 : 502, "play_token_rejected", "Google OAuth authorization needs reconnection");
    if (typeof body?.access_token !== "string" || !body.access_token || body.token_type !== "Bearer") {
      throw new PlayAdapterError(502, "play_token_malformed", "Google OAuth returned a malformed token response");
    }
    return body.access_token;
  }
  let privateKey: CryptoKey;
  try {
    privateKey = await importPKCS8(credential.private_key, "RS256");
  } catch {
    throw new PlayAdapterError(400, "play_credentials_invalid", "Google Play credentials are invalid");
  }
  const assertion = await new SignJWT({ scope: ANDROID_PUBLISHER_SCOPE })
    .setProtectedHeader({
      alg: "RS256",
      typ: "JWT",
      ...(credential.private_key_id ? { kid: credential.private_key_id } : {}),
    })
    .setIssuer(credential.client_email)
    .setAudience(TOKEN_URL)
    .setIssuedAt(nowSeconds)
    .setExpirationTime(nowSeconds + 3600)
    .sign(privateKey);

  let response: Response;
  try {
    response = await fetchImpl(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion,
      }),
      redirect: "manual",
    });
  } catch {
    throw new PlayAdapterError(502, "play_token_unavailable", "Google OAuth token request failed");
  }
  const body = await response.json().catch(() => null) as Record<string, unknown> | null;
  if (!response.ok) {
    const status = [400, 401, 403, 404].includes(response.status) ? 403 : 502;
    throw new PlayAdapterError(status, "play_token_rejected", `Google OAuth token request failed with ${response.status}`);
  }
  if (!body || typeof body.access_token !== "string" || !body.access_token) {
    throw new PlayAdapterError(502, "play_token_malformed", "Google OAuth returned a malformed token response");
  }
  return body.access_token;
}
