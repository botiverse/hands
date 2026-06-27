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
  slug: string;
  name: string;
  platform: string;
  description: string | null;
  archived: number;       // 0 = active, 1 = archived (soft-delete)
  archived_at: number | null;
  created_at: number;
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
}

export interface Channel {
  id: string;
  app_id: string;
  slug: string;
  name: string;
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

export const createApp = (input: { slug: string; name: string; platform: string }) =>
  request<App>(`/api/apps`, {
    method: "POST",
    admin: true,
    body: JSON.stringify(input),
  });

export const createChannel = (appId: string, input: { slug: string; name: string }) =>
  request<Channel>(`/api/apps/${appId}/channels`, {
    method: "POST",
    admin: true,
    body: JSON.stringify(input),
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
