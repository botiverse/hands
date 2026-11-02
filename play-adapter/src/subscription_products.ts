/** Google Play subscription reconciliation; no edit transaction exists for this API. */
import { PlayAdapterError } from "./errors";

type ObjectValue = Record<string, unknown>;
export interface ProductListing { languageCode: string; title: string; description?: string }
export interface ProductPrice { currencyCode: string; units: string; nanos: number }
export interface ProductRegion { regionCode: string; newSubscriberAvailability: boolean; price?: ProductPrice }
export interface ProductPlan {
  basePlanId: string;
  billingPeriodDuration: "P1M" | "P1Y";
  /** Omission means preserve every existing regional price and availability. */
  regionalConfigs?: ProductRegion[];
  activate?: boolean;
}
export interface ProductInput {
  productId: string;
  listings: ProductListing[];
  basePlans: ProductPlan[];
}
export interface ProductChange { resource: string; action: "create" | "update" | "activate" | "unchanged" | "deferred"; before?: unknown; after?: unknown }
export interface ProductResult {
  product_id: string;
  mode: "dry_run" | "commit";
  outcome: "planned" | "committed" | "no_changes" | "failed" | "pending";
  changes: ProductChange[];
  completed: string[];
  error?: { code: string; message: string };
}
export interface ProductClient {
  listSubscriptionProducts(packageName: string): Promise<ObjectValue[]>;
  createSubscriptionProduct(packageName: string, productId: string, body: ObjectValue, regionsVersion: string): Promise<unknown>;
  updateSubscriptionProduct(packageName: string, productId: string, body: ObjectValue, fields: string[], regionsVersion: string): Promise<unknown>;
  activateSubscriptionBasePlan(packageName: string, productId: string, basePlanId: string): Promise<unknown>;
}

const fail = (message: string): never => { throw new PlayAdapterError(400, "subscription_request_invalid", message); };
const object = (value: unknown, name: string): ObjectValue => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail(`${name} must be an object`);
  return value as ObjectValue;
};
function fields(row: ObjectValue, allowed: string[], name: string) {
  if (Object.keys(row).some(k => !allowed.includes(k))) fail(`${name} contains an unsupported field`);
}
function text(value: unknown, name: string, max: number): string {
  if (typeof value !== "string" || !value.trim() || [...value].length > max || /[\u0000-\u001f\u007f]/.test(value)) return fail(`${name} must be a nonempty string of at most ${max} characters`);
  return value;
}
function unique<T>(items: T[], key: (item: T) => string, name: string): T[] {
  const seen = new Set<string>();
  for (const item of items) { const k = key(item); if (seen.has(k)) fail(`${name} has duplicate entries`); seen.add(k); }
  return items;
}
function money(value: unknown): ProductPrice {
  const row = object(value, "price"); fields(row, ["currencyCode", "units", "nanos"], "price");
  if (typeof row.currencyCode !== "string" || !/^[A-Z]{3}$/.test(row.currencyCode)) return fail("price currencyCode must be an ISO currency code");
  if (typeof row.units !== "string" || !/^(0|[1-9][0-9]{0,11})$/.test(row.units)) return fail("price units must be a non-negative decimal string");
  const nanos = row.nanos === undefined ? 0 : row.nanos;
  if (!Number.isInteger(nanos) || (nanos as number) < 0 || (nanos as number) > 999999999) return fail("price nanos must be an integer from 0 to 999999999");
  if (row.units === "0" && nanos === 0) return fail("price must be positive");
  return { currencyCode: row.currencyCode, units: row.units, nanos: nanos as number };
}
export function normalizeProduct(value: unknown): ProductInput {
  const row = object(value, "product"); fields(row, ["productId", "listings", "basePlans"], "product");
  if (typeof row.productId !== "string" || !/^[a-z0-9][a-z0-9._]{0,39}$/.test(row.productId)) return fail("invalid Google Play productId");
  if (!Array.isArray(row.listings) || !row.listings.length || row.listings.length > 100) return fail("listings must contain 1 to 100 entries");
  const listings = unique(row.listings.map((raw: unknown): ProductListing => {
    const item = object(raw, "listing"); fields(item, ["languageCode", "title", "description"], "listing");
    if (typeof item.languageCode !== "string" || !/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(item.languageCode)) return fail("invalid listing languageCode");
    const title = text(item.title, "listing title", 55);
    const description = item.description === undefined ? undefined : text(item.description, "listing description", 200);
    return { languageCode: item.languageCode, title, ...(description !== undefined ? { description } : {}) };
  }), v => v.languageCode.toLowerCase(), "listings");
  if (!Array.isArray(row.basePlans) || !row.basePlans.length || row.basePlans.length > 50) return fail("basePlans must contain 1 to 50 entries");
  const basePlans = unique(row.basePlans.map((raw: unknown): ProductPlan => {
    const item = object(raw, "base plan"); fields(item, ["basePlanId", "billingPeriodDuration", "regionalConfigs", "activate"], "base plan");
    if (typeof item.basePlanId !== "string" || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(item.basePlanId)) return fail("invalid basePlanId");
    if (item.billingPeriodDuration !== "P1M" && item.billingPeriodDuration !== "P1Y") return fail("billingPeriodDuration must be P1M or P1Y");
    if (item.activate !== undefined && typeof item.activate !== "boolean") return fail("activate must be boolean");
    let regionalConfigs: ProductRegion[] | undefined;
    if (item.regionalConfigs !== undefined) {
      if (!Array.isArray(item.regionalConfigs) || item.regionalConfigs.length > 300) return fail("regionalConfigs must be a list of at most 300 regions");
      regionalConfigs = unique(item.regionalConfigs.map((entry: unknown): ProductRegion => {
        const region = object(entry, "region"); fields(region, ["regionCode", "newSubscriberAvailability", "price"], "region");
        if (typeof region.regionCode !== "string" || !/^[A-Z]{2}$/.test(region.regionCode)) return fail("invalid regionCode");
        if (typeof region.newSubscriberAvailability !== "boolean") return fail("newSubscriberAvailability must be boolean");
        const price = region.price === undefined ? undefined : money(region.price);
        if (region.newSubscriberAvailability && !price) return fail("an available region requires a price");
        return { regionCode: region.regionCode, newSubscriberAvailability: region.newSubscriberAvailability, ...(price ? { price } : {}) };
      }), v => v.regionCode, "regionalConfigs");
    }
    return { basePlanId: item.basePlanId, billingPeriodDuration: item.billingPeriodDuration,
      ...(regionalConfigs !== undefined ? { regionalConfigs } : {}), ...(item.activate !== undefined ? { activate: item.activate as boolean } : {}) };
  }), v => v.basePlanId, "basePlans");
  return { productId: row.productId, listings, basePlans };
}

const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
function providerObject(raw: unknown, label: string): ObjectValue {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new PlayAdapterError(502, "play_subscription_malformed", `Google Play returned an invalid ${label}`);
  return raw as ObjectValue;
}
function providerList(value: unknown, label: string): ObjectValue[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 500) throw new PlayAdapterError(502, "play_subscription_malformed", `Google Play returned an invalid ${label} list`);
  return value.map(x => providerObject(x, label));
}
function currentMoney(raw: unknown): ProductPrice | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const p = raw as ObjectValue;
  if (typeof p.currencyCode !== "string" || !/^[A-Z]{3}$/.test(p.currencyCode)) return null;
  const units = p.units === undefined ? "0" : p.units;
  const nanos = p.nanos === undefined ? 0 : p.nanos;
  if (typeof units !== "string" || !/^(0|[1-9][0-9]{0,11})$/.test(units) || !Number.isInteger(nanos) || (nanos as number) < 0 || (nanos as number) > 999999999 || (units === "0" && nanos === 0)) return null;
  return { currencyCode: p.currencyCode, units, nanos: nanos as number };
}
function currentRegion(raw: ObjectValue): ProductRegion {
  if (typeof raw.regionCode !== "string" || !/^[A-Z]{2}$/.test(raw.regionCode) || (raw.newSubscriberAvailability !== undefined && typeof raw.newSubscriberAvailability !== "boolean")) {
    throw new PlayAdapterError(502, "play_subscription_malformed", "Google Play returned an invalid region");
  }
  const price = raw.price === undefined ? null : currentMoney(raw.price);
  if (raw.price !== undefined && !price) throw new PlayAdapterError(502, "play_subscription_malformed", "Google Play returned an invalid region price");
  return { regionCode: raw.regionCode, newSubscriberAvailability: raw.newSubscriberAvailability === true, ...(price ? { price } : {}) };
}
function assertProviderUnique(rows: ObjectValue[], key: string, label: string) {
  const seen = new Set<string>();
  for (const row of rows) {
    const id = row[key];
    const normalized = typeof id === "string" && key === "languageCode" ? id.toLowerCase() : id;
    if (typeof id !== "string" || !id || seen.has(normalized as string)) throw new PlayAdapterError(502, "play_subscription_malformed", `Google Play returned invalid or duplicate ${label}`);
    seen.add(normalized as string);
  }
}

/** Build only a narrowly scoped patch and retain fields not managed by Hands. */
export function planProduct(packageName: string, desired: ProductInput, current: ObjectValue | null) {
  if (current && (current.packageName !== packageName || current.productId !== desired.productId)) {
    throw new PlayAdapterError(502, "play_subscription_malformed", "Google Play returned a different subscription");
  }
  const oldListings = providerList(current?.listings, "listing");
  const oldPlans = providerList(current?.basePlans, "base plan");
  assertProviderUnique(oldListings, "languageCode", "listing languages");
  assertProviderUnique(oldPlans, "basePlanId", "base plans");
  const listings = oldListings.map(x => ({ ...x }));
  // Keep all provider-returned configuration, except the documented output-only state.
  const basePlans = oldPlans.map(({ state: _state, ...plan }) => ({ ...plan }));
  const changes: ProductChange[] = [];
  let listingsChanged = false;
  let plansChanged = false;
  for (const wanted of desired.listings) {
    const idx = listings.findIndex(x => typeof x.languageCode === "string" && x.languageCode.toLowerCase() === wanted.languageCode.toLowerCase());
    const old = idx < 0 ? null : listings[idx]!;
    const next: ObjectValue = { ...(old ?? {}), languageCode: old?.languageCode ?? wanted.languageCode, title: wanted.title,
      ...(wanted.description !== undefined ? { description: wanted.description } : {}) };
    const changed = !old || old.title !== next.title || (wanted.description !== undefined && old.description !== next.description);
    changes.push({ resource: `listing:${wanted.languageCode}`, action: !old ? "create" : changed ? "update" : "unchanged",
      before: old && { title: old.title, ...(wanted.description !== undefined ? { description: old.description ?? null } : {}) },
      after: { title: next.title, ...(wanted.description !== undefined ? { description: next.description } : {}) } });
    if (changed) { listingsChanged = true; if (idx < 0) listings.push(next); else listings[idx] = next; }
  }
  const activations: string[] = [];
  for (const wanted of desired.basePlans) {
    const idx = basePlans.findIndex(x => x.basePlanId === wanted.basePlanId);
    const old = idx < 0 ? null : basePlans[idx]!;
    const oldWithState = idx < 0 ? null : oldPlans[idx]!;
    const oldAuto = old?.autoRenewingBasePlanType;
    if (old && (!oldAuto || typeof oldAuto !== "object" || Array.isArray(oldAuto)
      || (oldAuto as ObjectValue).billingPeriodDuration !== wanted.billingPeriodDuration)) {
      throw new PlayAdapterError(409, "base_plan_immutable_mismatch", `Existing base plan ${wanted.basePlanId} has a different type or period`);
    }
    const regions = providerList(old?.regionalConfigs, "region").map(x => ({ ...x }));
    assertProviderUnique(regions, "regionCode", "regions");
    let regionChanged = false;
    for (const region of wanted.regionalConfigs ?? []) {
      const ri = regions.findIndex(x => x.regionCode === region.regionCode);
      const prior = ri < 0 ? null : regions[ri]!;
      const before = prior ? currentRegion(prior) : null;
      const projected: ProductRegion = { regionCode: region.regionCode, newSubscriberAvailability: region.newSubscriberAvailability,
        ...(region.price ? { price: region.price } : before?.price ? { price: before.price } : {}) };
      if (!equal(before, projected)) {
        regionChanged = true;
        const merged: ObjectValue = { ...(prior ?? {}), ...projected };
        if (ri < 0) regions.push(merged); else regions[ri] = merged;
      }
      changes.push({ resource: `base-plan:${wanted.basePlanId}:region:${region.regionCode}`,
        action: !prior ? "create" : equal(before, projected) ? "unchanged" : "update", before, after: projected });
    }
    const next: ObjectValue = old ? { ...old } : { basePlanId: wanted.basePlanId, autoRenewingBasePlanType: { billingPeriodDuration: wanted.billingPeriodDuration } };
    if (wanted.regionalConfigs !== undefined || (!old && regions.length)) next.regionalConfigs = regions;
    const changed = !old || regionChanged;
    changes.push({ resource: `base-plan:${wanted.basePlanId}`, action: !old ? "create" : changed ? "update" : "unchanged",
      before: old ? { period: wanted.billingPeriodDuration, state: oldWithState?.state ?? null } : null,
      after: { period: wanted.billingPeriodDuration } });
    if (changed) { plansChanged = true; if (idx < 0) basePlans.push(next); else basePlans[idx] = next; }
    if (wanted.activate && oldWithState?.state !== "ACTIVE") {
      if (oldWithState && !["DRAFT", "INACTIVE"].includes(String(oldWithState.state))) throw new PlayAdapterError(409, "base_plan_state_unknown", `Base plan ${wanted.basePlanId} has an unknown state`);
      const enabled = regions.some(r => { const v = currentRegion(r); return v.newSubscriberAvailability && !!v.price; });
      if (enabled) { activations.push(wanted.basePlanId); changes.push({ resource: `base-plan:${wanted.basePlanId}:activation`, action: "activate", before: oldWithState?.state ?? "DRAFT", after: "ACTIVE" }); }
      else changes.push({ resource: `base-plan:${wanted.basePlanId}:activation`, action: "deferred", before: oldWithState?.state ?? "DRAFT", after: "awaiting_price" });
    }
  }
  const body: ObjectValue = { packageName, productId: desired.productId };
  const mask: string[] = [];
  if (!current || listingsChanged) { body.listings = listings; mask.push("listings"); }
  if (!current || plansChanged) { body.basePlans = basePlans; mask.push("basePlans"); }
  return { body, mask, changes, activations };
}

export async function reconcileProduct(client: ProductClient, packageName: string, desired: ProductInput, mode: "dry_run" | "commit", regionsVersion: string): Promise<ProductResult> {
  let all: ObjectValue[];
  try {
    all = await client.listSubscriptionProducts(packageName);
  } catch (error) {
    if (mode !== "dry_run" || !(error instanceof PlayAdapterError) || error.code !== "play_catalog_unverified") throw error;
    const plan = planProduct(packageName, desired, null);
    return {
      product_id: desired.productId, mode, outcome: "pending", completed: [],
      changes: [{ resource: "catalog", action: "deferred", before: null, after: "assumed_empty_unverified" }, ...plan.changes],
      error: { code: "play_catalog_unverified", message: "Google Play returned no catalogue; this preview assumes it is empty and is unverified" },
    };
  }
  const matches = all.filter(x => x.productId === desired.productId);
  if (matches.length > 1) throw new PlayAdapterError(502, "play_subscription_malformed", "Google Play returned a duplicate subscription");
  const current = matches[0] ?? null;
  const plan = planProduct(packageName, desired, current);
  const result: ProductResult = { product_id: desired.productId, mode, outcome: "planned", changes: plan.changes, completed: [] };
  if (mode === "dry_run") return result;
  try {
    if (!current) { await client.createSubscriptionProduct(packageName, desired.productId, plan.body, regionsVersion); result.completed.push("create"); }
    else if (plan.mask.length) { await client.updateSubscriptionProduct(packageName, desired.productId, plan.body, plan.mask, regionsVersion); result.completed.push("update"); }
    for (const planId of plan.activations) { await client.activateSubscriptionBasePlan(packageName, desired.productId, planId); result.completed.push(`activate:${planId}`); }
    const readback = (await client.listSubscriptionProducts(packageName)).filter(x => x.productId === desired.productId);
    if (readback.length !== 1) throw new PlayAdapterError(502, "subscription_readback_mismatch", "Google Play did not return the requested subscription");
    const remaining = planProduct(packageName, desired, readback[0]!);
    if (remaining.mask.length || remaining.activations.length) throw new PlayAdapterError(502, "subscription_readback_mismatch", "Google Play read-back does not match the requested subscription");
    result.outcome = remaining.changes.some(change => change.action === "deferred") ? "pending" : result.completed.length ? "committed" : "no_changes";
    return result;
  } catch (error) {
    result.outcome = "failed";
    result.error = { code: error instanceof PlayAdapterError && /^[a-z0-9_]{1,80}$/.test(error.code) ? error.code : "play_subscription_failed", message: "Google Play subscription update failed; inspect provider state before retrying" };
    return result;
  }
}
