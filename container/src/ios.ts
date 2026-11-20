/**
 * iOS re-signing helpers that need no tools: property lists (XML and binary),
 * provisioning-profile checks and the entitlements an App Store build is
 * signed with. The signing endpoint in signing.ts runs openssl and rcodesign
 * around these.
 */

export type PlistValue =
  | string
  | number
  | boolean
  | Date
  | Uint8Array
  | PlistValue[]
  | { [key: string]: PlistValue };

export type PlistDict = { [key: string]: PlistValue };

export class PlistError extends Error {}

// ---------- XML property lists ----------

const XML_ENTITIES: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };

function unescapeXml(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-z]+);/g, (match, entity: string) => {
    if (entity.startsWith("#x")) return String.fromCodePoint(parseInt(entity.slice(2), 16));
    if (entity.startsWith("#")) return String.fromCodePoint(parseInt(entity.slice(1), 10));
    return XML_ENTITIES[entity] ?? match;
  });
}

type Token = { kind: "open" | "close" | "empty"; name: string } | { kind: "text"; text: string };

function tokenize(xml: string): Token[] {
  const body = xml.replace(/<\?[\s\S]*?\?>|<!--[\s\S]*?-->|<!DOCTYPE[\s\S]*?>/g, "");
  const tokens: Token[] = [];
  const re = /<(\/?)([A-Za-z]+)[^>]*?(\/?)>|([^<]+)/g;
  for (let m = re.exec(body); m; m = re.exec(body)) {
    if (m[4] !== undefined) {
      tokens.push({ kind: "text", text: m[4] });
    } else {
      tokens.push({ kind: m[1] ? "close" : m[3] ? "empty" : "open", name: m[2]! });
    }
  }
  return tokens;
}

export function parseXmlPlist(xml: string): PlistValue {
  const tokens = tokenize(xml);
  let i = 0;
  const raw = () => {
    const token = tokens[i++];
    if (!token) throw new PlistError("unexpected end of property list");
    return token;
  };
  /** The next tag, skipping whitespace between elements. */
  const tag = () => {
    for (;;) {
      const token = raw();
      if (token.kind !== "text") return token;
      if (token.text.trim() !== "") throw new PlistError("unexpected text in property list");
    }
  };
  /** Text up to the closing tag; whitespace is kept (it is significant in <string>). */
  const textUntil = (name: string): string => {
    let text = "";
    for (;;) {
      const token = raw();
      if (token.kind === "text") text += token.text;
      else if (token.kind === "close" && token.name === name) return unescapeXml(text);
      else throw new PlistError(`unexpected <${token.name}> in <${name}>`);
    }
  };
  const readValue = (token: Token): PlistValue => {
    if (token.kind !== "open" && token.kind !== "empty") throw new PlistError("expected a value");
    const empty = token.kind === "empty";
    switch (token.name) {
      case "true": if (!empty) textUntil("true"); return true;
      case "false": if (!empty) textUntil("false"); return false;
      case "string": return empty ? "" : textUntil("string");
      case "integer": case "real": {
        const value = Number(empty ? "0" : textUntil(token.name).trim());
        if (!Number.isFinite(value)) throw new PlistError(`bad <${token.name}>`);
        return value;
      }
      case "date": return new Date(empty ? 0 : textUntil("date").trim());
      case "data": return empty ? new Uint8Array() : Uint8Array.from(Buffer.from(textUntil("data").replace(/\s+/g, ""), "base64"));
      case "array": {
        const out: PlistValue[] = [];
        if (empty) return out;
        for (let t = tag(); !(t.kind === "close" && t.name === "array"); t = tag()) out.push(readValue(t));
        return out;
      }
      case "dict": {
        const out: PlistDict = {};
        if (empty) return out;
        for (let t = tag(); !(t.kind === "close" && t.name === "dict"); t = tag()) {
          if (t.kind !== "open" || t.name !== "key") throw new PlistError("<dict> entries must start with <key>");
          const key = textUntil("key");
          out[key] = readValue(tag());
        }
        return out;
      }
      default: throw new PlistError(`unsupported <${token.name}>`);
    }
  };
  let top = tag();
  if (top.kind === "open" && top.name === "plist") top = tag();
  return readValue(top);
}

function escapeXml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function toXmlPlist(value: PlistValue): string {
  const out: string[] = [];
  const write = (v: PlistValue, indent: string) => {
    if (typeof v === "string") out.push(`${indent}<string>${escapeXml(v)}</string>`);
    else if (typeof v === "boolean") out.push(`${indent}<${v}/>`);
    else if (typeof v === "number") out.push(Number.isInteger(v) ? `${indent}<integer>${v}</integer>` : `${indent}<real>${v}</real>`);
    else if (v instanceof Date) out.push(`${indent}<date>${v.toISOString().replace(/\.\d{3}Z$/, "Z")}</date>`);
    else if (v instanceof Uint8Array) out.push(`${indent}<data>${Buffer.from(v).toString("base64")}</data>`);
    else if (Array.isArray(v)) {
      out.push(`${indent}<array>`);
      for (const item of v) write(item, `${indent}\t`);
      out.push(`${indent}</array>`);
    } else {
      out.push(`${indent}<dict>`);
      for (const key of Object.keys(v).sort()) {
        out.push(`${indent}\t<key>${escapeXml(key)}</key>`);
        write(v[key]!, `${indent}\t`);
      }
      out.push(`${indent}</dict>`);
    }
  };
  write(value, "");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n${out.join("\n")}\n</plist>\n`;
}

// ---------- Binary property lists (bplist00) ----------

export function parseBinaryPlist(buf: Buffer): PlistValue {
  if (buf.length < 40 || buf.subarray(0, 8).toString("latin1") !== "bplist00") throw new PlistError("not a binary property list");
  const trailer = buf.subarray(buf.length - 32);
  const offsetSize = trailer[6]!;
  const refSize = trailer[7]!;
  const numObjects = Number(trailer.readBigUInt64BE(8));
  const top = Number(trailer.readBigUInt64BE(16));
  const tableOffset = Number(trailer.readBigUInt64BE(24));
  if (numObjects > 1_000_000 || tableOffset + numObjects * offsetSize > buf.length - 32) throw new PlistError("bad binary property list trailer");
  const uint = (at: number, size: number) => {
    let v = 0;
    for (let k = 0; k < size; k++) v = v * 256 + buf[at + k]!;
    return v;
  };
  const offsets = Array.from({ length: numObjects }, (_, k) => uint(tableOffset + k * offsetSize, offsetSize));
  const depth = new Set<number>();
  const read = (ref: number): PlistValue => {
    if (ref >= numObjects) throw new PlistError("object reference out of range");
    if (depth.has(ref)) throw new PlistError("cyclic binary property list");
    depth.add(ref);
    try {
      const at = offsets[ref]!;
      const marker = buf[at]!;
      const type = marker >> 4;
      const info = marker & 0x0f;
      let start = at + 1;
      let count = info;
      if (info === 0x0f && [0x4, 0x5, 0x6, 0xa, 0xd].includes(type)) {
        const intMarker = buf[start]!;
        const size = 1 << (intMarker & 0x0f);
        count = uint(start + 1, size);
        start += 1 + size;
      }
      switch (type) {
        case 0x0:
          if (marker === 0x08) return false;
          if (marker === 0x09) return true;
          throw new PlistError("unsupported binary plist marker");
        case 0x1: {
          const size = 1 << info;
          if (size === 8) return Number(buf.readBigInt64BE(start));
          return uint(start, size);
        }
        case 0x2: return info === 2 ? buf.readFloatBE(start) : buf.readDoubleBE(start);
        case 0x3: return new Date(Date.UTC(2001, 0, 1) + buf.readDoubleBE(start) * 1000);
        case 0x4: return Uint8Array.from(buf.subarray(start, start + count));
        case 0x5: return buf.subarray(start, start + count).toString("latin1");
        case 0x6: {
          const chars = buf.subarray(start, start + count * 2);
          const swapped = Buffer.from(chars);
          swapped.swap16();
          return swapped.toString("utf16le");
        }
        case 0x8: return uint(start, info + 1);
        case 0xa: return Array.from({ length: count }, (_, k) => read(uint(start + k * refSize, refSize)));
        case 0xd: {
          const out: PlistDict = {};
          for (let k = 0; k < count; k++) {
            const key = read(uint(start + k * refSize, refSize));
            if (typeof key !== "string") throw new PlistError("dictionary key is not a string");
            out[key] = read(uint(start + (count + k) * refSize, refSize));
          }
          return out;
        }
        default: throw new PlistError("unsupported binary plist object");
      }
    } finally {
      depth.delete(ref);
    }
  };
  return read(top);
}

export function parsePlist(buf: Buffer): PlistValue {
  if (buf.subarray(0, 6).toString("latin1") === "bplist") return parseBinaryPlist(buf);
  return parseXmlPlist(buf.toString("utf8"));
}

export function asDict(value: PlistValue, what: string): PlistDict {
  if (typeof value !== "object" || value === null || Array.isArray(value) || value instanceof Date || value instanceof Uint8Array) {
    throw new PlistError(`${what} is not a dictionary`);
  }
  return value;
}

// ---------- Provisioning profiles ----------

export type ProfileInfo = {
  name: string;
  uuid: string;
  team_id: string;
  application_identifier: string;
  expiration: string;
  /** SHA-256 (hex) of each certificate the profile allows. */
  certificate_sha256: string[];
  entitlements: PlistDict;
  devices: number;
};

export function profileInfo(plist: PlistValue, sha256: (der: Uint8Array) => string): ProfileInfo {
  const p = asDict(plist, "provisioning profile");
  const entitlements = asDict(p.Entitlements ?? {}, "profile entitlements");
  const team = Array.isArray(p.TeamIdentifier) ? p.TeamIdentifier[0] : undefined;
  const certs = Array.isArray(p.DeveloperCertificates) ? p.DeveloperCertificates : [];
  const expiration = p.ExpirationDate instanceof Date ? p.ExpirationDate : null;
  if (typeof team !== "string" || typeof entitlements["application-identifier"] !== "string" || !expiration) {
    throw new PlistError("provisioning profile is missing its team, application identifier or expiry");
  }
  return {
    name: typeof p.Name === "string" ? p.Name : "",
    uuid: typeof p.UUID === "string" ? p.UUID : "",
    team_id: team,
    application_identifier: entitlements["application-identifier"] as string,
    expiration: expiration.toISOString(),
    certificate_sha256: certs.filter((c): c is Uint8Array => c instanceof Uint8Array).map(sha256),
    entitlements,
    devices: Array.isArray(p.ProvisionedDevices) ? p.ProvisionedDevices.length : 0,
  };
}

/** Whether a profile's application identifier (possibly a wildcard) covers this bundle. */
export function profileCoversBundle(profile: ProfileInfo, bundleId: string): boolean {
  const prefix = `${profile.team_id}.`;
  const id = profile.application_identifier;
  if (!id.startsWith(prefix)) return false;
  const pattern = id.slice(prefix.length);
  if (pattern === "*") return true;
  if (pattern.endsWith(".*")) return bundleId.startsWith(pattern.slice(0, -1));
  return pattern === bundleId;
}

export class EntitlementError extends Error {}

function allowed(profileValue: PlistValue | undefined, requested: PlistValue, team: string): boolean {
  if (profileValue === undefined) return false;
  const wildcard = (v: PlistValue) => typeof v === "string" && (v === "*" || v === `${team}.*`);
  if (wildcard(profileValue)) return true;
  if (Array.isArray(profileValue) && profileValue.some(wildcard)) return true;
  if (typeof requested === "boolean") return profileValue === true || profileValue === requested;
  if (typeof requested === "string") {
    if (Array.isArray(profileValue)) return profileValue.includes(requested);
    if (typeof profileValue === "string" && profileValue.endsWith(".*")) return requested.startsWith(profileValue.slice(0, -1));
    return profileValue === requested;
  }
  if (Array.isArray(requested)) {
    const pool = Array.isArray(profileValue) ? profileValue : [profileValue];
    return requested.every((item) => pool.some((p) => p === item || (typeof p === "string" && typeof item === "string" && p.endsWith(".*") && item.startsWith(p.slice(0, -1)))));
  }
  return false;
}

/**
 * Entitlements for an App Store build: what the app asks for (from its
 * project), each of which the profile must allow, plus the identity keys the
 * profile fixes. Debugging is never allowed.
 */
export function appStoreEntitlements(profile: ProfileInfo, bundleId: string, requested: PlistDict): PlistDict {
  if (profile.entitlements["get-task-allow"] === true) {
    throw new EntitlementError(`profile ${profile.name} is a development profile; use an App Store profile`);
  }
  if (profile.devices > 0) {
    throw new EntitlementError(`profile ${profile.name} lists devices (ad hoc); use an App Store profile`);
  }
  const fixed = new Set(["application-identifier", "com.apple.developer.team-identifier", "get-task-allow"]);
  const refused: string[] = [];
  const out: PlistDict = {};
  for (const [key, value] of Object.entries(requested)) {
    if (fixed.has(key)) continue;
    let wanted = value;
    // Xcode writes $(AppIdentifierPrefix) and $(TeamIdentifierPrefix) as the team prefix.
    const expand = (v: PlistValue): PlistValue => typeof v === "string"
      ? v.replace(/\$\((AppIdentifierPrefix|TeamIdentifierPrefix)\)/g, `${profile.team_id}.`).replace(/\$\((PRODUCT_BUNDLE_IDENTIFIER|CFBundleIdentifier)\)/g, bundleId)
      : Array.isArray(v) ? v.map(expand) : v;
    wanted = expand(wanted);
    if (key === "aps-environment") wanted = "production";
    if (!allowed(profile.entitlements[key], wanted, profile.team_id)) refused.push(key);
    else out[key] = wanted;
  }
  if (refused.length > 0) {
    throw new EntitlementError(`the profile does not allow: ${refused.join(", ")}. Turn these capabilities on for the App ID, then sign again.`);
  }
  out["application-identifier"] = `${profile.team_id}.${bundleId}`;
  out["com.apple.developer.team-identifier"] = profile.team_id;
  out["get-task-allow"] = false;
  if (profile.entitlements["beta-reports-active"] === true) out["beta-reports-active"] = true;
  return out;
}
