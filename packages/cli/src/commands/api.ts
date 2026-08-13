/**
 * `hands api <method> <path>` — direct authenticated call to a Hands API
 * endpoint. A power-user / scripting affordance over the SAME server-enforced
 * RBAC + audit + per-endpoint guards. It is NOT a permission bypass and NOT a
 * generic-SQL escape hatch: every write still hits the same server route that a
 * dedicated subcommand would.
 *
 * Security (reviewed with Sentinel — credential/origin boundary):
 *  - Same-origin `/api/*` only. The path is resolved against the configured
 *    Hands API base; the result must keep that exact origin AND its path must
 *    start with `/api/`. This rejects absolute URLs, `//protocol-relative`
 *    hosts, and `../` traversal that escapes the origin — any of which would
 *    otherwise carry the Authorization bearer to another host.
 *  - `redirect: "manual"` — a 3xx is reported, never auto-followed. Following a
 *    redirect off-origin would leak the bearer to the redirect target.
 *  - Reuses the existing CLI identity/token; no scope escalation.
 */

import type { Command } from "commander";
import { readFile, writeFile } from "node:fs/promises";
import { resolveApiBase, resolveAuthToken } from "../lib/config.js";

const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"]);

/**
 * Resolve `pathArg` against the Hands API base and enforce that it is a
 * same-origin `/api/*` request. Throws if the resolved URL would leave the
 * Hands origin or is not under `/api/`. Exported for unit tests.
 */
export function resolveSameOriginApiUrl(pathArg: string, apiBase: string): URL {
  const base = new URL(apiBase);
  let target: URL;
  try {
    target = new URL(pathArg, base);
  } catch {
    throw new Error(`Invalid path '${pathArg}'.`);
  }
  if (target.origin !== base.origin) {
    throw new Error(
      `Refusing '${pathArg}': must be a relative Hands path on ${base.origin} ` +
        "(no absolute or //protocol-relative URLs).",
    );
  }
  if (!target.pathname.startsWith("/api/")) {
    throw new Error(`Refusing '${target.pathname}': path must start with /api/.`);
  }
  return target;
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

export function registerApiCommand(program: Command): void {
  program
    .command("api <method> <path>")
    .description(
      "Call a Hands API endpoint directly (same-origin /api/* only). " +
        "Reuses your CLI login; every call still goes through server-side RBAC.",
    )
    .option("--param <kv...>", "Query parameter key=value (repeatable).")
    .option("--data <json|@file>", "JSON request body inline, or @path to read it from a file.")
    .option("--output <file>", "Write the raw response body to a file (required for binary).")
    .option("--json", "Print only the response body (omit the status line).", false)
    .action(
      async (
        methodArg: string,
        pathArg: string,
        opts: { param?: string[]; data?: string; output?: string; json?: boolean },
      ) => {
        const method = methodArg.toUpperCase();
        if (!METHODS.has(method)) {
          fail(`Unsupported method '${methodArg}'. Use one of: ${[...METHODS].join(", ")}.`);
        }

        let target: URL;
        try {
          target = resolveSameOriginApiUrl(pathArg, resolveApiBase());
        } catch (e) {
          fail(e instanceof Error ? e.message : String(e));
        }

        for (const kv of opts.param ?? []) {
          const eq = kv.indexOf("=");
          if (eq <= 0) fail(`Invalid --param '${kv}', expected key=value.`);
          target.searchParams.append(kv.slice(0, eq), kv.slice(eq + 1));
        }

        let body: string | undefined;
        if (opts.data !== undefined) {
          body = opts.data.startsWith("@")
            ? await readFile(opts.data.slice(1), "utf8")
            : opts.data;
        }

        const headers: Record<string, string> = { accept: "application/json" };
        const token = resolveAuthToken();
        if (token) headers.authorization = `Bearer ${token}`;
        if (body !== undefined) headers["content-type"] = "application/json";

        const res = await fetch(target.toString(), {
          method,
          headers,
          ...(body !== undefined ? { body } : {}),
          // Never auto-follow a 3xx: a redirect off the API origin would carry
          // the bearer token to the redirect target.
          redirect: "manual",
        });

        const requestId = res.headers.get("x-request-id") ?? res.headers.get("cf-ray");
        const statusLine = `${res.status} ${res.statusText}${
          requestId ? `  request-id=${requestId}` : ""
        }`;

        if (res.status >= 300 && res.status < 400) {
          console.error(
            `${statusLine}\nRedirect to ${res.headers.get("location") ?? "(none)"} not followed ` +
              "(hands api never follows redirects off the API origin).",
          );
          process.exit(1);
        }

        if (opts.output) {
          const bytes = Buffer.from(await res.arrayBuffer());
          await writeFile(opts.output, bytes);
          console.error(`${statusLine}  → ${opts.output} (${bytes.length} bytes)`);
          if (res.status >= 400) process.exit(1);
          return;
        }

        const text = await res.text();
        if (opts.json) {
          if (text.length > 0) console.log(text);
        } else {
          console.error(statusLine);
          if (text.length > 0) console.log(text);
        }
        if (res.status >= 400) process.exit(1);
      },
    );
}
