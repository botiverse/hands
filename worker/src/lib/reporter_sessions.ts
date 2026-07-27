import type { FeedbackTokenPermission } from "./app_permissions";

const SESSION_PREFIX = "hrps_v1_";
const SESSION_ALGORITHM = "HS256";
const SESSION_TYPE = "hands-reporter-session+jwt";
const SESSION_ISSUER = "hands";
const SESSION_AUDIENCE = "hands-reporter-feedback";
const SESSION_PROTOCOL_VERSION = 1;
const SESSION_TTL_SECONDS = 30;
const SESSION_MAX_LIFETIME_SECONDS = 60;
const SESSION_CLOCK_SKEW_SECONDS = 5;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const KEY_VERSION_RE = /^[A-Za-z0-9._-]{1,64}$/;
const JTI_RE = /^[A-Za-z0-9_-]{22,128}$/;
const MAX_SESSION_BYTES = 4096;
const REPORTER_SESSION_SCOPES = ["feedback:comment", "feedback:read"] as const;

function isReporterSessionScope(value: unknown): value is FeedbackTokenPermission {
  return typeof value === "string"
    && (REPORTER_SESSION_SCOPES as readonly string[]).includes(value);
}

export type ReporterSessionEnv = Env & {
  FEEDBACK_REPORTER_SESSION_ENABLED?: string;
  FEEDBACK_REPORTER_SESSION_ACTIVE_KEY_VERSION?: string;
  FEEDBACK_REPORTER_SESSION_KEYS?: string;
};

export type ReporterSessionClaims = {
  v: 1;
  iss: typeof SESSION_ISSUER;
  aud: typeof SESSION_AUDIENCE;
  app_id: string;
  reporter_integration_id: string;
  reporter_id: string;
  token_id: string;
  scopes: FeedbackTokenPermission[];
  iat: number;
  nbf: number;
  exp: number;
  jti: string;
  key_version: string;
};

type SessionHeader = {
  alg: typeof SESSION_ALGORITHM;
  kid: string;
  typ: typeof SESSION_TYPE;
};

type SessionKeyring = {
  activeVersion: string;
  keys: Map<string, Uint8Array>;
};

export type VerifyReporterSessionResult =
  | { ok: true; claims: ReporterSessionClaims }
  | { ok: false; reason: "invalid" | "unavailable" };

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function base64UrlDecode(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
    const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="));
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

function encodeJson(value: unknown): string {
  return base64UrlEncode(new TextEncoder().encode(JSON.stringify(value)));
}

function decodeJson(value: string): unknown {
  const bytes = base64UrlDecode(value);
  if (!bytes) return null;
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
  } catch {
    return null;
  }
}

function canonicalHeader(keyVersion: string): SessionHeader {
  return { alg: SESSION_ALGORITHM, kid: keyVersion, typ: SESSION_TYPE };
}

function canonicalClaims(claims: ReporterSessionClaims): ReporterSessionClaims {
  return {
    v: SESSION_PROTOCOL_VERSION,
    iss: SESSION_ISSUER,
    aud: SESSION_AUDIENCE,
    app_id: claims.app_id,
    reporter_integration_id: claims.reporter_integration_id,
    reporter_id: claims.reporter_id,
    token_id: claims.token_id,
    scopes: claims.scopes,
    iat: claims.iat,
    nbf: claims.nbf,
    exp: claims.exp,
    jti: claims.jti,
    key_version: claims.key_version,
  };
}

function exactCanonicalJson(encoded: string, value: unknown): boolean {
  return encodeJson(value) === encoded;
}

function parseKeyring(env: ReporterSessionEnv): SessionKeyring | null {
  const activeVersion = env.FEEDBACK_REPORTER_SESSION_ACTIVE_KEY_VERSION?.trim() ?? "";
  if (!KEY_VERSION_RE.test(activeVersion)) return null;
  try {
    const parsed = JSON.parse(env.FEEDBACK_REPORTER_SESSION_KEYS ?? "") as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const entries = Object.entries(parsed as Record<string, unknown>);
    if (entries.length < 1 || entries.length > 2) return null;
    const keys = new Map<string, Uint8Array>();
    for (const [version, encoded] of entries) {
      if (!KEY_VERSION_RE.test(version) || typeof encoded !== "string") return null;
      const key = base64UrlDecode(encoded);
      if (!key || key.byteLength < 32 || key.byteLength > 64) return null;
      keys.set(version, key);
    }
    if (!keys.has(activeVersion)) return null;
    return { activeVersion, keys };
  } catch {
    return null;
  }
}

async function sign(key: Uint8Array, input: string): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(input)));
}

async function verify(key: Uint8Array, input: string, signature: Uint8Array): Promise<boolean> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  return crypto.subtle.verify("HMAC", cryptoKey, signature, new TextEncoder().encode(input));
}

function canonicalScopes(value: unknown): FeedbackTokenPermission[] | null {
  if (!Array.isArray(value) || value.length === 0 || !value.every(isReporterSessionScope)) {
    return null;
  }
  const scopes = [...new Set(value)].sort() as FeedbackTokenPermission[];
  if (scopes.length !== value.length || scopes.some((scope, index) => scope !== value[index])) return null;
  return scopes;
}

function parseClaims(value: unknown): ReporterSessionClaims | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const expectedKeys = [
    "v", "iss", "aud", "app_id", "reporter_integration_id", "reporter_id",
    "token_id", "scopes", "iat", "nbf", "exp", "jti", "key_version",
  ];
  if (Object.keys(record).length !== expectedKeys.length || expectedKeys.some((key) => !(key in record))) {
    return null;
  }
  const scopes = canonicalScopes(record.scopes);
  if (
    record.v !== SESSION_PROTOCOL_VERSION
    || record.iss !== SESSION_ISSUER
    || record.aud !== SESSION_AUDIENCE
    || typeof record.app_id !== "string"
    || !UUID_RE.test(record.app_id)
    || typeof record.reporter_integration_id !== "string"
    || !UUID_RE.test(record.reporter_integration_id)
    || typeof record.reporter_id !== "string"
    || !/^[A-Za-z0-9_-]{16,200}$/.test(record.reporter_id)
    || typeof record.token_id !== "string"
    || !UUID_RE.test(record.token_id)
    || !scopes
    || !Number.isSafeInteger(record.iat)
    || (record.iat as number) < 0
    || !Number.isSafeInteger(record.nbf)
    || (record.nbf as number) < 0
    || !Number.isSafeInteger(record.exp)
    || (record.exp as number) < 0
    || typeof record.jti !== "string"
    || !JTI_RE.test(record.jti)
    || typeof record.key_version !== "string"
    || !KEY_VERSION_RE.test(record.key_version)
  ) return null;
  return canonicalClaims({ ...record, scopes } as ReporterSessionClaims);
}

export function reporterSessionEnabled(env: ReporterSessionEnv): boolean {
  return env.FEEDBACK_REPORTER_SESSION_ENABLED === "true";
}

export function isReporterSessionToken(value: string): boolean {
  return value.startsWith(SESSION_PREFIX);
}

export function normalizeRequestedReporterSessionScopes(value: unknown): FeedbackTokenPermission[] | null {
  if (!Array.isArray(value) || value.length === 0 || !value.every(isReporterSessionScope)) {
    return null;
  }
  return [...new Set(value)].sort() as FeedbackTokenPermission[];
}

export async function mintReporterSession(
  env: ReporterSessionEnv,
  input: {
    appId: string;
    integrationId: string;
    reporterId: string;
    tokenId: string;
    scopes: FeedbackTokenPermission[];
    nowSeconds?: number;
  },
): Promise<{ token: string; claims: ReporterSessionClaims } | null> {
  const keyring = parseKeyring(env);
  if (!keyring || !reporterSessionEnabled(env)) return null;
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  const scopes = normalizeRequestedReporterSessionScopes(input.scopes);
  if (
    !UUID_RE.test(input.appId)
    || !UUID_RE.test(input.integrationId)
    || !UUID_RE.test(input.tokenId)
    || !/^[A-Za-z0-9_-]{16,200}$/.test(input.reporterId)
    || !scopes
    || !Number.isSafeInteger(now)
    || now < 0
  ) return null;
  const nonce = new Uint8Array(16);
  crypto.getRandomValues(nonce);
  const claims = canonicalClaims({
    v: SESSION_PROTOCOL_VERSION,
    iss: SESSION_ISSUER,
    aud: SESSION_AUDIENCE,
    app_id: input.appId,
    reporter_integration_id: input.integrationId,
    reporter_id: input.reporterId,
    token_id: input.tokenId,
    scopes,
    iat: now,
    nbf: now,
    exp: now + SESSION_TTL_SECONDS,
    jti: base64UrlEncode(nonce),
    key_version: keyring.activeVersion,
  });
  const encodedHeader = encodeJson(canonicalHeader(keyring.activeVersion));
  const encodedClaims = encodeJson(claims);
  const signingInput = `${encodedHeader}.${encodedClaims}`;
  const signature = await sign(keyring.keys.get(keyring.activeVersion)!, signingInput);
  return { token: `${SESSION_PREFIX}${signingInput}.${base64UrlEncode(signature)}`, claims };
}

export async function verifyReporterSession(
  env: ReporterSessionEnv,
  token: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<VerifyReporterSessionResult> {
  if (!reporterSessionEnabled(env)) return { ok: false, reason: "invalid" };
  const keyring = parseKeyring(env);
  if (!keyring) return { ok: false, reason: "unavailable" };
  if (!isReporterSessionToken(token) || token.length > MAX_SESSION_BYTES) {
    return { ok: false, reason: "invalid" };
  }
  const compact = token.slice(SESSION_PREFIX.length);
  const parts = compact.split(".");
  if (parts.length !== 3) return { ok: false, reason: "invalid" };
  const encodedHeader = parts[0]!;
  const encodedClaims = parts[1]!;
  const encodedSignature = parts[2]!;
  const headerValue = decodeJson(encodedHeader);
  if (!headerValue || typeof headerValue !== "object" || Array.isArray(headerValue)) {
    return { ok: false, reason: "invalid" };
  }
  const header = headerValue as Record<string, unknown>;
  if (
    Object.keys(header).length !== 3
    || header.alg !== SESSION_ALGORITHM
    || header.typ !== SESSION_TYPE
    || typeof header.kid !== "string"
    || !KEY_VERSION_RE.test(header.kid)
    || !exactCanonicalJson(encodedHeader, canonicalHeader(header.kid))
  ) return { ok: false, reason: "invalid" };
  const key = keyring.keys.get(header.kid);
  if (!key) return { ok: false, reason: "invalid" };
  const signature = base64UrlDecode(encodedSignature);
  if (!signature || signature.byteLength !== 32) return { ok: false, reason: "invalid" };
  if (!await verify(key, `${encodedHeader}.${encodedClaims}`, signature)) {
    return { ok: false, reason: "invalid" };
  }
  const claims = parseClaims(decodeJson(encodedClaims));
  if (
    !claims
    || claims.key_version !== header.kid
    || !exactCanonicalJson(encodedClaims, canonicalClaims(claims))
    || claims.nbf < claims.iat
    || claims.exp <= claims.nbf
    || claims.exp - claims.iat > SESSION_MAX_LIFETIME_SECONDS
    || claims.iat > nowSeconds + SESSION_CLOCK_SKEW_SECONDS
    || claims.nbf > nowSeconds + SESSION_CLOCK_SKEW_SECONDS
    || claims.exp <= nowSeconds - SESSION_CLOCK_SKEW_SECONDS
  ) return { ok: false, reason: "invalid" };
  return { ok: true, claims };
}
