import { createHash, randomUUID, verify as verifySignature, type KeyLike } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { gzipSync } from "node:zlib";
import type { HandsLogger } from "./logger.js";
import { redactValue } from "./redaction.js";
import {
  HANDS_LOG_SCHEMA_VERSION,
  canonicalize,
  validateCollectPolicy,
  validateLogBundle,
  type CollectPolicyPayload,
  type LogBundle,
  type LogBundleFile,
  type LogLevel,
  type SignedCollectPolicy,
} from "./logs/schema.js";

export type CollectionNetwork = "strong" | "weak" | "offline";

export interface CollectionAuditEvent {
  event: string;
  code: string;
  message: string;
  policy_id?: string;
  policy_revision?: number;
}

export type CollectionAuditSink = (event: CollectionAuditEvent) => void;

export class CollectPolicyError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "CollectPolicyError";
    this.code = code;
  }
}

export interface VerifyPolicyOptions {
  publicKeys: Record<string, KeyLike>;
  now?: Date;
  maximumClockSkewMs?: number;
}

export function verifyCollectPolicy(
  policy: SignedCollectPolicy,
  options: VerifyPolicyOptions,
): CollectPolicyPayload {
  const validation = validateCollectPolicy(policy);
  if (!validation.valid) {
    throw new CollectPolicyError("POLICY_SCHEMA_INVALID", validation.errors.join("; "));
  }
  const now = options.now ?? new Date();
  const skew = options.maximumClockSkewMs ?? 5 * 60_000;
  const issuedAt = Date.parse(policy.payload.issued_at);
  const expiresAt = Date.parse(policy.payload.expires_at);
  if (issuedAt > now.getTime() + skew) {
    throw new CollectPolicyError("POLICY_NOT_YET_VALID", "collect policy was issued in the future");
  }
  if (expiresAt <= now.getTime()) {
    throw new CollectPolicyError("POLICY_EXPIRED", "collect policy has expired");
  }
  const key = options.publicKeys[policy.payload.key_id];
  if (!key) {
    throw new CollectPolicyError("POLICY_KEY_UNKNOWN", "collect policy signing key is unknown");
  }
  let signature: Buffer;
  try {
    signature = Buffer.from(policy.signature, "base64url");
  } catch {
    throw new CollectPolicyError("POLICY_SIGNATURE_INVALID", "collect policy signature is malformed");
  }
  const valid = verifySignature(
    null,
    Buffer.from(canonicalize(policy.payload), "utf8"),
    key,
    signature,
  );
  if (!valid) {
    throw new CollectPolicyError("POLICY_SIGNATURE_INVALID", "collect policy signature is invalid");
  }
  return policy.payload;
}

interface BudgetState {
  date: string;
  daily_bytes: number;
  highest_revisions: Record<string, number>;
}

const ACTIVE_COLLECTIONS = new Map<string, number>();

function utcDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function emptyState(date: Date): BudgetState {
  return { date: utcDay(date), daily_bytes: 0, highest_revisions: {} };
}

export interface CollectionLease {
  commit(bytes: number): void;
  release(): void;
}

export class CollectionBudgetManager {
  readonly stateFile: string;
  private readonly now: () => Date;

  constructor(stateFile: string, now: () => Date = () => new Date()) {
    this.stateFile = stateFile;
    this.now = now;
  }

  acceptRevision(payload: CollectPolicyPayload): void {
    const state = this.loadState();
    const highest = state.highest_revisions[payload.policy_id] ?? 0;
    if (payload.revision < highest) {
      throw new CollectPolicyError(
        "POLICY_DOWNGRADE_REJECTED",
        `collect policy revision ${payload.revision} is older than accepted revision ${highest}`,
      );
    }
    if (payload.revision > highest) {
      state.highest_revisions[payload.policy_id] = payload.revision;
      this.saveState(state);
    }
  }

  acquire(payload: CollectPolicyPayload, network: CollectionNetwork): CollectionLease {
    if (network === "offline") {
      throw new CollectPolicyError("NETWORK_OFFLINE", "log collection is disabled while offline");
    }
    if (network === "weak" && payload.budgets.weak_network_backoff_ms > 0) {
      throw new CollectPolicyError(
        "WEAK_NETWORK_BACKOFF",
        `log collection deferred for ${payload.budgets.weak_network_backoff_ms}ms on a weak network`,
      );
    }
    const key = this.stateFile;
    const active = ACTIVE_COLLECTIONS.get(key) ?? 0;
    if (active >= payload.budgets.max_concurrency) {
      throw new CollectPolicyError(
        "COLLECTION_CONCURRENCY_EXCEEDED",
        "log collection concurrency budget is exhausted",
      );
    }
    const state = this.loadState();
    if (state.daily_bytes >= payload.budgets.max_daily_bytes) {
      throw new CollectPolicyError("DAILY_BUDGET_EXCEEDED", "daily log collection budget is exhausted");
    }
    ACTIVE_COLLECTIONS.set(key, active + 1);
    let released = false;
    return {
      commit: (bytes: number) => {
        const latest = this.loadState();
        if (latest.daily_bytes + bytes > payload.budgets.max_daily_bytes) {
          throw new CollectPolicyError(
            "DAILY_BUDGET_EXCEEDED",
            "log bundle would exceed the daily collection budget",
          );
        }
        latest.daily_bytes += bytes;
        this.saveState(latest);
      },
      release: () => {
        if (released) return;
        released = true;
        const current = ACTIVE_COLLECTIONS.get(key) ?? 1;
        if (current <= 1) ACTIVE_COLLECTIONS.delete(key);
        else ACTIVE_COLLECTIONS.set(key, current - 1);
      },
    };
  }

  private loadState(): BudgetState {
    const now = this.now();
    try {
      const parsed = JSON.parse(readFileSync(this.stateFile, "utf8")) as Partial<BudgetState>;
      const revisions: Record<string, number> = {};
      if (parsed.highest_revisions && typeof parsed.highest_revisions === "object") {
        for (const [policyId, revision] of Object.entries(parsed.highest_revisions)) {
          if (Number.isSafeInteger(revision) && revision > 0) revisions[policyId] = revision;
        }
      }
      return {
        date: parsed.date === utcDay(now) ? parsed.date : utcDay(now),
        daily_bytes:
          parsed.date === utcDay(now) && typeof parsed.daily_bytes === "number"
            ? parsed.daily_bytes
            : 0,
        highest_revisions: revisions,
      };
    } catch {
      return emptyState(now);
    }
  }

  private saveState(state: BudgetState): void {
    mkdirSync(dirname(this.stateFile), { recursive: true, mode: 0o700 });
    const temporary = `${this.stateFile}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(state), { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, this.stateFile);
  }
}

export interface CollectLogsOptions {
  policy: SignedCollectPolicy;
  publicKeys: Record<string, KeyLike>;
  files: string[];
  outputFile: string;
  stateFile: string;
  source?: string;
  network?: CollectionNetwork;
  now?: Date;
  budgetManager?: CollectionBudgetManager;
  audit?: CollectionAuditSink;
  auditLogger?: HandsLogger;
}

export interface CollectSuccess {
  ok: true;
  output_file: string;
  bundle: LogBundle;
  compressed_bytes: number;
}

export interface CollectFailure {
  ok: false;
  code: string;
  message: string;
}

export type CollectResult = CollectSuccess | CollectFailure;

function auditFailure(options: CollectLogsOptions, error: CollectPolicyError): void {
  const payload = options.policy?.payload;
  const event: CollectionAuditEvent = {
    event: "handslog_collect_rejected",
    code: error.code,
    message: error.message,
    ...(payload?.policy_id ? { policy_id: payload.policy_id } : {}),
    ...(payload?.revision ? { policy_revision: payload.revision } : {}),
  };
  try {
    options.audit?.(event);
  } catch {
    // Audit callbacks are best-effort and cannot change host behavior.
  }
  options.auditLogger?.warn(
    "handslog",
    error.message,
    {
      code: error.code,
      policy_id: payload?.policy_id ?? "unknown",
      policy_revision: payload?.revision ?? 0,
    },
    event.event,
  );
}

function matchesSelection(entry: Record<string, unknown>, payload: CollectPolicyPayload): boolean {
  const selection = payload.selection;
  if (!selection) return true;
  if (
    selection.levels &&
    (typeof entry.level !== "string" || !selection.levels.includes(entry.level as LogLevel))
  ) {
    return false;
  }
  if (selection.tags && !selection.tags.includes(String(entry.tag ?? ""))) return false;
  if (selection.events && !selection.events.includes(String(entry.event ?? ""))) return false;
  if (selection.since) {
    const timestamp = typeof entry.ts === "string" ? Date.parse(entry.ts) : Number.NaN;
    if (!Number.isFinite(timestamp) || timestamp < Date.parse(selection.since)) return false;
  }
  return true;
}

function collectFile(
  path: string,
  payload: CollectPolicyPayload,
  remainingBytes: number,
): { file: LogBundleFile | null; entries: number; bytes: number } {
  const lines: string[] = [];
  let entries = 0;
  let bytes = 0;
  const redaction = {
    additionalSensitiveKeys: payload.redaction?.additional_sensitive_keys ?? [],
    additionalValuePatterns: payload.redaction?.additional_value_patterns ?? [],
  };
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
    if (!matchesSelection(parsed as Record<string, unknown>, payload)) continue;
    const redacted = redactValue(parsed, redaction);
    const serialized = `${JSON.stringify(redacted)}\n`;
    const lineBytes = Buffer.byteLength(serialized);
    if (bytes + lineBytes > remainingBytes) {
      throw new CollectPolicyError(
        "COLLECTION_BUDGET_EXCEEDED",
        "selected logs exceed the per-collection byte budget",
      );
    }
    lines.push(serialized);
    entries += 1;
    bytes += lineBytes;
  }
  if (lines.length === 0) return { file: null, entries: 0, bytes: 0 };
  const content = Buffer.from(lines.join(""), "utf8");
  return {
    file: {
      name: basename(path),
      size_bytes: content.byteLength,
      sha256: createHash("sha256").update(content).digest("hex"),
      content_base64: content.toString("base64"),
    },
    entries,
    bytes,
  };
}

export function collectLogs(options: CollectLogsOptions): CollectResult {
  let lease: CollectionLease | undefined;
  try {
    const payload = verifyCollectPolicy(options.policy, {
      publicKeys: options.publicKeys,
      ...(options.now === undefined ? {} : { now: options.now }),
    });
    const manager =
      options.budgetManager ??
      new CollectionBudgetManager(options.stateFile, () => options.now ?? new Date());
    manager.acceptRevision(payload);
    lease = manager.acquire(payload, options.network ?? "strong");

    const files: LogBundleFile[] = [];
    let entries = 0;
    let bytes = 0;
    for (const path of options.files) {
      const result = collectFile(path, payload, payload.budgets.max_collection_bytes - bytes);
      if (result.file) files.push(result.file);
      entries += result.entries;
      bytes += result.bytes;
    }
    const createdAt = (options.now ?? new Date()).toISOString();
    const bundle: LogBundle = {
      manifest: {
        schema_version: HANDS_LOG_SCHEMA_VERSION,
        bundle_id: randomUUID(),
        policy_id: payload.policy_id,
        policy_revision: payload.revision,
        created_at: createdAt,
        source: options.source ?? "hands-node",
        entries_count: entries,
        uncompressed_bytes: bytes,
        files: files.map(({ name, size_bytes, sha256 }) => ({ name, size_bytes, sha256 })),
      },
      files,
    };
    const validation = validateLogBundle(bundle);
    if (!validation.valid) {
      throw new CollectPolicyError("BUNDLE_SCHEMA_INVALID", validation.errors.join("; "));
    }
    const compressed = gzipSync(Buffer.from(JSON.stringify(bundle), "utf8"), { level: 9 });
    lease.commit(bytes);
    mkdirSync(dirname(options.outputFile), { recursive: true, mode: 0o700 });
    writeFileSync(options.outputFile, compressed, { mode: 0o600 });
    return {
      ok: true,
      output_file: options.outputFile,
      bundle,
      compressed_bytes: compressed.byteLength,
    };
  } catch (cause) {
    const error =
      cause instanceof CollectPolicyError
        ? cause
        : new CollectPolicyError(
            "COLLECTION_FAILED",
            cause instanceof Error ? cause.message : String(cause),
          );
    auditFailure(options, error);
    return { ok: false, code: error.code, message: error.message };
  } finally {
    lease?.release();
  }
}

export interface UploadLogBundleOptions {
  endpoint: string;
  bundleFile: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
}

export async function uploadLogBundle(
  options: UploadLogBundleOptions,
): Promise<{ ok: true; status: number } | { ok: false; code: string; message: string }> {
  try {
    const response = await fetch(options.endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/gzip",
        ...(options.headers ?? {}),
      },
      body: readFileSync(options.bundleFile),
      signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
    });
    if (!response.ok) {
      return { ok: false, code: "UPLOAD_REJECTED", message: `log ingest returned HTTP ${response.status}` };
    }
    return { ok: true, status: response.status };
  } catch (cause) {
    return {
      ok: false,
      code: "UPLOAD_FAILED",
      message: cause instanceof Error ? cause.message : String(cause),
    };
  }
}

export function defaultCollectionStateFile(logDirectory: string): string {
  return join(logDirectory, ".handslog-collection-state.json");
}
