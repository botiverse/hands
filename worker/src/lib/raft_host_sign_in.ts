import { appendVaryHeader, createRaftHostAutoSignIn } from "@botiverse/raft-sdk/app";

/**
 * Raft Desktop and Mobile send `Raft-Host: desktop|ios|android` on the page
 * load when someone opens Hands from a Raft App entry. A visitor without a
 * Hands session is then sent straight into Login with Raft, which Raft
 * approves silently once they have agreed before.
 *
 * The console keeps its bearer token in localStorage, so the server cannot see
 * that session. Browser login therefore also sets SIGNED_IN_HINT_COOKIE: it
 * carries no credential and only says "this browser finished a login", with
 * the token's expiry. A stale hint only skips the automatic redirect; the
 * console still shows its normal sign-in screen.
 */
export const SIGNED_IN_HINT_COOKIE = "hands_signed_in";

export const raftHostAutoSignIn = createRaftHostAutoSignIn({
  loginUrl: ({ url }) => `/api/auth/login?return=${encodeURIComponent(`${url.pathname}${url.search}`)}`,
});

export function hasSignedInHint(cookieHeader: string | null | undefined): boolean {
  if (!cookieHeader) return false;
  return cookieHeader
    .split(";")
    .some((part) => part.trim() === `${SIGNED_IN_HINT_COOKIE}=1`);
}

/**
 * Serves a console page, sending Raft-opened visitors without a session to
 * Login with Raft first. Every other request is served as before, with
 * `Vary: Raft-Host` on document responses.
 */
export async function serveConsolePage(
  request: Request,
  serve: (request: Request) => Promise<Response>,
): Promise<Response> {
  const decision = await raftHostAutoSignIn.evaluate(request, {
    isAuthenticated: hasSignedInHint(request.headers.get("cookie")),
  });
  if (decision.action === "redirect") return decision.response();
  const response = await serve(request);
  if (!decision.varyHeader) return response;
  const varied = new Response(response.body, response);
  varied.headers.set("vary", appendVaryHeader(varied.headers.get("vary"), decision.varyHeader));
  return varied;
}

/** Only plain OAuth error codes are echoed back to the console. */
export function oauthErrorCode(raw: string | undefined): string | null {
  if (!raw) return null;
  return /^[a-z_]{1,64}$/.test(raw) ? raw : "server_error";
}
