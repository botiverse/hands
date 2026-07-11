import type { AgcApiClientCredential } from "./agc_credentials";

export class AgcApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export async function exchangeAgcApiClientToken(credential: AgcApiClientCredential, fetchImpl: typeof fetch = fetch) {
  const response = await fetchImpl("https://connect-api.cloud.huawei.com/api/oauth2/v1/token", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_id: credential.client_id, client_secret: credential.client_secret, grant_type: "client_credentials" }),
  });
  let body: unknown;
  try { body = await response.json(); } catch { body = null; }
  if (!response.ok) throw new AgcApiError(response.status, "AGC rejected the API client credentials");
  const obj = body as Record<string, unknown> | null;
  if (!obj || typeof obj.access_token !== "string" || !obj.access_token || typeof obj.expires_in !== "number") {
    throw new AgcApiError(502, "AGC returned a malformed token response");
  }
  return { access_token: obj.access_token, expires_in: obj.expires_in };
}
