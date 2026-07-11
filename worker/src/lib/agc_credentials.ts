export type AgcApiClientCredential = {
  type: string;
  developer_id: string;
  project_id: string;
  client_id: string;
  client_secret: string;
  configuration_version?: string;
  region?: string;
};
export type AgcServiceAccountCredential = {
  credential_kind: "service_account";
  project_id?: string;
  key_id: string;
  private_key: string;
  sub_account: string;
  token_uri: string;
  auth_uri?: string;
  auth_provider_cert_uri?: string;
  client_cert_uri?: string;
};
export type AgcCredential = AgcApiClientCredential | AgcServiceAccountCredential;

export type AgcCredentialsMeta = {
  id: string;
  app_id: string;
  credential_kind: "api_client" | "service_account";
  developer_id: string | null;
  project_id: string | null;
  client_id: string | null;
  key_id: string | null;
  sub_account: string | null;
  configuration_version: string | null;
  region: string | null;
  credential_fingerprint: string;
  created_by_actor: string;
  created_at: number;
  updated_at: number;
};

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required`);
  return value.trim();
}

export function parseAgcCredential(input: string | unknown): AgcCredential {
  let value: unknown = input;
  if (typeof input === "string") {
    try { value = JSON.parse(input); } catch { throw new Error("credential_json must contain valid JSON"); }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("credential_json must be a JSON object");
  }
  const obj = value as Record<string, unknown>;
  if (typeof obj.key_id === "string" || typeof obj.private_key === "string" || typeof obj.sub_account === "string") {
    const privateKey = requiredString(obj.private_key, "private_key");
    if (!privateKey.includes("BEGIN PRIVATE KEY")) throw new Error("private_key must be a PKCS#8 PEM private key");
    const credential: AgcServiceAccountCredential = {
      credential_kind: "service_account",
      key_id: requiredString(obj.key_id, "key_id"),
      private_key: privateKey,
      sub_account: requiredString(obj.sub_account, "sub_account"),
      token_uri: typeof obj.token_uri === "string" && obj.token_uri.trim() ? obj.token_uri.trim() : "https://oauth-login.cloud.huawei.com/oauth2/v3/token",
    };
    if (typeof obj.project_id === "string") credential.project_id = obj.project_id.trim();
    if (typeof obj.auth_uri === "string") credential.auth_uri = obj.auth_uri.trim();
    if (typeof obj.auth_provider_cert_uri === "string") credential.auth_provider_cert_uri = obj.auth_provider_cert_uri.trim();
    if (typeof obj.client_cert_uri === "string") credential.client_cert_uri = obj.client_cert_uri.trim();
    return credential;
  }
  const type = requiredString(obj.type, "type");
  if (type !== "api_client" && type !== "project_client_id") {
    throw new Error(`unsupported AGC credential type: ${type}`);
  }
  const credential: AgcApiClientCredential = {
    type,
    developer_id: requiredString(obj.developer_id, "developer_id"),
    project_id: requiredString(obj.project_id, "project_id"),
    client_id: requiredString(obj.client_id, "client_id"),
    client_secret: requiredString(obj.client_secret, "client_secret"),
  };
  if (typeof obj.configuration_version === "string") credential.configuration_version = obj.configuration_version.trim();
  if (typeof obj.region === "string") credential.region = obj.region.trim();
  return credential;
}

function b64Encode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
function b64Decode(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}
async function keyFor(secret: string): Promise<CryptoKey> {
  if (!secret) throw new Error("AGC_CRED_ENC_KEY is not configured");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}
export async function encryptAgcCredential(value: string, secret: string) {
  const key = await keyFor(secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(value));
  return { ciphertext_b64: b64Encode(new Uint8Array(ciphertext)), iv_b64: b64Encode(iv) };
}
export async function decryptAgcCredential(ciphertext: string, iv: string, secret: string) {
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64Decode(iv) }, await keyFor(secret), b64Decode(ciphertext));
  return new TextDecoder().decode(plaintext);
}
export async function fingerprintAgcCredential(value: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function agcCredentialKind(value: AgcCredential): "api_client" | "service_account" {
  return "credential_kind" in value ? value.credential_kind : "api_client";
}
export async function storeAgcCredentials(db: D1Database, encKey: string, args: { app_id: string; credential: AgcCredential; actor: string }) {
  const canonical = JSON.stringify(args.credential);
  const encrypted = await encryptAgcCredential(canonical, encKey);
  const fingerprint = await fingerprintAgcCredential(canonical);
  const now = Date.now();
  const kind = agcCredentialKind(args.credential);
  const api = kind === "api_client" ? args.credential as AgcApiClientCredential : null;
  const service = kind === "service_account" ? args.credential as AgcServiceAccountCredential : null;
  await db.prepare(`INSERT INTO app_agc_credentials
    (id, app_id, credential_kind, developer_id, project_id, client_id, key_id, sub_account, configuration_version, region,
     credential_fingerprint, credential_ciphertext_b64, credential_iv_b64, created_by_actor, created_at, updated_at)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?15)
    ON CONFLICT(app_id) DO UPDATE SET credential_kind=excluded.credential_kind, developer_id=excluded.developer_id,
      project_id=excluded.project_id, client_id=excluded.client_id, key_id=excluded.key_id, sub_account=excluded.sub_account, configuration_version=excluded.configuration_version,
      region=excluded.region, credential_fingerprint=excluded.credential_fingerprint,
      credential_ciphertext_b64=excluded.credential_ciphertext_b64, credential_iv_b64=excluded.credential_iv_b64,
      updated_at=excluded.updated_at`)
    .bind(crypto.randomUUID(), args.app_id, kind, api?.developer_id ?? null, api?.project_id ?? service?.project_id ?? null,
      api?.client_id ?? null, service?.key_id ?? null, service?.sub_account ?? null, api?.configuration_version ?? null, api?.region ?? null,
      fingerprint, encrypted.ciphertext_b64, encrypted.iv_b64, args.actor, now).run();
  return (await getAgcCredentialsMeta(db, args.app_id))!;
}
export async function getAgcCredentialsMeta(db: D1Database, appId: string) {
  return (await db.prepare(`SELECT id, app_id, credential_kind, developer_id, project_id, client_id, key_id, sub_account,
    configuration_version, region, credential_fingerprint, created_by_actor, created_at, updated_at
    FROM app_agc_credentials WHERE app_id=?1`).bind(appId).first<AgcCredentialsMeta>()) ?? null;
}
export async function getAgcCredentials(db: D1Database, encKey: string, appId: string) {
  const row = await db.prepare(`SELECT credential_ciphertext_b64, credential_iv_b64 FROM app_agc_credentials WHERE app_id=?1`)
    .bind(appId).first<{ credential_ciphertext_b64: string; credential_iv_b64: string }>();
  if (!row) return null;
  return parseAgcCredential(await decryptAgcCredential(row.credential_ciphertext_b64, row.credential_iv_b64, encKey));
}
export async function deleteAgcCredentials(db: D1Database, appId: string) {
  await db.prepare("DELETE FROM app_agc_credentials WHERE app_id=?1").bind(appId).run();
}
