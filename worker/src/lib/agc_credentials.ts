export type AgcApiClientCredential = {
  type: string;
  developer_id: string;
  project_id: string;
  client_id: string;
  client_secret: string;
  configuration_version?: string;
  region?: string;
};

export type AgcCredentialsMeta = {
  id: string;
  app_id: string;
  credential_kind: "api_client";
  developer_id: string;
  project_id: string;
  client_id: string;
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

export function parseAgcCredential(input: string | unknown): AgcApiClientCredential {
  let value: unknown = input;
  if (typeof input === "string") {
    try { value = JSON.parse(input); } catch { throw new Error("credential_json must contain valid JSON"); }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("credential_json must be a JSON object");
  }
  const obj = value as Record<string, unknown>;
  const type = requiredString(obj.type, "type");
  if (type !== "api_client") throw new Error(`unsupported AGC credential type: ${type}`);
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

export async function storeAgcCredentials(db: D1Database, encKey: string, args: { app_id: string; credential: AgcApiClientCredential; actor: string }) {
  const canonical = JSON.stringify(args.credential);
  const encrypted = await encryptAgcCredential(canonical, encKey);
  const fingerprint = await fingerprintAgcCredential(canonical);
  const now = Date.now();
  await db.prepare(`INSERT INTO app_agc_credentials
    (id, app_id, credential_kind, developer_id, project_id, client_id, configuration_version, region,
     credential_fingerprint, credential_ciphertext_b64, credential_iv_b64, created_by_actor, created_at, updated_at)
    VALUES (?1, ?2, 'api_client', ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?12)
    ON CONFLICT(app_id) DO UPDATE SET credential_kind='api_client', developer_id=excluded.developer_id,
      project_id=excluded.project_id, client_id=excluded.client_id, configuration_version=excluded.configuration_version,
      region=excluded.region, credential_fingerprint=excluded.credential_fingerprint,
      credential_ciphertext_b64=excluded.credential_ciphertext_b64, credential_iv_b64=excluded.credential_iv_b64,
      updated_at=excluded.updated_at`)
    .bind(crypto.randomUUID(), args.app_id, args.credential.developer_id, args.credential.project_id,
      args.credential.client_id, args.credential.configuration_version ?? null, args.credential.region ?? null,
      fingerprint, encrypted.ciphertext_b64, encrypted.iv_b64, args.actor, now).run();
  return (await getAgcCredentialsMeta(db, args.app_id))!;
}
export async function getAgcCredentialsMeta(db: D1Database, appId: string) {
  return (await db.prepare(`SELECT id, app_id, credential_kind, developer_id, project_id, client_id,
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
