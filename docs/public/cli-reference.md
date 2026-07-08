# CLI Reference

`@oranix/quiver-cli` is the command-line client for Quiver. Use it from local scripts or CI to inspect apps, upload Android builds, and publish releases.

## Install

Install it globally:

```bash
npm install -g @oranix/quiver-cli
```

Or run it without a permanent install:

```bash
npm exec --package @oranix/quiver-cli@0.3.2 -- quiver --help
```

In CI, pin a version so release scripts stay reproducible.

## Authentication

The CLI reads a Quiver API server and bearer token from environment variables:

```bash
export QUIVER_SERVER=https://quiver.oranix.io
export QUIVER_BEARER_TOKEN=<deploy-token>
```

`QUIVER_AUTH_TOKEN` is also accepted as an alias for `QUIVER_BEARER_TOKEN`.

Use app-scoped deploy tokens for CI. Mint them with `quiver deploy-tokens create` (below) or in the app's Access page, choose the minimum role required, and store the raw token in your CI secret store.

## Deploy Tokens

App-scoped tokens for CI to publish (`publisher`) or read (`viewer`). Managing them requires **app admin**; if you lack it, the CLI prints an actionable error (which role you need, who can grant it, and that an admin can do it for you).

```bash
# Mint a publisher token for CI (printed ONCE — capture it immediately)
quiver deploy-tokens create raft-android --name github-ci --role publisher

# Optional expiry, and machine-readable output for scripting
quiver deploy-tokens create raft-android --name github-ci --expires-in-days 90 --json

# List an app's tokens (metadata only, never the secret)
quiver deploy-tokens list raft-android

# Revoke by id
quiver deploy-tokens revoke raft-android <tokenId>
```

The created token is what you set as `QUIVER_BEARER_TOKEN` in CI. The server stores only a hash, so a lost token can only be revoked and re-minted, never recovered.

## Basic Commands

Show the installed version:

```bash
quiver version
```

List apps visible to the current token:

```bash
quiver apps list
```

List builds for an app:

```bash
quiver builds list raft-android
```

## Publish Android

Use `builds publish-android` to upload an APK and create a release. Per the
release policy, CI should pass `--draft` so a human or agent reviews the
changelog before the release goes live.

```bash
quiver builds publish-android raft-android \
  --apk ./androidApp-release.apk \
  --channel preview \
  --version-name 1.0.0 \
  --version-code 1000000 \
  --changelog-file ./changelog.txt \
  --draft
```

Package id, SDK levels, and the launcher icon are extracted from the APK
automatically on the server — no extra flags needed.

Add support artifacts when available:

```bash
quiver builds publish-android raft-android \
  --apk ./androidApp-release.apk \
  --mapping ./mapping.txt \
  --symbols ./native-symbols.zip \
  --metadata ./metadata.json \
  --channel preview \
  --version-name 1.0.0 \
  --version-code 1000000
```

Public update checks only use the installable artifact. Mapping files, native symbols, and metadata stay available through authenticated admin APIs.

## Publish Electron (generic provider)

Quiver can host Electron apps that use `electron-updater` with the generic
provider:

```ts
autoUpdater.setFeedURL({
  provider: "generic",
  url: "https://quiver.oranix.io/electron/raft-desktop/main"
});
```

Quiver hosts electron-builder output **as-is**. Use
`builds publish-electron` to upload the files from `dist/` as build assets on
an `electron-installer` build/release, then create a draft release for review:

```bash
quiver builds publish-electron raft-desktop \
  --channel main \
  --version-name 1.2.3 \
  --version-code 10203 \
  --platform win32 \
  --arch x64 \
  --metadata dist/latest.yml \
  --installer "dist/Raft Setup 1.2.3.exe" \
  --blockmap "dist/Raft Setup 1.2.3.exe.blockmap" \
  --changelog-file ./changelog.txt \
  --draft
```

`--metadata`, `--installer`, and `--blockmap` are repeatable. For multi-platform
Electron apps, run the command once per platform/channel so each release has a
clear `platform`/`arch` pair. The command preserves original filenames through
`variant` and `metadata_json.filename`, which lets relative URLs inside
`latest*.yml` resolve unchanged.

Required files depend on target OS:

| Target | Required files |
|---|---|
| Windows NSIS | `latest.yml`, installer `.exe`, optional `.exe.blockmap` |
| macOS | `latest-mac.yml`, signed `.zip` for auto-update, optional `.dmg` for downloads, `.blockmap` files if generated |
| Linux | `latest-linux.yml`, `AppImage` or other configured target, `.blockmap` files if generated |

CI systems that need custom orchestration can also call the build, asset, and
release APIs directly. Register the original filenames using the same fields:

| File | `platform` | `arch` | `filetype` | `artifact_kind` | Filename field |
|---|---|---|---|---|---|
| `latest.yml` | `win32` | `x64` or null | `yml` | `electron-metadata` | `variant` or `metadata_json.filename` |
| `latest-mac.yml` | `darwin` | `arm64` or `x64` | `yml` | `electron-metadata` | `variant` or `metadata_json.filename` |
| `latest-linux.yml` | `linux` | `x64` or `arm64` | `yml` | `electron-metadata` | `variant` or `metadata_json.filename` |
| `Raft Setup 1.2.3.exe` | `win32` | `x64` | `exe` | `installable` | `metadata_json.filename` |
| `Raft Setup 1.2.3.exe.blockmap` | `win32` | `x64` | `blockmap` | `electron-blockmap` | `metadata_json.filename` |

Keep the same draft-first policy as Android: CI creates a draft Electron
release, then a human or agent reviews release notes and explicitly publishes.
macOS update artifacts must be signed before upload; Quiver hosts the signed
files but does not sign Electron applications.

## Review and Publish (draft flow)

CI creates drafts; publishing is an explicit step after changelog review:

```bash
# inspect the draft (status, rollout, changelog)
quiver releases show raft-android <release-id>

# write the reviewed changelog; repeatable [lang=]file entries
quiver releases update raft-android <release-id> \
  --changelog-file zh=changelog.zh.md \
  --changelog-file en=changelog.en.md

# make it live
quiver releases publish raft-android <release-id>
```

Bilingual changelogs are stored per language; clients receive the language
matching their locale (`zh` normalizes to `zh-CN`; plain single-value
changelogs are served as-is).

## Share Links

```bash
quiver releases share raft-android <release-id> --password <pw>   # password optional
quiver releases shares raft-android <release-id>                   # list
quiver releases update-share raft-android <release-id> <share-id> --ttl-seconds 1209600
quiver releases revoke-share raft-android <release-id> <share-id>
```

`--password` can also come from `QUIVER_SHARE_PASSWORD` to keep it out of
shell history. Share URLs are printed once at creation; tokens are stored
hashed.

## Feedback Tickets

Agents can triage feedback and crash tickets entirely from the CLI (viewer
role for read, publisher for changes):

```bash
quiver feedback list raft-android --status open --kind crash
quiver feedback show raft-android <ticket-id>
quiver feedback update raft-android <ticket-id> --status in_progress --assignee cc-quiver-owner
quiver feedback comment raft-android <ticket-id> "已复现，修复中"
quiver feedback update raft-android <ticket-id> --status resolved
```

`--assignee none` unassigns. All subcommands accept `--json` for scripting.

## CI Environment Variables

| Variable | Required | Purpose |
|---|---|---|
| `QUIVER_SERVER` | No | Quiver server URL. Defaults to `https://quiver.oranix.io` in most scripts. |
| `QUIVER_BEARER_TOKEN` | Yes | App-scoped deploy token for CI. |
| `QUIVER_AUTH_TOKEN` | No | Alias for `QUIVER_BEARER_TOKEN`. |
| `QUIVER_API_TIMEOUT_MS` | No | Request timeout in milliseconds. |
| `QUIVER_RETRIES` | No | Retry count for transient server errors. |

## Versioning Guidance

For Android releases, keep APK `versionCode` and Quiver `version_code` identical. Clients only update when the server release has a higher version code than the installed app.

One common scheme is:

```text
versionCode = major * 1_000_000 + minor * 10_000 + patch * 100 + build
versionName = major.minor.patch[-suffix]
```

Example: `1.0.3-rc2` becomes `versionName=1.0.3-rc2` and `versionCode=1000302`.

## Security

Do not paste deploy tokens, package tokens, signing passwords, or keystore data into public chat, issue comments, logs, or release notes. Store them in the CI secret store and pass them to Quiver through environment variables.
