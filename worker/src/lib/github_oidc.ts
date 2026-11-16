/**
 * GitHub Actions OIDC token verification and trusted-publisher matching.
 *
 * A workflow with `permissions: id-token: write` can ask GitHub for a signed
 * JWT whose claims name the repository, the workflow file and the ref it runs
 * on. Hands verifies the signature against GitHub's published keys and then
 * matches those claims against an app's configured trusted publishers.
 */

export const GITHUB_OIDC_ISSUER = "https://token.actions.githubusercontent.com";
const GITHUB_OIDC_JWKS_URL = `${GITHUB_OIDC_ISSUER}/.well-known/jwks`;
const JWKS_TTL_MS = 10 * 60 * 1000;
/** Tolerated clock skew for exp / nbf / iat. */
const CLOCK_SKEW_MS = 60 * 1000;
/** GitHub tokens live ~5 minutes; refuse anything claiming a longer life. */
const MAX_TOKEN_LIFETIME_MS = 60 * 60 * 1000;

export type GithubOidcClaims = {
  iss: string;
  aud: string | string[];
  sub: string;
  jti: string;
  exp: number;
  iat: number;
  nbf?: number;
  repository: string;
  repository_id: string;
  repository_owner: string;
  workflow_ref: string;
  job_workflow_ref?: string;
  ref: string;
  sha: string;
  run_id: string;
  run_attempt?: string;
  event_name: string;
  environment?: string;
  actor?: string;
};

export class GithubOidcError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

type Jwk = JsonWebKey & { kid?: string };
type JwksFetcher = () => Promise<Jwk[]>;

let jwksCache: { keys: Jwk[]; fetchedAt: number } | null = null;

async function fetchGithubJwks(): Promise<Jwk[]> {
  const response = await fetch(GITHUB_OIDC_JWKS_URL, {
    signal: AbortSignal.timeout(10_000),
    cf: { cacheTtl: 300, cacheEverything: true },
  } as RequestInit);
  if (!response.ok) throw new GithubOidcError("jwks_unavailable", `GitHub JWKS returned ${response.status}`);
  const body = await response.json() as { keys?: Jwk[] };
  if (!Array.isArray(body.keys)) throw new GithubOidcError("jwks_unavailable", "GitHub JWKS has no keys");
  return body.keys;
}

/** For tests: forget cached keys. */
export function resetGithubJwksCache() {
  jwksCache = null;
}

async function keyFor(kid: string, fetcher: JwksFetcher, now: number): Promise<Jwk> {
  const fresh = jwksCache && now - jwksCache.fetchedAt < JWKS_TTL_MS;
  let key = fresh ? jwksCache!.keys.find((k) => k.kid === kid) : undefined;
  if (!key) {
    // Unknown kid: GitHub may have rotated keys, so refetch once.
    const keys = await fetcher();
    jwksCache = { keys, fetchedAt: now };
    key = keys.find((k) => k.kid === kid);
  }
  if (!key) throw new GithubOidcError("unknown_key", "token signed with an unknown GitHub key");
  return key;
}

function base64UrlDecode(input: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(input)) throw new GithubOidcError("malformed_token", "token is not base64url");
  const padded = input.replaceAll("-", "+").replaceAll("_", "/") + "===".slice((input.length + 3) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function decodeJson(segment: string): Record<string, unknown> {
  try {
    const value = JSON.parse(new TextDecoder().decode(base64UrlDecode(segment)));
    if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch (error) {
    if (error instanceof GithubOidcError) throw error;
  }
  throw new GithubOidcError("malformed_token", "token segment is not a JSON object");
}

const REQUIRED_STRING_CLAIMS = [
  "sub", "jti", "repository", "repository_id", "repository_owner", "workflow_ref", "ref", "sha", "run_id", "event_name",
] as const;

/**
 * Verify a GitHub Actions OIDC token: RS256 signature by a current GitHub key,
 * issuer, audience, time window, and the presence of every claim matching
 * relies on. Returns the claims; throws GithubOidcError otherwise.
 */
export async function verifyGithubOidcToken(
  token: string,
  audience: string,
  options: { now?: number; fetchJwks?: JwksFetcher } = {},
): Promise<GithubOidcClaims> {
  const now = options.now ?? Date.now();
  const parts = token.split(".");
  if (parts.length !== 3) throw new GithubOidcError("malformed_token", "token is not a JWT");
  const [headerSegment, payloadSegment, signatureSegment] = parts as [string, string, string];
  const header = decodeJson(headerSegment);
  if (header.alg !== "RS256") throw new GithubOidcError("unsupported_algorithm", "token must be RS256");
  if (typeof header.kid !== "string" || !header.kid) throw new GithubOidcError("malformed_token", "token has no kid");

  const jwk = await keyFor(header.kid, options.fetchJwks ?? fetchGithubJwks, now);
  if (jwk.kty !== "RSA" || typeof jwk.n !== "string" || typeof jwk.e !== "string") {
    throw new GithubOidcError("unknown_key", "GitHub key is not an RSA key");
  }
  const key = await crypto.subtle.importKey(
    "jwk",
    { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    base64UrlDecode(signatureSegment),
    new TextEncoder().encode(`${headerSegment}.${payloadSegment}`),
  );
  if (!valid) throw new GithubOidcError("bad_signature", "token signature is invalid");

  const claims = decodeJson(payloadSegment);
  if (claims.iss !== GITHUB_OIDC_ISSUER) throw new GithubOidcError("wrong_issuer", "token was not issued by GitHub Actions");
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audiences.includes(audience)) {
    throw new GithubOidcError("wrong_audience", `token audience must be ${audience}`);
  }
  const exp = typeof claims.exp === "number" ? claims.exp * 1000 : NaN;
  const iat = typeof claims.iat === "number" ? claims.iat * 1000 : NaN;
  const nbf = typeof claims.nbf === "number" ? claims.nbf * 1000 : iat;
  if (!Number.isFinite(exp) || !Number.isFinite(iat)) throw new GithubOidcError("malformed_token", "token has no exp/iat");
  if (exp + CLOCK_SKEW_MS <= now) throw new GithubOidcError("expired", "token has expired");
  if (nbf - CLOCK_SKEW_MS > now || iat - CLOCK_SKEW_MS > now) throw new GithubOidcError("not_yet_valid", "token is not valid yet");
  if (exp - iat > MAX_TOKEN_LIFETIME_MS) throw new GithubOidcError("malformed_token", "token lifetime is too long");
  for (const name of REQUIRED_STRING_CLAIMS) {
    if (typeof claims[name] !== "string" || !claims[name]) {
      throw new GithubOidcError("missing_claim", `token has no ${name} claim`);
    }
  }
  return claims as unknown as GithubOidcClaims;
}

// ---------- Trusted publisher matching ----------

export type TrustedPublisher = {
  id: string;
  app_id: string;
  repository: string;
  repository_id: string | null;
  workflow_path: string;
  ref_patterns: string[];
  environment: string | null;
};

const REPOSITORY_PATTERN = /^[a-z0-9-]{1,39}\/[a-z0-9._-]{1,100}$/;
const WORKFLOW_PATH_PATTERN = /^\.github\/workflows\/[A-Za-z0-9._\/-]+\.ya?ml$/;
const REF_PATTERN = /^refs\/(heads|tags)\/[A-Za-z0-9._\/*-]+$/;

export function normalizeRepository(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const repository = value.trim().toLowerCase();
  return REPOSITORY_PATTERN.test(repository) ? repository : null;
}

export function normalizeWorkflowPath(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const path = value.trim().replace(/^\/+/, "");
  if (!WORKFLOW_PATH_PATTERN.test(path) || path.includes("..")) return null;
  return path;
}

/** Ref patterns: refs/heads/<branch> or refs/tags/<tag>; `*` matches within one path segment. */
export function normalizeRefPatterns(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > 20) return null;
  const patterns: string[] = [];
  for (const raw of value) {
    if (typeof raw !== "string") return null;
    const pattern = raw.trim();
    if (!REF_PATTERN.test(pattern) || pattern.length > 200) return null;
    // A bare `refs/heads/*` style wildcard is allowed but must be explicit.
    patterns.push(pattern);
  }
  return [...new Set(patterns)];
}

export function refMatches(pattern: string, ref: string): boolean {
  const regex = new RegExp(
    "^" + pattern.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*") + "$",
  );
  return regex.test(ref);
}

/**
 * Why a token does not match a publisher, or null when it matches. The token's
 * `workflow_ref` is `<owner>/<repo>/<path>@<ref>` for the workflow that started
 * the run, so a reusable workflow from another repository cannot stand in.
 */
export function trustedPublisherMismatch(publisher: TrustedPublisher, claims: GithubOidcClaims): string | null {
  if (claims.repository.toLowerCase() !== publisher.repository) return "repository";
  if (publisher.repository_id !== null && claims.repository_id !== publisher.repository_id) return "repository_id";
  const at = claims.workflow_ref.lastIndexOf("@");
  if (at < 0) return "workflow";
  const workflow = claims.workflow_ref.slice(0, at);
  const workflowRef = claims.workflow_ref.slice(at + 1);
  if (workflow.toLowerCase() !== `${publisher.repository}/${publisher.workflow_path}`.toLowerCase()) return "workflow";
  // The run's ref and the workflow file's ref are the same for push/tag runs;
  // requiring both keeps a workflow taken from another branch from matching.
  if (workflowRef !== claims.ref) return "ref";
  if (!publisher.ref_patterns.some((pattern) => refMatches(pattern, claims.ref))) return "ref";
  if (publisher.environment !== null && claims.environment !== publisher.environment) return "environment";
  return null;
}
