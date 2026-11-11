/**
 * `hands play api <app> <method> <path>` — call the Google Play Android Publisher
 * API for a Hands app using the app's server-side credentials.
 *
 * Credentials never leave Hands Server or the Play adapter. Every call goes
 * through Hands RBAC (`viewer` for GET, `publisher` for POST/PUT/PATCH/DELETE),
 * package-scoped path enforcement (`/androidpublisher/v3/applications/{packageName}/...`),
 * Play edit locks, immutable receipts, and audit logging.
 */

import { readFile } from "node:fs/promises";
import type { Command } from "commander";
import { apiRequest, QuiverApiError } from "../lib/api.js";
import { jsonRequested } from "../lib/json_output.js";

type AppRow = { id: string; slug: string };
const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);

export interface PlayApiProxyResponse {
  receipt_id: string | null;
  operation_id: string;
  package_name: string;
  method: string;
  path: string;
  status: number;
  data: unknown;
}

async function resolveAppId(input: string): Promise<string> {
  if (/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(input)) return input;
  const { apps } = await apiRequest<{ apps: AppRow[] }>("/api/apps");
  const app = apps.find((item) => item.slug === input);
  if (!app) throw new Error(`App not found: ${input}`);
  return app.id;
}

async function readStdinText(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function parseFieldValue(raw: string): unknown {
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (raw === "null") return null;
  if (/^-?\d+(?:\.\d+)?$/.test(raw)) {
    const num = Number(raw);
    if (Number.isFinite(num)) return num;
  }
  if ((raw.startsWith("{") && raw.endsWith("}")) || (raw.startsWith("[") && raw.endsWith("]"))) {
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }
  return raw;
}

export async function resolvePlayApiBody(opts: {
  input?: string;
  data?: string;
  field?: string[];
  rawField?: string[];
}): Promise<unknown> {
  const sources = [
    opts.input !== undefined ? "--input" : null,
    opts.data !== undefined ? "--data" : null,
  ].filter(Boolean);
  if (sources.length > 1) {
    throw new Error("Pass either --input or --data, not both.");
  }

  let base: unknown = undefined;
  if (opts.input !== undefined) {
    const text = opts.input === "-" ? await readStdinText() : await readFile(opts.input, "utf8");
    try {
      base = JSON.parse(text);
    } catch (error) {
      throw new Error(`Invalid JSON in ${opts.input === "-" ? "stdin" : opts.input}: ${(error as Error).message}`);
    }
  } else if (opts.data !== undefined) {
    const text = opts.data.startsWith("@")
      ? await readFile(opts.data.slice(1), "utf8")
      : opts.data;
    try {
      base = JSON.parse(text);
    } catch (error) {
      throw new Error(`Invalid JSON in --data: ${(error as Error).message}`);
    }
  }

  const hasFields = (opts.field?.length ?? 0) > 0 || (opts.rawField?.length ?? 0) > 0;
  if (!hasFields) return base;

  if (base !== undefined && (!base || typeof base !== "object" || Array.isArray(base))) {
    throw new Error("--field / --raw-field can only be combined with a JSON object body.");
  }
  const merged: Record<string, unknown> = base ? { ...(base as Record<string, unknown>) } : {};
  for (const kv of opts.field ?? []) {
    const eq = kv.indexOf("=");
    if (eq <= 0) throw new Error(`Invalid --field '${kv}', expected key=value.`);
    merged[kv.slice(0, eq)] = parseFieldValue(kv.slice(eq + 1));
  }
  for (const kv of opts.rawField ?? []) {
    const eq = kv.indexOf("=");
    if (eq <= 0) throw new Error(`Invalid --raw-field '${kv}', expected key=value.`);
    merged[kv.slice(0, eq)] = kv.slice(eq + 1);
  }
  return merged;
}

export function parseQueryParams(params: string[] | undefined): Record<string, string | string[]> | undefined {
  if (!params || params.length === 0) return undefined;
  const out: Record<string, string | string[]> = {};
  for (const kv of params) {
    const eq = kv.indexOf("=");
    if (eq <= 0) throw new Error(`Invalid --param '${kv}', expected key=value.`);
    const key = kv.slice(0, eq);
    const val = kv.slice(eq + 1);
    const existing = out[key];
    if (existing === undefined) {
      out[key] = val;
    } else if (Array.isArray(existing)) {
      existing.push(val);
    } else {
      out[key] = [existing, val];
    }
  }
  return out;
}

async function callPlayApiRoute(
  appId: string,
  payload: {
    method: string;
    path: string;
    query?: Record<string, string | string[]>;
    body?: unknown;
    note?: string;
  },
): Promise<PlayApiProxyResponse> {
  try {
    return await apiRequest<PlayApiProxyResponse>(
      `/api/apps/${appId}/distributions/play/api`,
      {
        method: "POST",
        body: payload,
        retryOnUnauthorized: false,
      },
    );
  } catch (error) {
    const body = error instanceof QuiverApiError ? (error.body as { error?: Record<string, unknown> } | null) : null;
    const nested = body && typeof body === "object" && body.error && typeof body.error === "object" ? body.error : null;
    if (error instanceof QuiverApiError && nested) {
      const code = typeof nested.failure_code === "string" ? nested.failure_code : nested.code;
      const receipt = typeof nested.receipt_id === "string" ? ` (receipt ${nested.receipt_id})` : "";
      throw new QuiverApiError(error.status, { ...nested, code }, `${String(nested.message ?? error.message)}${receipt}`);
    }
    throw error;
  }
}

export function registerPlayCommands(program: Command): void {
  const play = program
    .command("play")
    .description("Google Play operations through Hands (server-side credentials, RBAC, locks, and receipts).");

  play
    .command("api <appIdOrSlug> <method> <path>")
    .description(
      "Call a Google Play Android Publisher v3 endpoint for <appIdOrSlug> using the app's stored credentials. " +
        "<path> is relative to /androidpublisher/v3/applications/{packageName}/ (e.g. edits, edits/<id>/tracks/production, reviews, monetization/subscriptions).",
    )
    .option("--input <file>", "Read JSON request body from <file> (use - for stdin).")
    .option("--data <json|@file>", "Inline JSON request body, or @file to read from a file.")
    .option("-F, --field <key=value...>", "Add a typed JSON body field (booleans, numbers, JSON objects/arrays, or strings).")
    .option("-f, --raw-field <key=value...>", "Add a string JSON body field.")
    .option("-q, --param <key=value...>", "Query parameter key=value (repeatable).")
    .option("--note <note>", "Audit/receipt note for mutating calls.")
    .option("--envelope", "Print the full Hands proxy envelope (receipt_id, operation_id, path, status, data).", false)
    .option("--json", "Print JSON output.", false)
    .action(
      async (
        appIdOrSlug: string,
        methodArg: string,
        pathArg: string,
        opts: {
          input?: string;
          data?: string;
          field?: string[];
          rawField?: string[];
          param?: string[];
          note?: string;
          envelope?: boolean;
          json?: boolean;
        },
      ) => {
        const method = methodArg.trim().toUpperCase();
        if (!METHODS.has(method)) {
          throw new Error(`Unsupported method '${methodArg}'. Use one of: ${[...METHODS].join(", ")}.`);
        }
        const body = await resolvePlayApiBody(opts);
        if (method === "GET" && body !== undefined) {
          throw new Error("GET requests cannot include a request body (--input, --data, --field).");
        }
        const query = parseQueryParams(opts.param);
        const appId = await resolveAppId(appIdOrSlug);
        const res = await callPlayApiRoute(appId, {
          method,
          path: pathArg,
          ...(query ? { query } : {}),
          ...(body !== undefined ? { body } : {}),
          ...(opts.note ? { note: opts.note } : {}),
        });

        const wantJson = jsonRequested(program, opts.json);
        if (opts.envelope) {
          console.log(JSON.stringify(res, null, 2));
          return;
        }
        if (!wantJson && res.receipt_id) {
          console.error(`${res.method} ${res.path} -> ${res.status} (receipt ${res.receipt_id})`);
        }
        console.log(JSON.stringify(res.data ?? null, null, 2));
      },
    );
}
