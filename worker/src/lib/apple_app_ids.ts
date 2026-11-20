/**
 * Register an iOS App ID and turn on the capabilities an app's entitlements
 * ask for, through the App Store Connect API.
 *
 * The capabilities come from the entitlements the app is built with (its
 * .entitlements file), never from the caller, so a registration enables what
 * the app declares and nothing else. Some capabilities need a second object
 * the API cannot create or assign (App Groups, iCloud containers, Merchant
 * IDs, Pass Type IDs); those are turned on and returned as manual steps.
 */

import { AscApiError, ascRequest, type AscApiCredentials } from "./asc_api";
import { SigningError } from "./signing";

export type CapabilitySetting = { key: string; options: Array<{ key: string; enabled?: boolean }> };

export type CapabilityNeed = {
  capability: string;
  /** Entitlement keys that ask for it. */
  entitlements: string[];
  settings?: CapabilitySetting[];
};

export type ManualStep = { capability: string; entitlement: string; values: string[]; step: string };

export type AppIdPlan = {
  bundle_id: string;
  /** App Store Connect resource id; null when the App ID does not exist yet. */
  app_id_resource_id: string | null;
  create_app_id: boolean;
  /** Capabilities to turn on. */
  enable: CapabilityNeed[];
  /** Capabilities the entitlements ask for that are already on. */
  already_enabled: string[];
  manual: ManualStep[];
  /** Entitlement keys with no known capability; signing may refuse them. */
  unknown_entitlements: string[];
};

export type AppIdResult = {
  bundle_id: string;
  app_id_resource_id: string;
  created_app_id: boolean;
  enabled: string[];
  /** Hands-made App Store profiles removed so the next signing gets one with the new capabilities. */
  profiles_removed: string[];
  manual: ManualStep[];
  unknown_entitlements: string[];
};

/** Keys every signed app carries that need no capability. */
const NO_CAPABILITY = new Set([
  "application-identifier",
  "com.apple.developer.team-identifier",
  "get-task-allow",
  "beta-reports-active",
  "keychain-access-groups",
  "com.apple.developer.icloud-container-environment",
  "com.apple.developer.icloud-container-development-container-identifiers",
  "com.apple.developer.aps-environment",
]);

type Rule = { capability: string; settings?: (value: unknown) => CapabilitySetting[] | undefined; manual?: string };

const DATA_PROTECTION: Record<string, string> = {
  NSFileProtectionComplete: "COMPLETE_PROTECTION",
  NSFileProtectionCompleteUnlessOpen: "PROTECTED_UNLESS_OPEN",
  NSFileProtectionCompleteUntilFirstUserAuthentication: "PROTECTED_UNTIL_FIRST_USER_AUTH",
};

const RULES: Record<string, Rule> = {
  "aps-environment": { capability: "PUSH_NOTIFICATIONS" },
  "com.apple.developer.associated-domains": { capability: "ASSOCIATED_DOMAINS" },
  "com.apple.developer.applesignin": {
    capability: "APPLE_ID_AUTH",
    settings: () => [{ key: "APPLE_ID_AUTH_APP_CONSENT", options: [{ key: "PRIMARY_APP_CONSENT" }] }],
  },
  "com.apple.security.application-groups": {
    capability: "APP_GROUPS",
    manual: "create these App Groups and assign them to the App ID on the Apple Developer site (Identifiers › App IDs › App Groups › Configure)",
  },
  "com.apple.developer.icloud-container-identifiers": {
    capability: "ICLOUD",
    settings: () => [{ key: "ICLOUD_VERSION", options: [{ key: "XCODE_6" }] }],
    manual: "create these iCloud containers and assign them to the App ID on the Apple Developer site (Identifiers › App IDs › iCloud › Configure)",
  },
  "com.apple.developer.icloud-services": {
    capability: "ICLOUD",
    settings: () => [{ key: "ICLOUD_VERSION", options: [{ key: "XCODE_6" }] }],
  },
  "com.apple.developer.ubiquity-container-identifiers": {
    capability: "ICLOUD",
    settings: () => [{ key: "ICLOUD_VERSION", options: [{ key: "XCODE_6" }] }],
  },
  "com.apple.developer.ubiquity-kvstore-identifier": {
    capability: "ICLOUD",
    settings: () => [{ key: "ICLOUD_VERSION", options: [{ key: "XCODE_6" }] }],
  },
  "com.apple.developer.in-app-payments": {
    capability: "APPLE_PAY",
    manual: "create these Merchant IDs and assign them to the App ID on the Apple Developer site (Identifiers › App IDs › Apple Pay › Configure)",
  },
  "com.apple.developer.pass-type-identifiers": {
    capability: "WALLET",
    manual: "make sure these Pass Type IDs exist on the Apple Developer site (Identifiers › Pass Type IDs)",
  },
  "com.apple.developer.default-data-protection": {
    capability: "DATA_PROTECTION",
    settings: (value) => {
      const level = typeof value === "string" ? DATA_PROTECTION[value] : undefined;
      return level ? [{ key: "DATA_PROTECTION_PERMISSION_LEVEL", options: [{ key: level }] }] : undefined;
    },
  },
  "com.apple.developer.healthkit": { capability: "HEALTHKIT" },
  "com.apple.developer.healthkit.access": { capability: "HEALTHKIT" },
  "com.apple.developer.homekit": { capability: "HOMEKIT" },
  "com.apple.developer.siri": { capability: "SIRIKIT" },
  "com.apple.developer.game-center": { capability: "GAME_CENTER" },
  "com.apple.developer.networking.wifi-info": { capability: "ACCESS_WIFI_INFORMATION" },
  "com.apple.developer.networking.networkextension": { capability: "NETWORK_EXTENSIONS" },
  "com.apple.developer.networking.vpn.api": { capability: "PERSONAL_VPN" },
  "com.apple.developer.networking.HotspotConfiguration": { capability: "HOT_SPOT" },
  "com.apple.developer.networking.multipath": { capability: "MULTIPATH" },
  "com.apple.developer.nfc.readersession.formats": { capability: "NFC_TAG_READING" },
  "com.apple.developer.ClassKit-environment": { capability: "CLASSKIT" },
  "com.apple.developer.authentication-services.autofill-credential-provider": { capability: "AUTOFILL_CREDENTIAL_PROVIDER" },
  "com.apple.developer.usernotifications.time-sensitive": { capability: "USERNOTIFICATIONS_TIMESENSITIVE" },
  "com.apple.developer.usernotifications.communication": { capability: "USERNOTIFICATIONS_COMMUNICATION" },
  "com.apple.developer.group-session": { capability: "GROUP_ACTIVITIES" },
  "com.apple.developer.kernel.increased-memory-limit": { capability: "INCREASED_MEMORY_LIMIT" },
  "com.apple.developer.kernel.extended-virtual-addressing": { capability: "EXTENDED_VIRTUAL_ADDRESSING" },
  "com.apple.developer.weatherkit": { capability: "WEATHERKIT" },
  "com.apple.developer.family-controls": { capability: "FAMILY_CONTROLS" },
  "com.apple.developer.devicecheck.appattest-environment": { capability: "APP_ATTEST" },
  "com.apple.developer.coremedia.hls.low-latency": { capability: "COREMEDIA_HLS_LOW_LATENCY" },
  "com.apple.developer.associated-appclip-app-identifiers": { capability: "ON_DEMAND_INSTALL_CAPABLE" },
  "com.apple.developer.fileprovider.testing-mode": { capability: "FILEPROVIDER_TESTINGMODE" },
  "com.apple.developer.shared-with-you": { capability: "SHARED_WITH_YOU" },
  "com.apple.external-accessory.wireless-configuration": { capability: "WIRELESS_ACCESSORY_CONFIGURATION" },
  "inter-app-audio": { capability: "INTER_APP_AUDIO" },
};

function stringValues(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string");
  return [];
}

/** What the entitlements need from the App ID, without asking Apple. */
export function capabilitiesFor(entitlements: Record<string, unknown>): Pick<AppIdPlan, "manual" | "unknown_entitlements"> & { needs: CapabilityNeed[] } {
  const needs = new Map<string, CapabilityNeed>();
  const manual: ManualStep[] = [];
  const unknown: string[] = [];
  for (const key of Object.keys(entitlements).sort()) {
    const value = entitlements[key];
    if (NO_CAPABILITY.has(key)) continue;
    const rule = RULES[key];
    if (!rule) {
      unknown.push(key);
      continue;
    }
    // An empty list or false asks for nothing.
    if (value === false || (Array.isArray(value) && value.length === 0)) continue;
    const need = needs.get(rule.capability) ?? { capability: rule.capability, entitlements: [] };
    need.entitlements.push(key);
    const settings = rule.settings?.(value);
    if (settings && !need.settings) need.settings = settings;
    needs.set(rule.capability, need);
    const values = stringValues(value);
    if (rule.manual && values.length > 0) manual.push({ capability: rule.capability, entitlement: key, values, step: rule.manual });
  }
  return { needs: [...needs.values()], manual, unknown_entitlements: unknown };
}

const BUNDLE_ID = /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;

export function validBundleId(value: unknown): value is string {
  return typeof value === "string" && value.length <= 155 && BUNDLE_ID.test(value);
}

type Resource<A> = { id: string; type: string; attributes: A };
type List<A> = { data: Array<Resource<A>>; links?: { next?: string } };

async function asc<T>(creds: AscApiCredentials, method: string, path: string, body?: unknown): Promise<T> {
  try {
    return await ascRequest<T>(creds, method, path, body, AbortSignal.timeout(20_000));
  } catch (error) {
    if (error instanceof AscApiError) {
      const refused = error.status === 401 || error.status === 403;
      const detail = error.detail ? `: ${error.detail}` : "";
      throw new SigningError(refused ? 400 : 502, refused ? "asc_key_refused" : "asc_unavailable",
        `App Store Connect ${method} ${path.split("?")[0]} failed (${error.status}) ${error.message}${detail}`.slice(0, 500));
    }
    throw new SigningError(502, "asc_unavailable", `App Store Connect did not answer: ${error instanceof Error ? error.name : "error"}`);
  }
}

async function all<A>(creds: AscApiCredentials, path: string): Promise<Array<Resource<A>>> {
  const out: Array<Resource<A>> = [];
  let next: string | undefined = path;
  for (let page = 0; next && page < 10; page++) {
    const res: List<A> = await asc<List<A>>(creds, "GET", next);
    out.push(...res.data);
    next = res.links?.next ? res.links.next.replace(/^https:\/\/api\.appstoreconnect\.apple\.com/, "") : undefined;
  }
  return out;
}

async function findAppId(creds: AscApiCredentials, bundleId: string) {
  const bundles = await all<{ identifier: string; platform: string }>(creds, `/v1/bundleIds?filter[identifier]=${encodeURIComponent(bundleId)}&limit=200`);
  // The filter matches prefixes too (build.raft.deck finds build.raft.deck.widget).
  return bundles.find((b) => b.attributes.identifier === bundleId && (b.attributes.platform === "IOS" || b.attributes.platform === "UNIVERSAL")) ?? null;
}

export async function planAppId(creds: AscApiCredentials, bundleId: string, entitlements: Record<string, unknown>): Promise<AppIdPlan> {
  const { needs, manual, unknown_entitlements } = capabilitiesFor(entitlements);
  const bundle = await findAppId(creds, bundleId);
  let enabled = new Set<string>();
  if (bundle) {
    const caps = await all<{ capabilityType: string }>(creds, `/v1/bundleIds/${encodeURIComponent(bundle.id)}/bundleIdCapabilities`);
    enabled = new Set(caps.map((c) => c.attributes.capabilityType));
  }
  return {
    bundle_id: bundleId,
    app_id_resource_id: bundle?.id ?? null,
    create_app_id: !bundle,
    enable: needs.filter((n) => !enabled.has(n.capability)),
    already_enabled: needs.filter((n) => enabled.has(n.capability)).map((n) => n.capability),
    manual,
    unknown_entitlements,
  };
}

/** App ID names allow letters, digits and spaces only. */
function appIdName(bundleId: string) {
  return `Hands ${bundleId.replace(/[^A-Za-z0-9]+/g, " ")}`.trim().slice(0, 100);
}

export async function applyAppIdPlan(creds: AscApiCredentials, plan: AppIdPlan): Promise<AppIdResult> {
  let resourceId = plan.app_id_resource_id;
  if (!resourceId) {
    const created = await asc<{ data: Resource<{ identifier: string }> }>(creds, "POST", "/v1/bundleIds", {
      data: { type: "bundleIds", attributes: { identifier: plan.bundle_id, name: appIdName(plan.bundle_id), platform: "IOS" } },
    });
    resourceId = created.data.id;
  }
  const enabled: string[] = [];
  for (const need of plan.enable) {
    await asc(creds, "POST", "/v1/bundleIdCapabilities", {
      data: {
        type: "bundleIdCapabilities",
        attributes: { capabilityType: need.capability, ...(need.settings ? { settings: need.settings } : {}) },
        relationships: { bundleId: { data: { type: "bundleIds", id: resourceId } } },
      },
    });
    enabled.push(need.capability);
  }
  // A profile made before the change does not carry the new capabilities.
  // Remove the ones Hands made so the next signing creates a fresh one.
  const removed: string[] = [];
  if (plan.app_id_resource_id && enabled.length > 0) {
    const profiles = await all<{ name: string; profileType: string }>(creds, `/v1/bundleIds/${encodeURIComponent(resourceId)}/profiles?limit=200`);
    for (const profile of profiles) {
      if (profile.attributes.profileType !== "IOS_APP_STORE" || !profile.attributes.name.startsWith("Hands ")) continue;
      await asc(creds, "DELETE", `/v1/profiles/${encodeURIComponent(profile.id)}`);
      removed.push(profile.id);
    }
  }
  return {
    bundle_id: plan.bundle_id,
    app_id_resource_id: resourceId,
    created_app_id: !plan.app_id_resource_id,
    enabled,
    profiles_removed: removed,
    manual: plan.manual,
    unknown_entitlements: plan.unknown_entitlements,
  };
}
