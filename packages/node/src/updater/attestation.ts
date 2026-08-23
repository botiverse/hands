import { createHash, createPublicKey, verify } from "node:crypto";

export const UPDATE_ATTESTATION_ALGORITHM = "Ed25519" as const;
export const UPDATE_ATTESTATION_DOMAIN =
  "hands.build/update-artifact-attestation/v1" as const;
export const UPDATE_ATTESTATION_SCHEMA_VERSION = 1 as const;

export type UpdateArtifactKind = "build_asset" | "external_build_target";

export interface UpdateArtifactAttestationPayload {
  algorithm: typeof UPDATE_ATTESTATION_ALGORITHM;
  appId: string;
  artifact: {
    arch: string | null;
    id: string;
    kind: UpdateArtifactKind;
    platform: string;
    sha256: string;
    sizeBytes: number;
    type: string;
  };
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

export interface UpdateArtifactAttestationEnvelope {
  algorithm: typeof UPDATE_ATTESTATION_ALGORITHM;
  keyId: string;
  payload: string;
  schemaVersion: typeof UPDATE_ATTESTATION_SCHEMA_VERSION;
  signature: string;
}

export type UpdateTrustRoot = Readonly<Record<string, string>>;

export class UpdateAttestationError extends Error {
  constructor(
    readonly code:
      | "UPDATE_RESPONSE_INVALID"
      | "UPDATE_SIGNATURE_UNSUPPORTED"
      | "UPDATE_SIGNATURE_KEY_UNKNOWN"
      | "UPDATE_SIGNATURE_INVALID",
    message: string,
  ) {
    super(message);
    this.name = "UpdateAttestationError";
  }
}

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const KEY_ID_PATTERN = /^sha256:[a-f0-9]{64}$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  path: string,
): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new UpdateAttestationError(
      "UPDATE_RESPONSE_INVALID",
      `${path} must contain exactly: ${wanted.join(", ")}`,
    );
  }
}

function requireString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new UpdateAttestationError("UPDATE_RESPONSE_INVALID", `${path} must be a non-empty string`);
  }
  return value;
}

function requireSafeInteger(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new UpdateAttestationError(
      "UPDATE_RESPONSE_INVALID",
      `${path} must be a non-negative safe integer`,
    );
  }
  return value;
}

function canonicalizeValue(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new UpdateAttestationError("UPDATE_RESPONSE_INVALID", "canonical JSON rejects non-finite numbers");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalizeValue).join(",")}]`;
  }
  if (!isRecord(value)) {
    throw new UpdateAttestationError("UPDATE_RESPONSE_INVALID", "canonical JSON rejects unsupported values");
  }
  const fields = Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalizeValue(value[key])}`);
  return `{${fields.join(",")}}`;
}

export function canonicalizeUpdateAttestationPayload(
  payload: UpdateArtifactAttestationPayload,
): string {
  return canonicalizeValue(payload);
}

export function updateAttestationKeyId(publicKeySpki: Uint8Array): string {
  return `sha256:${createHash("sha256").update(publicKeySpki).digest("hex")}`;
}

export function parseUpdateAttestationPayload(value: unknown): UpdateArtifactAttestationPayload {
  if (!isRecord(value)) {
    throw new UpdateAttestationError("UPDATE_RESPONSE_INVALID", "attestation payload must be an object");
  }
  assertExactKeys(
    value,
    [
      "algorithm",
      "appId",
      "artifact",
      "buildId",
      "channelId",
      "domain",
      "issuedAt",
      "keyId",
      "productType",
      "releaseId",
      "releaseType",
      "schemaVersion",
      "sourceCommit",
      "version",
      "versionCode",
    ],
    "attestation payload",
  );
  if (value.algorithm !== UPDATE_ATTESTATION_ALGORITHM) {
    throw new UpdateAttestationError("UPDATE_SIGNATURE_UNSUPPORTED", "unsupported attestation algorithm");
  }
  if (value.domain !== UPDATE_ATTESTATION_DOMAIN) {
    throw new UpdateAttestationError("UPDATE_RESPONSE_INVALID", "invalid attestation domain");
  }
  if (value.schemaVersion !== UPDATE_ATTESTATION_SCHEMA_VERSION) {
    throw new UpdateAttestationError("UPDATE_SIGNATURE_UNSUPPORTED", "unsupported attestation schema version");
  }
  const keyId = requireString(value.keyId, "keyId");
  if (!KEY_ID_PATTERN.test(keyId)) {
    throw new UpdateAttestationError("UPDATE_RESPONSE_INVALID", "keyId must be an SPKI SHA-256 identity");
  }
  if (!isRecord(value.artifact)) {
    throw new UpdateAttestationError("UPDATE_RESPONSE_INVALID", "artifact must be an object");
  }
  assertExactKeys(
    value.artifact,
    ["arch", "id", "kind", "platform", "sha256", "sizeBytes", "type"],
    "artifact",
  );
  if (value.artifact.kind !== "build_asset" && value.artifact.kind !== "external_build_target") {
    throw new UpdateAttestationError("UPDATE_RESPONSE_INVALID", "artifact.kind is unsupported");
  }
  const sha256 = requireString(value.artifact.sha256, "artifact.sha256");
  if (!SHA256_PATTERN.test(sha256)) {
    throw new UpdateAttestationError("UPDATE_RESPONSE_INVALID", "artifact.sha256 must be lowercase hex");
  }
  const arch = value.artifact.arch;
  if (arch !== null && (typeof arch !== "string" || arch.length === 0)) {
    throw new UpdateAttestationError("UPDATE_RESPONSE_INVALID", "artifact.arch must be null or non-empty");
  }
  const sourceCommit = value.sourceCommit;
  if (sourceCommit !== null && (typeof sourceCommit !== "string" || sourceCommit.length === 0)) {
    throw new UpdateAttestationError("UPDATE_RESPONSE_INVALID", "sourceCommit must be null or non-empty");
  }
  return {
    algorithm: UPDATE_ATTESTATION_ALGORITHM,
    appId: requireString(value.appId, "appId"),
    artifact: {
      arch,
      id: requireString(value.artifact.id, "artifact.id"),
      kind: value.artifact.kind,
      platform: requireString(value.artifact.platform, "artifact.platform"),
      sha256,
      sizeBytes: requireSafeInteger(value.artifact.sizeBytes, "artifact.sizeBytes"),
      type: requireString(value.artifact.type, "artifact.type"),
    },
    buildId: requireString(value.buildId, "buildId"),
    channelId: requireString(value.channelId, "channelId"),
    domain: UPDATE_ATTESTATION_DOMAIN,
    issuedAt: requireSafeInteger(value.issuedAt, "issuedAt"),
    keyId,
    productType: requireString(value.productType, "productType"),
    releaseId: requireString(value.releaseId, "releaseId"),
    releaseType: requireString(value.releaseType, "releaseType"),
    schemaVersion: UPDATE_ATTESTATION_SCHEMA_VERSION,
    sourceCommit,
    version: requireString(value.version, "version"),
    versionCode: requireSafeInteger(value.versionCode, "versionCode"),
  };
}

function decodeBase64Url(value: string, path: string): Buffer {
  if (!BASE64URL_PATTERN.test(value) || value.includes("=")) {
    throw new UpdateAttestationError("UPDATE_RESPONSE_INVALID", `${path} must be unpadded base64url`);
  }
  const decoded = Buffer.from(value, "base64url");
  if (decoded.length === 0 || decoded.toString("base64url") !== value) {
    throw new UpdateAttestationError("UPDATE_RESPONSE_INVALID", `${path} is malformed`);
  }
  return decoded;
}

export function verifyUpdateArtifactAttestation(
  envelope: UpdateArtifactAttestationEnvelope,
  trustRoot: UpdateTrustRoot,
): UpdateArtifactAttestationPayload {
  if (envelope.algorithm !== UPDATE_ATTESTATION_ALGORITHM) {
    throw new UpdateAttestationError("UPDATE_SIGNATURE_UNSUPPORTED", "unsupported attestation algorithm");
  }
  if (envelope.schemaVersion !== UPDATE_ATTESTATION_SCHEMA_VERSION) {
    throw new UpdateAttestationError("UPDATE_SIGNATURE_UNSUPPORTED", "unsupported attestation schema version");
  }
  const spkiEncoded = trustRoot[envelope.keyId];
  if (!spkiEncoded) {
    throw new UpdateAttestationError("UPDATE_SIGNATURE_KEY_UNKNOWN", "attestation key is not trusted");
  }
  const spki = decodeBase64Url(spkiEncoded, "trusted public key");
  if (updateAttestationKeyId(spki) !== envelope.keyId) {
    throw new UpdateAttestationError("UPDATE_SIGNATURE_KEY_UNKNOWN", "trusted key identity is inconsistent");
  }
  const payloadBytes = decodeBase64Url(envelope.payload, "attestation payload");
  let decoded: unknown;
  try {
    decoded = JSON.parse(payloadBytes.toString("utf8"));
  } catch {
    throw new UpdateAttestationError("UPDATE_RESPONSE_INVALID", "attestation payload is not JSON");
  }
  const payload = parseUpdateAttestationPayload(decoded);
  if (payload.keyId !== envelope.keyId || payload.algorithm !== envelope.algorithm) {
    throw new UpdateAttestationError("UPDATE_SIGNATURE_INVALID", "attestation envelope does not match payload");
  }
  const canonical = Buffer.from(canonicalizeUpdateAttestationPayload(payload), "utf8");
  if (!canonical.equals(payloadBytes)) {
    throw new UpdateAttestationError("UPDATE_RESPONSE_INVALID", "attestation payload is not canonical JSON");
  }
  const signature = decodeBase64Url(envelope.signature, "attestation signature");
  let valid = false;
  try {
    const publicKey = createPublicKey({ key: spki, format: "der", type: "spki" });
    valid = verify(null, payloadBytes, publicKey, signature);
  } catch {
    throw new UpdateAttestationError("UPDATE_SIGNATURE_KEY_UNKNOWN", "trusted public key is invalid");
  }
  if (!valid) {
    throw new UpdateAttestationError("UPDATE_SIGNATURE_INVALID", "attestation signature is invalid");
  }
  return payload;
}
