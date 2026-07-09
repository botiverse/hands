import type { RedactionContract } from "./logs/schema.js";
import { HANDS_LOG_SCHEMA_VERSION } from "./logs/schema.js";

export const REDACTED = "[REDACTED]";

export const DEFAULT_REDACTION_CONTRACT: RedactionContract = {
  schema_version: HANDS_LOG_SCHEMA_VERSION,
  replacement: REDACTED,
  sensitive_keys: [
    "authorization",
    "cookie",
    "set-cookie",
    "token",
    "access_token",
    "refresh_token",
    "api_key",
    "apikey",
    "client_secret",
    "password",
    "passwd",
    "session",
    "credential",
    "private_key",
  ],
  value_patterns: [
    "\\bBearer\\s+[A-Za-z0-9._~+/=-]+",
    "\\bBasic\\s+[A-Za-z0-9+/=]+",
    "\\beyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}\\b",
    "\\b(?:sk_agent|sk_machine|qvdt|ghp|github_pat)_[A-Za-z0-9_-]{8,}\\b",
    "\\b(?:api[_-]?key|token|secret|password|authorization|cookie)\\s*[:=]\\s*[^\\s,;]+",
  ],
};

export interface RedactionOptions {
  replacement?: string;
  additionalSensitiveKeys?: string[];
  additionalValuePatterns?: string[];
}

function normalizeKey(key: string): string {
  return key.toLowerCase().replaceAll("-", "_");
}

function keyMatches(key: string, sensitiveKeys: Set<string>): boolean {
  const normalized = normalizeKey(key);
  return [...sensitiveKeys].some(
    (candidate) =>
      normalized === candidate ||
      normalized.startsWith(`${candidate}_`) ||
      normalized.endsWith(`_${candidate}`) ||
      normalized.includes(`_${candidate}_`),
  );
}

function compilePatterns(patterns: string[]): RegExp[] {
  return patterns.map((pattern) => new RegExp(pattern, "gi"));
}

function redactString(value: string, patterns: RegExp[], replacement: string): string {
  let redacted = value;
  for (const pattern of patterns) redacted = redacted.replace(pattern, replacement);
  return redacted;
}

export function redactValue(value: unknown, options: RedactionOptions = {}): unknown {
  const replacement = options.replacement ?? DEFAULT_REDACTION_CONTRACT.replacement;
  const sensitiveKeys = new Set(
    [...DEFAULT_REDACTION_CONTRACT.sensitive_keys, ...(options.additionalSensitiveKeys ?? [])].map(
      normalizeKey,
    ),
  );
  const patterns = compilePatterns([
    ...DEFAULT_REDACTION_CONTRACT.value_patterns,
    ...(options.additionalValuePatterns ?? []),
  ]);
  const seen = new WeakSet<object>();

  const visit = (current: unknown): unknown => {
    if (typeof current === "string") return redactString(current, patterns, replacement);
    if (current === null || typeof current !== "object") return current;
    if (seen.has(current)) return "[CIRCULAR]";
    seen.add(current);
    if (Array.isArray(current)) return current.map(visit);

    const output: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(current)) {
      output[key] = keyMatches(key, sensitiveKeys) ? replacement : visit(nested);
    }
    return output;
  };

  return visit(value);
}

export function redactEnvironment(
  environment: NodeJS.ProcessEnv,
  options: RedactionOptions = {},
): Record<string, string> {
  return redactValue(environment, options) as Record<string, string>;
}
