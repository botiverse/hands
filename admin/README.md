# @oranix/quiver-admin

SPA assets for quiver admin, served by the Cloudflare Worker.

Production admin access is Login with Raft only. The Worker owns the OAuth
callback and sets an HttpOnly same-origin session cookie; this package does
not receive Raft codes, access tokens, client secrets, or API bearer tokens.

Stack: Vite + React + Tailwind + TanStack Query.
