# Hands Agent Guide

This is the first-page guide for agents working in the Hands repository.
Hands manages APK uploads, release channels, public update checks, share
pages, and Raft-based access control on Cloudflare Workers, Containers, D1, and
R2.

## Start Here

1. Read this file and `CONTRIBUTING.md`.
2. Before cloning, creating worktrees, or pushing branches, set up Stamp
   (below). Agents use their own Stamp identity, not the machine's GitHub
   login.
3. Check the task thread that brought you here, then claim the task before
   doing any work.
4. Create or reuse an isolated worktree for code changes.
5. Report progress in the task thread, not as a new root message.

## Git Access Through Stamp

Agents clone, push, open PRs, review and merge through Stamp
(<https://stamp.build/llms.txt>) under their own agent identity. Do not use the
machine's shared `gh` login, a key in `~/.ssh`, or another agent's checkout or
SSH key: a push made with another agent's key is that agent's push.

Setup, once per agent:

```bash
raft integration login --service stamp
npm i -g @botiverse/stamp-cli@latest
stamp login && stamp whoami        # principalType=agent, your own name
```

Get a checkout that pushes through Stamp:

```bash
stamp repo clone botiverse/hands
# or, in an existing clone:
git remote add stamp ssh://git@ssh.stamp.build:443/botiverse/hands.git
stamp repo use .
```

`stamp repo clone` / `repo use` write this agent's SSH key and commit identity
(default `<server-slug>+<handle>@agents.stamp.build`) into that checkout only.
Commit emails are free text; what ties a change to an agent is Stamp's push
receipt and its approval / merge records.

Do not paste SSH private keys, GitHub tokens, `NPM_TOKEN`,
`CLOUDFLARE_API_TOKEN`, Hands deploy tokens, Raft client secrets, session
cookies, or other credentials into public Raft channels.

## Repository Map

| Purpose | Local path / package | Notes |
| --- | --- | --- |
| Your checkout | `stamp repo clone botiverse/hands` | Pushes through Stamp with your own key |
| Worker | `worker/` | Hono Worker, API routes, Login with Raft, D1/R2 access |
| Admin UI | `admin/` | React + Vite + Tailwind admin SPA and docs shell |
| APK parser container | `container/` | Cloudflare Container using `aapt` / `apksigner` |
| CLI package | `packages/cli/` | `@botiverse/hands-cli` |
| Android updater SDK | `clients/android/` | Update checks and APK installation |
| Docs | `docs/` | Admin guide, CLI reference, API reference, architecture notes |
| Migrations | `migrations/` | D1 SQL schema migrations |

## Workflow Rules

- Always use worktrees or a task branch for coding work, created from current
  `origin/main` in your own Stamp checkout. Never push remote `main` directly.
- Do not revert or clean unrelated dirty files. Preserve other agents' changes.
- Push the branch through Stamp, keep the receipt ID it prints, and open the PR
  from it:

  ```bash
  git push origin HEAD:refs/heads/agent/<branch>
  stamp pr create --receipt <ID> --base main --title "..." --body-file PR.md
  ```

  Refer to the PR by its Stamp page
  (`https://stamp.build/github/botiverse/hands/pull/<N>`).
- A reviewer who is not the author reads the exact head and approves it in
  Stamp; that approval is the GO, not a Raft message or PR comment:

  ```bash
  stamp pr review <N> --repo botiverse/hands
  stamp pr approve <N> --repo botiverse/hands --head <HEAD_SHA> --base <BASE_SHA>
  ```

  `--base` is the PR's recorded base SHA (`stamp pr view` prints it). Never
  approve your own PR.
- The author merges through Stamp, now or once approved and ready:

  ```bash
  stamp pr merge <N> --repo botiverse/hands --head <HEAD_SHA> --base <BASE_SHA> --method squash
  stamp pr merge <N> --repo botiverse/hands --head <HEAD_SHA> --base <BASE_SHA> --auto --method squash
  ```

  Do not merge with the GitHub Merge button or `gh pr merge`. A new push voids
  the approval and the auto-merge registration; review, approve and register
  again on the new head.
- Every meaningful progress or completion report names the PR (Stamp link) and
  whether it is open, approved, or merged; if merged, include the merge commit.

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
pnpm --filter @botiverse/hands-worker build
pnpm --filter @botiverse/hands-worker test
pnpm --filter @botiverse/hands-admin build
pnpm --filter @botiverse/hands-cli test
```

Local development:

```bash
pnpm --filter @botiverse/hands-worker dev
pnpm --filter @botiverse/hands-admin dev
docker build -t apk-parser container/
```

## Product And Security Rules

- Admin access uses Login with Raft as the production login path. Keep
  `RAFT_CLIENT_SECRET` in Worker secrets, never in browser JavaScript,
  repository files, logs, or public channels.
- Prefer app-scoped deploy tokens for CI and agents instead of reusing human
  browser sessions.
- Public update-check and download endpoints are intentionally unauthenticated;
  admin and publishing APIs require Hands auth or deploy-token auth.
- Keep APK metadata parsing in the container boundary. Worker routes should call
  the parser service rather than duplicating `aapt` / signing parsing logic.
- D1 migrations are append-only once shared. Do not edit applied migration
  files without explicit owner approval.
- Cloudflare Flagship is for product behavior only. Security, credential,
  authorization, audit, rate-limit, and destructive-data controls remain
  deploy-reviewed configuration. See `docs/flagship-policy.md`.

## Release Automation

GitHub Actions owns production publishing so local machines do not need
long-lived npm or Cloudflare credentials.

- `Publish CLI` publishes `@botiverse/hands-cli` to npm through npm Trusted
  Publishing / GitHub OIDC.
- `Deploy Quiver Server` applies D1 migrations (`wrangler d1 migrations
  apply quiver-db --remote`) and then deploys the Worker plus bundled
  admin/docs assets. Choose a container rollout mode only when the APK
  parser container changed.

## Release Policy (mobile app releases through Hands)

**CI never completes a real release.** CI builds, signs, generates a raw
changelog, and creates a **draft** release. A human or agent reviews the
draft, writes the final bilingual changelog, and publishes explicitly.
Follow `docs/release-runbook.md` (`hands releases show / update /
publish`).

## Docs Layout

- `docs/public/*` is the canonical user-facing documentation, served at
  `/docs` on the production origin. Update it in the same PR as behavior
  changes.
- Top-level `docs/{admin-user-guide,cli-reference,public-api-reference}.md`
  are retired pointer stubs — do not resurrect them.
- `docs/publish-architecture.md`, `docs/publish-tasks.md`, and
  `docs/account-org-invite.md` are frozen historical design docs.

## Querying feedback & crashes as an agent

Hands is a Login-with-Raft **HTTP API service**, so
`raft integration invoke --service quiver --list-actions` returns none by
design — that is not a bug. To read/triage a ticket: `raft integration login
--service quiver` → `curl` the printed one-time callback URL → export the
`access_token` as `QUIVER_BEARER_TOKEN`, then use `@botiverse/hands-cli`
(`hands feedback list|show|update|comment <appSlug> [ticketId]`) or the
`/api/apps/:appId/feedback*` REST endpoints. Full walkthrough:
[/docs/agent-cli-feedback/](https://quiver.oranix.io/docs/agent-cli-feedback/).

Quick lookup when someone gives you a Hands feedback id. Newer Hands
feedback references include the full ticket UUID; if you get an older short
id from chat, expand it first:

```bash
# Detail/attachment API routes require the full ticket UUID.
TICKET_ID="$(hands feedback list raft-android --json \
  | python3 -c 'import json,sys; p=sys.argv[1]; print(next(t["id"] for t in json.load(sys.stdin)["tickets"] if t["id"].startswith(p)))' 389d855b)"

# Show message, device context, comments, and attachment ids.
hands feedback show raft-android "$TICKET_ID"

# Logs/diagnostics are ticket attachments. Hands transports and stores them;
# the producing app owns the file layout inside the downloaded archive.
APP_ID="$(hands apps get raft-android --json | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')"
curl -s -H "Authorization: Bearer $QUIVER_BEARER_TOKEN" \
  "https://quiver.oranix.io/api/apps/$APP_ID/feedback/$TICKET_ID/attachments/<attachmentId>" \
  -o diagnostics.zip
```

## First-Day Checklist

- Confirm `stamp whoami` shows your own agent.
- Confirm your checkout pushes through Stamp (`git remote -v` shows
  `ssh.stamp.build`).
- Confirm you know the task channel and thread target.
- Run `git status --short --branch` in the repo you will touch.
- Create or reuse a task-specific worktree.
- Run focused validation before reporting.
- Report PR status (open / approved / merged) explicitly.

## Third-party code & licenses

Original implementations only borrow *patterns* from open source (e.g.
sentry-native's inproc handler discipline, KSCrash's dyld image tracking) —
that carries no license obligation. If actual code is ported or vendored:
keep the upstream license header on the file, add a NOTICE entry naming the
project and license (sentry-native/symbolic/rust-minidump: MIT; KSCrash:
MIT-style). Tools exec'd in the container (llvm-symbolizer: Apache-2.0 w/
LLVM exception; binutils readelf: GPL) are separate binaries, not linked
into our code — no copyleft propagation, no action needed.
