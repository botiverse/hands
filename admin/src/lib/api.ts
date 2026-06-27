/**
 * Minimal fetch client for the quiver Worker API.
 *
 * In dev: Vite proxies /api → http://127.0.0.1:8787 (wrangler dev).
 * In prod: Vite-built static assets are served by the Worker; /api calls are
 * same-origin.
 *
 * Admin auth is Login with Raft. The Worker sets an HttpOnly same-origin
 * session cookie after /login/raft/callback; browser code never sees Raft
 * codes, access tokens, or client secrets.
 */

// API base URL: in production, the Worker serves both admin UI + API under
// the same origin (via wrangler [assets] binding), so API_BASE is empty
// and requests go to the same host. In dev, Vite proxies /api → wrangler dev.
const API_BASE = (import.meta as any).env?.VITE_API_BASE_URL ?? "";

export class ApiError extends Error {
  constructor(public status: number, public body: unknown, message: string) {
    super(message);
    this.name = "ApiError";
  }
}

export interface App {
  id: string;
  org_id: string | null;
  slug: string;
  name: string;
  platform: string;
  description: string | null;
  archived: number;       // 0 = active, 1 = archived (soft-delete)
  archived_at: number | null;
  created_at: number;
}

export interface ProductType {
  id: string;
  app_id: string;
  name: string;
  display_name: string;
  description: string | null;
  icon: string | null;
  supported_platforms_json: string;  // '[]' or '["darwin-arm64", ...]'
  default_assets_json: string;
  parser_kind: string;
  schema_json: string;
  parent_product_type_id: string | null;
  created_at: number;
  updated_at: number;
}

export interface ReleaseType {
  id: string;
  app_id: string;
  name: string;
  display_name: string;
  color: string | null;
  description: string | null;
  created_at: number;
  updated_at: number;
}

export interface Version {
  id: string;
  app_id: string;
  channel: string;
  version_name: string;
  version_code: number;
  package_name: string;
  signature_sha256: string;
  min_sdk: number | null;
  target_sdk: number | null;
  size_bytes: number;
  file_hash: string;
  enabled: number;
  changelog: string | null;
  should_force_update: number;
  availability_at: number | null;
  provenance_json: string;
  created_at: number;
  download_url?: string;
  // Phase 2 compat: legacy /versions response shape from
  // worker/src/routes/builds.ts handleListVersionsCompat may also
  // include build_id / release_id / release_status.
  build_id?: string;
  release_id?: string;
  release_status?: string;
}

export interface Build {
  id: string;
  app_id: string;
  channel_id: string | null;
  product_type: string;
  release_type: string;
  version_name: string;
  version_code: number;
  changelog: string | null;
  source: string;
  status: string;            // 'pending' | 'building' | 'succeeded' | 'failed' | ...
  build_metadata_json: string;
  parsed_metadata_json: string;
  should_force_update: number;
  availability_at: number | null;
  provenance_json: string;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
}

export interface BuildAsset {
  id: string;
  build_id: string;
  platform: string;
  arch: string | null;
  variant: string | null;
  filetype: string;            // 'apk' | 'dmg' | 'exe' | 'deb' | 'bundle' | ...
  r2_key: string;
  file_hash: string;
  size_bytes: number;
  signature: string | null;
  signing_credential_id: string | null;
  metadata_json: string;
  download_count: number;
  created_at: number;
}

export interface Release {
  id: string;
  app_id: string;
  build_id: string;
  channel_id: string;
  product_type: string;
  release_type: string;
  status: string;            // 'active' | 'superseded' | 'rolled_back' | 'cancelled'
  is_full: number;
  superseded_by_release_id: string | null;
  rollout_cohort_count: number | null;
  rollout_target_cohorts_json: string;
  availability_at: number | null;
  should_force_update: number;
  changelog: string | null;
  provenance_json: string;
  created_by: string;
  created_at: number;
  updated_at: number;
}

export interface ReleaseScope {
  id: string;
  release_id: string;
  scope_type: string;         // 'full' | 'platform' | 'ip_range' | 'user_cohort'
  scope_value: string;
  created_at: number;
}

export interface Channel {
  id: string;
  app_id: string;
  slug: string;
  name: string;
  bundle_id: string | null;
  password: string | null;
  git_url: string | null;
  enabled_product_types_json: string;
  metadata_json: string;
  created_at: number;
}

export interface AuditLogEntry {
  id: string;
  app_id: string;
  action: string;
  actor: string;
  payload: string;
  created_at: number;
}

export interface Operation {
  id: string;
  app_id: string;
  kind: "parse" | "upload" | "publish" | "signed_url";
  status: "pending" | "in_progress" | "success" | "failed" | "cancelled";
  parent_op_id: string | null;
  step_number: number | null;
  actor: string;
  input: string;
  output: string;
  error: string | null;
  progress: number;
  retry_count: number;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
}

export interface AuthAccount {
  id: string;
  provider: "raft";
  server_id: string;
  server_slug: string | null;
  principal_type: "human" | "agent";
  server_role: string | null;
  org_id: string | null;
  org_role: "owner" | "admin" | "member" | "viewer" | null;
  username: string | null;
  display_name: string;
  avatar_url: string | null;
  actor: string;
}

async function request<T>(
  path: string,
  init: RequestInit & { admin?: boolean } = {},
): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json");
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers,
    credentials: "include",
  });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    // non-JSON body; leave as text
  }
  if (!res.ok) {
    const msg =
      typeof body === "object" && body && "error" in body
        ? String((body as any).error)
        : `${res.status} ${res.statusText}`;
    throw new ApiError(res.status, body, msg);
  }
  return body as T;
}

// ---------- Auth ----------

export const getAuthMe = () =>
  request<{ authenticated: true; account: AuthAccount }>(`/api/auth/me`);

export const logout = () =>
  request<{ ok: boolean }>(`/api/auth/logout`, {
    method: "POST",
  });

export const normalizeLoginReturnPath = (returnTo = window.location.pathname) => {
  if (!returnTo.startsWith("/") || returnTo.startsWith("//")) return "/";
  if (returnTo.startsWith("/api/") || returnTo.startsWith("/login/")) return "/";
  return returnTo;
};

export const loginUrl = (returnTo = window.location.pathname) =>
  `${API_BASE}/api/auth/login?return=${encodeURIComponent(normalizeLoginReturnPath(returnTo))}`;

// ---------- Public API (no auth) ----------

export const listPublicVersions = (appId: string) =>
  request<{ versions: Version[] }>(`/api/apps/${appId}/versions`);

export const getPublicVersion = (appId: string, versionId: string) =>
  request<Version & { download_url: string }>(
    `/api/apps/${appId}/versions/${versionId}`,
  );

// ---------- Admin API (requires Login with Raft session cookie in prod) ----------

export const listApps = () =>
  request<{ apps: App[] }>(`/api/apps`, { admin: true });

export const createApp = (input: {
  slug: string;
  name: string;
  platform: string;
  description?: string | undefined;
}) =>
  request<App>(`/api/apps`, {
    method: "POST",
    admin: true,
    body: JSON.stringify(input),
  });

export const createChannel = (
  appId: string,
  input: {
    slug: string;
    name: string;
    bundle_id?: string | undefined;
    password?: string | undefined;
    git_url?: string | undefined;
    enabled_product_types?: string[] | undefined;
  },
) =>
  request<Channel>(`/api/apps/${appId}/channels`, {
    method: "POST",
    admin: true,
    body: JSON.stringify(input),
  });

export const listProductTypes = (appId: string) =>
  request<{ product_types: ProductType[] }>(
    `/api/apps/${appId}/product-types`,
    { admin: true },
  );

export const listReleaseTypes = (appId: string) =>
  request<{ release_types: ReleaseType[] }>(
    `/api/apps/${appId}/release-types`,
    { admin: true },
  );

export const updateChannel = (
  appId: string,
  channelId: string,
  patch: {
    name?: string;
    bundle_id?: string | null;
    password?: string | null;
    git_url?: string | null;
    enabled_product_types?: string[];
  },
) =>
  request<{ ok: boolean }>(`/api/apps/${appId}/channels/${channelId}`, {
    method: "PATCH",
    admin: true,
    body: JSON.stringify(patch),
  });

export const deleteChannel = (appId: string, channelId: string) =>
  request<{ ok: boolean }>(`/api/apps/${appId}/channels/${channelId}`, {
    method: "DELETE",
    admin: true,
  });

export const listChannels = (appId: string) =>
  request<{ channels: Channel[] }>(`/api/apps/${appId}/channels`, { admin: true });

export const updateVersion = (
  appId: string,
  versionId: string,
  patch: { enabled?: boolean; channel?: string; should_force_update?: boolean },
) =>
  request<{ ok: boolean }>(`/api/apps/${appId}/versions/${versionId}`, {
    method: "PATCH",
    admin: true,
    body: JSON.stringify(patch),
  });

export const createVersion = (
  appId: string,
  input: any,
) =>
  request<Version>(`/api/apps/${appId}/versions`, {
    method: "POST",
    admin: true,
    body: JSON.stringify(input),
  });

export const listAuditLogs = (appId: string) =>
  request<{ logs: AuditLogEntry[] }>(`/api/apps/${appId}/audit-logs`, { admin: true });

// ---------- Operations (SSE + log) ----------

export const listOperations = (appId: string, limit = 50) =>
  request<{ operations: Operation[] }>(
    `/api/apps/${appId}/operations?limit=${limit}`,
    { admin: true },
  );

export const retryOperation = (appId: string, opId: string) =>
  request<Operation>(`/api/apps/${appId}/operations/${opId}/retry`, {
    method: "POST",
    admin: true,
  });

export const deleteOperation = (appId: string, opId: string) =>
  request<{ ok: boolean; id: string }>(
    `/api/apps/${appId}/operations/${opId}`,
    {
      method: "DELETE",
      admin: true,
    },
  );

/**
 * Open an EventSource (SSE) subscription for operation updates.
 * Returns the EventSource instance; caller is responsible for calling .close().
 */
export function streamOperations(
  appId: string,
  onOp: (op: Operation) => void,
  onError?: (e: unknown) => void,
): EventSource {
  const url = `${API_BASE}/api/apps/${appId}/operations/stream`;
  const es = new EventSource(url, {
    withCredentials: true,
  });
  es.addEventListener("op", (ev) => {
    try {
      onOp(JSON.parse((ev as MessageEvent).data) as Operation);
    } catch (e) {
      onError?.(e);
    }
  });
  es.addEventListener("error", (ev) => onError?.(ev));
  return es;
}

// Parse APK via Container (admin route)
export const parseApk = async (file: File): Promise<any> => {
  const res = await fetch(`${API_BASE}/api/parse-apk`, {
    method: "POST",
    headers: { "content-type": "application/octet-stream" },
    body: file,
    credentials: "include",
  });
  if (!res.ok) {
    throw new ApiError(res.status, await readErrorBody(res), `parse failed ${res.status}`);
  }
  return res.json();
};

// Multipart upload to the Worker, which stores in R2 and returns file_hash + r2_key.
export const uploadApk = async (
  appId: string,
  file: File,
): Promise<{ file_hash: string; r2_key: string; size_bytes: number; original_filename: string }> => {
  const fd = new FormData();
  fd.append("apk", file);
  const res = await fetch(`${API_BASE}/api/apps/${appId}/upload`, {
    method: "POST",
    body: fd,
    credentials: "include",
  });
  if (!res.ok) {
    throw new ApiError(res.status, await readErrorBody(res), `upload failed ${res.status}`);
  }
  return res.json();
};

async function readErrorBody(res: Response): Promise<unknown> {
  const text = await res.text();
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return text;
  }
}

// ---------- Phase 2: builds + releases + build_assets ----------

export const listBuilds = (appId: string) =>
  request<{ builds: Build[] }>(`/api/apps/${appId}/builds`, { admin: true });

export const getBuild = (appId: string, buildId: string) =>
  request<{ build: Build }>(`/api/apps/${appId}/builds/${buildId}`, { admin: true });

export const createBuild = (
  appId: string,
  input: {
    channel_id?: string | undefined;
    channel_slug?: string | undefined;
    product_type: string;
    release_type: string;
    version_name: string;
    version_code: number;
    changelog?: string | undefined;
    source?: string | undefined;
    build_metadata_json?: unknown;
    parsed_metadata_json?: unknown;
    provenance_json?: unknown;
    should_force_update?: boolean | undefined;
    availability_at?: number | undefined;
  },
) =>
  request<Build>(`/api/apps/${appId}/builds`, {
    method: "POST",
    admin: true,
    body: JSON.stringify(input),
  });

export const updateBuild = (
  appId: string,
  buildId: string,
  patch: {
    changelog?: string | undefined;
    should_force_update?: boolean | undefined;
    availability_at?: number | undefined;
    provenance_json?: unknown;
    status?: string | undefined;
  },
) =>
  request<{ ok: boolean }>(`/api/apps/${appId}/builds/${buildId}`, {
    method: "PATCH",
    admin: true,
    body: JSON.stringify(patch),
  });

export const deleteBuild = (appId: string, buildId: string) =>
  request<{ ok: boolean }>(`/api/apps/${appId}/builds/${buildId}`, {
    method: "DELETE",
    admin: true,
  });

export const listBuildAssets = (appId: string, buildId: string) =>
  request<{ assets: BuildAsset[] }>(
    `/api/apps/${appId}/builds/${buildId}/assets`,
    { admin: true },
  );

export const createBuildAsset = (
  appId: string,
  buildId: string,
  input: {
    platform: string;
    arch?: string | null | undefined;
    variant?: string | null | undefined;
    filetype: string;
    r2_key: string;
    file_hash: string;
    size_bytes: number;
    signature?: string | null | undefined;
    metadata_json?: unknown;
  },
) =>
  request<BuildAsset>(`/api/apps/${appId}/builds/${buildId}/assets`, {
    method: "POST",
    admin: true,
    body: JSON.stringify(input),
  });

export const deleteBuildAsset = (
  appId: string,
  buildId: string,
  assetId: string,
) =>
  request<{ ok: boolean }>(
    `/api/apps/${appId}/builds/${buildId}/assets/${assetId}`,
    { method: "DELETE", admin: true },
  );

export const listReleases = (appId: string) =>
  request<{ releases: Release[] }>(`/api/apps/${appId}/releases`, { admin: true });

export const getRelease = (appId: string, releaseId: string) =>
  request<{ release: Release; build: Build; assets: BuildAsset[]; scopes: ReleaseScope[] }>(
    `/api/apps/${appId}/releases/${releaseId}`,
    { admin: true },
  );

export const createRelease = (
  appId: string,
  input: {
    build_id: string;
    channel_id?: string | undefined;
    channel_slug?: string | undefined;
    product_type?: string | undefined;
    release_type?: string | undefined;
    changelog?: string | undefined;
    should_force_update?: boolean | undefined;
    rollout_cohort_count?: number | undefined;
    rollout_target_cohorts_json?: unknown;
    availability_at?: number | undefined;
    provenance_json?: unknown;
    scopes?: { scope_type: string; scope_value: string }[];
  },
) =>
  request<Release>(`/api/apps/${appId}/releases`, {
    method: "POST",
    admin: true,
    body: JSON.stringify(input),
  });

export const rollbackRelease = (
  appId: string,
  releaseId: string,
  input?: {
    build_id?: string | undefined;
    scopes?: { scope_type: string; scope_value: string }[];
  },
) =>
  request<Release>(`/api/apps/${appId}/releases/${releaseId}/rollback`, {
    method: "POST",
    admin: true,
    body: JSON.stringify(input ?? {}),
  });

export const bumpRollout = (
  appId: string,
  releaseId: string,
  input: { to?: number; by?: number },
) =>
  request<{ ok: boolean; rollout_cohort_count: number | null }>(
    `/api/apps/${appId}/releases/${releaseId}/bump-rollout`,
    { method: "POST", admin: true, body: JSON.stringify(input) },
  );

export const forceUpdate = (
  appId: string,
  releaseId: string,
  input?: { enabled?: boolean },
) =>
  request<{ ok: boolean; should_force_update: number }>(
    `/api/apps/${appId}/releases/${releaseId}/force-update`,
    { method: "POST", admin: true, body: JSON.stringify(input ?? {}) },
  );
