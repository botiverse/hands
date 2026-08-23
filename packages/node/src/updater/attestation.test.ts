import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  UPDATE_ATTESTATION_ALGORITHM,
  UPDATE_ATTESTATION_DOMAIN,
  UPDATE_ATTESTATION_SCHEMA_VERSION,
  UpdateAttestationError,
  canonicalizeUpdateAttestationPayload,
  updateAttestationKeyId,
  verifyUpdateArtifactAttestation,
  type UpdateArtifactAttestationPayload,
} from "./attestation.js";

function fixture() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const spki = publicKey.export({ format: "der", type: "spki" });
  const keyId = updateAttestationKeyId(spki);
  const payload: UpdateArtifactAttestationPayload = {
    algorithm: UPDATE_ATTESTATION_ALGORITHM,
    appId: "app_1",
    artifact: {
      arch: "arm64",
      id: "target_1",
      kind: "external_build_target",
      platform: "darwin",
      sha256: "a".repeat(64),
      sizeBytes: 42,
      type: "sea",
    },
    buildId: "build_1",
    channelId: "channel_alpha",
    domain: UPDATE_ATTESTATION_DOMAIN,
    issuedAt: 1_787_460_000_000,
    keyId,
    productType: "cli-binary",
    releaseId: "release_1",
    releaseType: "stable",
    schemaVersion: UPDATE_ATTESTATION_SCHEMA_VERSION,
    sourceCommit: "1".repeat(40),
    version: "1.0.19",
    versionCode: 1_000_019,
  };
  const canonical = Buffer.from(canonicalizeUpdateAttestationPayload(payload));
  return {
    payload,
    envelope: {
      algorithm: UPDATE_ATTESTATION_ALGORITHM,
      keyId,
      payload: canonical.toString("base64url"),
      schemaVersion: UPDATE_ATTESTATION_SCHEMA_VERSION,
      signature: sign(null, canonical, privateKey).toString("base64url"),
    },
    trustRoot: { [keyId]: spki.toString("base64url") },
  } as const;
}

describe("update artifact attestation", () => {
  it("verifies a canonical, release-bound Ed25519 envelope", () => {
    const { envelope, payload, trustRoot } = fixture();
    expect(verifyUpdateArtifactAttestation(envelope, trustRoot)).toEqual(payload);
  });

  it("rejects unknown trust roots", () => {
    const { envelope } = fixture();
    expect(() => verifyUpdateArtifactAttestation(envelope, {})).toThrowError(
      expect.objectContaining<Partial<UpdateAttestationError>>({ code: "UPDATE_SIGNATURE_KEY_UNKNOWN" }),
    );
  });

  it("rejects validly encoded but altered signatures", () => {
    const { envelope, trustRoot } = fixture();
    const signature = Buffer.from(envelope.signature, "base64url");
    signature[0] ^= 1;
    expect(() =>
      verifyUpdateArtifactAttestation(
        { ...envelope, signature: signature.toString("base64url") },
        trustRoot,
      ),
    ).toThrowError(expect.objectContaining<Partial<UpdateAttestationError>>({ code: "UPDATE_SIGNATURE_INVALID" }));
  });

  it("rejects non-canonical payload bytes before accepting their signature", () => {
    const { envelope, payload, trustRoot } = fixture();
    const nonCanonical = Buffer.from(JSON.stringify(payload, null, 2));
    expect(() =>
      verifyUpdateArtifactAttestation(
        { ...envelope, payload: nonCanonical.toString("base64url") },
        trustRoot,
      ),
    ).toThrowError(expect.objectContaining<Partial<UpdateAttestationError>>({ code: "UPDATE_RESPONSE_INVALID" }));
  });

  it("rejects omitted identity fields and unexpected fields", () => {
    const { envelope, payload, trustRoot } = fixture();
    const malformed = { ...payload, releaseId: undefined, extra: true };
    const bytes = Buffer.from(JSON.stringify(malformed));
    expect(() =>
      verifyUpdateArtifactAttestation(
        { ...envelope, payload: bytes.toString("base64url") },
        trustRoot,
      ),
    ).toThrowError(expect.objectContaining<Partial<UpdateAttestationError>>({ code: "UPDATE_RESPONSE_INVALID" }));
  });
});
