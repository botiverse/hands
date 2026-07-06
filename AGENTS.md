# Quiver Agent Guide

This is the first-page guide for agents working in the Quiver repository.
Quiver manages APK uploads, release channels, public update checks, share
pages, and Raft-based access control on Cloudflare Workers, Containers, D1, and
R2.

## Start Here

1. Read this file and `CONTRIBUTING.md`.
2. On a new machine, verify GitHub CLI and git SSH access before cloning,
   creating worktrees, or pushing branches.
3. Check the task thread that brought you here, then claim the task before
   doing any work.
4. Create or reuse an isolated worktree for code changes.
5. Report progress in the task thread, not as a new root message.

## New Machine GitHub Setup

Check GitHub CLI:

```bash
gh auth status
```

If it is not logged in, use the normal GitHub CLI flow:

```bash
gh auth login
```

Prefer SSH for git operations. Confirm SSH access:

```bash
ssh -T git@github.com
```

Expected result is GitHub accepting the key and saying shell access is not
provided. If SSH fails, create or register a key before cloning/pushing:

```bash
ssh-keygen -t ed25519 -C "<your-email-or-agent>@mail.build"
eval "$(ssh-agent -s)"
ssh-add ~/.ssh/id_ed25519
gh ssh-key add ~/.ssh/id_ed25519.pub --title "$(hostname)-quiver"
ssh -T git@github.com
```

Do not paste SSH private keys, GitHub tokens, `NPM_TOKEN`,
`CLOUDFLARE_API_TOKEN`, Quiver deploy tokens, Raft client secrets, session
cookies, or other credentials into public Raft channels.

## Repository Map

| Purpose | Local path / package | Notes |
| --- | --- | --- |
| Quiver canonical checkout | `/Users/artin/0Workspace/github.com/oranix-io/quiver` | `github.com/oranix-io/quiver` |
| Worker | `worker/` | Hono Worker, API routes, Login with Raft, D1/R2 access |
| Admin UI | `admin/` | React + Vite + Tailwind admin SPA and docs shell |
| APK parser container | `container/` | Cloudflare Container using `aapt` / `apksigner` |
| CLI package | `packages/cli/` | `@oranix/quiver-cli` |
| Android updater SDK | `clients/android/` | Update checks and APK installation |
| Docs | `docs/` | Admin guide, CLI reference, API reference, architecture notes |
| Migrations | `migrations/` | D1 SQL schema migrations |

## Workflow Rules

- Always use worktrees for coding work. Do not create new commits directly on
  the canonical `main` checkout.
- Do not push remote `main` directly. GitHub `main` is protected; finish work
  on a task branch and open a pull request.
- Do not revert or clean unrelated dirty files. If the canonical checkout is
  dirty, inspect carefully and preserve other agents' changes.
- Every meaningful progress or completion report must say whether the work is
  branch/worktree-only, opened as a PR, merged, or not applicable. Include the
  branch, commit, and PR link when they exist.

Create a worktree from the canonical checkout:

```bash
cd /Users/artin/0Workspace/github.com/oranix-io/quiver
git worktree add -b feat/<lane>-<slice> ../quiver-<slice> main
cd ../quiver-<slice>
```

## Build And Validation

Install dependencies from the repo root:

```bash
pnpm install
```

Common checks:

```bash
pnpm -w build
pnpm -w test
pnpm -w lint
```

Focused commands:

```bash
pnpm --filter @oranix/quiver-worker build
pnpm --filter @oranix/quiver-worker test
pnpm --filter @oranix/quiver-admin build
pnpm --filter @oranix/quiver-cli test
```

Local development:

```bash
pnpm --filter @oranix/quiver-worker dev
pnpm --filter @oranix/quiver-admin dev
docker build -t apk-parser container/
```

## Product And Security Rules

- Admin access uses Login with Raft as the production login path. Keep
  `RAFT_CLIENT_SECRET` in Worker secrets, never in browser JavaScript,
  repository files, logs, or public channels.
- Prefer app-scoped deploy tokens for CI and agents instead of reusing human
  browser sessions.
- Public update-check and download endpoints are intentionally unauthenticated;
  admin and publishing APIs require Quiver auth or deploy-token auth.
- Keep APK metadata parsing in the container boundary. Worker routes should call
  the parser service rather than duplicating `aapt` / signing parsing logic.
- D1 migrations are append-only once shared. Do not edit applied migration
  files without explicit owner approval.

## Release Automation

GitHub Actions owns production publishing so local machines do not need
long-lived npm or Cloudflare credentials.

- `Publish CLI` publishes `@oranix/quiver-cli` to npm through npm Trusted
  Publishing / GitHub OIDC.
- `Deploy Quiver Server` applies D1 migrations (`wrangler d1 migrations
  apply quiver-db --remote`) and then deploys the Worker plus bundled
  admin/docs assets. Choose a container rollout mode only when the APK
  parser container changed.

## Release Policy (mobile app releases through Quiver)

**CI never completes a real release.** CI builds, signs, generates a raw
changelog, and creates a **draft** release. A human or agent reviews the
draft, writes the final bilingual changelog, and publishes explicitly.
Follow `docs/release-runbook.md` (`quiver releases show / update /
publish`).

## Docs Layout

- `docs/public/*` is the canonical user-facing documentation, served at
  `/docs` on the production origin. Update it in the same PR as behavior
  changes.
- `docs/public/raft-app-template.md` captures the reusable Raft-native app
  pattern: Login with Raft, Agent Login manifest, generated OpenAPI,
  agent-friendly CLI/docs, auditability, and production-change governance.
  Use it when designing or reviewing new Raft apps that should be operated by
  both humans and agents.
- Top-level `docs/{admin-user-guide,cli-reference,public-api-reference}.md`
  are retired pointer stubs — do not resurrect them.
- `docs/publish-architecture.md`, `docs/publish-tasks.md`, and
  `docs/account-org-invite.md` are frozen historical design docs.

## Querying feedback & crashes as an agent

Quiver is a Login-with-Raft **HTTP API service**, so
`raft integration invoke --service quiver --list-actions` returns none by
design — that is not a bug. To read/triage a ticket: `raft integration login
--service quiver` → `curl` the printed one-time callback URL → export the
`access_token` as `QUIVER_BEARER_TOKEN`, then use `@oranix/quiver-cli`
(`quiver feedback list|show|update|comment <appSlug> [ticketId]`) or the
`/api/apps/:appId/feedback*` REST endpoints. Full walkthrough:
[/docs/agent-cli-feedback/](https://quiver.oranix.io/docs/agent-cli-feedback/).

## First-Day Checklist

- Confirm `gh auth status` works.
- Confirm `ssh -T git@github.com` works.
- Confirm you know the task channel and thread target.
- Run `git status --short --branch` in the repo you will touch.
- Create or reuse a task-specific worktree.
- Run focused validation before reporting.
- Report local-main / remote-main status explicitly.

## Third-party code & licenses

Original implementations only borrow *patterns* from open source (e.g.
sentry-native's inproc handler discipline, KSCrash's dyld image tracking) —
that carries no license obligation. If actual code is ported or vendored:
keep the upstream license header on the file, add a NOTICE entry naming the
project and license (sentry-native/symbolic/rust-minidump: MIT; KSCrash:
MIT-style). Tools exec'd in the container (llvm-symbolizer: Apache-2.0 w/
LLVM exception; binutils readelf: GPL) are separate binaries, not linked
into our code — no copyleft propagation, no action needed.
