# CLI Reference

`@oranix/quiver-cli` is the command-line client for Quiver. Use it from local scripts or CI to inspect apps, upload Android builds, and publish releases.

## Install

Install it globally:

```bash
npm install -g @oranix/quiver-cli
```

Or run it without a permanent install:

```bash
npm exec --package @oranix/quiver-cli@0.1.0 -- quiver --help
```

In CI, pin a version so release scripts stay reproducible.

## Authentication

The CLI reads a Quiver API server and bearer token from environment variables:

```bash
export QUIVER_SERVER=https://quiver.oranix.io
export QUIVER_BEARER_TOKEN=<deploy-token>
```

`QUIVER_AUTH_TOKEN` is also accepted as an alias for `QUIVER_BEARER_TOKEN`.

Use app-scoped deploy tokens for CI. Create them in the app's Access page, choose the minimum role required, and store the raw token in your CI secret store.

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

Use `builds publish-android` to upload an APK and create or publish a release.

```bash
quiver builds publish-android raft-android \
  --apk ./androidApp-release.apk \
  --channel preview \
  --version-name 1.0.0 \
  --version-code 1000000 \
  --package-name build.raft.app \
  --release-notes "Preview build"
```

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
