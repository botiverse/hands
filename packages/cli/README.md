# @botiverse/hands-cli

Hands CLI — manage apps, builds, releases from the terminal.

Status: **alpha**. The npm package is public as `@botiverse/hands-cli`; v1 ships
`login`, `logout`, `whoami`, `apps list/get`, `builds list/get`, and
`builds publish-version`, `builds publish-android`, `builds publish-ios`,
`builds publish-ohos`, and `builds publish-electron`. Other commands listed in
`docs/cli-reference.md` land incrementally as backend endpoints become available.
`builds notarize` submits an already Developer-ID-signed macOS artifact through
the app-scoped Hands Apple credentials and fails closed unless Apple's terminal
log digest matches the uploaded bytes.

## Install

```bash
npm install -g @botiverse/hands-cli
hands --help

# Or run without installing globally:
npm exec --package @botiverse/hands-cli@0.5.8 -- hands --help

# Local repo development:
pnpm --filter @botiverse/hands-cli build
pnpm --filter @botiverse/hands-cli start -- whoami
```

## Quickstart

```bash
# 1. Log in. The CLI prints a URL you must open in a browser.
hands login

# 2. Verify who you are.
hands whoami

# 3. List your apps.
hands apps list

# 4. List builds for an app (by slug or id).
hands builds list myapp-android

# Remote Apple notarization; staple/validate remains in this macOS runner.
hands builds notarize raft-desktop --file dist/Raft-1.2.3-arm64.dmg

# 5. Publish an Android APK release.
hands builds publish-android raft-android \
  --channel main \
  --apk ./app-release.apk \
  --version-name 1.0.3 \
  --version-code 1000300
```

For a Node app whose artifacts remain on an external CDN, register one
immutable target declaration at a time:

```bash
hands builds publish-version raft-computer \
  --version 0.72.13 \
  --target darwin-arm64 \
  --source-url https://cdn.raft.build/computer/0.72.13/darwin-arm64 \
  --raw-sha256 "$RAW_SHA256" --raw-size "$RAW_SIZE" \
  --gzip-sha256 "$GZIP_SHA256" --gzip-size "$GZIP_SIZE" \
  --node-version 22.23.1
```

This records external byte evidence; it does not upload the artifact or
activate a release. Repeating the same declaration is idempotent. Changing an
immutable version or target field returns a conflict.

## CI mode

```bash
export HANDS_API=https://hands.build
export HANDS_AUTH_TOKEN=...       # Hands JWT or an app deploy token
hands whoami
hands builds list myapp-android
```

## How auth works (v1)

Raft OAuth uses a browser redirect. Hands converts the successful login into
a signed JWT, so `hands login` asks you to:

1. Open the printed URL in any browser.
2. Sign in with Raft.
3. Copy the JWT shown on the Hands CLI callback page.
4. Paste it back into the CLI.

The JWT is saved to `$XDG_CONFIG_HOME/quiver/auth.json` (mode 0600).
For CI, pass it via `HANDS_AUTH_TOKEN` or `HANDS_BEARER_TOKEN`. The legacy
`QUIVER_*` aliases remain accepted for existing automation.

v2 will swap this for a true headless flow (Raft Device Flow or a
`--token-stdin` service-user mode). See `publish-tasks.md` P3.4.x.

## Local logs

The CLI writes best-effort, redacted JSONL logs under
`$XDG_STATE_HOME/hands/logs` (or `~/.local/state/hands/logs`). Logging failures
never change command output or exit status. Override the directory with
`HANDS_LOG_DIR`.

Create a gzip bundle only when you have a signed, unexpired collect policy and
its Ed25519 public key:

```bash
hands logs collect \
  --policy ./collect-policy.json \
  --public-key ./hands-log-policy-public.pem \
  --output ./hands-logs.json.gz
```

Policy signature, version, expiry, downgrade state, redaction, daily size,
per-collection size, concurrency, and network budgets are enforced locally.
Rejected collection stays fail-closed and writes an audit log without changing
the CLI process exit behavior.
