# Hands

**Ship it, roll it out, hear it break, fix it.**

The release platform for client apps, full loop.

Hands runs the whole release loop: CI lands builds as drafts, agents review and publish with bilingual changelogs, staged rollouts meter exposure by device cohort, share pages handle ad-hoc distribution, and in-app feedback and crash reports come back as tickets — grouped by signature, symbolicated, and triageable by humans and AI agents through the same API. Reporting SDKs cover Android, iOS, HarmonyOS, and Electron — fully Cloudflare-native (Workers + Container + D1 + R2).

- **Dashboard:** <https://app.hands.build>
- **Business origin:** <https://hands.build>
- **Docs:** <https://hands.build/docs> · [Admin guide](https://hands.build/docs/admin-user-guide/) · [CLI reference](https://hands.build/docs/cli-reference/)
- **API explorer:** <https://hands.build/api-docs>
- **CLI on npm:** [`@botiverse/hands-cli`](https://www.npmjs.com/package/@botiverse/hands-cli)

The "Hands" metaphor: admins load build arrows into channels; clients pick the right one for their channel — and tell you where it landed.

## Features

- **Channels** — keep main, preview, nightly, or debug releases separated by app. Publish to `main` for stable users, `preview` for validation, `nightly` for fast internal iteration.
- **Update checks & staged rollouts** — public latest/update responses with signed downloads, percentage rollouts bucketed by stable device id, and per-language changelogs; the Android SDK (`clients/android`) handles in-app checks, installation, and feedback/crash submission; iOS, HarmonyOS (ArkTS), and Electron (`@botiverse/hands-electron`) SDKs mirror the feedback and crash lanes.
- **Share pages & version history** — revocable, expiring, optionally password-protected download pages with QR codes and view/download stats, plus an opt-in public version history page per app.
- **Feedback tickets** — in-app feedback (attachments, device context) lands in a built-in ticket system with assignees, statuses, comments, and webhooks; submissions are authenticated with a per-app client key.
- **Crash reporting** — crash capture across Android, iOS, HarmonyOS, and Electron uploads on next launch, groups by signature, and symbolicates stacks server-side against uploaded R8/ProGuard mappings, native symbols, dSYMs, or Breakpad symbols (minidumps).
- **Draft-first releases** — CI creates draft releases with generated changelogs; an agent reviews, writes bilingual notes, and publishes explicitly (`docs/release-runbook.md`).
- **Raft access** — Login with Raft, org roles, direct app members, per-server visibility grants, and app-level deploy tokens for CI and agents.
- **CI-friendly publishing** — the public npm CLI publishes Android releases and creates share links from GitHub Actions, local packaging lanes, or Raft agents:

```sh
$ npm exec --package @botiverse/hands-cli -- hands builds publish-android raft-android
uploading APK and metadata...
creating release on channel main...
release: 14998dba-cfde-4002-8c01-230a2760f662
share: https://hands.build/share/...
```

## Architecture

```
┌────────────────────────────────────────────────────────┐
│ User / Admin / CI                                     │
└──────┬──────────────────────────┬─────────────────────┘
       │ upload / list / download │
       ▼                          │
┌────────────────────────────────────────────────────────┐
│ Cloudflare Worker (Hands)                             │
│ - API routes                                           │
│ - Admin SPA static assets                              │
│ - Auth (Login with Raft + signed Hands JWT)            │
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
- `packages/cli/` — `@botiverse/hands-cli` npm package
- `clients/android/` — Hands Android Updater SDK (update checks + APK install)
- `docs/` — admin user guide, CLI reference, public API reference, architecture notes
- `migrations/` — D1 SQL schema migrations

## Login with Raft

Admin access uses Login with Raft as the only production login path.

Register the app in Raft with callback URL:

```text
https://hands.build/login/raft/callback
```

Worker configuration:

- `RAFT_CLIENT_ID` in `worker/wrangler.jsonc`
- `RAFT_CLIENT_SECRET` as a Worker secret (`wrangler secret put RAFT_CLIENT_SECRET`)
- `app.hands.build` is the canonical dashboard/login origin. `hands.build` remains the business/API origin for SDKs, CLI/agents, share/download pages, release notes, and docs.
- Product links and docs use `app.hands.build` for the dashboard and `hands.build` for business surfaces. Both hostnames continue serving compatible Worker routes during the transition; there is no forced cross-domain redirect.
- Login starts from `app.hands.build`, uses the registered `https://hands.build/login/raft/callback`, then returns a signed Hands JWT to the dashboard in the URL fragment. The SPA stores the JWT locally and sends `Authorization: Bearer`; no browser session cookie is used.
- Optional `RAFT_ALLOWED_SERVER_IDS` / `RAFT_ALLOWED_SERVER_SLUGS` can restrict admin login to specific Raft servers

Do not put Raft client secrets in browser JavaScript, repository files, logs, or public channels.

## Quick start

```sh
# install
pnpm install

# local worker dev (D1 + R2 local emulators)
pnpm --filter @botiverse/hands-worker dev

# local admin UI
pnpm --filter @botiverse/hands-admin dev

# local container (Docker required)
docker build -t apk-parser container/
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the worktree workflow and merge rules.

## Release automation

GitHub Actions owns production publishing so local machines do not need long-lived npm or Cloudflare credentials.

Publishing and deploys read their npm, Cloudflare, and Hands Worker secrets from the repository's GitHub Actions secrets — configured in the repository settings, not documented here.

Workflows:

- `Publish Hands Node SDK` publishes `@botiverse/hands-node` to npm with the repository npm token. Trigger it manually with the package version from `packages/node/package.json`, or push a tag like `node-v0.1.0`.
- `Publish CLI` publishes `@botiverse/hands-cli` with the repository npm token. Publish the package's declared `@botiverse/hands-node` version first; the workflow verifies it exists, packs with pnpm so the workspace range becomes a normal npm semver range, and then publishes the tarball. Trigger it manually with the package version from `packages/cli/package.json`, or push a tag like `cli-v0.5.1`.
- `Deploy Quiver Server` is the legacy compatibility deployment for `quiver.oranix.io`; it no longer owns the Hands dashboard or business data plane.
- `Deploy Hands Server` deploys one Worker/admin bundle to the custom domains `hands.build` (business/API) and `app.hands.build` (dashboard/login) in the separate Hands Cloudflare account. It bootstraps `hands-db` and `hands-artifacts` if they do not exist, applies D1 migrations, and deploys with `worker/wrangler.hands.jsonc`. This workflow is manual-only so it cannot replace the existing Quiver deploy path accidentally.

## Credits

Reference feature set inspired by [Zealot (tryzealot/zealot)](https://github.com/tryzealot/zealot).
