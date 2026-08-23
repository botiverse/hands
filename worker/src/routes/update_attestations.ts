import type { Context } from "hono";
import type { AdminEnv } from "../middleware/auth";
import {
  UPDATE_ATTESTATION_ALGORITHM,
  UPDATE_ATTESTATION_DOMAIN,
  UPDATE_ATTESTATION_SCHEMA_VERSION,
  canonicalizeUpdateAttestationPayload,
  updateAttestationKeyId,
  verifyUpdateArtifactAttestation,
  type UpdateArtifactAttestationPayload,
  type UpdateArtifactKind,
} from "../lib/update_attestation";

type AdminContext = Context<AdminEnv & { Bindings: Env }>;

type ArtifactIdentity = {
  arch: string | null;
  id: string;
  kind: UpdateArtifactKind;
  platform: string;
  sha256: string;
  sizeBytes: number;
  type: string;
};

type ReleaseIdentity = {
  app_id: string;
  build_id: string;
  channel_id: string;
  product_type: string;
  provenance_json: string;
  release_id: string;
  release_type: string;
  status: string;
  version_code: number;
  version_name: string;
};

const REQUEST_TTL_MS = 15 * 60 * 1000;

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, "");
}

function decodeBase64Url(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/u.test(value) || value.includes("=")) return null;
  try {
    return Uint8Array.from(
      atob(value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=")),
      (char) => char.charCodeAt(0),
    );
  } catch {
    return null;
  }
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function sourceCommit(provenanceJson: string): string | null {
  try {
    const value = JSON.parse(provenanceJson) as Record<string, unknown>;
    const candidate = value.source_commit ?? value.sourceCommit ?? value.git_commit ?? value.gitCommit;
    return typeof candidate === "string" && candidate.length > 0 ? candidate : null;
  } catch {
    return null;
  }
}

function splitTarget(target: string): { platform: string; arch: string } | null {
  const index = target.lastIndexOf("-");
  if (index <= 0 || index === target.length - 1) return null;
  return { platform: target.slice(0, index), arch: target.slice(index + 1) };
}

async function releaseIdentity(
  db: D1Database,
  appId: string,
  releaseId: string,
): Promise<ReleaseIdentity | null> {
  return db.prepare(
    `SELECT r.id AS release_id, r.app_id, r.build_id, r.channel_id,
            r.product_type, r.release_type, r.status,
            b.version_name, b.version_code, b.provenance_json
     FROM releases r JOIN builds b ON b.id = r.build_id
     WHERE r.app_id = ?1 AND r.id = ?2`,
  ).bind(appId, releaseId).first<ReleaseIdentity>();
}

async function artifactIdentity(
  db: D1Database,
  buildId: string,
  kind: UpdateArtifactKind,
  artifactId: string,
): Promise<ArtifactIdentity | null> {
  if (kind === "build_asset") {
    const row = await db.prepare(
      `SELECT id, platform, arch, filetype, file_hash, size_bytes
       FROM build_assets WHERE build_id = ?1 AND id = ?2`,
    ).bind(buildId, artifactId).first<{
      id: string; platform: string; arch: string | null; filetype: string;
      file_hash: string; size_bytes: number;
    }>();
    return row ? {
      arch: row.arch,
      id: row.id,
      kind,
      platform: row.platform,
      sha256: row.file_hash.toLowerCase(),
      sizeBytes: row.size_bytes,
      type: row.filetype,
    } : null;
  }
  const row = await db.prepare(
    `SELECT id, target, raw_sha256, raw_size_bytes
     FROM external_build_targets WHERE build_id = ?1 AND id = ?2`,
  ).bind(buildId, artifactId).first<{
    id: string; target: string; raw_sha256: string; raw_size_bytes: number;
  }>();
  const target = row ? splitTarget(row.target) : null;
  return row && target ? {
    arch: target.arch,
    id: row.id,
    kind,
    platform: target.platform,
    sha256: row.raw_sha256.toLowerCase(),
    sizeBytes: row.raw_size_bytes,
    type: "sea",
  } : null;
}

function buildPayload(
  release: ReleaseIdentity,
  artifact: ArtifactIdentity,
  keyId: string,
  issuedAt: number,
): UpdateArtifactAttestationPayload {
  return {
    algorithm: UPDATE_ATTESTATION_ALGORITHM,
    appId: release.app_id,
    artifact,
    buildId: release.build_id,
    channelId: release.channel_id,
    domain: UPDATE_ATTESTATION_DOMAIN,
    issuedAt,
    keyId,
    productType: release.product_type,
    releaseId: release.release_id,
    releaseType: release.release_type,
    schemaVersion: UPDATE_ATTESTATION_SCHEMA_VERSION,
    sourceCommit: sourceCommit(release.provenance_json),
    version: release.version_name,
    versionCode: release.version_code,
  };
}

async function loadPayloadIdentity(
  db: D1Database,
  appId: string,
  releaseId: string,
  artifactKind: UpdateArtifactKind,
  artifactId: string,
  keyId: string,
  issuedAt: number,
): Promise<UpdateArtifactAttestationPayload | null> {
  const release = await releaseIdentity(db, appId, releaseId);
  if (!release || release.status !== "draft") return null;
  const artifact = await artifactIdentity(db, release.build_id, artifactKind, artifactId);
  return artifact ? buildPayload(release, artifact, keyId, issuedAt) : null;
}

export async function handleRegisterUpdateAttestationKey(c: AdminContext) {
  const appId = c.req.param("appId") ?? "";
  const body = await c.req.json().catch(() => ({})) as { label?: unknown; public_key_spki_b64url?: unknown };
  const label = typeof body.label === "string" ? body.label.trim() : "";
  const encoded = typeof body.public_key_spki_b64url === "string" ? body.public_key_spki_b64url : "";
  const spki = decodeBase64Url(encoded);
  if (!label || !spki) return c.json({ error: "label and valid public_key_spki_b64url required" }, 400);
  let keyId: string;
  try {
    await crypto.subtle.importKey("spki", spki, { name: UPDATE_ATTESTATION_ALGORITHM }, false, ["verify"]);
    keyId = await updateAttestationKeyId(spki);
  } catch {
    return c.json({ error: "public key must be Ed25519 SPKI DER" }, 400);
  }
  const now = Date.now();
  await c.env.DB.prepare(
    `INSERT INTO update_attestation_keys
     (key_id, app_id, algorithm, public_key_spki_b64url, status, label, created_at)
     VALUES (?1, ?2, ?3, ?4, 'active', ?5, ?6)
     ON CONFLICT(key_id) DO NOTHING`,
  ).bind(keyId, appId, UPDATE_ATTESTATION_ALGORITHM, encoded, label.slice(0, 200), now).run();
  const key = await c.env.DB.prepare(
    `SELECT key_id, app_id, algorithm, status, label, created_at, retired_at, revoked_at
     FROM update_attestation_keys WHERE key_id = ?1 AND app_id = ?2`,
  ).bind(keyId, appId).first();
  if (!key) return c.json({ error: "key identity already belongs to another app" }, 409);
  return c.json({ key }, 201);
}

export async function handlePrepareUpdateAttestation(c: AdminContext) {
  const appId = c.req.param("appId") ?? "";
  const releaseId = c.req.param("releaseId") ?? "";
  const body = await c.req.json().catch(() => ({})) as { artifact_id?: unknown; artifact_kind?: unknown; key_id?: unknown };
  const kind = body.artifact_kind;
  if (kind !== "build_asset" && kind !== "external_build_target") return c.json({ error: "artifact_kind unsupported" }, 400);
  const artifactId = typeof body.artifact_id === "string" ? body.artifact_id : "";
  const keyId = typeof body.key_id === "string" ? body.key_id : "";
  const key = await c.env.DB.prepare(
    `SELECT key_id FROM update_attestation_keys
     WHERE app_id = ?1 AND key_id = ?2 AND status = 'active'`,
  ).bind(appId, keyId).first();
  if (!artifactId || !key) return c.json({ error: "active app-scoped key and artifact_id required" }, 400);
  const now = Date.now();
  const existing = await c.env.DB.prepare(
    `SELECT id, payload_b64url, payload_sha256, issued_at, expires_at
     FROM release_artifact_attestation_requests
     WHERE release_id = ?1 AND artifact_kind = ?2 AND artifact_id = ?3 AND key_id = ?4
       AND consumed_at IS NULL AND expires_at > ?5`,
  ).bind(releaseId, kind, artifactId, keyId, now).first<{
    id: string; payload_b64url: string; payload_sha256: string; issued_at: number; expires_at: number;
  }>();
  if (existing) return c.json({ request: existing });
  const payload = await loadPayloadIdentity(c.env.DB, appId, releaseId, kind, artifactId, keyId, now);
  if (!payload) return c.json({ error: "draft release or artifact not found" }, 404);
  const payloadBytes = new TextEncoder().encode(canonicalizeUpdateAttestationPayload(payload));
  const payloadEncoded = encodeBase64Url(payloadBytes);
  const payloadSha256 = await sha256Hex(payloadBytes);
  const requestId = crypto.randomUUID();
  const expiresAt = now + REQUEST_TTL_MS;
  await c.env.DB.prepare(
    `INSERT INTO release_artifact_attestation_requests
     (id, app_id, release_id, build_id, artifact_kind, artifact_id, key_id,
      payload_b64url, payload_sha256, issued_at, expires_at, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
     ON CONFLICT(release_id, artifact_kind, artifact_id, key_id) DO UPDATE SET
       id = excluded.id, payload_b64url = excluded.payload_b64url,
       payload_sha256 = excluded.payload_sha256, issued_at = excluded.issued_at,
       expires_at = excluded.expires_at, consumed_at = NULL, created_at = excluded.created_at`,
  ).bind(requestId, appId, releaseId, payload.buildId, kind, artifactId, keyId,
    payloadEncoded, payloadSha256, now, expiresAt, now).run();
  return c.json({ request: { id: requestId, payload_b64url: payloadEncoded, payload_sha256: payloadSha256, issued_at: now, expires_at: expiresAt } }, 201);
}

export async function handleSubmitUpdateAttestation(c: AdminContext) {
  const appId = c.req.param("appId") ?? "";
  const releaseId = c.req.param("releaseId") ?? "";
  const body = await c.req.json().catch(() => ({})) as { request_id?: unknown; signature?: unknown };
  const requestId = typeof body.request_id === "string" ? body.request_id : "";
  const signature = typeof body.signature === "string" ? body.signature : "";
  const now = Date.now();
  const request = await c.env.DB.prepare(
    `SELECT q.*, k.public_key_spki_b64url
     FROM release_artifact_attestation_requests q
     JOIN update_attestation_keys k ON k.key_id = q.key_id AND k.app_id = q.app_id
     WHERE q.id = ?1 AND q.app_id = ?2 AND q.release_id = ?3
       AND q.consumed_at IS NULL AND q.expires_at > ?4 AND k.status = 'active'`,
  ).bind(requestId, appId, releaseId, now).first<{
    app_id: string; artifact_id: string; artifact_kind: UpdateArtifactKind; build_id: string;
    expires_at: number; issued_at: number; key_id: string; payload_b64url: string;
    payload_sha256: string; public_key_spki_b64url: string;
  }>();
  if (!request || !signature) return c.json({ error: "active attestation request not found" }, 404);
  const expected = await loadPayloadIdentity(c.env.DB, appId, releaseId, request.artifact_kind, request.artifact_id, request.key_id, request.issued_at);
  if (!expected || encodeBase64Url(new TextEncoder().encode(canonicalizeUpdateAttestationPayload(expected))) !== request.payload_b64url) {
    return c.json({ error: "attestation identity drift", code: "UPDATE_IDENTITY_DRIFT" }, 409);
  }
  try {
    await verifyUpdateArtifactAttestation({ algorithm: UPDATE_ATTESTATION_ALGORITHM, keyId: request.key_id, payload: request.payload_b64url, schemaVersion: UPDATE_ATTESTATION_SCHEMA_VERSION, signature }, { [request.key_id]: request.public_key_spki_b64url });
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "signature invalid", code: "UPDATE_SIGNATURE_INVALID" }, 400);
  }
  const id = crypto.randomUUID();
  try {
    await c.env.DB.batch([
      c.env.DB.prepare(
        `UPDATE release_artifact_attestation_requests SET consumed_at = ?1
         WHERE id = ?2 AND consumed_at IS NULL AND expires_at > ?3`,
      ).bind(now, requestId, now),
      c.env.DB.prepare(
        `INSERT INTO release_artifact_attestations
         (id, app_id, release_id, build_id, artifact_kind, artifact_id,
          schema_version, algorithm, key_id, payload_b64url, payload_sha256,
          signature_b64url, issued_at, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)`,
      ).bind(id, appId, releaseId, request.build_id, request.artifact_kind,
        request.artifact_id, UPDATE_ATTESTATION_SCHEMA_VERSION,
        UPDATE_ATTESTATION_ALGORITHM, request.key_id, request.payload_b64url,
        request.payload_sha256, signature, request.issued_at, now),
    ]);
  } catch {
    return c.json({ error: "attestation already submitted or identity conflict" }, 409);
  }
  return c.json({ attestation: { id, release_id: releaseId, artifact_kind: request.artifact_kind, artifact_id: request.artifact_id, key_id: request.key_id, payload_sha256: request.payload_sha256 } }, 201);
}

/** Closed publish precondition shared by every attestation-required app. */
export async function validateReleaseArtifactsAttested(
  db: D1Database,
  appId: string,
  releaseId: string,
  buildId: string,
  productType: string,
): Promise<{ ok: true } | { ok: false; code: string; error: string }> {
  let app: { update_attestation_required: number } | null = null;
  try {
    app = await db.prepare("SELECT update_attestation_required FROM apps WHERE id = ?1").bind(appId).first<{ update_attestation_required: number }>();
  } catch {
    // Legacy unit schemas predate migration 0069 and therefore represent an
    // app that has not opted into enforcement yet.
  }
  const required = Boolean(app?.update_attestation_required);
  if (!required) return { ok: true };
  const build = await db.prepare("SELECT status FROM builds WHERE id = ?1 AND app_id = ?2").bind(buildId, appId).first<{ status: string }>();
  if (!build || build.status !== "succeeded") return { ok: false, code: "UPDATE_RELEASE_NOT_READY", error: "build must be succeeded before attested publish" };
  const assets = await db.prepare(
    "SELECT id, file_hash, size_bytes FROM build_assets WHERE build_id = ?1 AND artifact_kind = 'installable'",
  ).bind(buildId).all<{ id: string; file_hash: string | null; size_bytes: number | null }>();
  const targets = await db.prepare(
    "SELECT id, raw_sha256 AS file_hash, raw_size_bytes AS size_bytes FROM external_build_targets WHERE build_id = ?1",
  ).bind(buildId).all<{ id: string; file_hash: string | null; size_bytes: number | null }>();
  const artifacts = [
    ...assets.results.map((row) => ({ kind: "build_asset" as const, ...row })),
    ...targets.results.map((row) => ({ kind: "external_build_target" as const, ...row })),
  ];
  if (artifacts.length === 0) return { ok: false, code: "UPDATE_ARTIFACT_MISSING", error: "release has no downloadable artifact" };
  for (const artifact of artifacts) {
    const sizeBytes = artifact.size_bytes;
    if (!artifact.file_hash || !/^[a-f0-9]{64}$/iu.test(artifact.file_hash) || !Number.isSafeInteger(sizeBytes) || sizeBytes === null || sizeBytes <= 0) {
      return { ok: false, code: "UPDATE_ARTIFACT_IDENTITY_MISSING", error: `artifact ${artifact.id} must declare size and SHA-256` };
    }
    const attestation = await db.prepare(
      `SELECT a.id FROM release_artifact_attestations a
       JOIN update_attestation_keys k ON k.key_id = a.key_id AND k.app_id = a.app_id
       WHERE a.app_id = ?1 AND a.release_id = ?2 AND a.build_id = ?3
         AND a.artifact_kind = ?4 AND a.artifact_id = ?5
         AND a.schema_version = 1 AND a.algorithm = 'Ed25519'
         AND k.status IN ('active', 'retired')`,
    ).bind(appId, releaseId, buildId, artifact.kind, artifact.id).first();
    if (!attestation) return { ok: false, code: "UPDATE_SIGNATURE_MISSING", error: `artifact ${artifact.id} has no valid attestation` };
  }
  return { ok: true };
}
