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
 * Each instance is written once, atomically, as per-instance rows; readers pick
 * one instance per (report, date), so re-running or overlapping ONGOING and
 * ONE_TIME_SNAPSHOT instances never double count.
 */
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
  code: "missing_column" | "unmapped_value" | "invalid_rows";
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

  warningList(): IngestWarning[] {
    const out = [...this.warnings.values()];
    for (const [column, values] of this.unmapped) out.push({ code: "unmapped_value", column, values: [...values] });
    if (this.invalidRows > 0) out.push({ code: "invalid_rows", count: this.invalidRows });
    return out;
  }
}

/** Parse one decompressed TSV text stream (header row first) into the aggregator. */
export async function parseTsvStream(
  text: ReadableStream<string>,
  agg: ReportAggregator,
  maxChars = 64 * 1024 * 1024,
): Promise<void> {
  let buffer = "";
  let consume: ((fields: string[]) => void) | null | undefined;
  let total = 0;
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
    total += value.length;
    if (total > maxChars) {
      await reader.cancel().catch(() => undefined);
      throw new AscIngestError("segment_too_large");
    }
    buffer += value;
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      line(buffer.slice(0, nl));
      buffer = buffer.slice(nl + 1);
    }
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
 * Download a pre-signed segment with no credentials. Redirects are followed by
 * hand so every hop is checked against the host allowlist.
 */
export async function fetchSegmentInto(rawUrl: string, agg: ReportAggregator, maxChars?: number): Promise<void> {
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
    const text = res.body
      .pipeThrough(new DecompressionStream("gzip") as unknown as ReadableWritablePair<Uint8Array, Uint8Array>)
      .pipeThrough(new TextDecoderStream() as unknown as ReadableWritablePair<string, Uint8Array>);
    try {
      await parseTsvStream(text, agg, maxChars);
    } catch (err) {
      if (err instanceof AscIngestError) throw err;
      throw new AscIngestError("segment_decode_failed", checked.url.hostname);
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
      if (!link.startsWith(`${ASC_API_BASE}/`)) throw new AscIngestError("asc_next_link_invalid");
      next = link.slice(ASC_API_BASE.length);
    }
  }
  return { items, truncated: next !== null };
}

export type IngestBudget = {
  /** New instances to ingest in one call. */
  maxInstances: number;
  /** An instance with more segments than this is skipped this run (recorded as failed). */
  maxSegmentsPerInstance: number;
  maxPages: number;
  maxSegmentChars?: number;
};

export const SCHEDULED_BUDGET: IngestBudget = { maxInstances: 6, maxSegmentsPerInstance: 8, maxPages: 10 };

export type IngestSummary = {
  status: "ok" | "not_configured" | "bundle_id_missing" | "asc_app_not_found";
  asc_app_id: string | null;
  requests: number;
  reports_matched: Array<{ report_id: string; name: string }>;
  instances_seen: number;
  instances_already_processed: number;
  instances_processed: number;
  instances_failed: Array<{ instance_id: string; code: string }>;
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
    instances_processed: 0,
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

  const done = new Set((await env.DB.prepare("SELECT instance_id FROM asc_analytics_instances WHERE app_id = ?1")
    .bind(appId).all<{ instance_id: string }>()).results.map((r) => r.instance_id));
  const pending = instances.filter((i) => !done.has(i.id));
  summary.instances_already_processed = instances.length - pending.length;
  // Newest first, so a fresh connection fills the recent window before history.
  pending.sort((a, b) => b.processingDate.localeCompare(a.processingDate) || b.id.localeCompare(a.id));
  if (pending.length > budget.maxInstances) summary.more_pending = true;

  for (const inst of pending.slice(0, budget.maxInstances)) {
    try {
      const segments = await ascGetAll<{ id: string; attributes?: { url?: string } }>(creds,
        `/v1/analyticsReportInstances/${encodeURIComponent(inst.id)}/segments?limit=200`, budget.maxPages);
      if (segments.items.length > budget.maxSegmentsPerInstance || segments.truncated) {
        throw new AscIngestError("too_many_segments");
      }
      const agg = new ReportAggregator(inst.mapping);
      for (const segment of segments.items) {
        const url = segment.attributes?.url;
        if (!url) throw new AscIngestError("segment_url_missing");
        await fetchSegmentInto(url, agg, budget.maxSegmentChars);
      }
      const rows = [...agg.values].map(([key, value]) => {
        const [date, metric, territory] = key.split("\t");
        return { d: date, m: metric, t: territory, v: value };
      });
      const warnings = agg.warningList();
      const statements = [
        env.DB.prepare("DELETE FROM asc_analytics_daily WHERE app_id = ?1 AND instance_id = ?2").bind(appId, inst.id),
      ];
      for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
        statements.push(env.DB.prepare(
          `INSERT INTO asc_analytics_daily (app_id, instance_id, report_name, processing_date, date, metric, dimension_key, value)
           SELECT ?1, ?2, ?3, ?4, json_extract(j.value, '$.d'), json_extract(j.value, '$.m'),
                  json_extract(j.value, '$.t'), json_extract(j.value, '$.v')
           FROM json_each(?5) j`,
        ).bind(appId, inst.id, inst.mapping.name, inst.processingDate, JSON.stringify(rows.slice(i, i + INSERT_CHUNK))));
      }
      statements.push(env.DB.prepare(
        `INSERT INTO asc_analytics_instances (app_id, instance_id, report_id, report_name, granularity, processing_date,
           segment_count, row_count, warnings_json, processed_at)
         VALUES (?1, ?2, ?3, ?4, 'DAILY', ?5, ?6, ?7, ?8, ?9)
         ON CONFLICT(app_id, instance_id) DO NOTHING`,
      ).bind(appId, inst.id, inst.reportId, inst.mapping.name, inst.processingDate, segments.items.length, agg.rows,
        JSON.stringify(warnings), now));
      await env.DB.batch(statements);
      summary.instances_processed++;
      summary.rows_written += rows.length;
      for (const w of warnings) summary.warnings.push({ instance_id: inst.id, report_name: inst.mapping.name, ...w });
    } catch (err) {
      const code = errorCode(err);
      summary.instances_failed.push({ instance_id: inst.id, code });
      logFailure(appId, code, { instance_id: inst.id, host: err instanceof AscIngestError ? err.host : undefined });
    }
  }
  return summary;
}

const RUN_INTERVAL_MS = 6 * 60 * 60 * 1000;
const APPS_PER_TICK = 2;

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
      else code = summary.instances_failed[0]?.code ?? null;
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
 * Daily App Store metrics since `sinceDate` (YYYY-MM-DD, inclusive). For each
 * (report, date) only the instance with the latest processing date counts.
 */
export async function queryAscAnalyticsDaily(db: D1Database, appId: string, sinceDate: string) {
  const { results } = await db.prepare(
    `SELECT d.date AS date, d.metric AS metric, SUM(d.value) AS value
     FROM asc_analytics_daily d
     WHERE d.app_id = ?1 AND d.date >= ?2
       AND d.instance_id = (
         SELECT d2.instance_id FROM asc_analytics_daily d2
         WHERE d2.app_id = d.app_id AND d2.report_name = d.report_name AND d2.date = d.date
         ORDER BY d2.processing_date DESC, d2.instance_id DESC LIMIT 1)
     GROUP BY d.date, d.metric
     ORDER BY d.date`,
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
    `SELECT COUNT(*) AS instances, MAX(processed_at) AS last_processed_at, MAX(processing_date) AS latest_processing_date
     FROM asc_analytics_instances WHERE app_id = ?1`,
  ).bind(appId).first<{ instances: number; last_processed_at: number | null; latest_processing_date: string | null }>();
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
      last_processed_at: ingest?.last_processed_at ?? null,
      latest_processing_date: ingest?.latest_processing_date ?? null,
      last_run_at: schedule?.last_run_at ?? null,
      last_error_code: schedule?.last_error_code ?? null,
      warnings: [...warnings.values()],
    },
    note: ASC_ANALYTICS_NOTE,
  };
}
