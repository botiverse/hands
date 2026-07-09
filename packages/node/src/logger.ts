import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { JsonScalar, LogLevel } from "./logs/schema.js";
import { redactValue, type RedactionOptions } from "./redaction.js";

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  verbose: 0,
  debug: 1,
  info: 2,
  warn: 3,
  error: 4,
};

export interface LogFields {
  [key: string]: JsonScalar;
}

export interface LogEntry {
  ts: string;
  level: LogLevel;
  event: string;
  tag: string;
  message: string;
  fields?: LogFields;
  thread?: string;
  seq: number;
  dropped: number;
  truncated: boolean;
}

export type LogRedactor = (entry: LogEntry) => LogEntry | null;

export interface HandsLoggerOptions {
  name?: string;
  dir?: string;
  minLevel?: LogLevel;
  rotate?: "daily" | "size";
  maxFileBytes?: number;
  maxTotalBytes?: number;
  maxFiles?: number;
  maxAgeDays?: number;
  ringSize?: number;
  maxEntryBytes?: number;
  thread?: string;
  redactor?: LogRedactor;
  redaction?: RedactionOptions;
  console?: boolean;
  now?: () => Date;
}

interface ResolvedLoggerOptions {
  name: string;
  dir: string;
  minLevel: LogLevel;
  rotate: "daily" | "size";
  maxFileBytes: number;
  maxTotalBytes: number;
  maxFiles: number;
  maxAgeDays: number;
  ringSize: number;
  maxEntryBytes: number;
  thread?: string;
  redactor?: LogRedactor;
  redaction: RedactionOptions;
  console: boolean;
  now: () => Date;
}

export function defaultLogDirectory(appName = "hands"): string {
  const stateHome = process.env.XDG_STATE_HOME;
  if (stateHome) return join(stateHome, appName, "logs");
  if (process.platform === "win32" && process.env.LOCALAPPDATA) {
    return join(process.env.LOCALAPPDATA, appName, "logs");
  }
  return join(homedir(), ".local", "state", appName, "logs");
}

function safeName(name: string): string {
  const value = name.trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return value || "app";
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function localDay(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function isoWithOffset(date: Date): string {
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  const hours = pad(Math.floor(Math.abs(offset) / 60));
  const minutes = pad(Math.abs(offset) % 60);
  const millis = String(date.getMilliseconds()).padStart(3, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${millis}${sign}${hours}:${minutes}`;
}

function positive(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback;
}

export class HandsLogger {
  readonly options: ResolvedLoggerOptions;
  private readonly ring: LogEntry[] = [];
  private sequence = 0;

  constructor(options: HandsLoggerOptions = {}) {
    const thread = options.thread;
    const redactor = options.redactor;
    this.options = {
      name: safeName(options.name ?? "hands"),
      dir: options.dir ?? defaultLogDirectory(),
      minLevel: options.minLevel ?? "info",
      rotate: options.rotate ?? "daily",
      maxFileBytes: positive(options.maxFileBytes, 512 * 1024),
      maxTotalBytes: positive(options.maxTotalBytes, 4 * 1024 * 1024),
      maxFiles: positive(options.maxFiles, 20),
      maxAgeDays: positive(options.maxAgeDays, 7),
      ringSize: positive(options.ringSize, 500),
      maxEntryBytes: positive(options.maxEntryBytes, 64 * 1024),
      ...(thread === undefined ? {} : { thread }),
      ...(redactor === undefined ? {} : { redactor }),
      redaction: options.redaction ?? {},
      console: options.console ?? false,
      now: options.now ?? (() => new Date()),
    };
    mkdirSync(this.options.dir, { recursive: true, mode: 0o700 });
    this.sequence = this.readLastSequence();
    this.enforceRetention();
  }

  verbose(tag: string, message: string, fields?: LogFields, event?: string): void {
    this.write("verbose", tag, message, fields, event);
  }

  debug(tag: string, message: string, fields?: LogFields, event?: string): void {
    this.write("debug", tag, message, fields, event);
  }

  info(tag: string, message: string, fields?: LogFields, event?: string): void {
    this.write("info", tag, message, fields, event);
  }

  warn(tag: string, message: string, fields?: LogFields, event?: string): void {
    this.write("warn", tag, message, fields, event);
  }

  error(tag: string, message: string, fields?: LogFields, event?: string): void {
    this.write("error", tag, message, fields, event);
  }

  write(
    level: LogLevel,
    tag: string,
    message: string,
    fields?: LogFields,
    event?: string,
  ): void {
    if (LEVEL_PRIORITY[level] < LEVEL_PRIORITY[this.options.minLevel]) return;
    try {
      const now = this.options.now();
      const base: LogEntry = {
        ts: isoWithOffset(now),
        level,
        event: event ?? tag,
        tag,
        message,
        ...(fields === undefined ? {} : { fields }),
        ...(this.options.thread === undefined ? {} : { thread: this.options.thread }),
        seq: ++this.sequence,
        dropped: 0,
        truncated: false,
      };
      const defaultRedacted = redactValue(base, this.options.redaction) as LogEntry;
      const entry = this.options.redactor
        ? this.options.redactor(defaultRedacted)
        : defaultRedacted;
      if (entry === null) return;
      const normalized = this.truncateEntry(entry);
      const line = `${JSON.stringify(normalized)}\n`;
      const target = this.prepareTarget(Buffer.byteLength(line), now);
      appendFileSync(target, line, { encoding: "utf8", mode: 0o600, flag: "a" });
      this.ring.push(normalized);
      while (this.ring.length > this.options.ringSize) this.ring.shift();
      if (this.options.console) console.error(line.trimEnd());
      this.enforceRetention();
    } catch {
      // Logging is deliberately best-effort and must never alter host behavior.
    }
  }

  flush(): void {
    // Writes are synchronous so there is no pending queue to flush.
  }

  snapshot(): LogEntry[] {
    return this.ring.map((entry) => structuredClone(entry));
  }

  currentFiles(): string[] {
    try {
      return this.logFiles()
        .sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs)
        .slice(0, this.options.maxFiles);
    } catch {
      return [];
    }
  }

  private truncateEntry(entry: LogEntry): LogEntry {
    let serialized = JSON.stringify(entry);
    if (Buffer.byteLength(serialized) <= this.options.maxEntryBytes) return entry;
    const copy: LogEntry = { ...entry, truncated: true };
    delete copy.fields;
    const overhead = Buffer.byteLength(JSON.stringify({ ...copy, message: "" }));
    const allowed = Math.max(0, this.options.maxEntryBytes - overhead - 16);
    copy.message = Buffer.from(copy.message).subarray(0, allowed).toString("utf8");
    serialized = JSON.stringify(copy);
    while (Buffer.byteLength(serialized) > this.options.maxEntryBytes && copy.message.length > 0) {
      copy.message = copy.message.slice(0, Math.floor(copy.message.length * 0.9));
      serialized = JSON.stringify(copy);
    }
    return copy;
  }

  private prepareTarget(incomingBytes: number, now: Date): string {
    if (this.options.rotate === "size") return this.prepareSizeTarget(incomingBytes);
    const base = join(this.options.dir, `hands-${this.options.name}-${localDay(now)}.jsonl`);
    if (!existsSync(base) || statSync(base).size + incomingBytes <= this.options.maxFileBytes) {
      return base;
    }
    let index = 1;
    while (true) {
      const candidate = base.replace(/\.jsonl$/, `.${index}.jsonl`);
      if (!existsSync(candidate) || statSync(candidate).size + incomingBytes <= this.options.maxFileBytes) {
        return candidate;
      }
      index += 1;
    }
  }

  private prepareSizeTarget(incomingBytes: number): string {
    const base = join(this.options.dir, `hands-${this.options.name}.jsonl`);
    if (!existsSync(base) || statSync(base).size + incomingBytes <= this.options.maxFileBytes) {
      return base;
    }
    for (let index = this.options.maxFiles - 1; index >= 1; index -= 1) {
      const source = index === 1 ? base : `${base}.${index - 1}`;
      const destination = `${base}.${index}`;
      if (!existsSync(source)) continue;
      if (existsSync(destination)) rmSync(destination, { force: true });
      renameSync(source, destination);
    }
    return base;
  }

  private logFiles(): string[] {
    if (!existsSync(this.options.dir)) return [];
    const dailyPrefix = `hands-${this.options.name}-`;
    const sizePrefix = `hands-${this.options.name}.jsonl`;
    return readdirSync(this.options.dir)
      .filter(
        (name) =>
          (name.startsWith(dailyPrefix) && name.endsWith(".jsonl")) ||
          name === sizePrefix ||
          name.startsWith(`${sizePrefix}.`),
      )
      .map((name) => join(this.options.dir, name));
  }

  private readLastSequence(): number {
    let highest = 0;
    for (const path of this.logFiles()) {
      try {
        for (const line of readFileSync(path, "utf8").split("\n")) {
          if (!line) continue;
          const parsed = JSON.parse(line) as { seq?: unknown };
          if (typeof parsed.seq === "number" && Number.isSafeInteger(parsed.seq)) {
            highest = Math.max(highest, parsed.seq);
          }
        }
      } catch {
        // Ignore damaged files and keep the best sequence found elsewhere.
      }
    }
    return highest;
  }

  private enforceRetention(): void {
    try {
      const cutoff = this.options.now().getTime() - this.options.maxAgeDays * 86_400_000;
      const files = this.logFiles()
        .map((path) => ({ path, stat: statSync(path) }))
        .sort((left, right) => right.stat.mtimeMs - left.stat.mtimeMs);

      for (const file of files) {
        if (file.stat.mtimeMs < cutoff) rmSync(file.path, { force: true });
      }

      const remaining = this.logFiles()
        .map((path) => ({ path, stat: statSync(path) }))
        .sort((left, right) => right.stat.mtimeMs - left.stat.mtimeMs);
      let total = 0;
      remaining.forEach((file, index) => {
        total += file.stat.size;
        if (index >= this.options.maxFiles || total > this.options.maxTotalBytes) {
          rmSync(file.path, { force: true });
        }
      });
    } catch {
      // Retention cleanup is best-effort for the same reason writes are.
    }
  }
}

export function logFileName(path: string): string {
  return basename(path);
}
