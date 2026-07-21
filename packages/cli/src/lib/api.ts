/**
 * HTTP client for the Quiver Worker API.
 *
 * Mirrors the shape of admin/src/lib/api.ts and sends the saved Hands JWT as
 * Authorization: Bearer.
 *
 * Endpoints called by the CLI use `requireAppRole("viewer")` or
 * `requireOrgRole("member")` after the user has logged in via `hands login`.
 */

import { resolveApiBase, resolveAuthToken } from "./config.js";
import { readEnv } from "./env.js";
import { Blob } from "node:buffer";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";

export class QuiverApiError extends Error {
  readonly status: number;
  readonly body: unknown;
  constructor(status: number, body: unknown, message: string) {
    super(message);
    this.name = "QuiverApiError";
    this.status = status;
    this.body = body;
  }
}

let currentApiBase: string | null = null;

export function setApiBase(url: string): void {
  currentApiBase = url;
}

export function getApiBase(): string {
  return currentApiBase ?? resolveApiBase();
}

export interface ApiRequestOptions {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  body?: unknown;
  query?: Record<string, string | number | boolean | null | undefined>;
  raw?: boolean; // when true, return Response instead of parsed JSON
  signal?: AbortSignal;
}

export async function apiRequest<T = unknown>(
  path: string,
  opts: ApiRequestOptions = {},
): Promise<T> {
  const url = new URL(path.startsWith("/") ? path : `/${path}`, getApiBase());
  if (opts.query) {
    for (const [k, v] of Object.entries(opts.query)) {
      if (v === null || v === undefined) continue;
      url.searchParams.set(k, String(v));
    }
  }
  const headers: Record<string, string> = {
    accept: "application/json",
  };
  const bearer = resolveAuthToken();
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  let body: string | undefined;
  if (opts.body !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(opts.body);
  }
  const res = await fetch(url.toString(), {
    method: opts.method ?? "GET",
    headers,
    ...(body !== undefined ? { body } : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
  if (readEnv("VERBOSE") === "1") {
    console.error(`> ${opts.method ?? "GET"} ${url}`);
    console.error(`< ${res.status}`);
  }
  if (opts.raw) return (res as unknown) as T;
  const text = await res.text();
  let data: unknown = text;
  if (text.length > 0) {
    try {
      data = JSON.parse(text);
    } catch {
      // keep as text
    }
  }
  if (!res.ok) {
    const msg =
      typeof data === "object" && data && "error" in data
        ? String((data as { error: unknown }).error)
        : `${res.status} ${res.statusText}`;
    throw new QuiverApiError(res.status, data, msg);
  }
  return data as T;
}

export async function apiUploadFile<T = unknown>(
  path: string,
  filePath: string,
  fieldName = "apk",
): Promise<T> {
  const url = new URL(path.startsWith("/") ? path : `/${path}`, getApiBase());
  const form = new FormData();
  const bytes = await readFile(filePath);
  form.append(fieldName, new Blob([bytes]), basename(filePath));

  const headers: Record<string, string> = {
    accept: "application/json",
  };
  const bearer = resolveAuthToken();
  if (bearer) headers.authorization = `Bearer ${bearer}`;

  const res = await fetch(url.toString(), {
    method: "POST",
    headers,
    body: form,
  });
  if (readEnv("VERBOSE") === "1") {
    console.error(`> POST ${url}`);
    console.error(`< ${res.status}`);
  }
  const text = await res.text();
  let data: unknown = text;
  if (text.length > 0) {
    try {
      data = JSON.parse(text);
    } catch {
      // keep as text
    }
  }
  if (!res.ok) {
    const msg =
      typeof data === "object" && data && "error" in data
        ? String((data as { error: unknown }).error)
        : `${res.status} ${res.statusText}`;
    throw new QuiverApiError(res.status, data, msg);
  }
  return data as T;
}
