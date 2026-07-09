export const HANDS_LOG_SCHEMA_VERSION = 1 as const;
export const HANDS_LOG_SIGNATURE_ALGORITHM = "ed25519" as const;

export type LogLevel = "verbose" | "debug" | "info" | "warn" | "error";
export type JsonScalar = string | number | boolean | null;

export interface RedactionContract {
  schema_version: typeof HANDS_LOG_SCHEMA_VERSION;
  replacement: string;
  sensitive_keys: string[];
  value_patterns: string[];
}

export interface CollectSelection {
  levels?: LogLevel[];
  tags?: string[];
  events?: string[];
  since?: string;
}

export interface CollectBudgets {
  max_collection_bytes: number;
  max_daily_bytes: number;
  max_concurrency: number;
  weak_network_backoff_ms: number;
}

export interface CollectPolicyPayload {
  schema_version: typeof HANDS_LOG_SCHEMA_VERSION;
  policy_id: string;
  revision: number;
  key_id: string;
  issued_at: string;
  expires_at: string;
  selection?: CollectSelection;
  budgets: CollectBudgets;
  redaction?: {
    additional_sensitive_keys?: string[];
    additional_value_patterns?: string[];
  };
}

export interface SignedCollectPolicy {
  signature_algorithm: typeof HANDS_LOG_SIGNATURE_ALGORITHM;
  signature: string;
  payload: CollectPolicyPayload;
}

export interface LogBundleFile {
  name: string;
  size_bytes: number;
  sha256: string;
  content_base64: string;
}

export interface LogBundleManifest {
  schema_version: typeof HANDS_LOG_SCHEMA_VERSION;
  bundle_id: string;
  policy_id: string;
  policy_revision: number;
  created_at: string;
  source: string;
  entries_count: number;
  uncompressed_bytes: number;
  files: Array<Pick<LogBundleFile, "name" | "size_bytes" | "sha256">>;
}

export interface LogBundle {
  manifest: LogBundleManifest;
  files: LogBundleFile[];
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

const LEVELS = new Set<LogLevel>(["verbose", "debug", "info", "warn", "error"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIsoDate(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && Number.isFinite(Date.parse(value));
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function validateStringArray(
  value: unknown,
  path: string,
  errors: string[],
  predicate: (item: string) => boolean = () => true,
): void {
  if (!Array.isArray(value) || !value.every((item) => isNonEmptyString(item) && predicate(item))) {
    errors.push(`${path} must be an array of supported non-empty strings`);
  }
}

function validateRegexArray(value: unknown, path: string, errors: string[]): void {
  validateStringArray(value, path, errors);
  if (!Array.isArray(value)) return;
  value.forEach((pattern, index) => {
    if (typeof pattern !== "string") return;
    try {
      new RegExp(pattern);
    } catch {
      errors.push(`${path}[${index}] must be a valid regular expression`);
    }
  });
}

export function validateCollectPolicy(value: unknown): ValidationResult {
  const errors: string[] = [];
  if (!isRecord(value)) return { valid: false, errors: ["policy must be an object"] };
  if (value.signature_algorithm !== HANDS_LOG_SIGNATURE_ALGORITHM) {
    errors.push(`signature_algorithm must be ${HANDS_LOG_SIGNATURE_ALGORITHM}`);
  }
  if (!isNonEmptyString(value.signature)) errors.push("signature must be a non-empty string");
  if (!isRecord(value.payload)) {
    errors.push("payload must be an object");
    return { valid: false, errors };
  }

  const payload = value.payload;
  if (payload.schema_version !== HANDS_LOG_SCHEMA_VERSION) {
    errors.push(`payload.schema_version must be ${HANDS_LOG_SCHEMA_VERSION}`);
  }
  if (!isNonEmptyString(payload.policy_id)) errors.push("payload.policy_id is required");
  if (!isPositiveInteger(payload.revision)) errors.push("payload.revision must be a positive integer");
  if (!isNonEmptyString(payload.key_id)) errors.push("payload.key_id is required");
  if (!isIsoDate(payload.issued_at)) errors.push("payload.issued_at must be ISO-8601");
  if (!isIsoDate(payload.expires_at)) errors.push("payload.expires_at must be ISO-8601");
  if (
    isIsoDate(payload.issued_at) &&
    isIsoDate(payload.expires_at) &&
    Date.parse(payload.expires_at) <= Date.parse(payload.issued_at)
  ) {
    errors.push("payload.expires_at must be later than payload.issued_at");
  }

  if (!isRecord(payload.budgets)) {
    errors.push("payload.budgets must be an object");
  } else {
    if (!isPositiveInteger(payload.budgets.max_collection_bytes)) {
      errors.push("payload.budgets.max_collection_bytes must be a positive integer");
    }
    if (!isPositiveInteger(payload.budgets.max_daily_bytes)) {
      errors.push("payload.budgets.max_daily_bytes must be a positive integer");
    }
    if (!isPositiveInteger(payload.budgets.max_concurrency)) {
      errors.push("payload.budgets.max_concurrency must be a positive integer");
    }
    if (!isNonNegativeInteger(payload.budgets.weak_network_backoff_ms)) {
      errors.push("payload.budgets.weak_network_backoff_ms must be a non-negative integer");
    }
  }

  if (payload.selection !== undefined) {
    if (!isRecord(payload.selection)) {
      errors.push("payload.selection must be an object");
    } else {
      if (payload.selection.levels !== undefined) {
        validateStringArray(
          payload.selection.levels,
          "payload.selection.levels",
          errors,
          (level) => LEVELS.has(level as LogLevel),
        );
      }
      if (payload.selection.tags !== undefined) {
        validateStringArray(payload.selection.tags, "payload.selection.tags", errors);
      }
      if (payload.selection.events !== undefined) {
        validateStringArray(payload.selection.events, "payload.selection.events", errors);
      }
      if (payload.selection.since !== undefined && !isIsoDate(payload.selection.since)) {
        errors.push("payload.selection.since must be ISO-8601");
      }
    }
  }

  if (payload.redaction !== undefined) {
    if (!isRecord(payload.redaction)) {
      errors.push("payload.redaction must be an object");
    } else {
      if (payload.redaction.additional_sensitive_keys !== undefined) {
        validateStringArray(
          payload.redaction.additional_sensitive_keys,
          "payload.redaction.additional_sensitive_keys",
          errors,
        );
      }
      if (payload.redaction.additional_value_patterns !== undefined) {
        validateRegexArray(
          payload.redaction.additional_value_patterns,
          "payload.redaction.additional_value_patterns",
          errors,
        );
      }
    }
  }
  return { valid: errors.length === 0, errors };
}

export function validateLogBundle(value: unknown): ValidationResult {
  const errors: string[] = [];
  let manifestFiles: unknown[] | undefined;
  if (!isRecord(value)) return { valid: false, errors: ["bundle must be an object"] };
  if (!isRecord(value.manifest)) {
    errors.push("manifest must be an object");
  } else {
    const manifest = value.manifest;
    if (manifest.schema_version !== HANDS_LOG_SCHEMA_VERSION) {
      errors.push(`manifest.schema_version must be ${HANDS_LOG_SCHEMA_VERSION}`);
    }
    if (!isNonEmptyString(manifest.bundle_id)) errors.push("manifest.bundle_id is required");
    if (!isNonEmptyString(manifest.policy_id)) errors.push("manifest.policy_id is required");
    if (!isPositiveInteger(manifest.policy_revision)) {
      errors.push("manifest.policy_revision must be a positive integer");
    }
    if (!isIsoDate(manifest.created_at)) errors.push("manifest.created_at must be ISO-8601");
    if (!isNonEmptyString(manifest.source)) errors.push("manifest.source is required");
    if (!isNonNegativeInteger(manifest.entries_count)) {
      errors.push("manifest.entries_count must be a non-negative integer");
    }
    if (!isNonNegativeInteger(manifest.uncompressed_bytes)) {
      errors.push("manifest.uncompressed_bytes must be a non-negative integer");
    }
    if (!Array.isArray(manifest.files)) {
      errors.push("manifest.files must be an array");
    } else {
      manifestFiles = manifest.files;
      manifest.files.forEach((file, index) => {
        if (!isRecord(file)) {
          errors.push(`manifest.files[${index}] must be an object`);
          return;
        }
        if (!isNonEmptyString(file.name)) errors.push(`manifest.files[${index}].name is required`);
        if (!isNonNegativeInteger(file.size_bytes)) {
          errors.push(`manifest.files[${index}].size_bytes must be a non-negative integer`);
        }
        if (typeof file.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(file.sha256)) {
          errors.push(`manifest.files[${index}].sha256 must be lowercase SHA-256 hex`);
        }
      });
    }
  }
  if (!Array.isArray(value.files)) {
    errors.push("files must be an array");
  } else {
    value.files.forEach((file, index) => {
      if (!isRecord(file)) {
        errors.push(`files[${index}] must be an object`);
        return;
      }
      if (!isNonEmptyString(file.name)) errors.push(`files[${index}].name is required`);
      if (!isNonNegativeInteger(file.size_bytes)) {
        errors.push(`files[${index}].size_bytes must be a non-negative integer`);
      }
      if (typeof file.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(file.sha256)) {
        errors.push(`files[${index}].sha256 must be lowercase SHA-256 hex`);
      }
      if (typeof file.content_base64 !== "string") {
        errors.push(`files[${index}].content_base64 must be a string`);
      } else if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(file.content_base64)) {
        errors.push(`files[${index}].content_base64 must be valid base64`);
      }
    });
    if (manifestFiles && manifestFiles.length !== value.files.length) {
      errors.push("manifest.files and files must have the same length");
    }
    if (manifestFiles) {
      value.files.forEach((file, index) => {
        const manifestFile = manifestFiles?.[index];
        if (!isRecord(file) || !isRecord(manifestFile)) return;
        if (
          file.name !== manifestFile.name ||
          file.size_bytes !== manifestFile.size_bytes ||
          file.sha256 !== manifestFile.sha256
        ) {
          errors.push(`manifest.files[${index}] must match files[${index}] metadata`);
        }
      });
    }
  }
  return { valid: errors.length === 0, errors };
}

export function validateRedactionContract(value: unknown): ValidationResult {
  const errors: string[] = [];
  if (!isRecord(value)) return { valid: false, errors: ["redaction must be an object"] };
  if (value.schema_version !== HANDS_LOG_SCHEMA_VERSION) {
    errors.push(`schema_version must be ${HANDS_LOG_SCHEMA_VERSION}`);
  }
  if (!isNonEmptyString(value.replacement)) errors.push("replacement is required");
  validateStringArray(value.sensitive_keys, "sensitive_keys", errors);
  validateRegexArray(value.value_patterns, "value_patterns", errors);
  return { valid: errors.length === 0, errors };
}

export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalize(item)).join(",")}]`;
  const record = value as Record<string, unknown>;
  const fields = Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`);
  return `{${fields.join(",")}}`;
}
