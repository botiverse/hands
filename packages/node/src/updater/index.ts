import { createHash } from "node:crypto";
import { chmod, mkdir, open, rename, rm } from "node:fs/promises";
import { basename, resolve } from "node:path";

export type UpdateChannel = "main" | "alpha" | `pinned:${string}`;
export interface RuntimeTarget { platform: NodeJS.Platform; arch: string }
export interface UpdateCheckInput { currentVersion: string; channel: UpdateChannel; target: RuntimeTarget; deviceId?: string; signal?: AbortSignal }

export interface UpdateCandidate {
  appId: string;
  appSlug: string;
  releaseId: string;
  releaseRevision: number;
  channel: UpdateChannel;
  selectedChannel: string;
  channelId: string;
  version: string;
  versionCode: number;
  versionRelation: "upgrade" | "same" | "downgrade";
  publishedAt: number;
  target: RuntimeTarget;
  artifact: {
    artifactId: string;
    url: string;
    size: number;
    sha256: string;
  };
  candidateDigest: string;
}

export type UpdateCheckResult =
  | { kind: "up_to_date"; currentVersion: string; checkedAt: string }
  | { kind: "update"; candidate: UpdateCandidate };

export interface UpdateVerificationReceipt {
  schemaVersion: 1;
  appId: string;
  releaseId: string;
  releaseRevision: number;
  channel: UpdateChannel;
  selectedChannel: string;
  version: string;
  target: RuntimeTarget;
  artifactId: string;
  candidateDigest: string;
  expectedSize: number;
  actualSize: number;
  expectedSha256: string;
  actualSha256: string;
  preparedAt: string;
}

export interface PreparedUpdate { stagedBinaryPath: string; version: string; sha256: string; size: number; receipt: UpdateVerificationReceipt }
export interface PrepareUpdateInput { candidate: UpdateCandidate; stagingDir: string; signal?: AbortSignal; onProgress?: (event: { downloaded: number; total: number }) => void }

export type HandsUpdateErrorCode =
  | "UPDATE_ABORTED" | "UPDATE_NETWORK_FAILED" | "UPDATE_AUTH_FAILED"
  | "UPDATE_APP_NOT_FOUND" | "UPDATE_APP_FORBIDDEN" | "UPDATE_CHANNEL_UNSUPPORTED"
  | "UPDATE_RELEASE_NOT_READY" | "UPDATE_NO_COMPATIBLE_ARTIFACT"
  | "UPDATE_RESPONSE_INVALID" | "UPDATE_IDENTITY_DRIFT" | "UPDATE_IDENTITY_CONFLICT" | "UPDATE_DOWNLOAD_FAILED"
  | "UPDATE_SIZE_MISMATCH" | "UPDATE_SHA256_MISMATCH" | "UPDATE_STAGING_FAILED";

export class HandsUpdateError extends Error {
  constructor(readonly code: HandsUpdateErrorCode, message: string, readonly retryable = false, readonly status?: number) {
    super(message);
    this.name = "HandsUpdateError";
  }
}

export interface HandsUpdaterOptions {
  appSlug: string;
  apiOrigin: string;
  credentialProvider?: () => string | undefined | Promise<string | undefined>;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  sdkVersion?: string;
  now?: () => number;
  allowInsecureHttpForTests?: boolean;
}

export interface HandsUpdater {
  checkUpdate(input: UpdateCheckInput): Promise<UpdateCheckResult>;
  prepareUpdate(input: PrepareUpdateInput): Promise<PreparedUpdate>;
}

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
export const HANDS_NODE_SDK_VERSION = "0.4.0";

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HandsUpdateError("UPDATE_RESPONSE_INVALID", "update response must be an object");
  return value as Record<string, unknown>;
}
function string(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) throw new HandsUpdateError("UPDATE_RESPONSE_INVALID", `${field} missing`);
  return value;
}
function integer(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new HandsUpdateError("UPDATE_RESPONSE_INVALID", `${field} invalid`);
  return value;
}
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const data = value as Record<string, unknown>;
  return `{${Object.keys(data).sort().map((key) => `${JSON.stringify(key)}:${canonical(data[key])}`).join(",")}}`;
}
function digest(value: unknown): string { return `sha256:${createHash("sha256").update(canonical(value)).digest("hex")}`; }

function abortError(error: unknown): HandsUpdateError {
  if (error instanceof HandsUpdateError) return error;
  if (error instanceof DOMException && error.name === "AbortError") return new HandsUpdateError("UPDATE_ABORTED", "update request aborted");
  return new HandsUpdateError("UPDATE_NETWORK_FAILED", "update request failed", true);
}

function candidateIdentity(candidate: Omit<UpdateCandidate, "candidateDigest">) {
  return {
    schemaVersion: 1,
    appId: candidate.appId,
    releaseId: candidate.releaseId,
    releaseRevision: candidate.releaseRevision,
    channel: candidate.channel,
    selectedChannel: candidate.selectedChannel,
    channelId: candidate.channelId,
    version: candidate.version,
    versionCode: candidate.versionCode,
    publishedAt: candidate.publishedAt,
    target: candidate.target,
    artifact: {
      artifactId: candidate.artifact.artifactId,
      size: candidate.artifact.size,
      sha256: candidate.artifact.sha256,
    },
  };
}

export function createHandsUpdater(options: HandsUpdaterOptions): HandsUpdater {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? 15_000;
  const origin = new URL(options.apiOrigin);
  if (origin.protocol !== "https:" && !options.allowInsecureHttpForTests) throw new HandsUpdateError("UPDATE_RESPONSE_INVALID", "Hands API must use HTTPS");

  async function checkUpdate(input: UpdateCheckInput): Promise<UpdateCheckResult> {
    if (!SEMVER.test(input.currentVersion)) throw new HandsUpdateError("UPDATE_RESPONSE_INVALID", "currentVersion must be semver");
    if (input.deviceId !== undefined && !/^[\x21-\x7e]{1,256}$/u.test(input.deviceId)) {
      throw new HandsUpdateError("UPDATE_RESPONSE_INVALID", "deviceId must be 1-256 printable ASCII characters");
    }
    const pinned = input.channel.startsWith("pinned:") ? input.channel.slice(7) : null;
    if (pinned && !SEMVER.test(pinned)) throw new HandsUpdateError("UPDATE_CHANNEL_UNSUPPORTED", "pinned channel requires semver");
    const channel = pinned ? "main" : input.channel;
    const url = new URL(`/public/v2/apps/${encodeURIComponent(options.appSlug)}/updates/check`, origin);
    url.searchParams.set("product_type", "cli-binary");
    url.searchParams.set("current_version", input.currentVersion);
    url.searchParams.set("channel", channel);
    url.searchParams.set("platform", input.target.platform);
    url.searchParams.set("arch", input.target.arch);
    url.searchParams.set("sdk_version", options.sdkVersion ?? HANDS_NODE_SDK_VERSION);
    if (pinned) url.searchParams.set("version", pinned);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const abort = () => controller.abort();
    input.signal?.addEventListener("abort", abort, { once: true });
    try {
      const token = await options.credentialProvider?.();
      const requestInit: RequestInit = { signal: controller.signal };
      requestInit.headers = {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(input.deviceId !== undefined ? { "X-Hands-Device-Id": input.deviceId } : {}),
      };
      const response = await fetchImpl(url, requestInit);
      const body = await response.json().catch(() => null) as unknown;
      if (!response.ok) {
        const serverCode = body && typeof body === "object" && "code" in body ? String((body as { code: unknown }).code) : "";
        const code: HandsUpdateErrorCode = serverCode === "UPDATE_IDENTITY_CONFLICT" || serverCode === "UPDATE_IDENTITY_DRIFT"
          ? serverCode
          : response.status === 401 ? "UPDATE_AUTH_FAILED" : response.status === 403 ? "UPDATE_APP_FORBIDDEN" : response.status === 404 ? "UPDATE_NO_COMPATIBLE_ARTIFACT" : "UPDATE_NETWORK_FAILED";
        throw new HandsUpdateError(code, "Hands did not return an update candidate", response.status >= 500, response.status);
      }
      const root = record(body);
      if (root.update_available === false) return { kind: "up_to_date", currentVersion: input.currentVersion, checkedAt: new Date(now()).toISOString() };
      if (root.update_available !== true) throw new HandsUpdateError("UPDATE_RESPONSE_INVALID", "update_available invalid");
      const app = record(root.app); const release = record(root.release); const artifact = record(root.artifact);
      const sha256 = string(artifact.sha256, "artifact.sha256").toLowerCase();
      if (!SHA256.test(sha256)) throw new HandsUpdateError("UPDATE_RESPONSE_INVALID", "artifact.sha256 invalid");
      const plain: Omit<UpdateCandidate, "candidateDigest"> = {
        appId: string(app.id, "app.id"), appSlug: string(app.slug, "app.slug"),
        releaseId: string(release.id, "release.id"), releaseRevision: integer(release.revision, "release.revision"),
        channel: input.channel, selectedChannel: string(release.channel, "release.channel"), channelId: string(release.channel_id, "release.channel_id"),
        version: string(release.version, "release.version"), versionCode: integer(release.version_code, "release.version_code"),
        versionRelation: string(release.version_relation, "release.version_relation") as UpdateCandidate["versionRelation"],
        publishedAt: integer(release.published_at, "release.published_at"), target: input.target,
        artifact: { artifactId: string(artifact.id, "artifact.id"), url: string(artifact.download_url, "artifact.download_url"), size: integer(artifact.size_bytes, "artifact.size_bytes"), sha256 },
      };
      if (pinned && plain.version !== pinned) throw new HandsUpdateError("UPDATE_IDENTITY_DRIFT", "pinned version was not selected");
      const candidate: UpdateCandidate = { ...plain, candidateDigest: digest(candidateIdentity(plain)) };
      return { kind: "update", candidate };
    } catch (error) { throw abortError(error); }
    finally { clearTimeout(timeout); input.signal?.removeEventListener("abort", abort); }
  }

  async function prepareUpdate(input: PrepareUpdateInput): Promise<PreparedUpdate> {
    const candidate = input.candidate;
    if (digest(candidateIdentity(candidate)) !== candidate.candidateDigest) throw new HandsUpdateError("UPDATE_IDENTITY_DRIFT", "candidate digest changed");
    await mkdir(input.stagingDir, { recursive: true });
    const safeName = `${candidate.version}-${candidate.artifact.sha256}.ready`;
    const finalPath = resolve(input.stagingDir, safeName);
    if (basename(finalPath) !== safeName) throw new HandsUpdateError("UPDATE_STAGING_FAILED", "invalid staging path");
    const partialPath = `${finalPath}.${crypto.randomUUID()}.partial`;
    let handle;
    try {
      handle = await open(partialPath, "wx", 0o700);
      let url = new URL(candidate.artifact.url);
      for (let redirects = 0; ; redirects += 1) {
        if (url.protocol !== "https:" && !options.allowInsecureHttpForTests) throw new HandsUpdateError("UPDATE_DOWNLOAD_FAILED", "artifact URL must use HTTPS");
        const requestInit: RequestInit = { redirect: "manual" };
        if (input.signal) requestInit.signal = input.signal;
        const response = await fetchImpl(url, requestInit);
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          if (redirects >= 5) throw new HandsUpdateError("UPDATE_DOWNLOAD_FAILED", "too many artifact redirects");
          const location = response.headers.get("location");
          if (!location) throw new HandsUpdateError("UPDATE_DOWNLOAD_FAILED", "artifact redirect has no location");
          url = new URL(location, url); continue;
        }
        if (!response.ok || !response.body) throw new HandsUpdateError("UPDATE_DOWNLOAD_FAILED", "artifact download failed", response.status >= 500, response.status);
        const hash = createHash("sha256"); let downloaded = 0;
        const reader = response.body.getReader();
        while (true) {
          const { done, value } = await reader.read(); if (done) break;
          downloaded += value.byteLength;
          if (downloaded > candidate.artifact.size) throw new HandsUpdateError("UPDATE_SIZE_MISMATCH", "artifact exceeds declared size");
          hash.update(value); await handle.write(value); input.onProgress?.({ downloaded, total: candidate.artifact.size });
        }
        if (downloaded !== candidate.artifact.size) throw new HandsUpdateError("UPDATE_SIZE_MISMATCH", "artifact size mismatch");
        const actualSha256 = hash.digest("hex");
        if (actualSha256 !== candidate.artifact.sha256) throw new HandsUpdateError("UPDATE_SHA256_MISMATCH", "artifact SHA-256 mismatch");
        await handle.sync(); await handle.close(); handle = undefined;
        if (process.platform !== "win32") await chmod(partialPath, 0o700);
        await rename(partialPath, finalPath);
        const directory = await open(input.stagingDir, "r"); try { await directory.sync(); } finally { await directory.close(); }
        const receipt: UpdateVerificationReceipt = {
          schemaVersion: 1, appId: candidate.appId, releaseId: candidate.releaseId,
          releaseRevision: candidate.releaseRevision, channel: candidate.channel,
          selectedChannel: candidate.selectedChannel,
          version: candidate.version, target: candidate.target, artifactId: candidate.artifact.artifactId,
          candidateDigest: candidate.candidateDigest, expectedSize: candidate.artifact.size,
          actualSize: downloaded, expectedSha256: candidate.artifact.sha256,
          actualSha256,
          preparedAt: new Date(now()).toISOString(),
        };
        return { stagedBinaryPath: finalPath, version: candidate.version, sha256: actualSha256, size: downloaded, receipt };
      }
    } catch (error) {
      try { await handle?.close(); } catch { /* best effort */ }
      await rm(partialPath, { force: true }).catch(() => undefined);
      if (error instanceof HandsUpdateError) throw error;
      throw abortError(error);
    }
  }
  return { checkUpdate, prepareUpdate };
}
