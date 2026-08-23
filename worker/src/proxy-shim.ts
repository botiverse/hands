/**
 * Legacy proxy shim for `quiver-worker`.
 *
 * After the Hands migration, the legacy domain no longer runs the business
 * worker — all business logic, D1, and R2 live on the Hands worker
 * (the configured business origin). This shim is the ONLY thing `quiver-worker` deploys going
 * forward. It exists purely to keep the legacy domain working for two very
 * different classes of traffic:
 *
 *   1. Machine / API paths (installed apps + CI): transparently
 *      reverse-proxied to the Hands worker, preserving method, body, query,
 *      and headers. Existing shipped apps POST feedback / crash / metrics and
 *      GET update-checks against the legacy `/public/*` routes; a 302 here would
 *      drop the POST body/headers (multipart), so these MUST be proxied, never
 *      redirected. Writes land in the Hands DB via the proxy — single source
 *      of truth, no divergence.
 *
 *   2. Human pages (browsers): 302-redirected to the configured business origin
 *      on the canonical new domain.
 *
 * The shim holds NO D1 / R2 / Container bindings and never touches the legacy
 * database. See `wrangler.jsonc` (name `quiver-worker`) for the stripped-down
 * config that deploys this file.
 */

export interface ShimEnv {
  /**
   * Origin serving the Hands business worker, no trailing slash. Points at the
   * worker's direct `workers.dev` route to skip the edge
   * cache and avoid any custom-domain loop, e.g.
   * a configured direct Worker origin.
   */
  PROXY_TARGET: string;
  /**
   * Origin humans are 302-redirected to, no trailing slash, e.g.
   * the configured business origin.
   */
  REDIRECT_TARGET: string;
}

/**
 * Machine / API paths that must be reverse-proxied (never redirected) because
 * they carry POST bodies, machine downloads, or the admin/auth API. Mirrors the
 * real route table in `src/index.ts`.
 */
function isMachinePath(pathname: string): boolean {
  if (
    pathname.startsWith("/public/") || // update-check, feedback/minidump/metrics POST, r2, icon
    pathname.startsWith("/api/") || // auth + admin API
    pathname.startsWith("/electron/") || // electron-updater asset fetches
    pathname.startsWith("/tauri/") || // Tauri updater manifests + artifacts
    pathname.startsWith("/.well-known/") // agent manifests
  ) {
    return true;
  }
  if (
    pathname === "/health" ||
    pathname === "/openapi.json" ||
    pathname === "/login/raft/callback"
  ) {
    return true;
  }
  // Public app pages and their downloads are origin routes. The bare
  // `/apps/:slug` client-side admin route remains a human dashboard route.
  if (
    pathname.startsWith("/apps/") &&
    (pathname.includes("/history") || pathname.includes("/latest"))
  ) {
    return true;
  }
  // `/share/:token` is a human page (redirect). Its sub-resources
  // `/share/:token/{download,unlock,icon}` are machine endpoints (proxy).
  if (pathname.startsWith("/share/")) {
    return pathname.slice("/share/".length).includes("/");
  }
  return false;
}

/**
 * Reverse-proxy the request to PROXY_TARGET, preserving method, body (streamed,
 * not buffered — feedback attachments / dSYM uploads can reach 200MB), query,
 * and headers. `redirect: "manual"` passes the origin's own 3xx (e.g. presigned
 * R2 download redirects) straight through instead of following them.
 */
async function proxy(request: Request, url: URL, env: ShimEnv): Promise<Response> {
  const target = new URL(env.PROXY_TARGET);
  const proxied = new URL(url.pathname + url.search, target);

  const headers = new Headers(request.headers);
  // Let fetch derive Host from the target URL; the Hands worker routes by path,
  // not Host, so rewriting it is safe and correct for workers.dev routing.
  headers.delete("host");
  // Record the original edge hostname for the origin's logs / audit trail.
  headers.set("x-forwarded-host", url.host);
  headers.set("x-forwarded-proto", url.protocol.replace(/:$/, ""));

  const init: RequestInit & { duplex?: "half" } = {
    method: request.method,
    headers,
    body: request.body,
    redirect: "manual",
  };
  // Streaming a request body requires duplex: "half" (undici / Workers runtime).
  // GET/HEAD have a null body, so this is only set for POST/PUT/PATCH.
  if (request.body) {
    init.duplex = "half";
  }

  const resp = await fetch(proxied, init);

  // Return the origin response as-is — status, headers, streamed body.
  return new Response(resp.body, {
    status: resp.status,
    statusText: resp.statusText,
    headers: resp.headers,
  });
}

export default {
  async fetch(request: Request, env: ShimEnv): Promise<Response> {
    const url = new URL(request.url);
    const isGetOrHead = request.method === "GET" || request.method === "HEAD";

    // Machine/API paths — and any non-GET (a 302 would drop the body) — proxy.
    if (isMachinePath(url.pathname) || !isGetOrHead) {
      return proxy(request, url, env);
    }

    // Human page — 302 to the canonical new domain, preserving path + query.
    const location = env.REDIRECT_TARGET + url.pathname + url.search;
    return new Response(null, { status: 302, headers: { Location: location } });
  },
};

// Exported for unit tests.
export { isMachinePath };
