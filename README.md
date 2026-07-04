# quiver

**Open-Source APK distribution platform** — Cloudflare Native (Workers + Container + D1 + R2).

Reference feature set inspired by [Zealot (tryzealot/zealot)](https://github.com/tryzealot/zealot).

The "quiver" metaphor: admins load APK arrows into channels; clients pick the right one for their channel.

## Architecture

```
┌────────────────────────────────────────────────────────┐
│ User / Admin / CI                                     │
└──────┬──────────────────────────┬─────────────────────┘
       │ upload / list / download │
       ▼                          │
┌────────────────────────────────────────────────────────┐
│ Cloudflare Worker (quiver)                            │
│ - API routes                                           │
│ - Admin SPA static assets                              │
│ - Auth (Login with Raft session cookie)                │
│ - Signed URL issuance for R2                           │
│ - D1 read/write for metadata                           │
└──────┬───────────────────────────┬────────────────────┘
       │ multipart upload          │ parse APK
       ▼                           ▼
┌─────────────────┐         ┌────────────────────────────────┐
│ R2 Bucket       │         │ Cloudflare Container           │
│ (raw APK + icon)│ ◀────── │ (apk-parser)                   │
└─────────────────┘   icon  │ - aapt/apksigner               │
       ▲                   │ - returns metadata + icon      │
       │                   └────────────────────────────────┘
       │                              │
       │                              ▼
       │                     ┌─────────────────┐
       └─────────────────────│ D1 Database     │
                             │ apps/versions/  │
                             │ channels/audit/ │
                             │ raft sessions   │
                             └─────────────────┘
```

## Modules

- `worker/` — Cloudflare Worker (Hono) — admin SPA, API routes, Login with Raft, D1 CRUD, R2 signed URLs
- `container/` — Cloudflare Container — APK metadata parser (aapt + apksigner)
- `admin/` — SPA assets (React + Vite + Tailwind) served by the Worker
- `migrations/` — D1 SQL schema migrations

## Login with Raft

Admin access uses Login with Raft as the only production login path.

Register the app in Raft with callback URL:

```text
https://quiver.oranix.io/login/raft/callback
```

Worker configuration:

- `RAFT_CLIENT_ID` in `worker/wrangler.jsonc`
- `RAFT_CLIENT_SECRET` as a Worker secret (`wrangler secret put RAFT_CLIENT_SECRET`)
- Public URLs and Raft callback URLs are generated from the incoming request origin. Register each public origin that should support login, for example `https://quiver.oranix.io/login/raft/callback`.
- Optional `RAFT_ALLOWED_SERVER_IDS` / `RAFT_ALLOWED_SERVER_SLUGS` can restrict admin login to specific Raft servers

Do not put Raft client secrets in browser JavaScript, repository files, logs, or public channels.

## Quick start

```sh
# install
pnpm install

# local worker dev (D1 + R2 local emulators)
pnpm --filter @oranix/quiver-worker dev

# local admin UI
pnpm --filter @oranix/quiver-admin dev

# local container (Docker required)
docker build -t apk-parser container/
```

## Release automation

GitHub Actions owns production publishing so local machines do not need long-lived npm or Cloudflare credentials.

Required repository secrets:

- `CLOUDFLARE_API_TOKEN` — Cloudflare API token allowed to deploy the Quiver Worker and its assets.
- `CLOUDFLARE_ACCOUNT_ID` — Cloudflare account id for the Worker deploy.

Workflows:

- `Publish CLI` publishes `@oranix/quiver-cli` to npm through npm Trusted Publishing / GitHub OIDC. Configure the npm package trusted publisher for this repository and workflow, then trigger it manually with the package version from `packages/cli/package.json`, or push a tag like `cli-v0.1.2`.
- `Deploy Quiver Server` deploys the Worker plus bundled admin/docs assets. Trigger it manually, or push a tag like `server-v2026.07.04`. The default container rollout is `none`; choose `immediate` or `gradual` only when the APK parser container image changed.

## Status

🚧 Initial scaffold. See `docs/architecture.md` (TODO) for design notes.
