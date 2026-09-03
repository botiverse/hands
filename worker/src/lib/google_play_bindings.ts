export type GoogleServiceAccountCredential = {
  type: "service_account";
  project_id?: string;
  private_key_id?: string;
  private_key: string;
  client_email: string;
};

export type GooglePlayTracks = {
  internal: string;
  closed: string;
  production: string;
};

export type GooglePlayBindingMeta = {
  id: string;
  app_id: string;
  enabled: number;
  package_name: string;
  internal_track: string;
  closed_track: string;
  production_track: string;
  service_account_email: string;
  service_account_project_id: string | null;
  private_key_id: string | null;
  credential_fingerprint: string;
  credential_key_version: string;
  verification_state: "verified" | "stale";
  verified_at: number | null;
  created_by_actor: string;
  updated_by_actor: string;
  created_at: number;
  updated_at: number;
};

export type GooglePlayBinding = GooglePlayBindingMeta & {
  credential: GoogleServiceAccountCredential;
  tracks: GooglePlayTracks;
};

const PACKAGE_NAME = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/;
const TRACK_NAME = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const KEY_VERSION = /^[A-Za-z0-9._-]{1,64}$/;

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required`);
  return value.trim();
}

export function normalizeGooglePlayPackage(value: unknown): string {
  const packageName = requiredString(value, "package_name");
  if (!PACKAGE_NAME.test(packageName)) throw new Error("package_name is invalid");
  return packageName;
}

export function normalizeGooglePlayTracks(value: unknown): GooglePlayTracks {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("tracks is required");
  }
  const object = value as Record<string, unknown>;
  const tracks = {
    internal: requiredString(object.internal, "tracks.internal"),
    closed: requiredString(object.closed, "tracks.closed"),
    production: requiredString(object.production, "tracks.production"),
  };
  for (const [name, track] of Object.entries(tracks)) {
    if (!TRACK_NAME.test(track)) throw new Error(`tracks.${name} is invalid`);
  }
  return tracks;
}

export function parseGoogleServiceAccount(input: unknown): GoogleServiceAccountCredential {
  let value = input;
  if (typeof input === "string") {
    try {
      value = JSON.parse(input);
    } catch {
      throw new Error("service_account_json must contain valid JSON");
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("service_account_json must be a JSON object");
  }
  const object = value as Record<string, unknown>;
  if (object.type !== "service_account") throw new Error("credential type must be service_account");
  const clientEmail = requiredString(object.client_email, "client_email");
  if (!/^[^@\s]+@[^@\s]+$/.test(clientEmail)) throw new Error("client_email is invalid");
  const privateKey = requiredString(object.private_key, "private_key");
  if (!privateKey.includes("BEGIN PRIVATE KEY")) {
    throw new Error("private_key must be a PKCS#8 PEM private key");
  }
  return {
    type: "service_account",
    client_email: clientEmail,
    private_key: privateKey,
    ...(typeof object.project_id === "string" && object.project_id.trim()
      ? { project_id: object.project_id.trim() }
      : {}),
    ...(typeof object.private_key_id === "string" && object.private_key_id.trim()
      ? { private_key_id: object.private_key_id.trim() }
      : {}),
  };
}

function b64Encode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function b64Decode(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function parseKeyring(raw: string | undefined): Record<string, string> {
  if (!raw) throw new Error("PLAY_CRED_ENC_KEYS is not configured");
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("PLAY_CRED_ENC_KEYS is invalid");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("PLAY_CRED_ENC_KEYS is invalid");
  }
  const result: Record<string, string> = {};
  for (const [version, secret] of Object.entries(value as Record<string, unknown>)) {
    if (!KEY_VERSION.test(version) || typeof secret !== "string" || secret.length < 32) {
      throw new Error("PLAY_CRED_ENC_KEYS is invalid");
    }
    result[version] = secret;
  }
  if (Object.keys(result).length === 0) throw new Error("PLAY_CRED_ENC_KEYS is invalid");
  return result;
}

export function assertGooglePlayCredentialKeyring(
  keyringJson: string | undefined,
  activeVersion: string | undefined,
): { version: string; secret: string } {
  const keyring = parseKeyring(keyringJson);
  const version = activeVersion?.trim() ?? "";
  const secret = keyring[version];
  if (!KEY_VERSION.test(version) || !secret) {
    throw new Error("PLAY_CRED_ENC_ACTIVE_KEY_VERSION is not configured");
  }
  return { version, secret };
}

async function aesKey(secret: string): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

function additionalData(appId: string, version: string): Uint8Array {
  return new TextEncoder().encode(`hands-google-play:${appId}:${version}`);
}

export async function encryptGooglePlayCredential(
  credential: GoogleServiceAccountCredential,
  appId: string,
  keyringJson: string | undefined,
  activeVersion: string | undefined,
) {
  const { version, secret } = assertGooglePlayCredentialKeyring(keyringJson, activeVersion);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(credential));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: additionalData(appId, version) },
    await aesKey(secret),
    plaintext,
  );
  return {
    ciphertext_b64: b64Encode(new Uint8Array(ciphertext)),
    iv_b64: b64Encode(iv),
    key_version: version,
  };
}

export async function decryptGooglePlayCredential(
  ciphertext: string,
  iv: string,
  appId: string,
  keyVersion: string,
  keyringJson: string | undefined,
): Promise<GoogleServiceAccountCredential> {
  const keyring = parseKeyring(keyringJson);
  const secret = keyring[keyVersion];
  if (!secret) throw new Error("Google Play credential key version is unavailable");
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: b64Decode(iv), additionalData: additionalData(appId, keyVersion) },
    await aesKey(secret),
    b64Decode(ciphertext),
  );
  return parseGoogleServiceAccount(new TextDecoder().decode(plaintext));
}

export async function fingerprintGooglePlayCredential(credential: GoogleServiceAccountCredential): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(credential))),
  );
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

const META_COLUMNS = `id, app_id, enabled, package_name, internal_track, closed_track,
  production_track, service_account_email, service_account_project_id, private_key_id,
  credential_fingerprint, credential_key_version, verification_state, verified_at,
  created_by_actor, updated_by_actor, created_at, updated_at`;

export async function getGooglePlayBindingMeta(db: D1Database, appId: string) {
  return (await db.prepare(`SELECT ${META_COLUMNS} FROM app_google_play_bindings WHERE app_id=?1`)
    .bind(appId).first<GooglePlayBindingMeta>()) ?? null;
}

export async function getGooglePlayBinding(
  db: D1Database,
  appId: string,
  keyringJson: string | undefined,
): Promise<GooglePlayBinding | null> {
  const row = await db.prepare(`SELECT ${META_COLUMNS}, credential_ciphertext_b64, credential_iv_b64
    FROM app_google_play_bindings WHERE app_id=?1`).bind(appId).first<GooglePlayBindingMeta & {
      credential_ciphertext_b64: string;
      credential_iv_b64: string;
    }>();
  if (!row) return null;
  const credential = await decryptGooglePlayCredential(
    row.credential_ciphertext_b64,
    row.credential_iv_b64,
    appId,
    row.credential_key_version,
    keyringJson,
  );
  return {
    ...row,
    credential,
    tracks: { internal: row.internal_track, closed: row.closed_track, production: row.production_track },
  };
}

export async function storeGooglePlayBinding(
  db: D1Database,
  args: {
    appId: string;
    packageName: string;
    tracks: GooglePlayTracks;
    credential: GoogleServiceAccountCredential;
    actor: string;
    keyringJson: string | undefined;
    activeKeyVersion: string | undefined;
  },
) {
  const encrypted = await encryptGooglePlayCredential(
    args.credential,
    args.appId,
    args.keyringJson,
    args.activeKeyVersion,
  );
  const fingerprint = await fingerprintGooglePlayCredential(args.credential);
  const now = Date.now();
  await db.prepare(`INSERT INTO app_google_play_bindings
    (id, app_id, enabled, package_name, internal_track, closed_track, production_track,
     service_account_email, service_account_project_id, private_key_id, credential_fingerprint,
     credential_ciphertext_b64, credential_iv_b64, credential_key_version, verification_state,
     verified_at, created_by_actor, updated_by_actor, created_at, updated_at)
    VALUES (?1, ?2, 1, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, 'verified', ?14, ?15, ?15, ?14, ?14)
    ON CONFLICT(app_id) DO UPDATE SET enabled=1, package_name=excluded.package_name,
      internal_track=excluded.internal_track, closed_track=excluded.closed_track,
      production_track=excluded.production_track, service_account_email=excluded.service_account_email,
      service_account_project_id=excluded.service_account_project_id, private_key_id=excluded.private_key_id,
      credential_fingerprint=excluded.credential_fingerprint,
      credential_ciphertext_b64=excluded.credential_ciphertext_b64,
      credential_iv_b64=excluded.credential_iv_b64,
      credential_key_version=excluded.credential_key_version,
      verification_state='verified', verified_at=excluded.verified_at,
      updated_by_actor=excluded.updated_by_actor, updated_at=excluded.updated_at`)
    .bind(
      crypto.randomUUID(), args.appId, args.packageName, args.tracks.internal, args.tracks.closed,
      args.tracks.production, args.credential.client_email, args.credential.project_id ?? null,
      args.credential.private_key_id ?? null, fingerprint, encrypted.ciphertext_b64,
      encrypted.iv_b64, encrypted.key_version, now, args.actor,
    ).run();
  return (await getGooglePlayBindingMeta(db, args.appId))!;
}

export async function setGooglePlayBindingEnabled(
  db: D1Database,
  appId: string,
  enabled: boolean,
  actor: string,
) {
  const now = Date.now();
  const result = await db.prepare(`UPDATE app_google_play_bindings
    SET enabled=?1, updated_by_actor=?2, updated_at=?3 WHERE app_id=?4`)
    .bind(enabled ? 1 : 0, actor, now, appId).run();
  return Number(result.meta?.changes ?? 0) === 1;
}

export async function setGooglePlayBindingVerification(
  db: D1Database,
  appId: string,
  verified: boolean,
  actor: string,
) {
  const now = Date.now();
  const result = await db.prepare(`UPDATE app_google_play_bindings
    SET verification_state=?1, verified_at=?2,
      enabled=CASE WHEN ?3=1 THEN enabled ELSE 0 END,
      updated_by_actor=?4, updated_at=?5
    WHERE app_id=?6`)
    .bind(verified ? "verified" : "stale", verified ? now : null, verified ? 1 : 0, actor, now, appId)
    .run();
  return Number(result.meta?.changes ?? 0) === 1;
}

export async function deleteGooglePlayBinding(db: D1Database, appId: string) {
  await db.prepare("DELETE FROM app_google_play_bindings WHERE app_id=?1").bind(appId).run();
}
