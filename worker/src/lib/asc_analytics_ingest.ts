/**
 * App Store Connect Analytics Reports ingestion.
 *
 * Chain (all reads, never writes on the Apple side):
 *   GET /v1/apps/{app}/analyticsReportRequests
 *   → GET /v1/analyticsReportRequests/{id}/reports   (matched by exact report name)
 *   → GET /v1/analyticsReports/{id}/instances?filter[granularity]=DAILY
 *   → GET /v1/analyticsReportInstances/{id}/segments
 *   → download each segment's pre-signed `url` (gzip TSV with a header row).
 *
 * The segment URL is pre-signed: it is fetched with no Authorization header,
 * only over https to an Apple host, and redirects are re-checked against the
 * same allowlist. URLs are never logged or stored.
 *
 * Each instance is written atomically as per-instance rows; readers pick one
 * instance per (report, date), so re-running or overlapping ONGOING and
 * ONE_TIME_SNAPSHOT instances never double count. That rule assumes each
 * instance fully restates the dates it contains (see queryAscAnalyticsDaily). A complete instance is never
 * read again; an incomplete (mapping lost data) or failed one is retried at
 * most every INSTANCE_RETRY_MS.
 */
import { createHash } from "node:crypto";
import { ASC_API_BASE, AscApiError, ascRequest, type AscApiCredentials } from "./asc_api";
import { getAscCredentials } from "./asc_credentials";

export const ASC_ANALYTICS_METRICS = [
  "downloads_first_time",
  "downloads_redownload",
  "installations",
  "deletions",
  "sessions",
  "active_devices",
] as const;
export type AscAnalyticsMetric = (typeof ASC_ANALYTICS_METRICS)[number];

/** Shown with every App Store analytics number in the API and CLI. */
export const ASC_ANALYTICS_NOTE =
  "From App Store Connect Analytics Reports. App usage numbers (installations, deletions, sessions, active devices) " +
  "only include users who agreed to share analytics with developers, and Apple drops rows below its privacy " +
  "thresholds, so all figures are lower than App Store Connect's own totals. Data arrives one to two days late. " +
  "active_devices adds up Apple's per-row Unique Devices, so a device seen in several rows (for example on two app " +
  "versions) counts more than once; it is not additive across days.";

/**
 * Explicit column mapping for the reports Hands reads. Column names and values
 * are matched case-insensitively after trimming. A missing column is a recorded
 * warning, never a guess.
 */
type Names = readonly [string, ...string[]];
type ValueColumnsMapping = {
  kind: "value_columns";
  columns: Array<{ metric: AscAnalyticsMetric; names: Names }>;
};
type ClassifiedMapping = {
  kind: "classified";
  classifier: Names;
  count: Names;
  /** Lower-cased classifier value → metric; null means a known value Hands does not count. */
  values: Record<string, AscAnalyticsMetric | null>;
};
export type AscReportMapping = {
  name: string;
  date: Names;
  territory: Names;
  mapping: ValueColumnsMapping | ClassifiedMapping;
};

export const ASC_ANALYTICS_REPORTS: AscReportMapping[] = [
  {
    name: "App Downloads Standard",
    date: ["Date"],
    territory: ["Territory"],
    mapping: {
      kind: "classified",
      classifier: ["Download Type"],
      count: ["Counts", "Count"],
      values: {
        "first-time download": "downloads_first_time",
        redownload: "downloads_redownload",
        "auto-update": null,
        "manual update": null,
        restore: null,
      },
    },
  },
  {
    name: "App Store Installation and Deletion Standard",
    date: ["Date"],
    territory: ["Territory"],
    mapping: {
      kind: "classified",
      classifier: ["Event"],
      count: ["Counts", "Count"],
      values: { install: "installations", delete: "deletions" },
    },
  },
  {
    name: "App Sessions Standard",
    date: ["Date"],
    territory: ["Territory"],
    mapping: {
      kind: "value_columns",
      columns: [
        { metric: "sessions", names: ["Sessions"] },
        { metric: "active_devices", names: ["Unique Devices"] },
      ],
    },
  },
];

const REPORT_CATEGORIES = "APP_USAGE,APP_STORE_COMMERCE,APP_STORE_ENGAGEMENT";

export type IngestWarning = {
  code: "missing_column" | "unmapped_value" | "invalid_rows" | "checksum_missing" | "checksum_unverified";
  column?: string;
  metric?: string;
  values?: string[];
  count?: number;
};

export class AscIngestError extends Error {
  constructor(public code: string, public host: string | null = null) {
    super(code);
  }
}

// ---------- TSV parsing ----------

function cell(raw: string | undefined): string {
  let v = (raw ?? "").trim();
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1).replace(/""/g, '"');
  return v;
}

function findColumn(header: string[], names: readonly string[]): number {
  const wanted = names.map((n) => n.toLowerCase());
  return header.findIndex((h) => wanted.includes(h.toLowerCase()));
}

/** Sums one report's rows into `${date}\t${metric}\t${territory}` → value. */
export class ReportAggregator {
  readonly values = new Map<string, number>();
  private readonly warnings = new Map<string, IngestWarning>();
  private readonly unmapped = new Map<string, Set<string>>();
  private invalidRows = 0;
  rows = 0;

  constructor(readonly report: AscReportMapping) {}

  private warn(w: IngestWarning) {
    this.warnings.set(`${w.code}:${w.column ?? ""}:${w.metric ?? ""}`, w);
  }

  /** Returns a row consumer for this header, or null when the segment is unusable. */
  header(columns: string[]): ((fields: string[]) => void) | null {
    const header = columns.map(cell).map((h) => h.replace(/^﻿/, ""));
    const r = this.report;
    const dateIdx = findColumn(header, r.date);
    if (dateIdx < 0) {
      this.warn({ code: "missing_column", column: r.date[0] });
      return null;
    }
    const territoryIdx = findColumn(header, r.territory);
    if (territoryIdx < 0) this.warn({ code: "missing_column", column: r.territory[0] });
    const add = (date: string, metric: AscAnalyticsMetric, territory: string, raw: string) => {
      const n = Number(raw.replace(/,/g, ""));
      if (raw === "" || !Number.isFinite(n)) {
        this.invalidRows++;
        return;
      }
      const key = `${date}\t${metric}\t${territory}`;
      this.values.set(key, (this.values.get(key) ?? 0) + Math.round(n));
    };
    const rowStart = (fields: string[]) => {
      const date = cell(fields[dateIdx]);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        this.invalidRows++;
        return null;
      }
      this.rows++;
      return { date, territory: territoryIdx >= 0 ? cell(fields[territoryIdx]) : "" };
    };

    const m = r.mapping;
    if (m.kind === "value_columns") {
      const cols = m.columns
        .map((c) => ({ metric: c.metric, idx: findColumn(header, c.names), name: c.names[0] }))
        .filter((c) => {
          if (c.idx < 0) this.warn({ code: "missing_column", column: c.name, metric: c.metric });
          return c.idx >= 0;
        });
      if (cols.length === 0) return null;
      return (fields) => {
        const row = rowStart(fields);
        if (!row) return;
        for (const c of cols) add(row.date, c.metric, row.territory, cell(fields[c.idx]));
      };
    }
    const classIdx = findColumn(header, m.classifier);
    const countIdx = findColumn(header, m.count);
    if (classIdx < 0) this.warn({ code: "missing_column", column: m.classifier[0] });
    if (countIdx < 0) this.warn({ code: "missing_column", column: m.count[0] });
    if (classIdx < 0 || countIdx < 0) return null;
    return (fields) => {
      const row = rowStart(fields);
      if (!row) return;
      const value = cell(fields[classIdx]);
      const lower = value.toLowerCase();
      if (!(lower in m.values)) {
        const seen = this.unmapped.get(m.classifier[0]) ?? new Set<string>();
        if (seen.size < 10) seen.add(value.slice(0, 60));
        this.unmapped.set(m.classifier[0], seen);
        return;
      }
      const metric = m.values[lower];
      if (metric) add(row.date, metric, row.territory, cell(fields[countIdx]));
    };
  }

  /** Segment-level warnings (e.g. a checksum Hands could not check). */
  note(w: IngestWarning) {
    this.warn(w);
  }

  warningList(): IngestWarning[] {
    const out = [...this.warnings.values()];
    for (const [column, values] of this.unmapped) out.push({ code: "unmapped_value", column, values: [...values] });
    if (this.invalidRows > 0) out.push({ code: "invalid_rows", count: this.invalidRows });
    return out;
  }
}

/**
 * Byte accounting shared by every segment of one instance, so the limits bound
 * the whole instance and not each file separately.
 */
export type ByteMeter = { compressed: number; text: number; maxCompressed: number; maxText: number };
export const newMeter = (maxCompressed: number, maxText: number): ByteMeter => ({ compressed: 0, text: 0, maxCompressed, maxText });

/** Codes that mean an instance is larger than Hands will read, not that it is broken. */
export const LIMIT_CODES = new Set(["segment_limit", "segment_bytes_limit", "segment_text_limit"]);

/**
 * Parse one decompressed TSV text stream (header row first) into the aggregator,
 * line by line: only the current chunk and one partial line are held in memory.
 */
export async function parseTsvStream(
  text: ReadableStream<string>,
  agg: ReportAggregator,
  meter: ByteMeter = newMeter(Infinity, 64 * 1024 * 1024),
): Promise<void> {
  let buffer = "";
  let consume: ((fields: string[]) => void) | null | undefined;
  const line = (raw: string) => {
    const l = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (l === "") return;
    const fields = l.split("\t");
    if (consume === undefined) consume = agg.header(fields);
    else if (consume) consume(fields);
  };
  const reader = text.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    meter.text += value.length;
    if (meter.text > meter.maxText) {
      await reader.cancel().catch(() => undefined);
      throw new AscIngestError("segment_text_limit");
    }
    const chunk = buffer + value;
    let start = 0;
    let nl: number;
    while ((nl = chunk.indexOf("\n", start)) >= 0) {
      line(chunk.slice(start, nl));
      start = nl + 1;
    }
    buffer = chunk.slice(start);
  }
  line(buffer);
}

// ---------- Segment download ----------

/** Pre-signed segment URLs must be https on apple.com or a subdomain of it. */
export function segmentUrlHost(raw: string): { ok: true; url: URL } | { ok: false; host: string | null } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, host: null };
  }
  const host = url.hostname.toLowerCase();
  const apple = host === "apple.com" || host.endsWith(".apple.com");
  if (url.protocol !== "https:" || !apple || url.username || url.password || (url.port && url.port !== "443")) {
    return { ok: false, host: host || null };
  }
  return { ok: true, url };
}

const MAX_REDIRECTS = 3;

/**
 * How to check Apple's segment `checksum`. Apple documents it as the checksum
 * of the downloaded (still gzip-compressed) file; a 32-hex-digit value is read
 * as MD5 and a 64-hex-digit one as SHA-256. Any other shape is not guessed:
 * it is recorded as `checksum_unverified`, and an absent value as
 * `checksum_missing`, so an unchecked segment is never silent.
 */
export function checksumAlgorithm(checksum: string | null | undefined): "md5" | "sha256" | "missing" | "unknown" {
  const v = (checksum ?? "").trim();
  if (!v) return "missing";
  if (/^[0-9a-f]{32}$/i.test(v)) return "md5";
  if (/^[0-9a-f]{64}$/i.test(v)) return "sha256";
  return "unknown";
}

/**
 * Download a pre-signed segment with no credentials. Redirects are followed by
 * hand so every hop is checked against the host allowlist.
 */
export async function fetchSegmentInto(
  rawUrl: string,
  agg: ReportAggregator,
  meter: ByteMeter,
  checksum?: string | null,
): Promise<void> {
  const algorithm = checksumAlgorithm(checksum);
  if (algorithm === "missing") agg.note({ code: "checksum_missing" });
  if (algorithm === "unknown") agg.note({ code: "checksum_unverified" });
  let current = rawUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const checked = segmentUrlHost(current);
    if (!checked.ok) throw new AscIngestError("segment_host_not_allowed", checked.host);
    const res = await fetch(checked.url.toString(), { method: "GET", redirect: "manual" });
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      await res.body?.cancel().catch(() => undefined);
      if (!location) throw new AscIngestError("segment_redirect_invalid", checked.url.hostname);
      current = new URL(location, checked.url).toString();
      continue;
    }
    if (!res.ok || !res.body) {
      await res.body?.cancel().catch(() => undefined);
      throw new AscIngestError(`segment_http_${res.status}`, checked.url.hostname);
    }
    // Hash the compressed bytes as they stream past, then compare once the body is read.
    // The same pass counts compressed bytes against the instance limit.
    const hash = algorithm === "md5" || algorithm === "sha256" ? createHash(algorithm) : null;
    const hashed = res.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        meter.compressed += chunk.byteLength;
        if (meter.compressed > meter.maxCompressed) throw new AscIngestError("segment_bytes_limit");
        hash?.update(chunk);
        controller.enqueue(chunk);
      },
    }));
    const text = hashed
      .pipeThrough(new DecompressionStream("gzip") as unknown as ReadableWritablePair<Uint8Array, Uint8Array>)
      .pipeThrough(new TextDecoderStream() as unknown as ReadableWritablePair<string, Uint8Array>);
    try {
      await parseTsvStream(text, agg, meter);
    } catch (err) {
      if (err instanceof AscIngestError) throw err;
      // An error thrown in the counting transform reaches us wrapped by the pipe.
      if (meter.compressed > meter.maxCompressed) throw new AscIngestError("segment_bytes_limit");
      throw new AscIngestError("segment_decode_failed", checked.url.hostname);
    }
    if (hash && hash.digest("hex") !== (checksum ?? "").trim().toLowerCase()) {
      throw new AscIngestError("segment_checksum_mismatch", checked.url.hostname);
    }
    return;
  }
  throw new AscIngestError("segment_too_many_redirects");
}

// ---------- App Store Connect listing ----------

type Page<T> = { data?: T[]; links?: { next?: string } };

/** GET every page of an ASC collection, following links.next only on the ASC API origin. */
export async function ascGetAll<T>(creds: AscApiCredentials, path: string, maxPages: number): Promise<{ items: T[]; truncated: boolean }> {
  const items: T[] = [];
  let next: string | null = path;
  for (let page = 0; next && page < maxPages; page++) {
    const res: Page<T> = await ascRequest<Page<T>>(creds, "GET", next);
    items.push(...(res.data ?? []));
    const link = res.links?.next;
    next = null;
    if (link) {
      // Parse and compare the origin exactly: the JWT must only ever go to the ASC API.
      let parsed: URL;
      try {
        parsed = new URL(link);
      } catch {
        throw new AscIngestError("asc_next_link_invalid");
      }
      if (parsed.origin !== new URL(ASC_API_BASE).origin) throw new AscIngestError("asc_next_link_invalid");
      next = `${parsed.pathname}${parsed.search}`;
    }
  }
  return { items, truncated: next !== null };
}

export type IngestBudget = {
  /** New instances to ingest in one call. */
  maxInstances: number;
  /** An instance with more segments than this is skipped this run (recorded as failed). */
  maxSegmentsPerInstance: number;
  /** Compressed bytes per instance (Apple's sizeInBytes is checked first, then actual bytes). */
  maxInstanceBytes: number;
  /** Decompressed characters per instance. */
  maxInstanceChars: number;
  /** Decompressed characters per call: once spent, remaining instances wait for the next run. */
  maxRunChars: number;
  maxPages: number;
};

const MiB = 1024 * 1024;
export const SCHEDULED_BUDGET: IngestBudget = {
  maxInstances: 6,
  maxSegmentsPerInstance: 50,
  maxInstanceBytes: 32 * MiB,
  maxInstanceChars: 128 * MiB,
  maxRunChars: 192 * MiB,
  maxPages: 10,
};

export type IngestSummary = {
  status: "ok" | "not_configured" | "bundle_id_missing" | "asc_app_not_found";
  asc_app_id: string | null;
  requests: number;
  reports_matched: Array<{ report_id: string; name: string }>;
  instances_seen: number;
  instances_already_processed: number;
  /** Instances skipped because they are still waiting for their retry time. */
  instances_deferred: number;
  instances_processed: number;
  /** Written, but missing a required column or holding unmapped values: retried later. */
  instances_incomplete: Array<{ instance_id: string; code: string }>;
  instances_failed: Array<{ instance_id: string; code: string }>;
  /** Larger than the per-instance limits: nothing written, status over_limit. */
  instances_over_limit: Array<{ instance_id: string; code: string }>;
  rows_written: number;
  more_pending: boolean;
  warnings: Array<{ instance_id: string; report_name: string } & IngestWarning>;
};

function errorCode(err: unknown): string {
  if (err instanceof AscIngestError) return err.code;
  if (err instanceof AscApiError) return `asc_api_${err.status}`;
  return "unexpected";
}

/** Only whitelisted identifiers and codes are logged; never URLs, bodies or keys. */
function logFailure(appId: string, code: string, extra: { instance_id?: string; host?: string | null | undefined } = {}) {
  console.warn("hands_asc_analytics_ingest_failure", JSON.stringify({ app_id: appId, code, ...extra }));
}

async function resolveExactAscApp(creds: AscApiCredentials, bundleId: string): Promise<string | null> {
  const apps = await ascRequest<{ data?: Array<{ id: string; attributes?: { bundleId?: string } }> }>(creds, "GET",
    `/v1/apps?filter[bundleId]=${encodeURIComponent(bundleId)}&fields[apps]=bundleId&limit=50`);
  return (apps.data ?? []).find((a) => a.attributes?.bundleId === bundleId)?.id ?? null;
}

const INSERT_CHUNK = 500;

/** An incomplete or failed instance is retried at most this often. */
export const INSTANCE_RETRY_MS = 6 * 60 * 60 * 1000;

/**
 * Warnings that mean the mapping lost data for this report: a required column
 * is absent (anything but Territory, which only drops the breakdown) or rows
 * carried values Hands does not recognise. Such an instance stays retryable,
 * so a later mapping fix re-ingests it without a manual reprocess.
 */
export function blockingWarning(w: IngestWarning, mapping: AscReportMapping): boolean {
  if (w.code === "unmapped_value") return true;
  if (w.code !== "missing_column") return false;
  const territory = mapping.territory.map((n) => n.toLowerCase());
  return !territory.includes((w.column ?? "").toLowerCase());
}

/** Ingest new DAILY instances of the mapped reports for one Hands app. */
export async function ingestAscAnalyticsForApp(
  env: Pick<Env, "DB" | "ASC_CRED_ENC_KEY">,
  appId: string,
  budget: IngestBudget,
  now = Date.now(),
): Promise<IngestSummary> {
  const summary: IngestSummary = {
    status: "ok",
    asc_app_id: null,
    requests: 0,
    reports_matched: [],
    instances_seen: 0,
    instances_already_processed: 0,
    instances_deferred: 0,
    instances_processed: 0,
    instances_incomplete: [],
    instances_over_limit: [],
    instances_failed: [],
    rows_written: 0,
    more_pending: false,
    warnings: [],
  };
  if (!env.ASC_CRED_ENC_KEY) return { ...summary, status: "not_configured" };
  const creds = await getAscCredentials(env.DB, env.ASC_CRED_ENC_KEY, appId);
  if (!creds) return { ...summary, status: "not_configured" };
  const channel = await env.DB.prepare("SELECT bundle_id FROM channels WHERE app_id = ?1 AND slug = 'main' LIMIT 1")
    .bind(appId).first<{ bundle_id: string | null }>();
  const bundleId = channel?.bundle_id?.trim();
  if (!bundleId) return { ...summary, status: "bundle_id_missing" };
  const ascAppId = await resolveExactAscApp(creds, bundleId);
  if (!ascAppId) return { ...summary, status: "asc_app_not_found" };
  summary.asc_app_id = ascAppId;

  const requests = await ascGetAll<{ id: string }>(creds,
    `/v1/apps/${encodeURIComponent(ascAppId)}/analyticsReportRequests?limit=200`, budget.maxPages);
  summary.requests = requests.items.length;

  const byName = new Map(ASC_ANALYTICS_REPORTS.map((r) => [r.name, r]));
  const instances: Array<{ id: string; processingDate: string; reportId: string; mapping: AscReportMapping }> = [];
  const seen = new Set<string>();
  for (const request of requests.items) {
    const reports = await ascGetAll<{ id: string; attributes?: { name?: string } }>(creds,
      `/v1/analyticsReportRequests/${encodeURIComponent(request.id)}/reports?filter[category]=${REPORT_CATEGORIES}&limit=200`,
      budget.maxPages);
    for (const report of reports.items) {
      const mapping = byName.get(report.attributes?.name ?? "");
      if (!mapping) continue;
      summary.reports_matched.push({ report_id: report.id, name: mapping.name });
      const listed = await ascGetAll<{ id: string; attributes?: { granularity?: string; processingDate?: string } }>(creds,
        `/v1/analyticsReports/${encodeURIComponent(report.id)}/instances?filter[granularity]=DAILY&limit=200`,
        budget.maxPages);
      if (listed.truncated) summary.more_pending = true;
      for (const inst of listed.items) {
        if (seen.has(inst.id)) continue;
        seen.add(inst.id);
        const processingDate = inst.attributes?.processingDate ?? "";
        if (inst.attributes?.granularity && inst.attributes.granularity !== "DAILY") continue;
        instances.push({ id: inst.id, processingDate, reportId: report.id, mapping });
      }
    }
  }
  summary.instances_seen = instances.length;

  // Complete instances are never read again; incomplete or failed ones wait for next_attempt_at.
  const known = new Map((await env.DB.prepare(
    `SELECT instance_id, status FROM asc_analytics_instances
     WHERE app_id = ?1 AND (status = 'complete' OR next_attempt_at > ?2)`,
  ).bind(appId, now).all<{ instance_id: string; status: string }>()).results.map((r) => [r.instance_id, r.status]));
  const pending = instances.filter((i) => !known.has(i.id));
  for (const i of instances) {
    const status = known.get(i.id);
    if (status === "complete") summary.instances_already_processed++;
    else if (status) summary.instances_deferred++;
  }
  // Newest first, so a fresh connection fills the recent window before history.
  pending.sort((a, b) => b.processingDate.localeCompare(a.processingDate) || b.id.localeCompare(a.id));
  if (pending.length > budget.maxInstances) summary.more_pending = true;

  let runChars = 0;
  for (const inst of pending.slice(0, budget.maxInstances)) {
    // Bound CPU per call: once the decompressed-text budget is spent, the rest waits.
    if (runChars >= budget.maxRunChars) {
      summary.more_pending = true;
      break;
    }
    const meter = newMeter(budget.maxInstanceBytes, budget.maxInstanceChars);
    try {
      const segments = await ascGetAll<{ id: string; attributes?: { url?: string; checksum?: string; sizeInBytes?: number } }>(creds,
        `/v1/analyticsReportInstances/${encodeURIComponent(inst.id)}/segments?limit=200`,
        // Enough pages to see the whole cap however Apple pages it; truncation then really means over the cap.
        Math.max(budget.maxPages, budget.maxSegmentsPerInstance + 1));
      // Check Apple's declared sizes before downloading anything.
      if (segments.items.length > budget.maxSegmentsPerInstance || segments.truncated) {
        throw new AscIngestError("segment_limit");
      }
      const declared = segments.items.reduce((sum, seg) => sum + (Number(seg.attributes?.sizeInBytes) || 0), 0);
      if (declared > budget.maxInstanceBytes) throw new AscIngestError("segment_bytes_limit");
      const agg = new ReportAggregator(inst.mapping);
      try {
        for (const segment of segments.items) {
          const url = segment.attributes?.url;
          if (!url) throw new AscIngestError("segment_url_missing");
          await fetchSegmentInto(url, agg, meter, segment.attributes?.checksum);
        }
      } finally {
        runChars += meter.text;
      }
      const rows = [...agg.values].map(([key, value]) => {
        const [date, metric, territory] = key.split("\t");
        return { d: date, m: metric, t: territory, v: value };
      });
      const warnings = agg.warningList();
      const blocking = warnings.find((w) => blockingWarning(w, inst.mapping));
      const status = blocking ? "incomplete" : "complete";
      const lastError = blocking ? `${blocking.code}${blocking.column ? `:${blocking.column}` : ""}` : null;
      const totals = new Map<string, { d: string; m: string; v: number }>();
      for (const r of rows) {
        const key = `${r.d}\t${r.m}`;
        const t = totals.get(key) ?? { d: r.d!, m: r.m!, v: 0 };
        t.v += r.v;
        totals.set(key, t);
      }
      const statements = [
        env.DB.prepare("DELETE FROM asc_analytics_daily WHERE app_id = ?1 AND instance_id = ?2").bind(appId, inst.id),
        env.DB.prepare("DELETE FROM asc_analytics_daily_totals WHERE app_id = ?1 AND instance_id = ?2").bind(appId, inst.id),
      ];
      const totalRows = [...totals.values()];
      for (let i = 0; i < totalRows.length; i += INSERT_CHUNK) {
        statements.push(env.DB.prepare(
          `INSERT INTO asc_analytics_daily_totals (app_id, instance_id, report_name, processing_date, date, metric, value)
           SELECT ?1, ?2, ?3, ?4, json_extract(j.value, '$.d'), json_extract(j.value, '$.m'), json_extract(j.value, '$.v')
           FROM json_each(?5) j`,
        ).bind(appId, inst.id, inst.mapping.name, inst.processingDate, JSON.stringify(totalRows.slice(i, i + INSERT_CHUNK))));
      }
      for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
        statements.push(env.DB.prepare(
          `INSERT INTO asc_analytics_daily (app_id, instance_id, report_name, processing_date, date, metric, dimension_key, value)
           SELECT ?1, ?2, ?3, ?4, json_extract(j.value, '$.d'), json_extract(j.value, '$.m'),
                  json_extract(j.value, '$.t'), json_extract(j.value, '$.v')
           FROM json_each(?5) j`,
        ).bind(appId, inst.id, inst.mapping.name, inst.processingDate, JSON.stringify(rows.slice(i, i + INSERT_CHUNK))));
      }
      // Partial rows of an incomplete instance are kept (and shown with its warning);
      // the next attempt replaces them.
      statements.push(env.DB.prepare(
        `INSERT INTO asc_analytics_instances (app_id, instance_id, report_id, report_name, granularity, processing_date,
           segment_count, row_count, warnings_json, processed_at, status, attempts, last_error, next_attempt_at)
         VALUES (?1, ?2, ?3, ?4, 'DAILY', ?5, ?6, ?7, ?8, ?9, ?10, 1, ?11, ?12)
         ON CONFLICT(app_id, instance_id) DO UPDATE SET
           processing_date = excluded.processing_date, segment_count = excluded.segment_count,
           row_count = excluded.row_count, warnings_json = excluded.warnings_json, processed_at = excluded.processed_at,
           status = excluded.status, attempts = asc_analytics_instances.attempts + 1,
           last_error = excluded.last_error, next_attempt_at = excluded.next_attempt_at
         WHERE asc_analytics_instances.status <> 'complete'`,
      ).bind(appId, inst.id, inst.reportId, inst.mapping.name, inst.processingDate, segments.items.length, agg.rows,
        JSON.stringify(warnings), now, status, lastError, blocking ? now + INSTANCE_RETRY_MS : null));
      await env.DB.batch(statements);
      if (blocking) {
        summary.instances_incomplete.push({ instance_id: inst.id, code: lastError ?? blocking.code });
        logFailure(appId, blocking.code, { instance_id: inst.id });
      } else {
        summary.instances_processed++;
      }
      summary.rows_written += rows.length;
      for (const w of warnings) summary.warnings.push({ instance_id: inst.id, report_name: inst.mapping.name, ...w });
    } catch (err) {
      const code = errorCode(err);
      logFailure(appId, code, { instance_id: inst.id, host: err instanceof AscIngestError ? err.host : undefined });
      // Record the attempt so a permanently broken or oversized instance is retried
      // every few hours, not on every run; its earlier rows (if any) are left as they were.
      // Oversized instances get their own status so they are visible, not a silent loop.
      const overLimit = LIMIT_CODES.has(code);
      if (overLimit) summary.instances_over_limit.push({ instance_id: inst.id, code });
      else summary.instances_failed.push({ instance_id: inst.id, code });
      await env.DB.prepare(
        `INSERT INTO asc_analytics_instances (app_id, instance_id, report_id, report_name, granularity, processing_date,
           processed_at, status, attempts, last_error, next_attempt_at)
         VALUES (?1, ?2, ?3, ?4, 'DAILY', ?5, ?6, ?9, 1, ?7, ?8)
         ON CONFLICT(app_id, instance_id) DO UPDATE SET
           status = CASE WHEN ?9 = 'over_limit' THEN 'over_limit'
                         WHEN asc_analytics_instances.status = 'incomplete' THEN 'incomplete' ELSE 'failed' END,
           attempts = asc_analytics_instances.attempts + 1,
           last_error = excluded.last_error, next_attempt_at = excluded.next_attempt_at
         WHERE asc_analytics_instances.status <> 'complete'`,
      ).bind(appId, inst.id, inst.reportId, inst.mapping.name, inst.processingDate, now, code, now + INSTANCE_RETRY_MS,
        overLimit ? "over_limit" : "failed")
        .run().catch(() => undefined);
    }
  }
  return summary;
}

const RUN_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** One app per five-minute tick, so one tenant's reports never share a tick's CPU with another's. */
const APPS_PER_TICK = 1;

/** Cron entry: a few apps per tick, each isolated; persisted rotation like the Play poll. */
export async function pollAscAnalytics(env: Env, now = Date.now()) {
  if (!env.ASC_CRED_ENC_KEY) return;
  await env.DB.prepare(`INSERT OR IGNORE INTO asc_analytics_ingest_schedule (app_id, next_run_at)
    SELECT c.app_id, 0 FROM app_asc_credentials c JOIN apps a ON a.id = c.app_id WHERE a.archived = 0`).run();
  const { results } = await env.DB.prepare(`SELECT s.app_id, s.next_run_at FROM asc_analytics_ingest_schedule s
    JOIN app_asc_credentials c ON c.app_id = s.app_id JOIN apps a ON a.id = s.app_id
    WHERE s.next_run_at <= ?1 AND a.archived = 0 ORDER BY s.next_run_at, s.app_id LIMIT ?2`)
    .bind(now, APPS_PER_TICK).all<{ app_id: string; next_run_at: number }>();
  for (const row of results) {
    const claim = await env.DB.prepare(`UPDATE asc_analytics_ingest_schedule SET next_run_at = ?1
      WHERE app_id = ?2 AND next_run_at = ?3`).bind(now + RUN_INTERVAL_MS, row.app_id, row.next_run_at).run();
    if (claim.meta.changes !== 1) continue;
    let next = now + RUN_INTERVAL_MS;
    let code: string | null = null;
    try {
      const summary = await ingestAscAnalyticsForApp(env, row.app_id, SCHEDULED_BUDGET, now);
      if (summary.status !== "ok") code = summary.status;
      else code = summary.instances_failed[0]?.code ?? summary.instances_over_limit[0]?.code
        ?? summary.instances_incomplete[0]?.code ?? null;
      // Backlog left: continue on the next five-minute slot instead of in six hours.
      if (summary.more_pending && summary.instances_processed > 0) next = (Math.floor(now / 300_000) + 1) * 300_000;
    } catch (err) {
      code = errorCode(err);
      logFailure(row.app_id, code);
    }
    await env.DB.prepare(`UPDATE asc_analytics_ingest_schedule SET next_run_at = ?1, last_run_at = ?2, last_error_code = ?3
      WHERE app_id = ?4`).bind(next, now, code, row.app_id).run().catch(() => undefined);
  }
}

// ---------- Reading ----------

export type AscDailyRow = { date: string } & Record<AscAnalyticsMetric, number | null>;

const ADDITIVE: AscAnalyticsMetric[] = ["downloads_first_time", "downloads_redownload", "installations", "deletions", "sessions"];

/**
 * Reads the per-instance daily totals (already summed over territories). The
 * winner is chosen once per (report, date) with a window function over a
 * covering-index scan, then joined back on the primary key; no correlated
 * subquery. ?1 = app id, ?2 = first date.
 */
export const ASC_DAILY_SQL = `WITH winners AS (
  SELECT report_name, date, instance_id FROM (
    SELECT report_name, date, instance_id,
           ROW_NUMBER() OVER (PARTITION BY report_name, date ORDER BY processing_date DESC, instance_id DESC) AS rn
    FROM (SELECT DISTINCT report_name, date, instance_id, processing_date
          FROM asc_analytics_daily_totals WHERE app_id = ?1 AND date >= ?2))
  WHERE rn = 1
)
SELECT t.date AS date, t.metric AS metric, SUM(t.value) AS value
FROM winners w
JOIN asc_analytics_daily_totals t ON t.app_id = ?1 AND t.instance_id = w.instance_id AND t.date = w.date
GROUP BY t.date, t.metric
ORDER BY t.date`;

/**
 * Daily App Store metrics since `sinceDate` (YYYY-MM-DD, inclusive). For each
 * (report, date) only the instance with the latest processing date counts.
 *
 * ASSUMPTION (verify against the first real instances): an instance that
 * contains a date restates that whole date for its report, so the latest
 * instance can replace earlier ones for that date. If Apple instead split one
 * date across several instances (each holding only part of the rows), this
 * rule would undercount that date, and the selection would have to become a
 * union of instances per date.
 */
export async function queryAscAnalyticsDaily(db: D1Database, appId: string, sinceDate: string) {
  const { results } = await db.prepare(
    ASC_DAILY_SQL,
  ).bind(appId, sinceDate).all<{ date: string; metric: string; value: number }>();
  const byDate = new Map<string, AscDailyRow>();
  for (const r of results) {
    if (!(ASC_ANALYTICS_METRICS as readonly string[]).includes(r.metric)) continue;
    let row = byDate.get(r.date);
    if (!row) {
      row = { date: r.date, ...Object.fromEntries(ASC_ANALYTICS_METRICS.map((m) => [m, null])) } as AscDailyRow;
      byDate.set(r.date, row);
    }
    row[r.metric as AscAnalyticsMetric] = Number(r.value);
  }
  const daily = [...byDate.values()];
  const totals: Record<string, number | null> = {};
  for (const m of ADDITIVE) {
    const vals = daily.map((d) => d[m]).filter((v): v is number => v !== null);
    totals[m] = vals.length ? vals.reduce((a, b) => a + b, 0) : null;
  }
  const devices = daily.map((d) => d.active_devices).filter((v): v is number => v !== null);
  totals.active_devices_peak_daily = devices.length ? Math.max(...devices) : null;

  const ingest = await db.prepare(
    `SELECT SUM(CASE WHEN status = 'complete' THEN 1 ELSE 0 END) AS instances,
            SUM(CASE WHEN status = 'incomplete' THEN 1 ELSE 0 END) AS incomplete,
            SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
            SUM(CASE WHEN status = 'over_limit' THEN 1 ELSE 0 END) AS over_limit,
            MAX(CASE WHEN status IN ('complete', 'incomplete') THEN processed_at END) AS last_processed_at,
            MAX(CASE WHEN status IN ('complete', 'incomplete') THEN processing_date END) AS latest_processing_date
     FROM asc_analytics_instances WHERE app_id = ?1`,
  ).bind(appId).first<{ instances: number | null; incomplete: number | null; failed: number | null; over_limit: number | null;
    last_processed_at: number | null; latest_processing_date: string | null }>();
  const warned = await db.prepare(
    `SELECT report_name, warnings_json FROM asc_analytics_instances
     WHERE app_id = ?1 AND warnings_json <> '[]' ORDER BY processed_at DESC LIMIT 20`,
  ).bind(appId).all<{ report_name: string; warnings_json: string }>();
  const warnings = new Map<string, { report_name: string } & IngestWarning>();
  for (const w of warned.results) {
    let list: IngestWarning[] = [];
    try { list = JSON.parse(w.warnings_json) as IngestWarning[]; } catch { list = []; }
    for (const item of list) warnings.set(`${w.report_name}:${item.code}:${item.column ?? ""}`, { report_name: w.report_name, ...item });
  }
  const schedule = await db.prepare(
    "SELECT last_run_at, last_error_code FROM asc_analytics_ingest_schedule WHERE app_id = ?1",
  ).bind(appId).first<{ last_run_at: number | null; last_error_code: string | null }>();

  return {
    daily,
    totals,
    ingest: {
      instances_processed: Number(ingest?.instances ?? 0),
      /** Written with a blocking warning; retried automatically. */
      instances_incomplete: Number(ingest?.incomplete ?? 0),
      /** Not written (download, checksum or API failure); retried automatically. */
      instances_failed: Number(ingest?.failed ?? 0),
      /** Larger than Hands reads per instance (segments or bytes); last_error says which. */
      instances_over_limit: Number(ingest?.over_limit ?? 0),
      last_processed_at: ingest?.last_processed_at ?? null,
      latest_processing_date: ingest?.latest_processing_date ?? null,
      last_run_at: schedule?.last_run_at ?? null,
      last_error_code: schedule?.last_error_code ?? null,
      warnings: [...warnings.values()],
    },
    note: ASC_ANALYTICS_NOTE,
  };
}
