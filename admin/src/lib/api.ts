/**
 * Minimal fetch client for the quiver Worker API.
 *
 * In dev: Vite proxies /api → http://127.0.0.1:8787 (wrangler dev).
 * In prod: Vite-built static assets are deployed to Cloudflare Pages; /api
 *          calls go to the deployed Worker.
 *
 * For dev with auth, set VITE_ADMIN_API_TOKEN in admin/.dev.vars (or env)
 * and the client will attach `Authorization: Bearer <token>` to admin calls.
 */

const TOKEN = (import.meta as any).env?.VITE_ADMIN_API_TOKEN ?? "";

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

async function request<T>(
  path: string,
  init: RequestInit & { admin?: boolean } = {},
): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json");
  if (init.admin && TOKEN) {
    headers.set("authorization", `Bearer ${TOKEN}`);
  }
  const res = await fetch(`${API_BASE}${path}`, { ...init, headers });
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

// ---------- Public API (no auth) ----------

export const listPublicVersions = (appId: string) =>
  request<{ versions: Version[] }>(`/api/apps/${appId}/versions`);

export const getPublicVersion = (appId: string, versionId: string) =>
  request<Version & { download_url: string }>(
    `/api/apps/${appId}/versions/${versionId}`,
  );

// ---------- Admin API (requires ADMIN_API_TOKEN in dev / Cloudflare Access in prod) ----------

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
  patch: { enabled?: boolean; channel?: string },
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
    // EventSource can't send custom headers; we rely on the Access JWT
    // being set as a cookie by the browser, OR on VITE_API_BASE_URL pointing
    // at a path that the Worker knows is internal.
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
    headers: {
      authorization: TOKEN ? `Bearer ${TOKEN}` : "",
      "content-type": "application/octet-stream",
    },
    body: file,
  });
  if (!res.ok) {
    throw new ApiError(res.status, await res.text(), `parse failed ${res.status}`);
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
    headers: TOKEN ? { authorization: `Bearer ${TOKEN}` } : {},
    body: fd,
  });
  if (!res.ok) {
    throw new ApiError(res.status, await res.text(), `upload failed ${res.status}`);
  }
  return res.json();
};
