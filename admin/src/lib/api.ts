/**
 * Minimal fetch client for the quiver Worker API.
 *
 * In dev: Vite proxies /api → http://127.0.0.1:8787 (wrangler dev).
 * In prod: Vite-built static assets are deployed to Cloudflare Pages; /api
 *          goes to the production Worker.
 *
 * For dev with auth, set VITE_ADMIN_API_TOKEN in admin/.dev.vars (or env)
 * and the client will attach `Authorization: Bearer <token>` to admin calls.
 */

const TOKEN = (import.meta as any).env?.VITE_ADMIN_API_TOKEN ?? "";

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

async function request<T>(
  path: string,
  init: RequestInit & { admin?: boolean } = {},
): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json");
  if (init.admin && TOKEN) {
    headers.set("authorization", `Bearer ${TOKEN}`);
  }
  const res = await fetch(path, { ...init, headers });
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
  input: Parameters<typeof request>[1] extends infer R ? any : never,
) =>
  request<Version>(`/api/apps/${appId}/versions`, {
    method: "POST",
    admin: true,
    body: JSON.stringify(input),
  });

export const listAuditLogs = (appId: string) =>
  request<{ logs: AuditLogEntry[] }>(`/api/apps/${appId}/audit-logs`, { admin: true });

// Parse APK via Container (admin route)
export const parseApk = async (file: File): Promise<any> => {
  const res = await fetch(`/api/parse-apk`, {
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