import { vi } from "vitest";

/**
 * Shared fake App Store Connect for route tests: records every request (method,
 * path, parsed JSON body, headers) and answers from a handler. An unhandled request
 * is answered with a 599 so a test that forgot a route fails loudly instead of
 * reading an empty 200 as success.
 */
export const ASC = "https://api.appstoreconnect.apple.com";

export interface AscCall {
  method: string;
  url: string;
  /** Path + query relative to the ASC base; the full URL for non-ASC hosts. */
  path: string;
  body: any;
  headers: Record<string, string>;
  rawBody: unknown;
}

export type AscReply = Response | { status?: number; json?: unknown } | undefined;

export function installAscFake(handler: (call: AscCall) => AscReply | Promise<AscReply>) {
  const calls: AscCall[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    let body: unknown = undefined;
    if (typeof init?.body === "string") {
      try { body = JSON.parse(init.body); } catch { body = init.body; }
    }
    const headers: Record<string, string> = {};
    new Headers(init?.headers as HeadersInit | undefined).forEach((value, key) => { headers[key] = value; });
    const call: AscCall = { method, url, path: url.startsWith(ASC) ? url.slice(ASC.length) : url, body, headers, rawBody: init?.body };
    calls.push(call);
    const reply = await handler(call);
    if (reply instanceof Response) return reply;
    if (!reply) {
      return new Response(JSON.stringify({ errors: [{ title: `unmocked ${method} ${call.path}` }] }), { status: 599 });
    }
    const status = reply.status ?? 200;
    return new Response(reply.json === undefined || status === 204 ? null : JSON.stringify(reply.json), { status });
  }));
  return {
    calls,
    /** Requests that would change something at Apple (anything but GET to the ASC API, plus any upload). */
    writes: () => calls.filter((c) => c.method !== "GET"),
  };
}

/** A real P-256 key: ascRequest signs a JWT before every call. */
export async function realCreds() {
  const pair = (await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"],
  )) as CryptoKeyPair;
  const pkcs8 = new Uint8Array((await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer);
  let bin = "";
  for (const b of pkcs8) bin += String.fromCharCode(b);
  return { key_id: "TESTKEY123", issuer_id: "issuer-uuid-1234",
    p8: `-----BEGIN PRIVATE KEY-----\n${btoa(bin)}\n-----END PRIVATE KEY-----` };
}

/**
 * Route context with a statement-aware D1 stub. Audit inserts are captured so tests
 * can assert what was recorded.
 */
export function makeContext(opts: {
  body?: unknown;
  request?: Request;
  params?: Record<string, string>;
}) {
  const audits: Array<{ action: string; payload: any }> = [];
  const db = {
    prepare: (sql: string) => ({
      bind: (...args: unknown[]) => ({
        first: async () => {
          if (/SELECT id FROM apps/i.test(sql)) return { id: "app-1" };
          if (/FROM channels/i.test(sql)) return { bundle_id: "build.raft.app" };
          return null;
        },
        run: async () => {
          if (/INSERT INTO audit_logs/i.test(sql)) {
            audits.push({ action: String(args[2]), payload: JSON.parse(String(args[6])) });
          }
          return { meta: { changes: 1 } };
        },
      }),
    }),
  };
  const params: Record<string, string> = { appId: "app-1", ...(opts.params ?? {}) };
  const raw = opts.request ?? new Request("https://hands.test/x", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(opts.body ?? null),
  });
  const c = {
    env: { DB: db, ASC_CRED_ENC_KEY: "k" },
    req: {
      param: (name: string) => params[name] ?? "",
      query: () => undefined,
      header: (name: string) => raw.headers.get(name) ?? undefined,
      json: async () => (opts.body !== undefined ? opts.body : raw.clone().json()),
      raw,
    },
    get: () => undefined,
    json: (data: unknown, status = 200) => new Response(JSON.stringify(data), { status }),
  } as any;
  return { c, audits };
}

/**
 * Minimal PNG: signature, IHDR, a tEXt chunk carrying `seed` (so equal-size images
 * have different bytes and checksums), IEND. sniffImage reads only these headers.
 */
export function png(width: number, height: number, opts: { alpha?: boolean; seed?: string } = {}): Uint8Array {
  const chunk = (type: string, data: number[]) => {
    const len = data.length;
    return [(len >>> 24) & 255, (len >>> 16) & 255, (len >>> 8) & 255, len & 255,
      ...[...type].map((ch) => ch.charCodeAt(0)), ...data, 0, 0, 0, 0];
  };
  const u32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
  const ihdr = [...u32(width), ...u32(height), 8, opts.alpha ? 6 : 2, 0, 0, 0];
  const text = [...new TextEncoder().encode(`seed\0${opts.seed ?? `${width}x${height}`}`)];
  return new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ...chunk("IHDR", ihdr),
    ...chunk("tEXt", text),
    ...chunk("IEND", []),
  ]);
}
