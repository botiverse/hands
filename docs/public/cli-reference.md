# CLI Reference

`@oranix/quiver-cli` is the command-line client for Quiver. Use it from local scripts or CI to inspect apps, upload Android builds, and publish releases.

## Install

Install it globally:

```bash
npm install -g @oranix/quiver-cli
```

Or run it without a permanent install:

```bash
npm exec --package @oranix/quiver-cli@0.2.1 -- quiver --help
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
