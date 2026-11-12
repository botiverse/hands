/**
 * General-purpose Google Play Android Publisher API proxy through Hands.
 *
 * Allows authenticated callers to inspect or mutate Google Play resources for
 * an app without ever exposing the app's stored service-account or OAuth
 * credentials to the client.
 *
 * Security & governance gates:
 * - App role: `viewer` for read-only `GET`; `publisher` (authenticated human or
 *   agent, never a deploy token) for mutating `POST` / `PUT` / `PATCH` / `DELETE`.
 * - Verified & enabled Google Play binding on the app.
 * - Strict path confinement to `/androidpublisher/v3/applications/{packageName}/...`
 *   (cross-package paths, path traversal, and non-API hosts are refused before
 *   any Google call).
 * - Mutating calls require a package-scoped Play edit lock (shared with
 *   `promote` and `store-listing`), write an immutable receipt to
 *   `play_store_listing_receipts` (`mode = 'api'`), and append an audit log entry.
 */
import type { Context } from "hono";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";
import { currentActor, currentActorInfo, type AdminEnv } from "../middleware/auth";
import { ensureAppRole, insertAuditLog } from "../lib/permissions";
import { reclaimStalePlayEditLock } from "../lib/play_edit_lock";
import { getGooglePlayBinding, hasGooglePlayConfiguration, type GooglePlayBinding } from "../lib/google_play_bindings";

type AdminContext = Context<AdminEnv & { Bindings: Env }>;

export type PlayApiMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
const PLAY_API_METHODS = new Set<PlayApiMethod>(["GET", "POST", "PUT", "PATCH", "DELETE"]);
const LOCK_STALE_MS = 15 * 60 * 1000;
const IDENTIFIER_RE = /^[A-Za-z][A-Za-z0-9._]{0,60}$/;

export interface PlayApiProxyInput {
  method: PlayApiMethod;
  path: string;
  query?: Record<string, string | string[]>;
  body?: unknown;
  note?: string;
}

export class PlayApiInputError extends Error {
  constructor(
    readonly status: 400 | 403,
    readonly failureCode: string,
    message: string,
  ) {
    super(message);
  }
}

export function normalizePlayApiPathForPackage(packageName: string, rawPath: string): {
  canonicalPath: string;
  inlineQuery: Record<string, string[]>;
} {
  const invalid = (message = "Google Play API path is invalid") =>
    new PlayApiInputError(400, "play_api_path_invalid", message);
  if (typeof rawPath !== "string" || !rawPath.trim()) throw invalid();
  const trimmed = rawPath.trim();
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed)) {
    throw invalid("Google Play API path must be a path, not a full URL");
  }
  if (trimmed.startsWith("//") || trimmed.includes("\\")) {
    throw invalid();
  }
  const [pathnamePart = "", searchPart] = trimmed.split("?", 2);
  if (pathnamePart.includes("#")) throw invalid();
  const rawSegments = pathnamePart.replace(/^\/+/, "").split("/").filter((s) => s.length > 0);
  for (const seg of rawSegments) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(seg);
    } catch {
      throw invalid();
    }
    if (decoded === "." || decoded === ".." || decoded.includes("/") || decoded.includes("\\") || decoded.includes("\0")) {
      throw invalid("Google Play API path cannot contain path traversal segments");
    }
  }

  let subSegments: string[];
  if (
    rawSegments[0] === "androidpublisher" &&
    rawSegments[1] === "v3" &&
    rawSegments[2] === "applications"
  ) {
    if (rawSegments.length < 4) throw invalid("Google Play API path is missing packageName");
    const pathPkg = decodeURIComponent(rawSegments[3]!);
    if (pathPkg !== packageName) {
      throw new PlayApiInputError(
        403,
        "play_api_package_mismatch",
        `Google Play API path targets package '${pathPkg}', but this app is bound to '${packageName}'`,
      );
    }
    subSegments = rawSegments.slice(4);
  } else if (rawSegments[0] === "v3" && rawSegments[1] === "applications") {
    if (rawSegments.length < 3) throw invalid("Google Play API path is missing packageName");
    const pathPkg = decodeURIComponent(rawSegments[2]!);
    if (pathPkg !== packageName) {
      throw new PlayApiInputError(
        403,
        "play_api_package_mismatch",
        `Google Play API path targets package '${pathPkg}', but this app is bound to '${packageName}'`,
      );
    }
    subSegments = rawSegments.slice(3);
  } else if (rawSegments[0] === "applications") {
    if (rawSegments.length < 2) throw invalid("Google Play API path is missing packageName");
    const pathPkg = decodeURIComponent(rawSegments[1]!);
    if (pathPkg !== packageName) {
      throw new PlayApiInputError(
        403,
        "play_api_package_mismatch",
        `Google Play API path targets package '${pathPkg}', but this app is bound to '${packageName}'`,
      );
    }
    subSegments = rawSegments.slice(2);
  } else if (rawSegments[0] === "upload") {
    throw invalid("Media upload paths are not supported by the JSON API proxy");
  } else {
    subSegments = rawSegments;
  }

  const base = `/androidpublisher/v3/applications/${encodeURIComponent(packageName)}`;
  const canonicalPath = subSegments.length > 0 ? `${base}/${subSegments.join("/")}` : base;

  const inlineQuery: Record<string, string[]> = {};
  if (searchPart) {
    const params = new URLSearchParams(searchPart);
    for (const [k, v] of params.entries()) {
      if (!inlineQuery[k]) inlineQuery[k] = [];
      inlineQuery[k].push(v);
    }
  }
  return { canonicalPath, inlineQuery };
}

export function normalizePlayApiProxyInput(raw: unknown): PlayApiProxyInput {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new PlayApiInputError(400, "play_api_request_invalid", "request body must be a JSON object");
  }
  const obj = raw as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!["method", "path", "query", "body", "note"].includes(key)) {
      throw new PlayApiInputError(400, "play_api_request_invalid", `unknown field ${key}`);
    }
  }
  const method = (typeof obj.method === "string" ? obj.method.trim().toUpperCase() : "") as PlayApiMethod;
  if (!PLAY_API_METHODS.has(method)) {
    throw new PlayApiInputError(400, "play_api_method_invalid", "method must be GET, POST, PUT, PATCH, or DELETE");
  }
  const path = typeof obj.path === "string" ? obj.path.trim() : "";
  if (!path) {
    throw new PlayApiInputError(400, "play_api_path_invalid", "path is required");
  }
  if (method === "GET" && obj.body !== undefined && obj.body !== null) {
    throw new PlayApiInputError(400, "play_api_request_invalid", "GET requests cannot include a body");
  }
  let query: Record<string, string | string[]> | undefined;
  if (obj.query !== undefined && obj.query !== null) {
    if (typeof obj.query !== "object" || Array.isArray(obj.query)) {
      throw new PlayApiInputError(400, "play_api_request_invalid", "query must be an object of string or string[] values");
    }
    query = {};
    for (const [k, v] of Object.entries(obj.query as Record<string, unknown>)) {
      if (!k.trim()) continue;
      if (typeof v === "string") {
        query[k] = v;
      } else if (Array.isArray(v) && v.every((item) => typeof item === "string")) {
        query[k] = v as string[];
      } else if (typeof v === "number" || typeof v === "boolean") {
        query[k] = String(v);
      } else {
        throw new PlayApiInputError(400, "play_api_request_invalid", `query parameter '${k}' must be a string or string array`);
      }
    }
  }
  let note: string | undefined;
  if (obj.note !== undefined && obj.note !== null) {
    if (typeof obj.note !== "string") {
      throw new PlayApiInputError(400, "play_api_request_invalid", "note must be a string");
    }
    const trimmedNote = obj.note.trim();
    if (trimmedNote.length > 500) {
      throw new PlayApiInputError(400, "play_api_request_invalid", "note must be at most 500 characters");
    }
    if (trimmedNote) note = trimmedNote;
  }
  return {
    method,
    path,
    ...(query ? { query } : {}),
    ...(obj.body !== undefined ? { body: obj.body } : {}),
    ...(note ? { note } : {}),
  };
}

function fail(
  c: Context<any>,
  status: 400 | 403 | 409 | 502 | 503,
  failure: {
    code: "gate_failed" | "forbidden" | "edit_conflict" | "edit_in_review" | "play_api_error";
    failure_code: string;
    message: string;
    receipt_id?: string | null;
    [key: string]: unknown;
  },
) {
  return c.json({ error: { receipt_id: null, ...failure } }, status);
}

async function resolveBinding(c: AdminContext): Promise<GooglePlayBinding | Response> {
  if (!c.env.PLAY_RELEASE_SERVICE || typeof c.env.PLAY_RELEASE_SERVICE.callPlayApi !== "function") {
    return fail(c, 503, {
      code: "play_api_error",
      failure_code: "play_service_unavailable",
      message: "Google Play API proxy service is not configured or adapter must be updated",
    });
  }
  let binding: GooglePlayBinding | null;
  try {
    binding = await getGooglePlayBinding(c.env.DB, c.req.param("appId") ?? "", c.env.PLAY_CRED_ENC_KEYS);
  } catch {
    return fail(c, 502, {
      code: "play_api_error",
      failure_code: "play_credentials_unavailable",
      message: "Google Play credentials are unavailable for this app",
    });
  }
  if (
    !binding ||
    !hasGooglePlayConfiguration(binding) ||
    binding.enabled !== 1 ||
    binding.verification_state !== "verified" ||
    !binding.package_name
  ) {
    return fail(c, 403, {
      code: "forbidden",
      failure_code: "play_binding_not_ready",
      message: "Google Play must be bound, verified, and enabled for this app",
    });
  }
  return binding;
}

async function takePlayApiLock(db: D1Database, appId: string, packageName: string, operationId: string, actor: string): Promise<boolean> {
  const now = Date.now();
  await db
    .prepare("DELETE FROM play_store_listing_locks WHERE app_id = ?1 AND package_name = ?2 AND acquired_at < ?3")
    .bind(appId, packageName, now - LOCK_STALE_MS)
    .run();
  await reclaimStalePlayEditLock(db, appId, packageName, now);
  try {
    const result = await db
      .prepare(
        `INSERT INTO play_store_listing_locks (app_id, package_name, operation_id, acquired_by, acquired_at)
         SELECT ?1, ?2, ?3, ?4, ?5
         WHERE NOT EXISTS (SELECT 1 FROM play_edit_locks WHERE app_id = ?1 AND package_name = ?2)`,
      )
      .bind(appId, packageName, operationId, actor, now)
      .run();
    return (result.meta?.changes ?? 0) === 1;
  } catch {
    return false;
  }
}

async function releasePlayApiLock(db: D1Database, operationId: string) {
  await db.prepare("DELETE FROM play_store_listing_locks WHERE operation_id = ?1").bind(operationId).run();
}

function sha256Hex(value: string): string {
  return bytesToHex(sha256(new TextEncoder().encode(value)));
}

function extractEditIdFromPathOrBody(canonicalPath: string, body: unknown): string | null {
  const match = canonicalPath.match(/\/edits\/([^/?#]+)/);
  if (match?.[1]) {
    try {
      const id = decodeURIComponent(match[1]).replace(/:(validate|commit)$/, "");
      if (/^[A-Za-z0-9._:-]{1,128}$/.test(id)) return id;
    } catch {
      // ignore
    }
  }
  if (body && typeof body === "object" && !Array.isArray(body)) {
    const id = (body as Record<string, unknown>).id;
    if (typeof id === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(id)) return id;
  }
  return null;
}

export async function handleProxyPlayApi(c: AdminContext) {
  const appId = c.req.param("appId") ?? "";
  let rawBody: unknown;
  try {
    rawBody = await c.req.json();
  } catch {
    return fail(c, 400, {
      code: "gate_failed",
      failure_code: "play_api_request_invalid",
      message: "request body must be valid JSON",
    });
  }

  let input: PlayApiProxyInput;
  try {
    input = normalizePlayApiProxyInput(rawBody);
  } catch (error) {
    if (!(error instanceof PlayApiInputError)) throw error;
    return fail(c, error.status, {
      code: error.status === 403 ? "forbidden" : "gate_failed",
      failure_code: error.failureCode,
      message: error.message,
    });
  }

  const isMutating = input.method !== "GET";
  if (isMutating) {
    const allowed = await ensureAppRole(c, appId, "publisher");
    if (!allowed.ok) return allowed.response;
    const actorType = currentActorInfo(c).type;
    if (actorType !== "human" && actorType !== "agent") {
      return fail(c, 403, {
        code: "forbidden",
        failure_code: "actor_not_allowed",
        message: "Mutating Google Play API calls require an authenticated human or agent publisher",
      });
    }
  }

  const binding = await resolveBinding(c);
  if (binding instanceof Response) return binding;
  const packageName = binding.package_name!;

  let normalizedPath: { canonicalPath: string; inlineQuery: Record<string, string[]> };
  try {
    normalizedPath = normalizePlayApiPathForPackage(packageName, input.path);
  } catch (error) {
    if (!(error instanceof PlayApiInputError)) throw error;
    return fail(c, error.status, {
      code: error.status === 403 ? "forbidden" : "gate_failed",
      failure_code: error.failureCode,
      message: error.message,
    });
  }

  const mergedQuery: Record<string, string | string[]> = { ...normalizedPath.inlineQuery, ...(input.query ?? {}) };
  const actor = currentActor(c);
  const operationId = crypto.randomUUID();

  // Only acquire the package-scoped edit lock when the mutating call is NOT
  // already operating inside an existing caller-managed edit (`edits/{editId}...`),
  // OR acquire it for the duration of this HTTP request so concurrent promote /
  // store-listing operations do not collide. Since `play_store_listing_locks` is
  // released in `finally` at the end of this HTTP request, acquiring it for every
  // mutating request is safe and prevents concurrent collisions with `promote`.
  if (isMutating) {
    if (!(await takePlayApiLock(c.env.DB, appId, packageName, operationId, actor))) {
      return fail(c, 409, {
        code: "edit_conflict",
        failure_code: "play_edit_locked",
        message: "another Hands Play edit is active for this package",
      });
    }
  }

  try {
    let reply;
    try {
      reply = await c.env.PLAY_RELEASE_SERVICE!.callPlayApi!({
        credential: binding.credential,
        packageName,
        operationId,
        method: input.method,
        path: normalizedPath.canonicalPath,
        query: mergedQuery,
        ...(input.body !== undefined ? { body: input.body } : {}),
      });
    } catch {
      reply = {
        ok: false as const,
        error: { status: 502, code: "play_adapter_unavailable", message: "Google Play API request failed" },
      };
    }

    const createdAt = Date.now();
    const requestBodySha256 =
      input.body !== undefined && input.body !== null ? sha256Hex(JSON.stringify(input.body)) : null;

    if (!reply?.ok) {
      const code =
        typeof reply?.error?.code === "string" && IDENTIFIER_RE.test(reply.error.code)
          ? reply.error.code
          : "play_adapter_error";
      const cause = reply?.error?.cause ?? null;
      let receiptId: string | null = null;
      if (isMutating) {
        receiptId = crypto.randomUUID();
        const editId = extractEditIdFromPathOrBody(normalizedPath.canonicalPath, null);
        const payload = {
          schema_version: 1,
          kind: "play-api-proxy",
          receipt_id: receiptId,
          operation_id: operationId,
          actor,
          package_name: packageName,
          method: input.method,
          path: normalizedPath.canonicalPath,
          query: mergedQuery,
          request_body_sha256: requestBodySha256,
          note: input.note ?? null,
          created_at: new Date(createdAt).toISOString(),
          result: {
            status: "failed-closed",
            failure_code: code,
            http_status: reply?.error?.status ?? 502,
            ...(cause ? { cause } : {}),
          },
        };
        await c.env.DB.prepare(
          `INSERT INTO play_store_listing_receipts
           (id, app_id, package_name, operation_id, mode, verdict, play_edit_id, languages_json, payload_json, created_by, created_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`,
        )
          .bind(
            receiptId,
            appId,
            packageName,
            operationId,
            "commit",
            "failed-closed",
            editId,
            JSON.stringify([]),
            JSON.stringify(payload),
            actor,
            createdAt,
          )
          .run();
        await insertAuditLog(c.env.DB, c, {
          app_id: appId,
          action: "play_api.call",
          payload: {
            operation_id: operationId,
            receipt_id: receiptId,
            package_name: packageName,
            method: input.method,
            path: normalizedPath.canonicalPath,
            verdict: "failed-closed",
            failure_code: code,
            note: input.note ?? null,
          },
          created_at: createdAt,
        });
      }
      const status = reply?.error?.status;
      const httpStatus: 400 | 403 | 409 | 502 =
        status === 400 ? 400 : status === 403 ? 403 : status === 409 ? 409 : 502;
      return fail(c, httpStatus, {
        code: status === 400 ? "gate_failed" : status === 403 ? "forbidden" : "play_api_error",
        failure_code: code,
        message: reply?.error?.message ?? "Google Play API request failed",
        receipt_id: receiptId,
        ...(cause ? { cause } : {}),
      });
    }

    const value = reply.value;
    let receiptId: string | null = null;
    if (isMutating) {
      receiptId = crypto.randomUUID();
      const editId = extractEditIdFromPathOrBody(normalizedPath.canonicalPath, value.body);
      const responseBodySha256 =
        value.body !== undefined && value.body !== null ? sha256Hex(JSON.stringify(value.body)) : null;
      const payload = {
        schema_version: 1,
        kind: "play-api-proxy",
        receipt_id: receiptId,
        operation_id: operationId,
        actor,
        package_name: packageName,
        method: input.method,
        path: value.path,
        query: mergedQuery,
        request_body_sha256: requestBodySha256,
        response_body_sha256: responseBodySha256,
        note: input.note ?? null,
        created_at: new Date(createdAt).toISOString(),
        result: {
          status: "committed",
          http_status: value.status,
        },
      };
      await c.env.DB.prepare(
        `INSERT INTO play_store_listing_receipts
         (id, app_id, package_name, operation_id, mode, verdict, play_edit_id, languages_json, payload_json, created_by, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`,
      )
        .bind(
          receiptId,
          appId,
          packageName,
          operationId,
          "commit",
          "committed",
          editId,
          JSON.stringify([]),
          JSON.stringify(payload),
          actor,
          createdAt,
        )
        .run();
      await insertAuditLog(c.env.DB, c, {
        app_id: appId,
        action: "play_api.call",
        payload: {
          operation_id: operationId,
          receipt_id: receiptId,
          package_name: packageName,
          method: input.method,
          path: value.path,
          status: value.status,
          verdict: "committed",
          note: input.note ?? null,
        },
        created_at: createdAt,
      });
    }

    return c.json({
      receipt_id: receiptId,
      operation_id: operationId,
      package_name: value.package_name,
      method: value.method,
      path: value.path,
      status: value.status,
      data: value.body,
    });
  } finally {
    if (isMutating) {
      await releasePlayApiLock(c.env.DB, operationId);
    }
  }
}
