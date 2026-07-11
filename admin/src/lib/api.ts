/**
 * Minimal fetch client for the quiver Worker API.
 *
 * In dev: Vite proxies /api → http://127.0.0.1:8787 (wrangler dev).
 * In prod: Vite-built static assets are served by the Worker; /api calls are
 * same-origin.
 *
 * Admin auth is Login with Raft. The callback returns a Hands JWT in the URL
 * fragment; the SPA stores it locally and sends it as Authorization: Bearer.
 * Raft codes and client secrets never enter browser storage.
 */

// API base URL: in production, the Worker serves both admin UI + API under
// the same origin (via wrangler [assets] binding), so API_BASE is empty
// and requests go to the same host. In dev, Vite proxies /api → wrangler dev.
const API_BASE = (import.meta as any).env?.VITE_API_BASE_URL ?? "";
export const ACTIVE_ORG_STORAGE_KEY = "hands:active-org-id";
export const AUTH_TOKEN_STORAGE_KEY = "hands:auth-token";

export function getAuthToken(): string | null {
  try {
    return window.localStorage.getItem(AUTH_TOKEN_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function clearAuthToken(): void {
  try {
    window.localStorage.removeItem(AUTH_TOKEN_STORAGE_KEY);
  } catch {
    // Storage can be unavailable in private/restricted browser contexts.
  }
}

export function consumeAuthTokenFromUrl(): string | null {
  if (typeof window === "undefined" || !window.location.hash) return null;
  const params = new URLSearchParams(window.location.hash.slice(1));
  const token = params.get("access_token");
  if (!token) return null;
  try {
    window.localStorage.setItem(AUTH_TOKEN_STORAGE_KEY, token);
  } catch {
    return null;
  }
  params.delete("access_token");
  params.delete("expires_at");
  const remainingHash = params.toString();
  window.history.replaceState(
    null,
    "",
    `${window.location.pathname}${window.location.search}${remainingHash ? `#${remainingHash}` : ""}`,
  );
  return token;
}

function addAuthHeader(headers: Headers): void {
  const token = getAuthToken();
  if (token && !headers.has("authorization")) {
    headers.set("authorization", `Bearer ${token}`);
  }
}

consumeAuthTokenFromUrl();

export function getActiveOrgId(): string | null {
  try {
    return window.localStorage.getItem(ACTIVE_ORG_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function setActiveOrgId(orgId: string): void {
  try {
    window.localStorage.setItem(ACTIVE_ORG_STORAGE_KEY, orgId);
  } catch {
    // Storage can be unavailable in private/restricted browser contexts.
  }
}

export function clearActiveOrgId(): void {
  try {
    window.localStorage.removeItem(ACTIVE_ORG_STORAGE_KEY);
  } catch {
    // Storage can be unavailable in private/restricted browser contexts.
  }
}

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
  public_history?: number; // 1 = public /apps/:slug/history page enabled
  delta_updates_enabled?: number; // 1 = auto-generate Android delta patches on publish
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
  // Kept for historical rows that were backfilled into the release model.
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
  artifact_kind: string;
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
  // release_metrics (nullable when never checked)
  offered_count?: number | null;
  current_count?: number | null;
  last_checked_at?: number | null;
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
  kind: "parse" | "upload" | "publish" | "signed_url" | "testflight-upload";
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

export interface AppServerGrant {
  id: string;
  app_id: string;
  server_id: string | null;
  server_slug: string | null;
  app_role: "admin" | "publisher" | "viewer";
  granted_by: string | null;
  created_at: number;
  updated_at: number;
}

export interface AppDeployToken {
  id: string;
  app_id: string;
  name: string;
  token_prefix: string;
  app_role: "publisher" | "viewer";
  created_by: string | null;
  created_by_actor: string;
  created_at: number;
  expires_at: number | null;
  last_used_at: number | null;
  revoked_at: number | null;
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
  addAuthHeader(headers);
  const activeOrgId = getActiveOrgId();
  if (activeOrgId) headers.set("x-hands-org-id", activeOrgId);
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers,
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

export const logout = async () => {
  try {
    return await request<{ ok: boolean }>(`/api/auth/logout`, {
      method: "POST",
    });
  } finally {
    clearAuthToken();
  }
};

export const normalizeLoginReturnPath = (returnTo = window.location.pathname) => {
  if (!returnTo.startsWith("/") || returnTo.startsWith("//")) return "/";
  if (returnTo.startsWith("/api/") || returnTo.startsWith("/login/")) return "/";
  return returnTo;
};

export const loginUrl = (returnTo = window.location.pathname) =>
  `${API_BASE}/api/auth/login?return=${encodeURIComponent(normalizeLoginReturnPath(returnTo))}`;

// ---------- Admin API (requires Login with Raft bearer JWT in prod) ----------

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

export const listAppServerGrants = (appId: string) =>
  request<{ server_grants: AppServerGrant[] }>(`/api/apps/${appId}/server-grants`, {
    admin: true,
  });

export const addAppServerGrant = (
  appId: string,
  input: {
    server_id?: string | null;
    server_slug?: string | null;
    app_role: AppServerGrant["app_role"];
  },
) =>
  request<{ ok: boolean }>(`/api/apps/${appId}/server-grants`, {
    method: "POST",
    admin: true,
    body: JSON.stringify(input),
  });

export const updateAppServerGrant = (
  appId: string,
  grantKey: string,
  input: {
    server_id?: string | null;
    server_slug?: string | null;
    app_role: AppServerGrant["app_role"];
  },
) =>
  request<{ ok: boolean }>(
    `/api/apps/${appId}/server-grants/${encodeURIComponent(grantKey)}`,
    {
      method: "PATCH",
      admin: true,
      body: JSON.stringify(input),
    },
  );

export const removeAppServerGrant = (appId: string, serverId: string) =>
  request<{ ok: boolean }>(
    `/api/apps/${appId}/server-grants/${encodeURIComponent(serverId)}`,
    {
      method: "DELETE",
      admin: true,
    },
  );

// ---------- App Store Connect credentials (TestFlight) ----------

export interface AscCredentialsMeta {
  id: string;
  app_id: string;
  key_id: string;
  issuer_id: string;
  created_by_actor: string | null;
  created_at: number;
  updated_at: number;
}

export const getAscCredentials = (appId: string) =>
  request<{ asc_credentials: AscCredentialsMeta | null }>(
    `/api/apps/${appId}/asc-credentials`,
    { admin: true },
  );

export const setAscCredentials = (
  appId: string,
  input: { key_id: string; issuer_id: string; p8: string },
) =>
  request<{ asc_credentials: AscCredentialsMeta }>(
    `/api/apps/${appId}/asc-credentials`,
    { method: "PUT", admin: true, body: JSON.stringify(input) },
  );

export const deleteAscCredentials = (appId: string) =>
  request<{ ok: boolean }>(`/api/apps/${appId}/asc-credentials`, {
    method: "DELETE",
    admin: true,
  });

export const verifyAscCredentials = (appId: string, bundleId: string) =>
  request<{
    ok: boolean;
    key_id?: string;
    bundle_id?: string;
    asc_app_id?: string | null;
    detail?: string;
    error?: string;
    status?: number;
  }>(`/api/apps/${appId}/asc-credentials/verify`, {
    method: "POST",
    admin: true,
    body: JSON.stringify({ bundle_id: bundleId }),
  });

// ---------- AppGallery Connect credentials (HarmonyOS) ----------

export interface AgcCredentialsMeta {
  id: string;
  app_id: string;
  credential_kind: "api_client" | "service_account";
  developer_id: string | null;
  project_id: string | null;
  client_id: string | null;
  key_id: string | null;
  sub_account: string | null;
  configuration_version: string | null;
  region: string | null;
  credential_fingerprint: string;
  created_by_actor: string | null;
  created_at: number;
  updated_at: number;
}
export const getAgcCredentials = (appId: string) =>
  request<{ agc_credentials: AgcCredentialsMeta | null }>(`/api/apps/${appId}/agc-credentials`, { admin: true });
export const setAgcCredentials = (appId: string, credential_json: string) =>
  request<{ agc_credentials: AgcCredentialsMeta }>(`/api/apps/${appId}/agc-credentials`, {
    method: "PUT", admin: true, body: JSON.stringify({ credential_json }),
  });
export const deleteAgcCredentials = (appId: string) =>
  request<{ ok: boolean }>(`/api/apps/${appId}/agc-credentials`, { method: "DELETE", admin: true });
export const verifyAgcCredentials = (appId: string) =>
  request<{ ok: boolean; credential_kind?: string; developer_id?: string; project_id?: string; client_id?: string; key_id?: string; sub_account?: string; region?: string | null; expires_in?: number; error?: string; status?: number }>(
    `/api/apps/${appId}/agc-credentials/verify`, { method: "POST", admin: true },
  );

export interface AgcSubmission {
  id: string;
  app_id: string;
  build_id: string;
  provider: "appgallery";
  lane: "invitation_test";
  state: "uploading" | "processing" | "ready" | "testing_review" | "failed";
  external_app_id: string | null;
  external_version_id: string | null;
  external_package_id: string | null;
  error_message: string | null;
  provider_state: Record<string, unknown>;
  created_at: number;
  updated_at: number;
}

export const getAgcBuildSubmission = (appId: string, buildId: string) =>
  request<{ submission: AgcSubmission | null }>(
    `/api/apps/${appId}/builds/${buildId}/agc-invitation-test`,
    { admin: true },
  );

export const startAgcInvitationTest = (appId: string, buildId: string, packageName: string) =>
  request<{ submission_id?: string; state?: string; submission?: AgcSubmission }>(
    `/api/apps/${appId}/builds/${buildId}/agc-invitation-test`,
    {
      method: "POST",
      admin: true,
      body: JSON.stringify({ package_name: packageName }),
    },
  );

export const getAgcSubmission = (appId: string, submissionId: string) =>
  request<{ submission: AgcSubmission; events: Array<{ state: string; detail_json: string; created_at: number }> }>(
    `/api/apps/${appId}/agc-submissions/${submissionId}`,
    { admin: true },
  );

export const submitAgcInvitationTest = (appId: string, submissionId: string) =>
  request<{ ok: boolean; submission_id: string; state: string }>(
    `/api/apps/${appId}/agc-submissions/${submissionId}/submit`,
    { method: "POST", admin: true },
  );

// ---------- TestFlight upload (Hands → Apple) ----------

/** Apple's build-upload state is an object, not a bare string. */
export interface AscUploadState {
  state: "AWAITING_UPLOAD" | "PROCESSING" | "FAILED" | "COMPLETE" | string;
  errors?: Array<{ code?: string; description?: string }>;
  warnings?: Array<{ code?: string; description?: string }>;
  infos?: Array<{ code?: string; description?: string }>;
}

export const uploadBuildToTestflight = (
  appId: string,
  buildId: string,
  bundleId?: string,
) =>
  request<{
    operation_id: string;
    ok: boolean;
    asc_app_id?: string;
    build_upload_id?: string;
    parts_uploaded?: number;
    state?: AscUploadState;
    error?: string;
    detail?: string | null;
  }>(`/api/apps/${appId}/builds/${buildId}/testflight-upload`, {
    method: "POST",
    admin: true,
    body: JSON.stringify(bundleId ? { bundle_id: bundleId } : {}),
  });

export const getTestflightUploadStatus = (appId: string, buildUploadId: string) =>
  request<{
    build_upload_id: string;
    state: AscUploadState | null;
    version: string | null;
    build_number: string | null;
    uploaded_at: string | null;
  }>(`/api/apps/${appId}/testflight-uploads/${buildUploadId}`, { admin: true });

// ---------- App Store review status (read-only) ----------

export interface AppStoreVersionSummary {
  versionString: string | null;
  appStoreState: string | null;
  platform: string | null;
  createdDate: string | null;
}

export interface BetaReviewSummary {
  version: string | null;
  processingState: string | null;
  uploadedDate: string | null;
  betaReviewState: string | null;
}

/**
 * Read-only App Store / TestFlight review status for an iOS app. The worker
 * returns one of a few shapes; the optional fields distinguish them:
 *  - { applicable: false }                          → non-iOS, hide the panel
 *  - { configured: false }                          → no ASC credentials
 *  - { configured: true, bundle_id: null, error }   → no iOS bundle id
 *  - { configured: true, error }                    → Apple/ASC call failed
 *  - { configured: true, applicable: true, … }      → data present
 */
export interface AppStoreReview {
  applicable?: boolean;
  configured?: boolean;
  platform?: string;
  bundle_id?: string | null;
  asc_app_id?: string;
  app_store_versions?: AppStoreVersionSummary[];
  testflight_builds?: BetaReviewSummary[];
  error?: string;
}

export const getAppStoreReview = (appId: string) =>
  request<AppStoreReview>(`/api/apps/${appId}/appstore-review`, {
    admin: true,
  });

export const listAppDeployTokens = (appId: string) =>
  request<{ deploy_tokens: AppDeployToken[] }>(
    `/api/apps/${appId}/deploy-tokens`,
    { admin: true },
  );

export const createAppDeployToken = (
  appId: string,
  input: {
    name: string;
    app_role: AppDeployToken["app_role"];
    expires_at?: number | null;
  },
) =>
  request<{ token: string; deploy_token: AppDeployToken }>(
    `/api/apps/${appId}/deploy-tokens`,
    {
      method: "POST",
      admin: true,
      body: JSON.stringify(input),
    },
  );

export const revokeAppDeployToken = (appId: string, tokenId: string) =>
  request<{ ok: boolean; id: string; revoked_at: number }>(
    `/api/apps/${appId}/deploy-tokens/${encodeURIComponent(tokenId)}`,
    {
      method: "DELETE",
      admin: true,
    },
  );

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
 * Open a bearer-authenticated SSE subscription for operation updates.
 */
export function streamOperations(
  appId: string,
  onOp: (op: Operation) => void,
  onError?: (e: unknown) => void,
): { close: () => void } {
  const url = `${API_BASE}/api/apps/${appId}/operations/stream`;
  const controller = new AbortController();
  void (async () => {
    try {
      const headers = new Headers({ accept: "text/event-stream" });
      addAuthHeader(headers);
      const response = await fetch(url, { headers, signal: controller.signal });
      if (!response.ok || !response.body) throw new Error(`operation stream ${response.status}`);
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split("\n\n");
        buffer = events.pop() ?? "";
        for (const event of events) {
          const eventName = event.split("\n").find((line) => line.startsWith("event:"))?.slice(6).trim();
          const data = event.split("\n").filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trimStart()).join("\n");
          if (eventName === "op" && data) onOp(JSON.parse(data) as Operation);
        }
      }
    } catch (error) {
      if (!controller.signal.aborted) onError?.(error);
    }
  })();
  return { close: () => controller.abort() };
}

// Multipart upload to the Worker, which stores in R2 and returns file_hash + r2_key.
export const uploadApk = async (
  appId: string,
  file: File,
): Promise<{ file_hash: string; r2_key: string; size_bytes: number; original_filename: string }> => {
  const fd = new FormData();
  fd.append("apk", file);
  const headers = new Headers();
  addAuthHeader(headers);
  const res = await fetch(`${API_BASE}/api/apps/${appId}/upload`, {
    method: "POST",
    headers,
    body: fd,
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

export const buildAssetDownloadUrl = (
  appId: string,
  buildId: string,
  assetId: string,
) =>
  `${API_BASE}/api/apps/${encodeURIComponent(appId)}/builds/${encodeURIComponent(buildId)}/assets/${encodeURIComponent(assetId)}/download`;

/**
 * Fetch a browser-navigable signed download URL for a build asset. The raw
 * /download endpoint is Bearer-gated, so a direct <a href> would 401 in the
 * browser; this authenticated call returns a short-lived signed URL the browser
 * can open directly.
 */
export const getBuildAssetDownloadUrl = (
  appId: string,
  buildId: string,
  assetId: string,
) =>
  request<{ download_url: string }>(
    `/api/apps/${appId}/builds/${buildId}/assets/${assetId}/download?presign=1`,
    { admin: true },
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
  | "feedback:new"
  | "crash:new_group"
  | "crash:spike"
  | "release:new"
  | "release:superseded"
  | "release:rolled_back"
  | "release:cancelled"
  | "build:succeeded"
  | "build:failed";

export const WEBHOOK_EVENT_TYPES: WebhookEventType[] = [
  "feedback:new",
  "crash:new_group",
  "crash:spike",
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

// ---- Release shares (P1: share management tab) ----

export interface AppShare {
  id: string;
  release_id: string;
  created_by: string;
  created_at: number;
  expires_at: number;
  revoked_at: number | null;
  has_password: number; // 0 | 1 from SQLite
  release_status: string;
  channel_slug: string;
  version_name: string;
  version_code: number;
  view_count: number;
  unique_view_count: number;
  download_count: number;
  unique_download_count: number;
}

export const listAppShares = (appId: string) =>
  request<{ shares: AppShare[] }>(`/api/apps/${appId}/shares`, { admin: true });

export const createReleaseShare = (
  appId: string,
  releaseId: string,
  body: { ttl_seconds?: number; expires_at?: number; password?: string },
) =>
  request<{ id: string; share_url: string; expires_at: number; has_password: boolean }>(
    `/api/apps/${appId}/releases/${releaseId}/shares`,
    { method: "POST", body: JSON.stringify(body), admin: true },
  );

export const renewReleaseShare = (
  appId: string,
  releaseId: string,
  shareId: string,
  body: { ttl_seconds?: number; expires_at?: number; password?: string | null },
) =>
  request<{ id: string; expires_at: number }>(
    `/api/apps/${appId}/releases/${releaseId}/shares/${shareId}`,
    { method: "PATCH", body: JSON.stringify(body), admin: true },
  );

export const revokeReleaseShare = (appId: string, releaseId: string, shareId: string) =>
  request<{ id: string }>(
    `/api/apps/${appId}/releases/${releaseId}/shares/${shareId}`,
    { method: "DELETE", admin: true },
  );

// ---- Feedback tickets (task #66) ----

export interface FeedbackTicket {
  id: string;
  kind: "feedback" | "bug" | "crash";
  status: "open" | "in_progress" | "resolved" | "closed";
  assignee: string | null;
  message: string;
  contact: string | null;
  version_name: string | null;
  version_code: number | null;
  channel: string | null;
  device_id: string | null;
  device_model: string | null;
  os_version: string | null;
  created_at: number;
  updated_at: number;
  attachment_count: number;
  comment_count: number;
}

export interface FeedbackDetail {
  ticket: FeedbackTicket & {
    arch: string | null;
    locale: string | null;
    metadata_json: string;
  };
  attachments: Array<{
    id: string;
    filename: string;
    content_type: string | null;
    size_bytes: number;
    created_at: number;
  }>;
  comments: Array<{
    id: string;
    author_actor: string;
    body: string;
    internal: number;
    created_at: number;
  }>;
}

export const listFeedback = (
  appId: string,
  filters?: {
    status?: string | undefined;
    kind?: string | undefined;
    deviceId?: string | undefined;
    versionCode?: number | undefined;
    signature?: string | undefined;
  },
) => {
  const params = new URLSearchParams();
  if (filters?.status) params.set("status", filters.status);
  if (filters?.kind) params.set("kind", filters.kind);
  if (filters?.deviceId) params.set("device_id", filters.deviceId);
  if (filters?.versionCode != null) params.set("version_code", String(filters.versionCode));
  if (filters?.signature) params.set("signature", filters.signature);
  const qs = params.toString();
  return request<{ tickets: FeedbackTicket[] }>(
    `/api/apps/${appId}/feedback${qs ? `?${qs}` : ""}`,
    { admin: true },
  );
};

export const getFeedback = (appId: string, ticketId: string) =>
  request<FeedbackDetail>(`/api/apps/${appId}/feedback/${ticketId}`, { admin: true });

export const updateFeedbackTicket = (
  appId: string,
  ticketId: string,
  body: { status?: string; assignee?: string | null },
) =>
  request<{ id: string; status: string | null; assignee: string | null }>(
    `/api/apps/${appId}/feedback/${ticketId}`,
    {
      method: "PATCH",
      body: JSON.stringify(body),
      admin: true,
    },
  );

export const addFeedbackComment = (appId: string, ticketId: string, body: string) =>
  request<{ id: string }>(`/api/apps/${appId}/feedback/${ticketId}/comments`, {
    method: "POST",
    body: JSON.stringify({ body }),
    admin: true,
  });

export const feedbackAttachmentUrl = (appId: string, ticketId: string, attachmentId: string) =>
  `/api/apps/${appId}/feedback/${ticketId}/attachments/${attachmentId}`;

export const feedbackAttachmentInlineUrl = (appId: string, ticketId: string, attachmentId: string) =>
  `/api/apps/${appId}/feedback/${ticketId}/attachments/${attachmentId}?inline=1`;

export const getFeedbackAttachmentBlob = async (
  appId: string,
  ticketId: string,
  attachmentId: string,
  inline = false,
): Promise<Blob> => {
  const headers = new Headers();
  addAuthHeader(headers);
  const url = inline
    ? feedbackAttachmentInlineUrl(appId, ticketId, attachmentId)
    : feedbackAttachmentUrl(appId, ticketId, attachmentId);
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`attachment ${res.status}`);
  return res.blob();
};

export const downloadFeedbackAttachment = async (
  appId: string,
  ticketId: string,
  attachmentId: string,
  filename: string,
): Promise<void> => {
  const blob = await getFeedbackAttachmentBlob(appId, ticketId, attachmentId);
  const url = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
  } finally {
    URL.revokeObjectURL(url);
  }
};

export const getFeedbackAttachmentText = async (
  appId: string,
  ticketId: string,
  attachmentId: string,
  maxBytes = 200_000,
): Promise<string> => {
  const res = await fetch(feedbackAttachmentUrl(appId, ticketId, attachmentId), {
    headers: (() => {
      const headers = new Headers();
      addAuthHeader(headers);
      return headers;
    })(),
  });
  if (!res.ok) throw new Error(`attachment ${res.status}`);
  const text = await res.text();
  return text.length > maxBytes ? text.slice(0, maxBytes) + "\n…(truncated)" : text;
};

export const updateAppPublicHistory = (appId: string, enabled: boolean) =>
  request<{ ok: boolean }>(`/api/apps/${appId}`, {
    method: "PATCH",
    body: JSON.stringify({ public_history: enabled }),
    admin: true,
  });

export const updateAppDeltaUpdates = (appId: string, enabled: boolean) =>
  request<{ ok: boolean }>(`/api/apps/${appId}`, {
    method: "PATCH",
    body: JSON.stringify({ delta_updates_enabled: enabled }),
    admin: true,
  });

export const uploadAppIcon = async (appId: string, file: File) => {
  const headers = new Headers({ "content-type": file.type || "image/png" });
  addAuthHeader(headers);
  const res = await fetch(`${API_BASE}/api/apps/${appId}/icon`, {
    method: "PUT",
    headers,
    body: file,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new ApiError(res.status, text, text || `${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<{ ok: boolean; icon_r2_key: string }>;
};

export const publicAppIconUrl = (slug: string) => `${API_BASE}/public/apps/${slug}/icon`;

export interface CrashGroup {
  signature: string;
  count: number;
  device_count: number;
  first_seen: number;
  last_seen: number;
  versions: string | null;
  open_count: number;
}

export interface DeviceAnalytics {
  active_devices: number;
  window_start: number;
  by_version: Array<{ version_name: string; version_code: number | null; devices: number }>;
  by_platform: Array<{ platform: string; devices: number }>;
  by_channel: Array<{ channel: string; devices: number }>;
}

export interface VersionMetric {
  release_id: string | null;
  build_id: string | null;
  channel: string;
  product_type: string | null;
  release_type: string | null;
  release_status: string | null;
  rollout_cohort_count: number | null;
  version_name: string;
  version_code: number | null;
  released_at: number | null;
  release_updated_at: number | null;
  active_devices: number;
  total_devices: number;
  update_current_count: number;
  update_offered_count: number;
  last_checked_at: number | null;
  feedback_count: number;
  crash_count: number;
  download_count: number;
  telemetry_only: boolean;
}

export interface VersionMetrics {
  window_start: number;
  window_days: number;
  window_minutes: number;
  versions: VersionMetric[];
}

export interface DeviceDetail {
  device_id: string;
  version_name: string | null;
  version_code: number | null;
  channel: string | null;
  platform: string | null;
  arch: string | null;
  os_version: string | null;
  device_model: string | null;
  locale: string | null;
  first_seen: number;
  last_seen: number;
  ping_count: number;
}

export const getDeviceDetail = (appId: string, deviceId: string) =>
  request<{ device: DeviceDetail | null }>(
    `/api/apps/${appId}/analytics/devices/${encodeURIComponent(deviceId)}`,
    { admin: true },
  );

export const getDeviceAnalytics = (appId: string, windowDays = 30) =>
  request<DeviceAnalytics>(
    `/api/apps/${appId}/analytics/devices?window_days=${windowDays}`,
    { admin: true },
  );

export const getVersionMetrics = (appId: string, windowDays = 30) =>
  request<VersionMetrics>(
    `/api/apps/${appId}/analytics/versions?window_days=${windowDays}`,
    { admin: true },
  );

export interface FeedbackStats {
  daily: Array<{ day: string; kind: string; n: number }>;
  crashes_by_version: Array<{ version_name: string; version_code: number | null; n: number }>;
}

export const getFeedbackStats = (appId: string) =>
  request<FeedbackStats>(`/api/apps/${appId}/feedback/stats`, { admin: true });

export const listCrashGroups = (appId: string) =>
  request<{ groups: CrashGroup[] }>(`/api/apps/${appId}/feedback/crash-groups`, { admin: true });

export const purgeApp = (appId: string, confirmSlug: string) =>
  request<{ ok: true; purged_app_id: string; r2_objects_deleted: number }>(
    `/api/apps/${appId}/purge`,
    { method: "POST", admin: true, body: JSON.stringify({ confirm_slug: confirmSlug }) },
  );

export const getAppClientKey = (appId: string) =>
  request<{ app_id: string; client_key: string | null }>(
    `/api/apps/${appId}/client-key`,
    { admin: true },
  );

export const rotateAppClientKey = (appId: string) =>
  request<{ app_id: string; client_key: string; rotated_at: number }>(
    `/api/apps/${appId}/rotate-client-key`,
    { method: "POST", body: "{}", admin: true },
  );
