/**
 * Hands signing service: encrypted signing identities and the container calls
 * that inspect, generate and use them.
 *
 * Key material is encrypted with AES-GCM under a key derived (HKDF-SHA256,
 * info "hands.signing.v1") from ASC_CRED_ENC_KEY, so no new production secret
 * is needed and the signing key is still distinct from the one that protects
 * App Store Connect credentials. Plaintext secrets exist only in Worker memory
 * for one request and in the container's temporary directory for one command.
 */

export const SIGNING_KINDS = ["android_keystore", "apple_developer_id", "apple_ios_distribution"] as const;
export type SigningKind = (typeof SIGNING_KINDS)[number];
export const ARTIFACT_TYPES = ["apk", "aab", "macos", "ipa"] as const;
export type ArtifactType = (typeof ARTIFACT_TYPES)[number];

/** Which identity kind signs which artifact type. */
export const KIND_FOR_ARTIFACT: Record<ArtifactType, SigningKind> = {
  apk: "android_keystore",
  aab: "android_keystore",
  macos: "apple_developer_id",
  ipa: "apple_ios_distribution",
};

export type NotaryKey = { key_id: string; issuer_id: string; p8: string };

export type SigningSecret =
  | { kind: "android_keystore"; keystore_b64: string; store_password: string; key_alias: string; key_password: string }
  | { kind: "apple_developer_id"; p12_b64: string; p12_password: string; notary: NotaryKey | null }
  | {
    kind: "apple_ios_distribution";
    p12_b64: string;
    p12_password: string;
    provisioning_profiles_b64: string[];
    /** App Store Connect API key used to create and renew App Store profiles. */
    asc?: NotaryKey | null;
  };

/** A key made in Hands that waits for Apple to issue its certificate. */
export type PendingKeySecret = { kind: "pending_apple_key"; key_pem: string; api_key: NotaryKey | null };

/** A HarmonyOS signing key and the certificate chain AGC issued for it (routes/harmony_signing.ts). */
export type HarmonySigningSecret = { kind: "harmony"; key_pem: string; chain_pem: string };

/** Public facts reported by the container; never key material. */
export type SigningMetadata = {
  subject?: string;
  issuer?: string;
  sha256_fingerprint?: string;
  not_before?: string;
  not_after?: string;
  key_alias?: string;
  key_algorithm?: string;
  team_id?: string;
  notary_key_id?: string | null;
  /** iOS: key id of the App Store Connect API key that manages profiles. */
  asc_key_id?: string | null;
  /** Where the API key came from when it was copied from an app's TestFlight credentials. */
  api_key_from_app?: string | null;
  provisioning_profile_count?: number;
  /** Apple's id for a certificate Hands requested through App Store Connect. */
  apple_certificate_id?: string;
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

async function signingKey(master: string | undefined): Promise<CryptoKey> {
  if (!master) throw new SigningError(500, "signing_not_configured", "server is missing its credential encryption key");
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(master), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(32), info: new TextEncoder().encode("hands.signing.v1") },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function encryptSigningSecret(secret: SigningSecret | PendingKeySecret | HarmonySigningSecret, master: string | undefined) {
  const key = await signingKey(master);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(JSON.stringify(secret)));
  return { secret_ciphertext_b64: b64Encode(new Uint8Array(ciphertext)), secret_iv_b64: b64Encode(iv) };
}

export async function decryptSigningSecret<T = SigningSecret>(
  row: { secret_ciphertext_b64: string; secret_iv_b64: string },
  master: string | undefined,
): Promise<T> {
  const key = await signingKey(master);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: b64Decode(row.secret_iv_b64) },
    key,
    b64Decode(row.secret_ciphertext_b64),
  );
  return JSON.parse(new TextDecoder().decode(plaintext)) as T;
}

export class SigningError extends Error {
  constructor(readonly status: 400 | 403 | 404 | 409 | 500 | 502 | 503, readonly code: string, message: string) {
    super(message);
  }
}

// ---------- Container calls ----------

type ContainerCaller = (path: string, body: unknown, timeoutMs: number) => Promise<Response>;

async function defaultContainerCaller(env: Env): Promise<ContainerCaller> {
  const { getRandom } = await import("@cloudflare/containers");
  return async (path, body, timeoutMs) => {
    const container = await getRandom(env.APK_PARSER, 1);
    return container.fetch(new Request(`http://container${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    }));
  };
}

/** Test hook: replace the container. */
let containerOverride: ContainerCaller | null = null;
export function setSigningContainerForTests(caller: ContainerCaller | null) {
  containerOverride = caller;
}

export async function callSigningContainer<T>(env: Env, path: string, body: unknown, timeoutMs: number): Promise<T> {
  const call = containerOverride ?? await defaultContainerCaller(env);
  let response: Response;
  try {
    response = await call(path, body, timeoutMs);
  } catch (error) {
    throw new SigningError(503, "signing_container_unavailable", `signing container did not answer: ${error instanceof Error ? error.name : "error"}`);
  }
  const text = await response.text();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(text);
  } catch {
    // fall through
  }
  if (!response.ok) {
    const code = typeof parsed.code === "string" ? parsed.code : "signing_failed";
    const message = typeof parsed.error === "string" ? parsed.error : `signing container returned ${response.status}`;
    throw new SigningError(response.status === 400 ? 400 : 502, code, message);
  }
  return parsed as T;
}
