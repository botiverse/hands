/**
 * Google Play Console statistics reports ingestion.
 *
 * Play Console exports monthly CSVs to a Google-owned Cloud Storage bucket:
 *   stats/installs/installs_<package>_<YYYYMM>_overview.csv
 *   stats/store_performance/store_performance_<package>_<YYYYMM>_overview.csv
 * (other dimensions such as country or app_version exist and are not read yet).
 *
 * Trust boundary: the Worker decrypts the app's Google credential as it does
 * for every Play call and hands it to the Play adapter (PLAY_RELEASE_SERVICE).
 * Only the adapter mints a token (devstorage.read_only), and it only lists and
 * reads stats CSVs of the bound package in a pubsite_prod_* bucket. The Worker
 * never sees a token or a URL; it receives object metadata and bytes.
 *
 * A file is processed per (object name, generation). The current month's file
 * is rewritten daily with a new generation; processing it replaces that
 * month's rows atomically (delete then insert in one batch), so re-reads never
 * double count. A complete generation is never read again; incomplete,
 * failed and over_limit ones are retried with back-off, or at once when a new
 * generation appears.
 */
import { createHash } from "node:crypto";
import { getGooglePlayBinding, getGooglePlayReportsCredential, hasGooglePlayConfiguration } from "./google_play_bindings";

export const PLAY_STATS_BUCKET = /^pubsite_prod_(rev_)?[0-9]{1,30}$/;

export const PLAY_STATS_METRICS = [
  "device_installs",
  "device_uninstalls",
  "device_upgrades",
  "user_installs",
  "user_uninstalls",
  "total_user_installs",
  "active_device_installs",
  "install_events",
  "update_events",
  "uninstall_events",
  "store_listing_visitors",
  "store_listing_acquisitions",
] as const;
export type PlayStatsMetric = (typeof PLAY_STATS_METRICS)[number];

/** Shown with every Google Play statistics number in the API and CLI. */
export const PLAY_STATS_NOTE =
  "From Google Play Console statistics reports (monthly CSV exports in the app's Cloud Storage reports bucket). " +
  "Google publishes them with a delay of about 3 to 7 days and rewrites the current month daily, so recent days " +
  "may be missing or change. Device metrics count devices, user metrics count Google accounts, and the *_events " +
  "metrics count every install, update or uninstall including repeats. active_device_installs and " +
  "total_user_installs are point-in-time values, not additive across days. Store listing metrics come from the " +
  "store performance report; the conversion rate is acquisitions / visitors over the window. Figures can differ " +
  "from the Play Console Statistics page, which applies its own definitions.";

export type PlayStatsReportKind = "installs_overview" | "store_performance_overview";

type Names = readonly [string, ...string[]];
export type PlayStatsMapping = {
  kind: PlayStatsReportKind;
  report: "installs" | "store_performance";
  date: Names;
  /** Columns Hands knows and deliberately does not store. */
  known: readonly string[];
  columns: Array<{ metric: PlayStatsMetric; names: Names }>;
};

/**
 * Explicit column mapping. Header names are matched case-insensitively after
 * trimming; nothing else is inferred. A missing metric column is a blocking
 * warning (the file stays retryable); an unknown extra column is a visible,
 * non-blocking warning so a rename shows up instead of disappearing.
 */
export const PLAY_STATS_REPORTS: Record<PlayStatsReportKind, PlayStatsMapping> = {
  installs_overview: {
    kind: "installs_overview",
    report: "installs",
    date: ["Date"],
    known: ["Package Name"],
    columns: [
      { metric: "device_installs", names: ["Daily Device Installs"] },
      { metric: "device_uninstalls", names: ["Daily Device Uninstalls"] },
      { metric: "device_upgrades", names: ["Daily Device Upgrades"] },
      { metric: "total_user_installs", names: ["Total User Installs"] },
      { metric: "user_installs", names: ["Daily User Installs"] },
      { metric: "user_uninstalls", names: ["Daily User Uninstalls"] },
      { metric: "active_device_installs", names: ["Active Device Installs"] },
      { metric: "install_events", names: ["Install events"] },
      { metric: "update_events", names: ["Update events"] },
      { metric: "uninstall_events", names: ["Uninstall events"] },
    ],
  },
  store_performance_overview: {
    kind: "store_performance_overview",
    report: "store_performance",
    date: ["Date"],
    // The rate is derived from the two counts; its text format is not parsed.
    known: ["Package Name", "Store listing conversion rate"],
    columns: [
      { metric: "store_listing_visitors", names: ["Store listing visitors"] },
      { metric: "store_listing_acquisitions", names: ["Store listing acquisitions"] },
    ],
  },
};

export type PlayStatsWarning = {
  code: "missing_column" | "unknown_column" | "invalid_rows" | "empty_values" | "checksum_missing" | "checksum_unverified_transcoded" | "no_rows";
  column?: string;
  columns?: string[];
  count?: number;
};

/** Warnings that mean data was lost: the file stays retryable. */
export function blockingPlayWarning(w: PlayStatsWarning): boolean {
  return w.code === "missing_column" || w.code === "invalid_rows" || w.code === "no_rows";
}

export class PlayStatsError extends Error {
  constructor(public code: string) {
    super(code);
  }
}

// ---------- Decoding and parsing ----------

function decodeUtf16(bytes: Uint8Array, offset: number, littleEndian: boolean): string {
  if ((bytes.length - offset) % 2 !== 0) throw new PlayStatsError("decode_failed");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const parts: string[] = [];
  const units: number[] = [];
  for (let i = offset; i < bytes.length; i += 2) {
    units.push(view.getUint16(i, littleEndian));
    if (units.length === 8192) {
      parts.push(String.fromCharCode(...units));
      units.length = 0;
    }
  }
  if (units.length) parts.push(String.fromCharCode(...units));
  return parts.join("");
}

/**
 * Play exports are usually UTF-16LE with a BOM; UTF-8 (with or without BOM)
 * and UTF-16BE with a BOM are accepted too. Without a BOM, text whose odd
 * bytes are mostly zero is read as UTF-16LE; anything else must be valid UTF-8.
 */
export function decodeReportBytes(bytes: Uint8Array): { text: string; encoding: "utf-16le" | "utf-16be" | "utf-8" } {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return { text: decodeUtf16(bytes, 2, true), encoding: "utf-16le" };
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return { text: decodeUtf16(bytes, 2, false), encoding: "utf-16be" };
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { text: utf8(bytes.subarray(3)), encoding: "utf-8" };
  }
  const sample = Math.min(bytes.length - (bytes.length % 2), 512);
  if (sample >= 4) {
    let oddZero = 0;
    let evenZero = 0;
    for (let i = 0; i < sample; i += 2) {
      if (bytes[i] === 0) evenZero++;
      if (bytes[i + 1] === 0) oddZero++;
    }
    if (oddZero / (sample / 2) > 0.4 && evenZero === 0) return { text: decodeUtf16(bytes, 0, true), encoding: "utf-16le" };
  }
  return { text: utf8(bytes), encoding: "utf-8" };
}

function utf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    throw new PlayStatsError("decode_failed");
  }
}

/** One CSV record; double-quoted fields may contain commas and "" escapes. */
export function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ",") {
      out.push(field);
      field = "";
    } else {
      field += ch;
    }
  }
  out.push(field);
  return out.map((f) => f.trim());
}

export type ParsedReport = {
  /** `${date}\t${metric}` → value. */
  values: Map<string, number>;
  rows: number;
  warnings: PlayStatsWarning[];
};

/**
 * Parse one monthly CSV. `month` is YYYY-MM from the object name: a row dated
 * outside it is counted as invalid, never moved.
 */
export function parsePlayReport(text: string, mapping: PlayStatsMapping, month: string): ParsedReport {
  const warnings: PlayStatsWarning[] = [];
  const values = new Map<string, number>();
  const lines = text.replace(/^﻿/, "").split("\n").map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l)).filter((l) => l.trim() !== "");
  if (lines.length === 0) return { values, rows: 0, warnings: [{ code: "no_rows" }] };
  const header = parseCsvLine(lines[0]!).map((h) => h.replace(/^﻿/, ""));
  const lower = header.map((h) => h.toLowerCase());
  const find = (names: readonly string[]) => lower.findIndex((h) => names.some((n) => n.toLowerCase() === h));
  const dateIdx = find(mapping.date);
  if (dateIdx < 0) return { values, rows: 0, warnings: [{ code: "missing_column", column: mapping.date[0] }] };
  const cols = mapping.columns.map((c) => ({ metric: c.metric, idx: find(c.names), name: c.names[0] }));
  for (const c of cols) if (c.idx < 0) warnings.push({ code: "missing_column", column: c.name });
  const used = new Set([dateIdx, ...cols.map((c) => c.idx)]);
  const known = new Set(mapping.known.map((k) => k.toLowerCase()));
  const unknown = header.filter((h, i) => !used.has(i) && !known.has(h.toLowerCase()) && h !== "");
  if (unknown.length) warnings.push({ code: "unknown_column", columns: unknown.slice(0, 10).map((u) => u.slice(0, 60)) });

  let rows = 0;
  let invalid = 0;
  let empty = 0;
  for (const line of lines.slice(1)) {
    const fields = parseCsvLine(line);
    const date = fields[dateIdx] ?? "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date.slice(0, 7) !== month) {
      invalid++;
      continue;
    }
    let bad = false;
    const parsed: Array<[PlayStatsMetric, number]> = [];
    for (const c of cols) {
      if (c.idx < 0) continue;
      const raw = (fields[c.idx] ?? "").replace(/,/g, "");
      if (raw === "") {
        empty++;
        continue;
      }
      if (!/^-?\d+(\.\d+)?$/.test(raw)) {
        bad = true;
        break;
      }
      parsed.push([c.metric, Number(raw)]);
    }
    if (bad) {
      invalid++;
      continue;
    }
    rows++;
    // A date appearing twice is summed, as the file states it twice.
    for (const [metric, n] of parsed) {
      const key = `${date}\t${metric}`;
      values.set(key, (values.get(key) ?? 0) + n);
    }
  }
  if (invalid) warnings.push({ code: "invalid_rows", count: invalid });
  if (empty) warnings.push({ code: "empty_values", count: empty });
  if (rows === 0 && invalid === 0) warnings.push({ code: "no_rows" });
  return { values, rows, warnings };
}

/** Cloud Storage md5Hash is the base64 MD5 of the object bytes. */
export function md5Base64(bytes: Uint8Array): string {
  return createHash("md5").update(bytes).digest("base64");
}

// ---------- Settings ----------

export function normalizePlayStatsBucket(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string") throw new Error("stats_bucket must be a string or null");
  let bucket = value.trim();
  // Accept the gs:// URI Play Console shows, without a path.
  if (bucket.startsWith("gs://")) bucket = bucket.slice(5).replace(/\/+$/, "");
  if (!PLAY_STATS_BUCKET.test(bucket)) {
    throw new Error("stats_bucket must look like pubsite_prod_rev_<digits> (older accounts: pubsite_prod_<digits>)");
  }
  return bucket;
}

export async function getPlayStatsBucket(db: D1Database, appId: string): Promise<string | null> {
  const row = await db.prepare("SELECT stats_bucket FROM google_play_stats_settings WHERE app_id = ?1")
    .bind(appId).first<{ stats_bucket: string | null }>();
  return row?.stats_bucket ?? null;
}

export async function setPlayStatsBucket(db: D1Database, appId: string, bucket: string | null, actor: string, now = Date.now()) {
  await db.prepare(`INSERT INTO google_play_stats_settings (app_id, stats_bucket, updated_by_actor, updated_at)
    VALUES (?1, ?2, ?3, ?4)
    ON CONFLICT(app_id) DO UPDATE SET stats_bucket = excluded.stats_bucket,
      updated_by_actor = excluded.updated_by_actor, updated_at = excluded.updated_at`)
    .bind(appId, bucket, actor, now).run();
  // A new bucket is worth reading soon; an earlier failure code belongs to the old one.
  await db.prepare("UPDATE google_play_stats_ingest_schedule SET next_run_at = 0, last_error_code = NULL WHERE app_id = ?1")
    .bind(appId).run();
}

/**
 * A 403/404 on a bucket name without rev_ may mean the account uses the newer
 * pubsite_prod_rev_<digits> form. Hands never switches buckets on its own.
 */
export function playStatsBucketHint(bucket: string | null, code: string | null): string | null {
  if (!bucket || !code) return null;
  if (code === "play_reports_not_authorized") {
    return "Statistics reports are not authorized for this app. An app admin can choose \"Authorize statistics reports\" in the app's Google Play settings; publishing is not affected.";
  }
  if (code === "play_reports_token_rejected") {
    return "Google rejected the statistics authorization (it expired or was revoked). An admin can reauthorize statistics reports in the app's Google Play settings; publishing is not affected.";
  }
  if (code !== "play_reports_bucket_forbidden" && code !== "play_reports_bucket_not_found") return null;
  if (bucket.startsWith("pubsite_prod_rev_")) {
    return "Google denied or could not find this bucket. Check that the connected Google account can download reports in Play Console, and copy the exact Cloud Storage URI from Play Console > Download reports.";
  }
  return "Google denied or could not find this bucket. Newer Play Console accounts use pubsite_prod_rev_<digits>; copy the exact Cloud Storage URI from Play Console > Download reports and set it again. Hands does not switch buckets on its own.";
}

// ---------- Ingest ----------

export type PlayStatsBudget = {
  /** Files downloaded per call. */
  maxFiles: number;
  /** A file larger than this ends over_limit without being downloaded. */
  maxFileBytes: number;
  /** Bytes per call: once spent, the remaining files wait for the next run. */
  maxRunBytes: number;
};

const KiB = 1024;
const MiB = 1024 * KiB;
export const PLAY_STATS_SCHEDULED_BUDGET: PlayStatsBudget = { maxFiles: 4, maxFileBytes: 2 * MiB, maxRunBytes: 6 * MiB };
export const PLAY_STATS_MANUAL_BUDGET: PlayStatsBudget = { maxFiles: 12, maxFileBytes: 2 * MiB, maxRunBytes: 16 * MiB };

/** First retry after six hours, doubling per attempt up to four days. */
export const PLAY_FILE_RETRY_MS = 6 * 60 * 60 * 1000;
export function playRetryDelay(attempts: number): number {
  return PLAY_FILE_RETRY_MS * 2 ** Math.min(Math.max(attempts - 1, 0), 4);
}

export type PlayStatsIngestSummary = {
  status: "ok" | "not_configured" | "bucket_not_configured" | "service_unavailable";
  bucket: string | null;
  package_name: string | null;
  files_seen: number;
  files_already_processed: number;
  files_deferred: number;
  files_processed: number;
  files_incomplete: Array<{ object_name: string; code: string }>;
  files_failed: Array<{ object_name: string; code: string }>;
  files_over_limit: Array<{ object_name: string; code: string }>;
  rows_written: number;
  more_pending: boolean;
  /** Which credential read the reports: the separate statistics grant, or the publishing one. */
  reports_credential?: "reports_grant" | "publishing";
  warnings: Array<{ object_name: string; report_kind: PlayStatsReportKind } & PlayStatsWarning>;
};

type Listed = { name: string; generation: string; md5_hash: string | null; content_encoding?: string | null; size: number };
type Candidate = Listed & { kind: PlayStatsReportKind; month: string; generationNum: number };

function overviewMatch(name: string, report: "installs" | "store_performance", packageName: string): string | null {
  const prefix = `stats/${report}/${report}_${packageName}_`;
  if (!name.startsWith(prefix)) return null;
  const m = name.slice(prefix.length).match(/^(\d{4})(\d{2})_overview\.csv$/);
  if (!m || Number(m[2]) < 1 || Number(m[2]) > 12) return null;
  return `${m[1]}-${m[2]}`;
}

/** Only whitelisted identifiers and codes are logged; never bucket contents, bodies or credentials. */
function logFailure(appId: string, code: string, extra: { report_kind?: string; month?: string } = {}) {
  console.warn("hands_play_stats_ingest_failure", JSON.stringify({ app_id: appId, code, ...extra }));
}

const LIMIT_CODES = new Set(["file_bytes_limit", "play_reports_object_too_large"]);
const INSERT_CHUNK = 500;

/** A newer generation of the same (kind, month) already written wins over this one. */
const NEWER_EXISTS = `EXISTS (SELECT 1 FROM google_play_stats_files f WHERE f.app_id = ?1 AND f.report_kind = ?2
  AND f.month = ?3 AND f.status IN ('complete', 'incomplete') AND f.generation > ?4)`;

export async function ingestGooglePlayStatsForApp(
  env: Pick<Env, "DB" | "PLAY_CRED_ENC_KEYS" | "PLAY_RELEASE_SERVICE">,
  appId: string,
  budget: PlayStatsBudget,
  now = Date.now(),
): Promise<PlayStatsIngestSummary> {
  const summary: PlayStatsIngestSummary = {
    status: "ok",
    bucket: null,
    package_name: null,
    files_seen: 0,
    files_already_processed: 0,
    files_deferred: 0,
    files_processed: 0,
    files_incomplete: [],
    files_failed: [],
    files_over_limit: [],
    rows_written: 0,
    more_pending: false,
    warnings: [],
  };
  const service = env.PLAY_RELEASE_SERVICE;
  if (!service || typeof service.listStatsObjects !== "function" || typeof service.readStatsObject !== "function") {
    return { ...summary, status: "service_unavailable" };
  }
  const binding = await getGooglePlayBinding(env.DB, appId, env.PLAY_CRED_ENC_KEYS);
  if (!binding || !hasGooglePlayConfiguration(binding) || binding.enabled !== 1 || binding.verification_state !== "verified") {
    return { ...summary, status: "not_configured" };
  }
  const packageName = binding.package_name;
  summary.package_name = packageName;
  const bucket = await getPlayStatsBucket(env.DB, appId);
  if (!bucket) return { ...summary, status: "bucket_not_configured" };
  summary.bucket = bucket;
  // The separate statistics authorization when there is one. Until it is granted,
  // fall back to the publishing credential (a service account, or an older Google
  // grant that also holds the reports scope).
  const reportsCredential = await getGooglePlayReportsCredential(env.DB, appId, env.PLAY_CRED_ENC_KEYS);
  const credential = reportsCredential ?? binding.credential;
  summary.reports_credential = reportsCredential ? "reports_grant" : "publishing";
  // A rejected reports grant needs the statistics authorization redone, not the publishing one.
  // Without one, a publishing grant that cannot read reports (no reports scope, which is
  // every publishing grant from now on) means statistics were never authorized.
  const errorCode = (code: string) => {
    if (reportsCredential) return code === "play_token_rejected" ? "play_reports_token_rejected" : code;
    return code === "play_token_rejected" || code === "play_reports_scope_missing" ? "play_reports_not_authorized" : code;
  };

  const candidates: Candidate[] = [];
  for (const kind of ["installs_overview", "store_performance_overview"] as const) {
    const report = PLAY_STATS_REPORTS[kind].report;
    const listed = await service.listStatsObjects({ credential, packageName, bucket, report });
    if (!listed.ok) throw new PlayStatsError(errorCode(listed.error.code));
    if (listed.value.truncated) summary.more_pending = true;
    for (const o of listed.value.objects) {
      const month = overviewMatch(o.name, report, packageName);
      const generationNum = Number(o.generation);
      if (!month || !/^\d{1,19}$/.test(o.generation) || !Number.isSafeInteger(generationNum)) continue;
      candidates.push({ ...o, kind, month, generationNum });
    }
  }
  summary.files_seen = candidates.length;

  const known = new Map((await env.DB.prepare(
    `SELECT object_name, generation, status, attempts, next_attempt_at FROM google_play_stats_files WHERE app_id = ?1`,
  ).bind(appId).all<{ object_name: string; generation: number; status: string; attempts: number; next_attempt_at: number | null }>())
    .results.map((r) => [r.object_name, r]));
  const pending: Candidate[] = [];
  for (const c of candidates) {
    const prior = known.get(c.name);
    if (prior && Number(prior.generation) >= c.generationNum) {
      if (prior.status === "complete") summary.files_already_processed++;
      else if ((prior.next_attempt_at ?? 0) > now) summary.files_deferred++;
      else pending.push(c);
    } else {
      // New file, or Google rewrote it (new generation): read it now.
      pending.push(c);
    }
  }
  // Newest month first, so a fresh connection fills the recent window before history.
  pending.sort((a, b) => b.month.localeCompare(a.month) || a.kind.localeCompare(b.kind));
  if (pending.length > budget.maxFiles) summary.more_pending = true;

  let runBytes = 0;
  for (const file of pending.slice(0, budget.maxFiles)) {
    if (runBytes + file.size > budget.maxRunBytes && runBytes > 0) {
      summary.more_pending = true;
      break;
    }
    const mapping = PLAY_STATS_REPORTS[file.kind];
    // Attempts count per generation; a rewritten file starts again at one.
    const prior = known.get(file.name);
    const attempts = prior && Number(prior.generation) === file.generationNum ? Number(prior.attempts) + 1 : 1;
    try {
      if (file.size > budget.maxFileBytes) throw new PlayStatsError("file_bytes_limit");
      const read = await service.readStatsObject({
        credential, packageName, bucket, name: file.name, generation: file.generation, maxBytes: budget.maxFileBytes,
      });
      if (!read.ok) throw new PlayStatsError(errorCode(read.error.code));
      const bytes = read.value.bytes instanceof Uint8Array ? read.value.bytes : new Uint8Array(read.value.bytes as ArrayBufferLike);
      runBytes += bytes.byteLength;
      if (read.value.name !== file.name || read.value.generation !== file.generation) throw new PlayStatsError("object_identity_mismatch");
      if (bytes.byteLength > budget.maxFileBytes) throw new PlayStatsError("file_bytes_limit");
      const extra: PlayStatsWarning[] = [];
      if (file.content_encoding === "gzip") {
        // Stored gzip-encoded: Cloud Storage serves it decompressed, and md5Hash covers the
        // compressed bytes, so it cannot be compared. Recorded, not silent.
        extra.push({ code: "checksum_unverified_transcoded" });
      } else if (file.md5_hash) {
        if (md5Base64(bytes) !== file.md5_hash) {
          throw new PlayStatsError(bytes.byteLength === file.size ? "md5_mismatch" : "md5_mismatch_size_differs");
        }
      } else {
        extra.push({ code: "checksum_missing" });
      }
      const { text } = decodeReportBytes(bytes);
      const parsed = parsePlayReport(text, mapping, file.month);
      const warnings = [...parsed.warnings, ...extra];
      const blocking = warnings.find(blockingPlayWarning);
      const status = blocking ? "incomplete" : "complete";
      const lastError = blocking ? `${blocking.code}${blocking.column ? `:${blocking.column}` : ""}` : null;
      const rows = [...parsed.values].map(([key, v]) => {
        const [d, m] = key.split("\t");
        return { d, m, v };
      });
      const statements = [
        env.DB.prepare(`DELETE FROM google_play_stats_daily_totals
          WHERE app_id = ?1 AND report_kind = ?2 AND month = ?3 AND NOT ${NEWER_EXISTS}`)
          .bind(appId, file.kind, file.month, file.generationNum),
      ];
      for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
        statements.push(env.DB.prepare(
          `INSERT INTO google_play_stats_daily_totals (app_id, report_kind, month, date, metric, value)
           SELECT ?1, ?2, ?3, json_extract(j.value, '$.d'), json_extract(j.value, '$.m'), json_extract(j.value, '$.v')
           FROM json_each(?5) j WHERE NOT ${NEWER_EXISTS}`,
        ).bind(appId, file.kind, file.month, file.generationNum, JSON.stringify(rows.slice(i, i + INSERT_CHUNK))));
      }
      statements.push(env.DB.prepare(
        `INSERT INTO google_play_stats_files (app_id, object_name, report_kind, month, generation, md5_hash, size_bytes,
           row_count, warnings_json, processed_at, status, attempts, last_error, next_attempt_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?14, ?12, ?13)
         ON CONFLICT(app_id, object_name) DO UPDATE SET
           attempts = excluded.attempts, generation = excluded.generation, md5_hash = excluded.md5_hash, size_bytes = excluded.size_bytes,
           row_count = excluded.row_count, warnings_json = excluded.warnings_json, processed_at = excluded.processed_at,
           status = excluded.status, last_error = excluded.last_error, next_attempt_at = excluded.next_attempt_at
         WHERE excluded.generation >= google_play_stats_files.generation`,
      ).bind(appId, file.name, file.kind, file.month, file.generationNum, file.md5_hash, bytes.byteLength, parsed.rows,
        JSON.stringify(warnings), now, status, lastError, blocking ? now + playRetryDelay(attempts) : null, attempts));
      await env.DB.batch(statements);
      if (blocking) {
        summary.files_incomplete.push({ object_name: file.name, code: lastError ?? blocking.code });
        logFailure(appId, blocking.code, { report_kind: file.kind, month: file.month });
      } else {
        summary.files_processed++;
      }
      summary.rows_written += rows.length;
      for (const w of warnings) summary.warnings.push({ object_name: file.name, report_kind: file.kind, ...w });
    } catch (err) {
      const code = err instanceof PlayStatsError ? err.code : "unexpected";
      logFailure(appId, code, { report_kind: file.kind, month: file.month });
      const overLimit = LIMIT_CODES.has(code);
      if (overLimit) summary.files_over_limit.push({ object_name: file.name, code });
      else summary.files_failed.push({ object_name: file.name, code });
      // Nothing is written for this file; rows of an earlier generation stay as they were.
      await env.DB.prepare(
        `INSERT INTO google_play_stats_files (app_id, object_name, report_kind, month, generation, md5_hash, size_bytes,
           processed_at, status, attempts, last_error, next_attempt_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
         ON CONFLICT(app_id, object_name) DO UPDATE SET
           generation = excluded.generation, md5_hash = excluded.md5_hash, size_bytes = excluded.size_bytes,
           processed_at = excluded.processed_at, status = excluded.status, attempts = excluded.attempts,
           last_error = excluded.last_error, next_attempt_at = excluded.next_attempt_at
         WHERE excluded.generation >= google_play_stats_files.generation`,
      ).bind(appId, file.name, file.kind, file.month, file.generationNum, file.md5_hash, file.size, now,
        overLimit ? "over_limit" : "failed", attempts, code, now + playRetryDelay(attempts))
        .run().catch(() => undefined);
    }
  }
  return summary;
}

const RUN_INTERVAL_MS = 6 * 60 * 60 * 1000;
const APPS_PER_TICK = 1;

/** Candidates: verified, enabled bindings with a package and a configured bucket. */
const ELIGIBLE = `FROM google_play_stats_settings st
  JOIN app_google_play_bindings b ON b.app_id = st.app_id
  JOIN apps a ON a.id = st.app_id
  WHERE st.stats_bucket IS NOT NULL AND b.enabled = 1 AND b.verification_state = 'verified'
    AND b.package_name IS NOT NULL AND a.archived = 0`;

/** Cron entry: one app per tick, isolated, persisted rotation like the ASC ingest. */
export async function pollGooglePlayStats(env: Env, now = Date.now()) {
  const service = env.PLAY_RELEASE_SERVICE;
  if (!service || typeof service.listStatsObjects !== "function") return;
  await env.DB.prepare(`INSERT OR IGNORE INTO google_play_stats_ingest_schedule (app_id, next_run_at)
    SELECT st.app_id, 0 ${ELIGIBLE}`).run();
  const { results } = await env.DB.prepare(`SELECT s.app_id, s.next_run_at FROM google_play_stats_ingest_schedule s
    WHERE s.next_run_at <= ?1 AND s.app_id IN (SELECT st.app_id ${ELIGIBLE})
    ORDER BY s.next_run_at, s.app_id LIMIT ?2`)
    .bind(now, APPS_PER_TICK).all<{ app_id: string; next_run_at: number }>();
  for (const row of results) {
    const claim = await env.DB.prepare(`UPDATE google_play_stats_ingest_schedule SET next_run_at = ?1
      WHERE app_id = ?2 AND next_run_at = ?3`).bind(now + RUN_INTERVAL_MS, row.app_id, row.next_run_at).run();
    if (claim.meta.changes !== 1) continue;
    let next = now + RUN_INTERVAL_MS;
    let code: string | null = null;
    try {
      const summary = await ingestGooglePlayStatsForApp(env, row.app_id, PLAY_STATS_SCHEDULED_BUDGET, now);
      if (summary.status !== "ok") code = summary.status;
      else code = summary.files_failed[0]?.code ?? summary.files_over_limit[0]?.code ?? summary.files_incomplete[0]?.code ?? null;
      // Backlog left: continue on a following tick instead of in six hours.
      if (summary.more_pending && summary.files_processed > 0) next = (Math.floor(now / 300_000) + 1) * 300_000;
    } catch (err) {
      code = err instanceof PlayStatsError ? err.code : "unexpected";
      logFailure(row.app_id, code);
    }
    await env.DB.prepare(`UPDATE google_play_stats_ingest_schedule SET next_run_at = ?1, last_run_at = ?2, last_error_code = ?3
      WHERE app_id = ?4`).bind(next, now, code, row.app_id).run().catch(() => undefined);
  }
}

// ---------- Reading ----------

export type PlayDailyRow = { date: string } & Record<PlayStatsMetric, number | null>;

const ADDITIVE: PlayStatsMetric[] = [
  "device_installs", "device_uninstalls", "device_upgrades", "user_installs", "user_uninstalls",
  "install_events", "update_events", "uninstall_events", "store_listing_visitors", "store_listing_acquisitions",
];

/** ?1 = app id, ?2 = first date. A primary-key range scan: O(days x metrics). */
export const PLAY_DAILY_SQL = `SELECT date, metric, value FROM google_play_stats_daily_totals
  WHERE app_id = ?1 AND date >= ?2 ORDER BY date`;

export async function queryGooglePlayStatsDaily(db: D1Database, appId: string, sinceDate: string) {
  const { results } = await db.prepare(PLAY_DAILY_SQL).bind(appId, sinceDate)
    .all<{ date: string; metric: string; value: number }>();
  const byDate = new Map<string, PlayDailyRow>();
  for (const r of results) {
    if (!(PLAY_STATS_METRICS as readonly string[]).includes(r.metric)) continue;
    let row = byDate.get(r.date);
    if (!row) {
      row = { date: r.date, ...Object.fromEntries(PLAY_STATS_METRICS.map((m) => [m, null])) } as PlayDailyRow;
      byDate.set(r.date, row);
    }
    row[r.metric as PlayStatsMetric] = Number(r.value);
  }
  const daily = [...byDate.values()];
  const totals: Record<string, number | string | null> = {};
  for (const m of ADDITIVE) {
    const vals = daily.map((d) => d[m]).filter((v): v is number => v !== null);
    totals[m] = vals.length ? vals.reduce((a, b) => a + b, 0) : null;
  }
  const latest = (m: PlayStatsMetric) => {
    for (let i = daily.length - 1; i >= 0; i--) if (daily[i]![m] !== null) return { value: daily[i]![m], date: daily[i]!.date };
    return null;
  };
  const active = latest("active_device_installs");
  const users = latest("total_user_installs");
  totals.active_device_installs_latest = active?.value ?? null;
  totals.active_device_installs_latest_date = active?.date ?? null;
  totals.total_user_installs_latest = users?.value ?? null;
  const visitors = totals.store_listing_visitors as number | null;
  const acquisitions = totals.store_listing_acquisitions as number | null;
  totals.store_listing_conversion_rate = visitors && acquisitions !== null ? Math.round((acquisitions / visitors) * 10_000) / 10_000 : null;

  const files = await db.prepare(
    `SELECT SUM(CASE WHEN status = 'complete' THEN 1 ELSE 0 END) AS complete,
            SUM(CASE WHEN status = 'incomplete' THEN 1 ELSE 0 END) AS incomplete,
            SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
            SUM(CASE WHEN status = 'over_limit' THEN 1 ELSE 0 END) AS over_limit,
            MAX(CASE WHEN status IN ('complete', 'incomplete') THEN processed_at END) AS last_processed_at
     FROM google_play_stats_files WHERE app_id = ?1`,
  ).bind(appId).first<{ complete: number | null; incomplete: number | null; failed: number | null; over_limit: number | null; last_processed_at: number | null }>();
  const latestDate = await db.prepare("SELECT MAX(date) AS d FROM google_play_stats_daily_totals WHERE app_id = ?1")
    .bind(appId).first<{ d: string | null }>();
  const problems = await db.prepare(
    `SELECT report_kind, month, status, last_error FROM google_play_stats_files
     WHERE app_id = ?1 AND status <> 'complete' ORDER BY month DESC, report_kind LIMIT 10`,
  ).bind(appId).all<{ report_kind: string; month: string; status: string; last_error: string | null }>();
  const warned = await db.prepare(
    `SELECT report_kind, warnings_json FROM google_play_stats_files
     WHERE app_id = ?1 AND warnings_json <> '[]' ORDER BY processed_at DESC LIMIT 20`,
  ).bind(appId).all<{ report_kind: string; warnings_json: string }>();
  const warnings = new Map<string, { report_kind: string } & PlayStatsWarning>();
  for (const w of warned.results) {
    let list: PlayStatsWarning[] = [];
    try { list = JSON.parse(w.warnings_json) as PlayStatsWarning[]; } catch { list = []; }
    for (const item of list) warnings.set(`${w.report_kind}:${item.code}:${item.column ?? ""}`, { report_kind: w.report_kind, ...item });
  }
  const schedule = await db.prepare(
    "SELECT last_run_at, last_error_code FROM google_play_stats_ingest_schedule WHERE app_id = ?1",
  ).bind(appId).first<{ last_run_at: number | null; last_error_code: string | null }>();
  const bucket = await getPlayStatsBucket(db, appId);

  return {
    daily,
    totals,
    ingest: {
      stats_bucket: bucket,
      files_processed: Number(files?.complete ?? 0),
      files_incomplete: Number(files?.incomplete ?? 0),
      files_failed: Number(files?.failed ?? 0),
      files_over_limit: Number(files?.over_limit ?? 0),
      last_processed_at: files?.last_processed_at ?? null,
      latest_data_date: latestDate?.d ?? null,
      last_run_at: schedule?.last_run_at ?? null,
      last_error_code: schedule?.last_error_code ?? null,
      hint: playStatsBucketHint(bucket, schedule?.last_error_code ?? null),
      problems: problems.results,
      warnings: [...warnings.values()],
    },
    note: PLAY_STATS_NOTE,
  };
}
