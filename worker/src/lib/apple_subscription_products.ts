/** App-scoped App Store Connect subscription reconciliation. */
import { AscApiError, sameOriginAscPath, type UploadOperation } from "./asc_api";

type Obj = Record<string, unknown>;
type Resource = { id: string; attributes: Obj; relationships: Obj };
export type AscRequest = <T>(method: string, path: string, body?: unknown) => Promise<T>;
export interface AppleLocalization { locale: string; name: string; description?: string }
export interface ApplePrice { territory: string; customerPrice: string; preserveCurrentPrice: boolean }
export interface AppleProduct {
  group: { referenceName: string; localizations: Array<{ locale: string; name: string }> };
  productId: string; name: string; subscriptionPeriod: "ONE_MONTH" | "ONE_YEAR"; groupLevel: number;
  localizations: AppleLocalization[];
  prices?: ApplePrice[];
  screenshot?: { fileName: string; md5: string; sha256: string; bytes: Uint8Array };
}
export interface AppleChange { resource: string; action: "create" | "update" | "replace" | "unchanged" | "deferred"; before?: unknown; after?: unknown }
export interface AppleResult {
  product_id: string; mode: "dry_run" | "commit"; outcome: "planned" | "committed" | "no_changes" | "failed" | "pending";
  changes: AppleChange[]; completed: string[]; error?: { code: string; message: string };
}
export class ProductInputError extends Error { constructor(message: string) { super(message); } }
const invalid = (message: string): never => { throw new ProductInputError(message); };
function obj(value: unknown, name: string): Obj {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid(`${name} must be an object`);
  return value as Obj;
}
function only(row: Obj, keys: string[], name: string) {
  if (Object.keys(row).some(k => !keys.includes(k))) invalid(`${name} contains an unsupported field`);
}
function nonempty(value: unknown, name: string, limit: number): string {
  if (typeof value !== "string" || !value.trim() || [...value].length > limit || /[\u0000-\u001f\u007f]/.test(value)) return invalid(`${name} must be a nonempty string of at most ${limit} characters without control characters`);
  return value;
}
function unique<T>(items: T[], key: (x: T) => string, name: string) {
  const seen = new Set<string>();
  for (const item of items) { const id = key(item); if (seen.has(id)) invalid(`${name} contains duplicates`); seen.add(id); }
  return items;
}
function loc(raw: unknown, group: boolean): AppleLocalization {
  const item = obj(raw, "localization"); only(item, group ? ["locale", "name"] : ["locale", "name", "description"], "localization");
  if (typeof item.locale !== "string" || !/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(item.locale)) return invalid("invalid localization locale");
  const name = nonempty(item.name, "localization name", 30);
  const description = item.description === undefined ? undefined : nonempty(item.description, "localization description", 45);
  return { locale: item.locale, name, ...(description !== undefined ? { description } : {}) };
}
/** Normalize a decimal string without floating-point rounding. */
export function decimal(value: unknown): string {
  if (typeof value !== "string" || !/^(0|[1-9]\d{0,9})(?:\.\d{1,6})?$/.test(value)) return invalid("customerPrice must be a positive decimal string");
  const [whole, fraction = ""] = value.split(".");
  const f = fraction.replace(/0+$/, "");
  if (whole === "0" && !f) return invalid("customerPrice must be positive");
  return f ? `${whole}.${f}` : whole!;
}
export function normalizeAppleProduct(raw: unknown, screenshot?: AppleProduct["screenshot"]): AppleProduct {
  const row = obj(raw, "product"); only(row, ["group", "productId", "name", "subscriptionPeriod", "groupLevel", "localizations", "prices"], "product");
  const group = obj(row.group, "group"); only(group, ["referenceName", "localizations"], "group");
  const referenceName = nonempty(group.referenceName, "group referenceName", 64);
  if (!Array.isArray(group.localizations) || group.localizations.length > 100) return invalid("group localizations must be a list of at most 100 entries");
  const groupLocalizations = unique(group.localizations.map((x: unknown) => loc(x, true)), x => x.locale.toLowerCase(), "group localizations");
  if (typeof row.productId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/.test(row.productId)) return invalid("invalid Apple productId");
  const name = nonempty(row.name, "subscription name", 64);
  if (row.subscriptionPeriod !== "ONE_MONTH" && row.subscriptionPeriod !== "ONE_YEAR") return invalid("subscriptionPeriod must be ONE_MONTH or ONE_YEAR");
  if (!Number.isSafeInteger(row.groupLevel) || (row.groupLevel as number) < 1 || (row.groupLevel as number) > 100) return invalid("groupLevel must be from 1 to 100");
  if (!Array.isArray(row.localizations) || !row.localizations.length || row.localizations.length > 100) return invalid("localizations must contain 1 to 100 entries");
  const localizations = unique(row.localizations.map((x: unknown) => loc(x, false)), x => x.locale.toLowerCase(), "localizations");
  let prices: ApplePrice[] | undefined;
  if (row.prices !== undefined) {
    if (!Array.isArray(row.prices) || row.prices.length > 5) return invalid("prices must contain at most 5 territories per request");
    prices = unique(row.prices.map((x: unknown): ApplePrice => {
      const price = obj(x, "price"); only(price, ["territory", "customerPrice", "preserveCurrentPrice"], "price");
      if (typeof price.territory !== "string" || !/^[A-Z]{3}$/.test(price.territory)) return invalid("territory must be an Apple three-letter territory code");
      if (typeof price.preserveCurrentPrice !== "boolean") return invalid("preserveCurrentPrice must be specified for every price");
      return { territory: price.territory, customerPrice: decimal(price.customerPrice), preserveCurrentPrice: price.preserveCurrentPrice };
    }), x => x.territory, "prices");
  }
  return { group: { referenceName, localizations: groupLocalizations }, productId: row.productId, name,
    subscriptionPeriod: row.subscriptionPeriod, groupLevel: row.groupLevel as number, localizations,
    ...(prices !== undefined ? { prices } : {}), ...(screenshot ? { screenshot } : {}) };
}

function resource(raw: unknown, type: string): Resource {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new AscApiError(502, "subscription_response_malformed");
  const row = raw as Obj;
  if (typeof row.id !== "string" || !row.id || row.type !== type || !row.attributes || typeof row.attributes !== "object" || Array.isArray(row.attributes)) {
    throw new AscApiError(502, "subscription_response_malformed");
  }
  const relations = row.relationships;
  if (relations !== undefined && (!relations || typeof relations !== "object" || Array.isArray(relations))) throw new AscApiError(502, "subscription_response_malformed");
  return { id: row.id, attributes: row.attributes as Obj, relationships: (relations ?? {}) as Obj };
}
function relation(row: Resource, key: string): string | null {
  const rel = row.relationships[key] as { data?: { id?: unknown } | null } | undefined;
  return typeof rel?.data?.id === "string" && rel.data.id ? rel.data.id : null;
}
async function list(req: AscRequest, path: string, type: string): Promise<{ rows: Resource[]; included: Resource[] }> {
  const start = new URL(`https://api.appstoreconnect.apple.com${path}`);
  let current: string | null = path;
  const seen = new Set<string>(); const rows: Resource[] = []; const included: Resource[] = [];
  for (let page = 0; current; page++) {
    if (page >= 5 || seen.has(current)) throw new AscApiError(502, "subscription_pagination_invalid");
    seen.add(current);
    const response: { data?: unknown; included?: unknown; links?: { next?: unknown } } = await req("GET", current);
    if (!Array.isArray(response?.data) || (response.included !== undefined && !Array.isArray(response.included))) throw new AscApiError(502, "subscription_response_malformed");
    rows.push(...response.data.map(x => resource(x, type)));
    for (const x of response.included ?? []) {
      const row = x as Obj; if (row?.type === "subscriptionPricePoints") included.push(resource(row, "subscriptionPricePoints"));
    }
    const next = response.links?.next;
    if (next === undefined || next === null || next === "") { current = null; continue; }
    if (typeof next !== "string") throw new AscApiError(502, "subscription_pagination_invalid");
    const safe = sameOriginAscPath(next);
    if (!safe || new URL(safe, start).pathname !== start.pathname) throw new AscApiError(502, "subscription_pagination_invalid");
    current = safe;
  }
  return { rows, included };
}
function findUnique(rows: Resource[], key: string, value: string): Resource | null {
  const found = rows.filter(x => x.attributes[key] === value);
  if (found.length > 1) throw new AscApiError(409, "subscription_duplicate");
  return found[0] ?? null;
}
function field(row: Resource, key: string): string | null { return typeof row.attributes[key] === "string" ? row.attributes[key] as string : null; }
function localizations(rows: Resource[], wanted: AppleLocalization[], prefix: string): AppleChange[] {
  const seen = new Set<string>();
  for (const row of rows) { const locale = field(row, "locale"); if (!locale || seen.has(locale.toLowerCase())) throw new AscApiError(502, "subscription_response_malformed"); seen.add(locale.toLowerCase()); }
  return wanted.map(item => {
    const current = rows.find(x => typeof x.attributes.locale === "string" && x.attributes.locale.toLowerCase() === item.locale.toLowerCase());
    const before = current ? { name: field(current, "name"), ...(item.description !== undefined ? { description: field(current, "description") } : {}) } : null;
    const after = { name: item.name, ...(item.description !== undefined ? { description: item.description } : {}) };
    const changed = !current || before?.name !== after.name || (item.description !== undefined && before?.description !== item.description);
    return { resource: `${prefix}:${item.locale}`, action: !current ? "create" : changed ? "update" : "unchanged", before, after };
  });
}
interface Snapshot { group: Resource | null; product: Resource | null; groupLocs: Resource[]; productLocs: Resource[]; screenshot: Resource | null; prices: Resource[]; points: Resource[] }
async function snapshot(req: AscRequest, appId: string, wanted: AppleProduct): Promise<Snapshot> {
  const groups = (await list(req, `/v1/apps/${encodeURIComponent(appId)}/subscriptionGroups?limit=200`, "subscriptionGroups")).rows;
  if (groups.length > 20) throw new AscApiError(409, "subscription_group_limit");
  const group = findUnique(groups, "referenceName", wanted.group.referenceName);
  let product: Resource | null = null;
  for (const candidate of groups) {
    const products = (await list(req, `/v1/subscriptionGroups/${encodeURIComponent(candidate.id)}/subscriptions?limit=200`, "subscriptions")).rows;
    const match = findUnique(products, "productId", wanted.productId);
    if (match && (!group || candidate.id !== group.id)) throw new AscApiError(409, "subscription_in_other_group");
    if (match) { if (product) throw new AscApiError(409, "subscription_duplicate"); product = match; }
  }
  const groupLocs = group && wanted.group.localizations.length
    ? (await list(req, `/v1/subscriptionGroups/${encodeURIComponent(group.id)}/subscriptionGroupLocalizations?limit=200`, "subscriptionGroupLocalizations")).rows : [];
  const productLocs = product ? (await list(req, `/v1/subscriptions/${encodeURIComponent(product.id)}/subscriptionLocalizations?limit=200`, "subscriptionLocalizations")).rows : [];
  let screenshot: Resource | null = null;
  if (product && wanted.screenshot) {
    try {
      const response = await req<{ data?: unknown }>("GET", `/v1/subscriptions/${encodeURIComponent(product.id)}/appStoreReviewScreenshot`);
      if (response?.data) screenshot = resource(response.data, "subscriptionAppStoreReviewScreenshots");
    } catch (error) { if (!(error instanceof AscApiError) || error.status !== 404) throw error; }
  }
  let prices: Resource[] = []; let points: Resource[] = [];
  if (product && wanted.prices?.length) {
    const all = await list(req, `/v1/subscriptions/${encodeURIComponent(product.id)}/prices?limit=200&include=territory,subscriptionPricePoint`, "subscriptionPrices");
    prices = all.rows; points = all.included;
    for (const price of prices) {
      const date = price.attributes.startDate;
      if (!relation(price, "territory") || typeof price.attributes.preserved !== "boolean"
        || !["UPFRONT", "MONTHLY"].includes(String(price.attributes.planType))
        || (date != null && (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)))) {
        throw new AscApiError(502, "subscription_response_malformed");
      }
    }
  }
  return { group, product, groupLocs, productLocs, screenshot, prices, points };
}
function priceView(s: Snapshot, price: ApplePrice, today: string): { current: string | null; pending: boolean } {
  const rows = s.prices.filter(x => relation(x, "territory") === price.territory && x.attributes.planType === "UPFRONT" && x.attributes.preserved !== true);
  const future = rows.some(x => typeof x.attributes.startDate === "string" && x.attributes.startDate > today);
  const past = rows.filter(x => x.attributes.startDate == null || (typeof x.attributes.startDate === "string" && x.attributes.startDate <= today))
    .sort((a,b) => String(b.attributes.startDate ?? "").localeCompare(String(a.attributes.startDate ?? "")));
  if (!past.length) return { current: null, pending: future };
  if (past.length > 1 && past[0]!.attributes.startDate === past[1]!.attributes.startDate) throw new AscApiError(502, "subscription_prices_ambiguous");
  const pointId = relation(past[0]!, "subscriptionPricePoint");
  const point = s.points.find(x => x.id === pointId);
  const value = point?.attributes.customerPrice;
  if (!pointId || typeof value !== "string") throw new AscApiError(502, "subscription_price_missing_point");
  let amount: string; try { amount = decimal(value); } catch { throw new AscApiError(502, "subscription_response_malformed"); }
  return { current: amount, pending: future };
}
async function pricePoint(req: AscRequest, productId: string, wanted: ApplePrice): Promise<string> {
  const result = await list(req, `/v1/subscriptions/${encodeURIComponent(productId)}/pricePoints?limit=200&filter[territory]=${wanted.territory}&include=territory`, "subscriptionPricePoints");
  const points = result.rows.filter(x => {
    if (relation(x, "territory") !== wanted.territory) return false;
    try { return decimal(x.attributes.customerPrice) === wanted.customerPrice; } catch { return false; }
  });
  if (points.length !== 1) throw new AscApiError(409, points.length ? "subscription_price_ambiguous" : "subscription_price_unavailable");
  return points[0]!.id;
}
interface Planned { changes: AppleChange[]; pointIds: Map<string, string> }
async function plan(req: AscRequest, s: Snapshot, wanted: AppleProduct, today: string): Promise<Planned> {
  const changes: AppleChange[] = [{ resource: "group", action: s.group ? "unchanged" : "create", before: s.group ? wanted.group.referenceName : null, after: wanted.group.referenceName }];
  changes.push(...localizations(s.groupLocs, wanted.group.localizations, "group-localization"));
  if (s.product && (field(s.product, "subscriptionPeriod") !== wanted.subscriptionPeriod)) throw new AscApiError(409, "subscription_period_mismatch");
  const before = s.product ? { name: field(s.product, "name"), subscriptionPeriod: field(s.product, "subscriptionPeriod"), groupLevel: s.product.attributes.groupLevel } : null;
  const after = { name: wanted.name, subscriptionPeriod: wanted.subscriptionPeriod, groupLevel: wanted.groupLevel };
  const changed = !before || before.name !== after.name || before.groupLevel !== after.groupLevel;
  changes.push({ resource: "subscription", action: !s.product ? "create" : changed ? "update" : "unchanged", before, after });
  changes.push(...localizations(s.productLocs, wanted.localizations, "localization"));
  const pointIds = new Map<string, string>();
  for (const p of wanted.prices ?? []) {
    if (!s.product) { changes.push({ resource: `price:${p.territory}`, action: "deferred", before: null, after: p.customerPrice }); continue; }
    const current = priceView(s, p, today);
    if (current.pending) throw new AscApiError(409, "subscription_price_scheduled");
    if (current.current === p.customerPrice) { changes.push({ resource: `price:${p.territory}`, action: "unchanged", before: current.current, after: p.customerPrice }); continue; }
    pointIds.set(p.territory, await pricePoint(req, s.product.id, p));
    changes.push({ resource: `price:${p.territory}`, action: current.current === null ? "create" : "update", before: current.current, after: { customerPrice: p.customerPrice, preserveCurrentPrice: p.preserveCurrentPrice } });
  }
  if (wanted.screenshot) {
    const state = (s.screenshot?.attributes.assetDeliveryState as { state?: unknown } | undefined)?.state;
    const checksum = s.screenshot?.attributes.sourceFileChecksum;
    const unchanged = state === "COMPLETE" && checksum === wanted.screenshot.md5;
    if (s.screenshot && !["COMPLETE", "FAILED"].includes(String(state))) {
      changes.push({ resource: "review-screenshot", action: "deferred", before: state, after: wanted.screenshot.sha256 });
    } else {
      changes.push({ resource: "review-screenshot", action: unchanged ? "unchanged" : s.screenshot ? "replace" : "create", before: s.screenshot ? state ?? "unknown" : null, after: wanted.screenshot.sha256 });
    }
  }
  return { changes, pointIds };
}
function linkage(type: string, id: string) { return { data: { type, id } }; }
async function created(req: AscRequest, path: string, type: string, attributes: Obj, relationships: Obj): Promise<string> {
  const res = await req<{ data?: { id?: unknown; type?: unknown } }>("POST", path, { data: { type, attributes, relationships } });
  if (typeof res?.data?.id !== "string" || !res.data.id || res.data.type !== type) throw new AscApiError(502, "subscription_response_malformed");
  return res.data.id;
}
async function patch(req: AscRequest, path: string, type: string, id: string, attributes: Obj) {
  await req("PATCH", `${path}/${encodeURIComponent(id)}`, { data: { type, id, attributes } });
}
export interface AppleExecution {
  /** Durable claim before creating a group; resolves uncertainty without duplicate group POSTs. */
  claimGroupCreation(): Promise<boolean>;
  confirmGroupVisible(): Promise<void>;
  releaseRejectedGroup(): Promise<void>;
  upload(operations: UploadOperation[], bytes: Uint8Array): Promise<void>;
}
function safeError(error: unknown) {
  const code = error instanceof AscApiError && /^[A-Za-z0-9_]{1,80}$/.test(error.message) ? error.message : "apple_subscription_failed";
  return { code, message: "Apple subscription operation failed; review completed steps and retry" };
}
/** Re-read before writing and after every product; never treat partial work as complete. */
export async function reconcileAppleProduct(req: AscRequest, appId: string, wanted: AppleProduct, mode: "dry_run" | "commit", exec: AppleExecution, today = new Date().toISOString().slice(0, 10)): Promise<AppleResult> {
  let before = await snapshot(req, appId, wanted);
  const initial = await plan(req, before, wanted, today);
  const result: AppleResult = { product_id: wanted.productId, mode, outcome: "planned", changes: initial.changes, completed: [] };
  if (mode === "dry_run") return result;
  try {
    let groupId = before.group?.id;
    if (!groupId) {
      if (!await exec.claimGroupCreation()) throw new AscApiError(409, "group_creation_unconfirmed");
      try {
        groupId = await created(req, "/v1/subscriptionGroups", "subscriptionGroups", { referenceName: wanted.group.referenceName }, { app: linkage("apps", appId) });
        result.completed.push("group:create");
      } catch (error) {
        if (error instanceof AscApiError && [400, 401, 403, 422].includes(error.status)) await exec.releaseRejectedGroup();
        throw error;
      }
    } else await exec.confirmGroupVisible();
    for (const item of wanted.group.localizations) {
      const existing = before.groupLocs.find(x => typeof x.attributes.locale === "string" && x.attributes.locale.toLowerCase() === item.locale.toLowerCase());
      if (!existing) { await created(req, "/v1/subscriptionGroupLocalizations", "subscriptionGroupLocalizations", item, { subscriptionGroup: linkage("subscriptionGroups", groupId) }); result.completed.push(`group-localization:${item.locale}`); }
      else if (existing.attributes.name !== item.name) { await patch(req, "/v1/subscriptionGroupLocalizations", "subscriptionGroupLocalizations", existing.id, { name: item.name }); result.completed.push(`group-localization:${item.locale}`); }
    }
    let subscriptionId = before.product?.id;
    if (!subscriptionId) {
      subscriptionId = await created(req, "/v1/subscriptions", "subscriptions", { name: wanted.name, productId: wanted.productId, subscriptionPeriod: wanted.subscriptionPeriod, groupLevel: wanted.groupLevel }, { group: linkage("subscriptionGroups", groupId) });
      result.completed.push("subscription:create");
    } else if (before.product?.attributes.name !== wanted.name || before.product?.attributes.groupLevel !== wanted.groupLevel) {
      await patch(req, "/v1/subscriptions", "subscriptions", subscriptionId, { name: wanted.name, groupLevel: wanted.groupLevel }); result.completed.push("subscription:update");
    }
    for (const item of wanted.localizations) {
      const existing = before.productLocs.find(x => typeof x.attributes.locale === "string" && x.attributes.locale.toLowerCase() === item.locale.toLowerCase());
      if (!existing) { await created(req, "/v1/subscriptionLocalizations", "subscriptionLocalizations", { ...item }, { subscription: linkage("subscriptions", subscriptionId) }); result.completed.push(`localization:${item.locale}`); }
      else if (existing.attributes.name !== item.name || (item.description !== undefined && existing.attributes.description !== item.description)) {
        await patch(req, "/v1/subscriptionLocalizations", "subscriptionLocalizations", existing.id, { name: item.name, ...(item.description !== undefined ? { description: item.description } : {}) });
        result.completed.push(`localization:${item.locale}`);
      }
    }
    // A new subscription has no price points until Apple assigns its id. Read the
    // current catalogue again before scheduling any price change.
    if (wanted.prices?.length) {
      before = await snapshot(req, appId, wanted);
      if (!before.product || before.product.id !== subscriptionId) throw new AscApiError(502, "subscription_readback_mismatch");
      const prices = await plan(req, before, wanted, today);
      for (const p of wanted.prices) {
        const id = prices.pointIds.get(p.territory); if (!id) continue;
        await created(req, "/v1/subscriptionPrices", "subscriptionPrices", { startDate: null, preserveCurrentPrice: p.preserveCurrentPrice, planType: "UPFRONT" },
          { subscription: linkage("subscriptions", subscriptionId), territory: linkage("territories", p.territory), subscriptionPricePoint: linkage("subscriptionPricePoints", id) });
        result.completed.push(`price:${p.territory}`);
      }
    }
    if (wanted.screenshot) {
      const screenshotChange = initial.changes.find(x => x.resource === "review-screenshot");
      if (screenshotChange?.action === "deferred") { result.outcome = "pending"; return result; }
      if (screenshotChange?.action === "create" || screenshotChange?.action === "replace") {
        if (before.screenshot) { await req("DELETE", `/v1/subscriptionAppStoreReviewScreenshots/${encodeURIComponent(before.screenshot.id)}`); result.completed.push("review-screenshot:delete"); }
        const reservation = await req<{ data?: { id?: unknown; type?: unknown; attributes?: { uploadOperations?: unknown } } }>("POST", "/v1/subscriptionAppStoreReviewScreenshots", {
          data: { type: "subscriptionAppStoreReviewScreenshots", attributes: { fileName: wanted.screenshot.fileName, fileSize: wanted.screenshot.bytes.length }, relationships: { subscription: linkage("subscriptions", subscriptionId) } },
        });
        const id = reservation?.data?.id; const ops = reservation?.data?.attributes?.uploadOperations;
        if (typeof id !== "string" || !id || reservation.data?.type !== "subscriptionAppStoreReviewScreenshots" || !Array.isArray(ops) || !ops.length) throw new AscApiError(502, "screenshot_reservation_malformed");
        result.completed.push("review-screenshot:reserved");
        await exec.upload(ops as UploadOperation[], wanted.screenshot.bytes);
        await patch(req, "/v1/subscriptionAppStoreReviewScreenshots", "subscriptionAppStoreReviewScreenshots", id, { uploaded: true, sourceFileChecksum: wanted.screenshot.md5 });
        result.completed.push("review-screenshot:uploaded");
      }
    }
    const after = await snapshot(req, appId, wanted);
    const remaining = await plan(req, after, wanted, today);
    const pending = remaining.changes.some(x => x.action === "deferred" && x.resource === "review-screenshot");
    if (pending) { result.outcome = "pending"; return result; }
    if (remaining.changes.some(x => x.action !== "unchanged")) throw new AscApiError(502, "subscription_readback_mismatch");
    await exec.confirmGroupVisible();
    result.outcome = result.completed.length ? "committed" : "no_changes";
    return result;
  } catch (error) { result.outcome = "failed"; result.error = safeError(error); return result; }
}
