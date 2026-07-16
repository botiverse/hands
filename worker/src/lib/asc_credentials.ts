/**
 * Per-app App Store Connect (ASC) API credentials, stored in Hands so the
 * "Upload to TestFlight" action runs server-side (Container + iTMSTransporter)
 * instead of the app's CI holding the ASC key.
 *
 * The .p8 private key is stored ENCRYPTED with AES-GCM (unlike deploy tokens,
 * which are hashed — this must be reversible because iTMSTransporter needs the
 * real key). The AES key is derived from the ASC_CRED_ENC_KEY worker secret;
 * key_id / issuer_id are non-secret identifiers stored in plaintext.
 */

export type AscCredentialsMeta = {
  id: string;
  app_id: string;
  key_id: string;
  issuer_id: string;
  created_by_actor: string;
  created_at: number;
  updated_at: number;
};

export type AscCredentials = AscCredentialsMeta & {
  /** The decrypted .p8 private key (PEM). Keep within explicit secret paths. */
  p8: string;
};

function b64Encode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function b64Decode(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Derive a stable AES-GCM key from the encryption secret (SHA-256 → 256-bit key). */
async function deriveAesKey(secret: string): Promise<CryptoKey> {
  if (!secret || secret.length === 0) {
    throw new Error("ASC_CRED_ENC_KEY is not configured");
  }
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(secret),
  );
  return crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

export async function encryptP8(
  p8: string,
  secret: string,
): Promise<{ ciphertext_b64: string; iv_b64: string }> {
  const key = await deriveAesKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(p8),
  );
  return {
    ciphertext_b64: b64Encode(new Uint8Array(ciphertext)),
    iv_b64: b64Encode(iv),
  };
}

export async function decryptP8(
  ciphertext_b64: string,
  iv_b64: string,
  secret: string,
): Promise<string> {
  const key = await deriveAesKey(secret);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: b64Decode(iv_b64) },
    key,
    b64Decode(ciphertext_b64),
  );
  return new TextDecoder().decode(plaintext);
}

/**
 * Store (or overwrite — rotate) an app's ASC credentials. Returns metadata only.
 */
export async function storeAscCredentials(
  db: D1Database,
  encKey: string,
  args: {
    app_id: string;
    key_id: string;
    issuer_id: string;
    p8: string;
    actor: string;
  },
): Promise<AscCredentialsMeta> {
  const { ciphertext_b64, iv_b64 } = await encryptP8(args.p8, encKey);
  const now = Date.now();
  const id = crypto.randomUUID();
  // Upsert on app_id (one credential set per app; rotating overwrites).
  await db
    .prepare(
      `INSERT INTO app_asc_credentials
         (id, app_id, key_id, issuer_id, p8_ciphertext_b64, p8_iv_b64,
          created_by_actor, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)
       ON CONFLICT(app_id) DO UPDATE SET
         key_id = excluded.key_id,
         issuer_id = excluded.issuer_id,
         p8_ciphertext_b64 = excluded.p8_ciphertext_b64,
         p8_iv_b64 = excluded.p8_iv_b64,
         updated_at = excluded.updated_at`,
    )
    .bind(
      id,
      args.app_id,
      args.key_id,
      args.issuer_id,
      ciphertext_b64,
      iv_b64,
      args.actor,
      now,
    )
    .run();
  const meta = await getAscCredentialsMeta(db, args.app_id);
  if (!meta) throw new Error("failed to persist ASC credentials");
  return meta;
}

export async function getAscCredentialsMeta(
  db: D1Database,
  appId: string,
): Promise<AscCredentialsMeta | null> {
  const row = await db
    .prepare(
      `SELECT id, app_id, key_id, issuer_id, created_by_actor, created_at, updated_at
       FROM app_asc_credentials WHERE app_id = ?1`,
    )
    .bind(appId)
    .first<AscCredentialsMeta>();
  return row ?? null;
}

/** Full credentials incl. the decrypted .p8 — only for explicit secret paths. */
export async function getAscCredentials(
  db: D1Database,
  encKey: string,
  appId: string,
): Promise<AscCredentials | null> {
  const row = await db
    .prepare(
      `SELECT id, app_id, key_id, issuer_id, p8_ciphertext_b64, p8_iv_b64,
              created_by_actor, created_at, updated_at
       FROM app_asc_credentials WHERE app_id = ?1`,
    )
    .bind(appId)
    .first<
      AscCredentialsMeta & { p8_ciphertext_b64: string; p8_iv_b64: string }
    >();
  if (!row) return null;
  const p8 = await decryptP8(row.p8_ciphertext_b64, row.p8_iv_b64, encKey);
  return {
    id: row.id,
    app_id: row.app_id,
    key_id: row.key_id,
    issuer_id: row.issuer_id,
    created_by_actor: row.created_by_actor,
    created_at: row.created_at,
    updated_at: row.updated_at,
    p8,
  };
}

export async function deleteAscCredentials(
  db: D1Database,
  appId: string,
): Promise<void> {
  await db
    .prepare(`DELETE FROM app_asc_credentials WHERE app_id = ?1`)
    .bind(appId)
    .run();
}
