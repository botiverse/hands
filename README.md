# Quiver

**Ship it, roll it out, hear it break, fix it — one platform for mobile release operations.**

Quiver runs the whole release loop: CI lands builds as drafts, agents review and publish with bilingual changelogs, staged rollouts meter exposure by device cohort, share pages handle ad-hoc distribution, and in-app feedback and crash reports come back as tickets — grouped by signature, auto-deobfuscated, and triageable by humans and AI agents through the same API. Reporting SDKs cover Android and HarmonyOS today (iOS next) — fully Cloudflare-native (Workers + Container + D1 + R2).

- **Live instance:** <https://quiver.oranix.io>
- **Docs:** <https://quiver.oranix.io/docs> · [Admin guide](https://quiver.oranix.io/docs/admin-user-guide/) · [CLI reference](https://quiver.oranix.io/docs/cli-reference/)
- **API explorer:** <https://quiver.oranix.io/api-docs>
- **CLI on npm:** [`@oranix/quiver-cli`](https://www.npmjs.com/package/@oranix/quiver-cli)

The "quiver" metaphor: admins load APK arrows into channels; clients pick the right one for their channel — and tell you where it landed.

## Features

- **Channels** — keep main, preview, nightly, or debug releases separated by app. Publish to `main` for stable users, `preview` for validation, `nightly` for fast internal iteration.
- **Update checks & staged rollouts** — public latest/update responses with signed APK downloads, percentage rollouts bucketed by stable device id, and per-language changelogs; the Android SDK (`clients/android`) handles in-app checks, installation, and feedback and crash submission; a HarmonyOS (ArkTS) reporting layer mirrors it.
- **Share pages & version history** — revocable, expiring, optionally password-protected download pages with QR codes and view/download stats, plus an opt-in public version history page per app.
- **Feedback tickets** — in-app feedback (attachments, device context) lands in a built-in ticket system with assignees, statuses, comments, and webhooks; submissions are authenticated with a per-app client key.
- **Crash reporting** — store-then-send crash capture on Android and HarmonyOS uploads on next launch, groups by signature, and auto-retraces stacks against uploaded R8/ProGuard mappings.
- **Draft-first releases** — CI creates draft releases with generated changelogs; an agent reviews, writes bilingual notes, and publishes explicitly (`docs/release-runbook.md`).
- **Raft access** — Login with Raft, org roles, direct app members, per-server visibility grants, and app-level deploy tokens for CI and agents.
- **CI-friendly publishing** — the public npm CLI publishes Android releases and creates share links from GitHub Actions, local packaging lanes, or Raft agents:

```sh
$ npm exec --package @oranix/quiver-cli -- quiver builds publish-android raft-android
uploading APK and metadata...
creating release on channel main...
release: 14998dba-cfde-4002-8c01-230a2760f662
share: https://quiver.oranix.io/share/...
```

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

## Repository layout

- `worker/` — Cloudflare Worker (Hono) — admin SPA, API routes, Login with Raft, D1 CRUD, R2 signed URLs
- `admin/` — admin SPA and public landing (React + Vite + Tailwind) served by the Worker
- `container/` — Cloudflare Container — APK metadata parser (aapt + apksigner)
- `packages/cli/` — `@oranix/quiver-cli` npm package
- `clients/android/` — Quiver Android Updater SDK (update checks + APK install)
- `docs/` — admin user guide, CLI reference, public API reference, architecture notes
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

See [CONTRIBUTING.md](CONTRIBUTING.md) for the worktree workflow and merge rules.

## Release automation

GitHub Actions owns production publishing so local machines do not need long-lived npm or Cloudflare credentials.

Required repository secrets:

- `CLOUDFLARE_API_TOKEN` — Cloudflare API token allowed to deploy the Quiver Worker and its assets.
- `CLOUDFLARE_ACCOUNT_ID` — Cloudflare account id for the Worker deploy.

Workflows:

- `Publish CLI` publishes `@oranix/quiver-cli` to npm through npm Trusted Publishing / GitHub OIDC. Configure the npm package trusted publisher for this repository and workflow, then trigger it manually with the package version from `packages/cli/package.json`, or push a tag like `cli-v0.1.2`.
- `Deploy Quiver Server` deploys the Worker plus bundled admin/docs assets. Trigger it manually, or push a tag like `server-v2026.07.04`. The default container rollout is `none`; choose `immediate` or `gradual` only when the APK parser container image changed.

## Credits

Reference feature set inspired by [Zealot (tryzealot/zealot)](https://github.com/tryzealot/zealot).
