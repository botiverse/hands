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
  // Default release channel (P2.5.9 / migration 0018). pre-fills the
  // NewReleaseDialog channel dropdown so onboarding is one fewer click.
  default_channel_id?: string | null;
  default_channel_slug?: string | null;
  default_channel_name?: string | null;
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
  status: string;            // 'draft' | 'active' | 'superseded' | 'cancelled'
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
  app_slug?: string;
  app_name?: string;
  action: string;
  actor: string;
  actor_id?: string | null;
  actor_type?: "human" | "agent" | "system" | null;
  actor_display_name?: string | null;
  actor_username?: string | null;
  actor_avatar_url?: string | null;
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

export interface Org {
  id: string;
  slug: string;
  name: string;
  external_provider: string;
  external_id: string;
  created_at: number;
  archived: number;
  org_role?: "owner" | "admin" | "member" | "viewer";
}

export interface OrgMember {
  id: string;
  org_id: string;
  account_id: string;
  org_role: "owner" | "admin" | "member" | "viewer";
  invited_by: string | null;
  joined_at: number;
  provider: "raft";
  provider_subject: string;
  server_id: string;
  server_slug: string | null;
  principal_type: "human" | "agent";
  server_role: string | null;
  username: string | null;
  display_name: string;
  avatar_url: string | null;
  last_login_at: number;
}

export interface AppMember {
  id: string;
  app_id: string;
  account_id: string;
  app_role: "admin" | "publisher" | "viewer";
  invited_by: string | null;
  joined_at: number;
  provider: "raft";
  provider_subject: string;
  server_id: string;
  server_slug: string | null;
  principal_type: "human" | "agent";
  server_role: string | null;
  username: string | null;
  display_name: string;
  avatar_url: string | null;
  last_login_at: number;
}

export interface Invite {
  id: string;
  org_id: string;
  app_id: string | null;
  email: string;
  role: string;
  status: "pending" | "accepted" | "revoked" | "expired";
  message: string | null;
  created_at: number;
  expires_at: number;
  accepted_at?: number | null;
  accepted_by?: string | null;
  revoked_at?: number | null;
  revoked_by?: string | null;
  invited_by?: string | null;
  invited_by_display_name?: string | null;
  org_name?: string;
  app_name?: string | null;
  app_slug?: string | null;
  invite_url?: string;
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

export const updateApp = (
  appId: string,
  input: {
    name?: string;
    description?: string | null;
    default_channel_id?: string | null;
  },
) =>
  request<{ ok: true }>(`/api/apps/${appId}`, {
    method: "PATCH",
    admin: true,
    body: JSON.stringify(input),
  });

export const listOrgs = () =>
  request<{ orgs: Org[] }>(`/api/orgs`, { admin: true });

export const listOrgMembers = (orgId: string) =>
  request<{ members: OrgMember[] }>(`/api/orgs/${orgId}/members`, { admin: true });

export const updateOrgMember = (
  orgId: string,
  accountId: string,
  orgRole: OrgMember["org_role"],
) =>
  request<{ ok: boolean }>(`/api/orgs/${orgId}/members/${accountId}`, {
    method: "PATCH",
    admin: true,
    body: JSON.stringify({ org_role: orgRole }),
  });

export const removeOrgMember = (orgId: string, accountId: string) =>
  request<{ ok: boolean }>(`/api/orgs/${orgId}/members/${accountId}`, {
    method: "DELETE",
    admin: true,
  });

export const listOrgInvites = (orgId: string, status?: string) =>
  request<{ invites: Invite[] }>(
    `/api/orgs/${orgId}/invites${status ? `?status=${encodeURIComponent(status)}` : ""}`,
    { admin: true },
  );

export const createOrgInvite = (
  orgId: string,
  input: {
    email: string;
    role: string;
    app_id?: string | null;
    message?: string | null;
  },
) =>
  request<Invite & { invite_url: string }>(`/api/orgs/${orgId}/invites`, {
    method: "POST",
    admin: true,
    body: JSON.stringify(input),
  });

export const resendOrgInvite = (orgId: string, inviteId: string) =>
  request<{ ok: boolean; invite_url: string; expires_at: number }>(
    `/api/orgs/${orgId}/invites/${inviteId}/resend`,
    { method: "POST", admin: true },
  );

export const revokeOrgInvite = (orgId: string, inviteId: string) =>
  request<{ ok: boolean }>(`/api/orgs/${orgId}/invites/${inviteId}`, {
    method: "DELETE",
    admin: true,
  });

export const listOrgAuditLogs = (orgId: string, limit = 100) =>
  request<{ logs: AuditLogEntry[] }>(
    `/api/orgs/${orgId}/audit-logs?limit=${limit}`,
    { admin: true },
  );

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

export const archiveApp = (appId: string, patch: { archived: boolean }) =>
  request<{ ok: boolean; archived: boolean }>(
    `/api/apps/${appId}/archive`,
    { method: "POST", admin: true, body: JSON.stringify(patch) },
  );

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

export const listAuditLogs = (appId: string, filters?: { actorId?: string; actionPrefix?: string; since?: number }) => {
  const q = new URLSearchParams();
  if (filters?.actorId) q.set("actor_id", filters.actorId);
  if (filters?.actionPrefix) q.set("action_prefix", filters.actionPrefix);
  if (filters?.since != null) q.set("since", String(filters.since));
  const qs = q.toString();
  return request<{ logs: AuditLogEntry[] }>(
    `/api/apps/${appId}/audit-logs${qs ? `?${qs}` : ""}`,
    { admin: true },
  );
};

export const listUserAudit = (accountId: string, limit = 100) =>
  request<{ logs: AuditLogEntry[]; total: number }>(
    `/api/users/${accountId}/audit?limit=${limit}`,
    { admin: true },
  );

export const listAppMembers = (appId: string) =>
  request<{ members: AppMember[] }>(`/api/apps/${appId}/members`, { admin: true });

export const addAppMember = (
  appId: string,
  input: { account_id: string; app_role: AppMember["app_role"] },
) =>
  request<{ ok: boolean }>(`/api/apps/${appId}/members`, {
    method: "POST",
    admin: true,
    body: JSON.stringify(input),
  });

export const updateAppMember = (
  appId: string,
  accountId: string,
  appRole: AppMember["app_role"],
) =>
  request<{ ok: boolean }>(`/api/apps/${appId}/members/${accountId}`, {
    method: "PATCH",
    admin: true,
    body: JSON.stringify({ app_role: appRole }),
  });

export const removeAppMember = (appId: string, accountId: string) =>
  request<{ ok: boolean }>(`/api/apps/${appId}/members/${accountId}`, {
    method: "DELETE",
    admin: true,
  });

export const getInvite = (token: string) =>
  request<Invite>(`/api/invites/${token}`);

export const acceptInvite = (token: string) =>
  request<{ ok: boolean; org_id: string; app_id: string | null }>(
    `/api/invites/${token}/accept`,
    { method: "POST", admin: true },
  );

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
    release_type?: string | undefined;
    version_name: string;
    version_code: number;
    changelog?: string | undefined;
    source?: string | undefined;
    status?: string | undefined;
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
    status?: "draft" | "active" | undefined;
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

export const updateRelease = (
  appId: string,
  releaseId: string,
  input: {
    changelog?: string | null | undefined;
    should_force_update?: boolean | undefined;
    rollout_cohort_count?: number | null | undefined;
    rollout_target_cohorts_json?: unknown;
    availability_at?: number | null | undefined;
    provenance_json?: unknown;
    scopes?: { scope_type: string; scope_value: string }[];
  },
) =>
  request<Release>(`/api/apps/${appId}/releases/${releaseId}`, {
    method: "PATCH",
    admin: true,
    body: JSON.stringify(input),
  });

export const publishRelease = (appId: string, releaseId: string) =>
  request<Release>(`/api/apps/${appId}/releases/${releaseId}/publish`, {
    method: "POST",
    admin: true,
  });

export const deleteRelease = (appId: string, releaseId: string) =>
  request<{ ok: boolean; id: string; status: "cancelled" }>(
    `/api/apps/${appId}/releases/${releaseId}`,
    { method: "DELETE", admin: true },
  );

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

// =============================================================================
// Webhooks (P2.5.8)
// =============================================================================

export type WebhookEventType =
  | "release:new"
  | "release:superseded"
  | "release:rolled_back"
  | "release:cancelled"
  | "build:succeeded"
  | "build:failed";

export const WEBHOOK_EVENT_TYPES: WebhookEventType[] = [
  "release:new",
  "release:superseded",
  "release:rolled_back",
  "release:cancelled",
  "build:succeeded",
  "build:failed",
];

export interface Webhook {
  id: string;
  org_id: string;
  app_id: string | null;
  url: string;
  secret_set: boolean;
  events_json: string;
  enabled: number;
  created_at: number;
  updated_at: number;
  archived_at: number | null;
}

export interface WebhookDelivery {
  id: string;
  webhook_id: string;
  event_type: string;
  status: "pending" | "succeeded" | "failed";
  attempts: number;
  max_attempts: number;
  last_attempt_at: number | null;
  next_attempt_at: number | null;
  last_response_status: number | null;
  last_response_body: string | null;
  last_error: string | null;
  created_at: number;
  completed_at: number | null;
}

export const listOrgWebhooks = (orgId: string) =>
  request<{ webhooks: Webhook[] }>(`/api/orgs/${orgId}/webhooks`, { admin: true });

export const createOrgWebhook = (
  orgId: string,
  input: { url: string; secret: string; events: WebhookEventType[]; app_id?: string | null },
) =>
  request<Webhook>(`/api/orgs/${orgId}/webhooks`, {
    method: "POST",
    admin: true,
    body: JSON.stringify(input),
  });

export const updateOrgWebhook = (
  orgId: string,
  webhookId: string,
  input: { url?: string; events?: WebhookEventType[]; enabled?: boolean },
) =>
  request<{ ok: true }>(`/api/orgs/${orgId}/webhooks/${webhookId}`, {
    method: "PATCH",
    admin: true,
    body: JSON.stringify(input),
  });

export const deleteOrgWebhook = (orgId: string, webhookId: string) =>
  request<{ ok: true }>(`/api/orgs/${orgId}/webhooks/${webhookId}`, {
    method: "DELETE",
    admin: true,
  });

export const listWebhookDeliveries = (orgId: string, webhookId: string) =>
  request<{ deliveries: WebhookDelivery[] }>(
    `/api/orgs/${orgId}/webhooks/${webhookId}/deliveries`,
    { admin: true },
  );
