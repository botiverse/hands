/**
 * Read-only access to the Play Console statistics export bucket.
 *
 * This is the narrowest surface that lets Hands ingest the monthly install and
 * store-performance CSVs without the Worker ever holding a Google token:
 *
 *  - the token is minted here with only devstorage.read_only;
 *  - every request is a GET to https://storage.googleapis.com, built here from
 *    validated parts (the caller never supplies a URL, path or prefix);
 *  - the bucket must look like a Play Console export bucket
 *    (pubsite_prod_<digits> or pubsite_prod_rev_<digits>);
 *  - only objects under stats/installs/ and stats/store_performance/ whose name
 *    carries the bound package can be listed or read;
 *  - reads are size-bounded and pinned to one object generation;
 *  - redirects are never followed.
 *
 * Errors carry adapter-chosen codes only; Google's bodies never leave here.
 */
import { PlayAdapterError } from "./errors";

export const STATS_BUCKET = /^pubsite_prod_(rev_)?[0-9]{1,30}$/;
export const STATS_REPORTS = ["installs", "store_performance"] as const;
export type StatsReport = (typeof STATS_REPORTS)[number];
/** Hard ceiling regardless of what the caller asks for. */
export const MAX_STATS_OBJECT_BYTES = 8 * 1024 * 1024;
export const MAX_STATS_LIST_PAGES = 10;
const GCS_ORIGIN = "https://storage.googleapis.com";
const PACKAGE_NAME = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/;
const GENERATION = /^[0-9]{1,19}$/;
const MD5_B64 = /^[A-Za-z0-9+/]{22}==$/;

export type StatsObject = {
  name: string;
  generation: string;
  /** Base64 MD5 of the object bytes, as Cloud Storage reports it (may be absent for composite objects). */
  md5_hash: string | null;
  size: number;
  updated: string | null;
};

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** stats/<report>/<report>_<package>_<YYYYMM>_<dimension>.csv, for exactly this package. */
export function statsObjectPattern(report: StatsReport, packageName: string): RegExp {
  return new RegExp(`^stats/${report}/${report}_${escapeRegex(packageName)}_[0-9]{6}_[a-z_]{1,40}\\.csv$`);
}

export function statsPrefix(report: StatsReport, packageName: string): string {
  return `stats/${report}/${report}_${packageName}_`;
}

export function statsBucketInput(value: unknown): string {
  if (typeof value !== "string" || !STATS_BUCKET.test(value)) {
    throw new PlayAdapterError(400, "play_reports_bucket_invalid", "Play reports bucket must be pubsite_prod_<digits> or pubsite_prod_rev_<digits>");
  }
  return value;
}

export function statsReportInput(value: unknown): StatsReport {
  if (value !== "installs" && value !== "store_performance") {
    throw new PlayAdapterError(400, "play_reports_request_invalid", "Play report kind must be installs or store_performance");
  }
  return value;
}

export function statsPackageInput(value: unknown): string {
  const packageName = typeof value === "string" ? value.trim() : "";
  if (!PACKAGE_NAME.test(packageName)) {
    throw new PlayAdapterError(400, "package_name_invalid", "Google Play package name is invalid");
  }
  return packageName;
}

/** The object a caller may read: a stats CSV of the bound package, pinned to one generation. */
export function statsObjectInput(packageName: string, name: unknown, generation: unknown): { name: string; report: StatsReport; generation: string } {
  const invalid = () => new PlayAdapterError(403, "play_reports_object_not_allowed", "Only Play statistics CSVs of the bound package can be read");
  if (typeof name !== "string") throw invalid();
  const report = STATS_REPORTS.find((r) => statsObjectPattern(r, packageName).test(name));
  if (!report) throw invalid();
  if (typeof generation !== "string" || !GENERATION.test(generation)) {
    throw new PlayAdapterError(400, "play_reports_request_invalid", "Object generation is invalid");
  }
  return { name, report, generation };
}

function bucketError(status: number): PlayAdapterError {
  if (status === 401 || status === 403) {
    return new PlayAdapterError(403, "play_reports_bucket_forbidden", "Google Cloud Storage denied access to the Play reports bucket");
  }
  if (status === 404) {
    return new PlayAdapterError(403, "play_reports_bucket_not_found", "The Play reports bucket or object was not found");
  }
  if (status >= 300 && status < 400) {
    return new PlayAdapterError(502, "play_reports_redirect_refused", "Google Cloud Storage answered with a redirect, which is not followed");
  }
  return new PlayAdapterError(502, "play_reports_unavailable", `Google Cloud Storage request failed with ${status}`);
}

export class PlayStatsStorageClient {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly accessToken: string, fetchImpl: typeof fetch) {
    this.fetchImpl = (input, init) => fetchImpl(input, init);
  }

  private async get(url: URL): Promise<Response> {
    // Built here from validated parts; this check is a last line, not the validation.
    if (url.origin !== GCS_ORIGIN || url.username || url.password) {
      throw new PlayAdapterError(403, "play_reports_host_not_allowed", "Only storage.googleapis.com is allowed");
    }
    let response: Response;
    try {
      response = await this.fetchImpl(url.toString(), {
        method: "GET",
        headers: { authorization: `Bearer ${this.accessToken}` },
        redirect: "manual",
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      throw new PlayAdapterError(502, "play_reports_unavailable", "Google Cloud Storage request failed");
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw bucketError(response.status);
    }
    return response;
  }

  /** Every page of one report folder for one package, keeping only well-formed stats CSV entries. */
  async list(bucket: string, report: StatsReport, packageName: string, maxPages = MAX_STATS_LIST_PAGES): Promise<{ objects: StatsObject[]; truncated: boolean }> {
    const pattern = statsObjectPattern(report, packageName);
    const objects: StatsObject[] = [];
    let pageToken: string | null = null;
    let pages = 0;
    do {
      const url = new URL(`${GCS_ORIGIN}/storage/v1/b/${encodeURIComponent(bucket)}/o`);
      url.searchParams.set("prefix", statsPrefix(report, packageName));
      url.searchParams.set("fields", "items(name,generation,md5Hash,size,updated),nextPageToken");
      url.searchParams.set("maxResults", "1000");
      if (pageToken) url.searchParams.set("pageToken", pageToken);
      const response = await this.get(url);
      const body = await response.json().catch(() => null) as { items?: unknown; nextPageToken?: unknown } | null;
      if (!body || typeof body !== "object" || (body.items !== undefined && !Array.isArray(body.items))) {
        throw new PlayAdapterError(502, "play_reports_malformed", "Google Cloud Storage returned a malformed listing");
      }
      for (const raw of (body.items ?? []) as Array<Record<string, unknown>>) {
        const name = raw?.name;
        const generation = raw?.generation;
        const size = typeof raw?.size === "string" && /^[0-9]{1,15}$/.test(raw.size) ? Number(raw.size) : NaN;
        if (typeof name !== "string" || !pattern.test(name)) continue;
        if (typeof generation !== "string" || !GENERATION.test(generation) || !Number.isSafeInteger(size)) continue;
        objects.push({
          name,
          generation,
          md5_hash: typeof raw.md5Hash === "string" && MD5_B64.test(raw.md5Hash) ? raw.md5Hash : null,
          size,
          updated: typeof raw.updated === "string" && raw.updated.length <= 40 ? raw.updated : null,
        });
      }
      pageToken = typeof body.nextPageToken === "string" && body.nextPageToken ? body.nextPageToken : null;
      pages++;
    } while (pageToken && pages < maxPages);
    return { objects, truncated: pageToken !== null };
  }

  /** Download one generation of one object, refusing anything over maxBytes. */
  async read(bucket: string, name: string, generation: string, maxBytes: number): Promise<Uint8Array> {
    const url = new URL(`${GCS_ORIGIN}/storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(name)}`);
    url.searchParams.set("alt", "media");
    url.searchParams.set("generation", generation);
    const response = await this.get(url);
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > maxBytes) {
      await response.body?.cancel().catch(() => undefined);
      throw new PlayAdapterError(413, "play_reports_object_too_large", "Play statistics file exceeds the size limit");
    }
    if (!response.body) return new Uint8Array();
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new PlayAdapterError(413, "play_reports_object_too_large", "Play statistics file exceeds the size limit");
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  }
}
