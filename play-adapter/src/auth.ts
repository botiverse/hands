import { importPKCS8, SignJWT } from "jose";
import { PlayAdapterError } from "./errors";
import type { ServiceAccountCredential } from "./types";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const ANDROID_PUBLISHER_SCOPE = "https://www.googleapis.com/auth/androidpublisher";

export function parseServiceAccount(raw: string | undefined): ServiceAccountCredential {
  if (!raw) {
    throw new PlayAdapterError(503, "play_credentials_missing", "Google Play credentials are not configured");
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new PlayAdapterError(503, "play_credentials_invalid", "Google Play credentials are invalid");
  }
  const object = value as Record<string, unknown> | null;
  const clientEmail = object?.client_email;
  const privateKey = object?.private_key;
  const privateKeyId = object?.private_key_id;
  if (
    object?.type !== "service_account"
    || typeof clientEmail !== "string"
    || !/^[^@\s]+@[^@\s]+$/.test(clientEmail)
    || typeof privateKey !== "string"
    || !privateKey.includes("BEGIN PRIVATE KEY")
    || (privateKeyId !== undefined && typeof privateKeyId !== "string")
  ) {
    throw new PlayAdapterError(503, "play_credentials_invalid", "Google Play credentials are invalid");
  }
  return {
    client_email: clientEmail,
    private_key: privateKey,
    ...(privateKeyId ? { private_key_id: privateKeyId } : {}),
  };
}

export async function createAccessToken(
  credential: ServiceAccountCredential,
  fetchImpl: typeof fetch,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<string> {
  let privateKey: CryptoKey;
  try {
    privateKey = await importPKCS8(credential.private_key, "RS256");
  } catch {
    throw new PlayAdapterError(503, "play_credentials_invalid", "Google Play credentials are invalid");
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
      redirect: "error",
    });
  } catch {
    throw new PlayAdapterError(502, "play_token_unavailable", "Google OAuth token request failed");
  }
  const body = await response.json().catch(() => null) as Record<string, unknown> | null;
  if (!response.ok) {
    throw new PlayAdapterError(502, "play_token_rejected", `Google OAuth token request failed with ${response.status}`);
  }
  if (!body || typeof body.access_token !== "string" || !body.access_token) {
    throw new PlayAdapterError(502, "play_token_malformed", "Google OAuth returned a malformed token response");
  }
  return body.access_token;
}
