/**
 * App Store provisioning profiles through the App Store Connect API, for
 * re-signing an iOS build with a Distribution certificate held by Hands.
 *
 * The profile is looked up for the build's bundle ID and certificate; an
 * active App Store profile that has more than a week left is reused, and
 * otherwise a new one is created. The App ID itself is not created here: its
 * capabilities decide what the app may do, so a person registers it.
 */

import { AscApiError, ascRequest, type AscApiCredentials } from "./asc_api";
import { SigningError } from "./signing";

const RENEW_BEFORE_MS = 7 * 24 * 60 * 60 * 1000;

type Resource<A> = { id: string; type: string; attributes: A };
type List<A> = { data: Array<Resource<A>>; links?: { next?: string } };

type BundleIdAttributes = { identifier: string; platform: string; name?: string };
type CertificateAttributes = { certificateType: string; certificateContent?: string; serialNumber?: string; expirationDate?: string };
type ProfileAttributes = {
  name: string;
  profileType: string;
  profileState: string;
  profileContent?: string;
  expirationDate?: string;
  uuid?: string;
};

export type ResolvedProfile = {
  profile_b64: string;
  profile_id: string;
  name: string;
  uuid: string | null;
  expiration: string | null;
  created: boolean;
};

async function sha256Hex(b64: string): Promise<string> {
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function asc<T>(creds: AscApiCredentials, method: string, path: string, body?: unknown): Promise<T> {
  try {
    return await ascRequest<T>(creds, method, path, body, AbortSignal.timeout(20_000));
  } catch (error) {
    if (error instanceof AscApiError) {
      const detail = error.detail ? `: ${error.detail}` : "";
      const status = error.status === 401 || error.status === 403 ? 400 : 502;
      throw new SigningError(status, error.status === 401 || error.status === 403 ? "asc_key_refused" : "asc_unavailable",
        `App Store Connect ${method} ${path.split("?")[0]} failed (${error.status}) ${error.message}${detail}`.slice(0, 500));
    }
    throw new SigningError(502, "asc_unavailable", `App Store Connect did not answer: ${error instanceof Error ? error.name : "error"}`);
  }
}

/** Follow `links.next` (absolute URLs on the API host) up to a few pages. */
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

export async function appStoreProfile(
  creds: AscApiCredentials,
  bundleId: string,
  certificateSha256: string,
  now = Date.now(),
): Promise<ResolvedProfile> {
  const bundles = await all<BundleIdAttributes>(creds, `/v1/bundleIds?filter[identifier]=${encodeURIComponent(bundleId)}&limit=200`);
  const bundle = bundles.find((b) => b.attributes.identifier === bundleId && (b.attributes.platform === "IOS" || b.attributes.platform === "UNIVERSAL"));
  if (!bundle) {
    throw new SigningError(400, "signing_app_id_missing",
      `register the App ID ${bundleId} (iOS) with its capabilities in the Apple Developer site, then sign again`);
  }

  const certs = await all<CertificateAttributes>(creds, "/v1/certificates?filter[certificateType]=DISTRIBUTION,IOS_DISTRIBUTION&limit=200");
  let certificateId: string | null = null;
  for (const cert of certs) {
    if (cert.attributes.certificateContent && await sha256Hex(cert.attributes.certificateContent) === certificateSha256) {
      certificateId = cert.id;
      break;
    }
  }
  if (!certificateId) {
    throw new SigningError(400, "signing_certificate_not_in_team",
      "this Distribution certificate is not in the API key's team, or it was revoked; check that the key and the certificate belong to the same team");
  }

  const profiles = await all<ProfileAttributes>(creds, `/v1/bundleIds/${encodeURIComponent(bundle.id)}/profiles?limit=200`);
  const usable = profiles.filter((p) => p.attributes.profileType === "IOS_APP_STORE"
    && p.attributes.profileState === "ACTIVE"
    && !!p.attributes.profileContent
    && Date.parse(p.attributes.expirationDate ?? "") > now + RENEW_BEFORE_MS);
  for (const profile of usable) {
    const linked = await asc<{ data: Array<{ id: string }> }>(creds, "GET", `/v1/profiles/${encodeURIComponent(profile.id)}/relationships/certificates?limit=200`);
    if (linked.data.some((c) => c.id === certificateId)) {
      return {
        profile_b64: profile.attributes.profileContent!,
        profile_id: profile.id,
        name: profile.attributes.name,
        uuid: profile.attributes.uuid ?? null,
        expiration: profile.attributes.expirationDate ?? null,
        created: false,
      };
    }
  }

  const stamp = new Date(now).toISOString().slice(0, 16).replace(/[-:T]/g, "");
  const created = await asc<{ data: Resource<ProfileAttributes> }>(creds, "POST", "/v1/profiles", {
    data: {
      type: "profiles",
      attributes: { name: `Hands ${bundleId} App Store ${stamp}`.slice(0, 100), profileType: "IOS_APP_STORE" },
      relationships: {
        bundleId: { data: { type: "bundleIds", id: bundle.id } },
        certificates: { data: [{ type: "certificates", id: certificateId }] },
      },
    },
  });
  if (!created.data.attributes.profileContent) throw new SigningError(502, "asc_unavailable", "App Store Connect returned a profile without content");
  return {
    profile_b64: created.data.attributes.profileContent,
    profile_id: created.data.id,
    name: created.data.attributes.name,
    uuid: created.data.attributes.uuid ?? null,
    expiration: created.data.attributes.expirationDate ?? null,
    created: true,
  };
}
