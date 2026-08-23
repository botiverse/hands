export const UPDATE_ATTESTATION_ALGORITHM = "Ed25519" as const;
export const UPDATE_ATTESTATION_DOMAIN = "hands.build/update-artifact-attestation/v1" as const;
export const UPDATE_ATTESTATION_SCHEMA_VERSION = 1 as const;

export type UpdateArtifactKind = "build_asset" | "external_build_target";

export interface UpdateArtifactAttestationPayload {
  algorithm: typeof UPDATE_ATTESTATION_ALGORITHM;
  appId: string;
  artifact: { arch: string | null; id: string; kind: UpdateArtifactKind; platform: string; sha256: string; sizeBytes: number; type: string };
  buildId: string;
  channelId: string;
  domain: typeof UPDATE_ATTESTATION_DOMAIN;
  issuedAt: number;
  keyId: string;
  productType: string;
  releaseId: string;
  releaseType: string;
  schemaVersion: typeof UPDATE_ATTESTATION_SCHEMA_VERSION;
  sourceCommit: string | null;
  version: string;
  versionCode: number;
}

export interface UpdateAttestationEnvelope { algorithm: string; keyId: string; payload: string; schemaVersion: number; signature: string }

export class UpdateAttestationError extends Error {
  constructor(readonly code: "UPDATE_RESPONSE_INVALID" | "UPDATE_SIGNATURE_UNSUPPORTED" | "UPDATE_SIGNATURE_KEY_UNKNOWN" | "UPDATE_SIGNATURE_INVALID", message: string) {
    super(message);
    this.name = "UpdateAttestationError";
  }
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], path: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new UpdateAttestationError("UPDATE_RESPONSE_INVALID", `${path} fields are invalid`);
  }
}

function parsePayload(value: unknown): UpdateArtifactAttestationPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new UpdateAttestationError("UPDATE_RESPONSE_INVALID", "attestation payload must be an object");
  const payload = value as Record<string, unknown>;
  exactKeys(payload, ["algorithm", "appId", "artifact", "buildId", "channelId", "domain", "issuedAt", "keyId", "productType", "releaseId", "releaseType", "schemaVersion", "sourceCommit", "version", "versionCode"], "attestation payload");
  if (!payload.artifact || typeof payload.artifact !== "object" || Array.isArray(payload.artifact)) throw new UpdateAttestationError("UPDATE_RESPONSE_INVALID", "artifact must be an object");
  const artifact = payload.artifact as Record<string, unknown>;
  exactKeys(artifact, ["arch", "id", "kind", "platform", "sha256", "sizeBytes", "type"], "artifact");
  const nonEmpty = (candidate: unknown) => typeof candidate === "string" && candidate.length > 0;
  if (payload.algorithm !== UPDATE_ATTESTATION_ALGORITHM || payload.domain !== UPDATE_ATTESTATION_DOMAIN || payload.schemaVersion !== UPDATE_ATTESTATION_SCHEMA_VERSION || !nonEmpty(payload.keyId) ||
      !nonEmpty(payload.appId) || !nonEmpty(payload.buildId) || !nonEmpty(payload.channelId) || !nonEmpty(payload.productType) || !nonEmpty(payload.releaseId) || !nonEmpty(payload.releaseType) || !nonEmpty(payload.version) ||
      !Number.isSafeInteger(payload.issuedAt) || !Number.isSafeInteger(payload.versionCode) ||
      (payload.sourceCommit !== null && !nonEmpty(payload.sourceCommit)) ||
      (artifact.kind !== "build_asset" && artifact.kind !== "external_build_target") || !nonEmpty(artifact.id) || !nonEmpty(artifact.platform) || !nonEmpty(artifact.type) ||
      (artifact.arch !== null && !nonEmpty(artifact.arch)) || !nonEmpty(artifact.sha256) || !/^[a-f0-9]{64}$/u.test(String(artifact.sha256)) || !Number.isSafeInteger(artifact.sizeBytes)) {
    throw new UpdateAttestationError("UPDATE_RESPONSE_INVALID", "attestation payload fields are invalid");
  }
  return payload as unknown as UpdateArtifactAttestationPayload;
}

export function canonicalizeUpdateAttestationPayload(payload: UpdateArtifactAttestationPayload): string {
  return canonical(payload);
}

function decode(value: string, path: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value) || value.includes("=")) throw new UpdateAttestationError("UPDATE_RESPONSE_INVALID", `${path} must be unpadded base64url`);
  const bytes = Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=")), (char) => char.charCodeAt(0));
  return bytes;
}

export async function updateAttestationKeyId(publicKeySpki: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", publicKeySpki));
  return `sha256:${Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export async function verifyUpdateArtifactAttestation(envelope: UpdateAttestationEnvelope, trustRoot: Readonly<Record<string, string>>): Promise<UpdateArtifactAttestationPayload> {
  if (envelope.algorithm !== UPDATE_ATTESTATION_ALGORITHM || envelope.schemaVersion !== UPDATE_ATTESTATION_SCHEMA_VERSION) throw new UpdateAttestationError("UPDATE_SIGNATURE_UNSUPPORTED", "unsupported attestation algorithm or schema");
  const encodedKey = trustRoot[envelope.keyId];
  if (!encodedKey) throw new UpdateAttestationError("UPDATE_SIGNATURE_KEY_UNKNOWN", "attestation key is not trusted");
  const keyBytes = decode(encodedKey, "trusted public key");
  if (await updateAttestationKeyId(keyBytes) !== envelope.keyId) throw new UpdateAttestationError("UPDATE_SIGNATURE_KEY_UNKNOWN", "trusted key identity is inconsistent");
  const payloadBytes = decode(envelope.payload, "attestation payload");
  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder().decode(payloadBytes)); } catch { throw new UpdateAttestationError("UPDATE_RESPONSE_INVALID", "attestation payload is not JSON"); }
  const payload = parsePayload(parsed);
  if (payload.keyId !== envelope.keyId) throw new UpdateAttestationError("UPDATE_RESPONSE_INVALID", "attestation key identity differs from envelope");
  if (canonical(payload) !== new TextDecoder().decode(payloadBytes)) throw new UpdateAttestationError("UPDATE_RESPONSE_INVALID", "attestation payload is not canonical JSON");
  const signature = decode(envelope.signature, "attestation signature");
  let key: CryptoKey;
  try { key = await crypto.subtle.importKey("spki", keyBytes, { name: UPDATE_ATTESTATION_ALGORITHM }, false, ["verify"]); } catch { throw new UpdateAttestationError("UPDATE_SIGNATURE_KEY_UNKNOWN", "trusted public key is invalid"); }
  if (!await crypto.subtle.verify(UPDATE_ATTESTATION_ALGORITHM, key, signature, payloadBytes)) throw new UpdateAttestationError("UPDATE_SIGNATURE_INVALID", "attestation signature is invalid");
  return payload;
}
