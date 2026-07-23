# CLI Reference

`@botiverse/hands-cli` is the command-line client for Hands. Use it from local scripts or CI to inspect apps, upload Android builds, and publish releases.

## Install

Install it globally:

```bash
npm install -g @botiverse/hands-cli
```

Or run it without a permanent install:

```bash
npm exec --package @botiverse/hands-cli@0.5.12 -- hands --help
```

In CI, pin a version so release scripts stay reproducible.

## Authentication

The CLI reads a Hands API server and bearer token from environment variables:

```bash
export HANDS_API=https://hands.build
export HANDS_BEARER_TOKEN=<deploy-token>
```

If `HANDS_API` is unset, the CLI defaults to `https://hands.build`.
`HANDS_AUTH_TOKEN` is also accepted as an alias for `HANDS_BEARER_TOKEN`.

Legacy `QUIVER_*` names still work: every variable is read as `HANDS_<name>`
first, then `QUIVER_<name>`, so existing CI keeps working unchanged.

Use app-scoped deploy tokens for CI. Mint them with `hands deploy-tokens create`
(below) or in the app's Settings page, choose the minimum role required, and
store the raw token in your CI secret store.

Raft Agent Login sessions are not exported to this CLI. `raft integration login`
authenticates `raft integration invoke`; it does not populate
`HANDS_AUTH_TOKEN`. An admin agent that needs to bootstrap CI should call the
manifest `create-deploy-token` action, write the returned one-time token
directly to the CI secret store, and then let the CLI consume that deploy
token.

## Deploy Tokens

App-scoped tokens for CI to publish (`publisher`) or read (`viewer`). Managing them requires **app admin**; if you lack it, the CLI prints an actionable error (which role you need, who can grant it, and that an admin can do it for you).

```bash
# Mint a publisher token for CI (printed ONCE — capture it immediately)
hands deploy-tokens create raft-android --name github-ci --role publisher

# Optional expiry, and machine-readable output for scripting
hands deploy-tokens create raft-android --name github-ci --expires-in-days 90 --json

# List an app's tokens (metadata only, never the secret)
hands deploy-tokens list raft-android

# Revoke by id
hands deploy-tokens revoke raft-android <tokenId>
```

The created token is what you set as `HANDS_BEARER_TOKEN` in CI. The server stores only a hash, so a lost token can only be revoked and re-minted, never recovered.

## Basic Commands

Show the installed version:

```bash
hands version
```

Create an app in the current Hands organization (requires org member or higher):

```bash
hands apps create \
  --slug hands-example-web \
  --name "Hands Example Web" \
  --platform web \
  --description "Hands web app example"
```

List apps visible to the current token:

```bash
hands apps list
```

Read the app's public SDK client key explicitly (requires app admin; this does
not rotate the key or return any deploy token):

```bash
hands apps client-key hands-example-web
```

List builds for an app:

```bash
hands builds list raft-android
```

## Register External Node / CLI Bytes

For an app created with platform `node`, `builds publish-version` records one
externally hosted target without copying it into Hands storage:

```bash
hands builds publish-version raft-computer \
  --version-name 0.72.13 \
  --target linux-x64 \
  --source-url https://cdn.raft.build/computer/0.72.13/linux-x64 \
  --raw-sha256 "$RAW_SHA256" --raw-size "$RAW_SIZE" \
  --gzip-sha256 "$GZIP_SHA256" --gzip-size "$GZIP_SIZE" \
  --node-version 22.23.1 \
  --source-commit "$GIT_COMMIT"
```

Run the command once per target. Hands stores the URL, raw/gzip hashes and
sizes, Node version, and provenance under one app/version build. An identical
declaration replays successfully; changing version-level or target-level
immutable fields returns a conflict. This command does not upload bytes or
activate a release/channel pointer.

## Publish Android

Use `builds publish-android` to upload an APK and create a release. Per the
release policy, CI should pass `--draft` so a human or agent reviews the
changelog before the release goes live.

```bash
hands builds publish-android raft-android \
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
hands builds publish-android raft-android \
  --apk ./androidApp-release.apk \
  --mapping ./mapping.txt \
  --symbols ./native-symbols.zip \
  --metadata ./metadata.json \
  --channel preview \
  --version-name 1.0.0 \
  --version-code 1000000
```

Public update checks only use the installable artifact. Mapping files, native symbols, and metadata stay available through authenticated admin APIs.

## Publish iOS / TestFlight

CI should upload the **signed IPA** exported by macOS/Xcode, not an unsigned
intermediate IPA. Hands stores the IPA and dSYM; Apple signing certificates,
profiles, and passwords stay in the CI secret boundary. The separate App Store
Connect API key used for server-side upload/distribution stays encrypted in
Hands and is never copied to CI or an agent.

Use `builds publish-ios` after `xcodebuild archive` and
`xcodebuild -exportArchive`:

```bash
hands builds publish-ios raft-ios \
  --ipa ./build/Raft.ipa \
  --dsym ./build/Raft.dSYM.zip \
  --channel main \
  --version-name 1.0.0 \
  --version-code 1000000 \
  --changelog-file zh=./changelog.zh.md \
  --changelog-file en=./changelog.en.md \
  --source-commit "$GITHUB_SHA" \
  --ci-provider github-actions \
  --ci-run-id "$GITHUB_RUN_ID" \
  --ci-url "$GITHUB_SERVER_URL/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID" \
  --export-method app-store \
  --appstore-build-number 42 \
  --draft
```

`--version-code` **must match the value the app reports**
(`CFBundleVersion`), or iOS crashes will not symbolicate against the right
dSYM. The `--dsym` file is a `.dSYM.zip` of the archive's `*.dSYM` bundles;
without it, iOS crashes for that version show only raw frames.
`--export-method`, `--appstore-build-number`, and `--testflight-status` are
recorded as build metadata. `publish-ios` creates the Hands build/release; it
does not itself upload to Apple or activate TestFlight testing.

An app admin then starts the **server-side upload** through the Hands console,
API, or Raft integration action `upload-testflight-build`. Poll the returned
Apple Build Upload id with `get-testflight-upload-status` until `COMPLETE` or
`FAILED` (`response.state.state`; Apple errors/warnings/infos remain alongside
it). This stage only uploads and processes the binary: it never assigns a beta
group, notifies testers, activates the Hands release, or submits an App Store
production release.

After Apple exposes the exact build as `VALID`, list stable beta group ids:

```bash
hands builds testflight-groups raft-ios <hands-build-id>
```

Distribute to internal testers:

```bash
hands builds testflight-publish raft-ios <hands-build-id> \
  --distribution internal \
  --group-id 11111111-2222-3333-4444-555555555555 \
  --what-to-test en-US="Verify login and Activity." \
  --what-to-test zh-Hans="验证登录和活动页。" \
  --wait
```

External distribution uses the same processed build, but submits TestFlight
Beta App Review. `--notify-testers` enables Apple's automatic notification
after approval; for an already-approved build without auto-notify pending,
Hands sends the official build beta notification immediately.

```bash
hands builds testflight-publish raft-ios <hands-build-id> \
  --distribution external \
  --group-id aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee \
  --what-to-test-file en-US=./testflight.en.txt \
  --what-to-test-file zh-Hans=./testflight.zh.txt \
  --notify-testers
```

External review can take longer than a normal CLI session. Omit `--wait` to
submit and return immediately, then inspect the live state later:

```bash
hands builds testflight-status raft-ios <hands-build-id> \
  --distribution external
```

When `--wait` is useful, tune its bounded poll contract with
`--poll-interval-seconds` and `--timeout-seconds` (defaults: 15 and 3600).
Terminal failure/rejection/expiry states fail the command. External mode
requires an existing or supplied What to Test localization; selected group ids
must all match the requested internal/external mode.

Hands follows Apple's role boundary: uploading the IPA requires Hands app
admin; TestFlight group distribution requires Hands app publisher. The stored
App Store Connect key must have an Apple role permitted for the requested
operation (external testing: Account Holder, Admin, or App Manager; internal
testing also permits Developer or Marketing). Apple limits beta builds to 90
days and permits at most one build of a version in Beta App Review at a time.

Official Apple references:

- [Prerelease Versions and Beta Testers](https://developer.apple.com/documentation/appstoreconnectapi/prerelease-versions-and-beta-testers)
- [Add internal testers](https://developer.apple.com/help/app-store-connect/test-a-beta-version/add-internal-testers/)
- [Invite external testers](https://developer.apple.com/help/app-store-connect/test-a-beta-version/invite-external-testers/)
- [TestFlight overview](https://developer.apple.com/help/app-store-connect/test-a-beta-version/testflight-overview/)

For raw CI drafts, a single `--changelog-file ./changelog.txt` is still valid.
For reviewed notes, prefer repeatable `lang=file` entries such as
`--changelog-file zh=zh.md --changelog-file en=en.md`.

## Publish HarmonyOS / OHOS

Use `builds publish-ohos` after CI has assembled and signed the App Pack. The
command stores both distribution paths on one build: `.app` for AppGallery and
the standalone signed `.hap` for user sideloading.

```bash
hands builds publish-ohos raft-ohos \
  --app ./raft-ohos-1.0.0-1000000.app \
  --hap ./raft-ohos-entry-1.0.0-1000000.hap \
  --symbols ./ohos-symbols-1.0.0-1000000.tar.gz \
  --metadata ./ohos-release-metadata.json \
  --channel main \
  --version-name 1.0.0 \
  --version-code 1000000 \
  --source-commit "$GITHUB_SHA" \
  --ci-provider github-actions \
  --ci-run-id "$GITHUB_RUN_ID" \
  --ci-url "$GITHUB_SERVER_URL/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID" \
  --draft
```

Both `.app` and `.hap` are installable assets with distinct file types and
distribution metadata. Public update consumers can request `filetype=app` or
`filetype=hap`; authenticated build views expose both files individually.
Signing certificates, profiles, P12 files, and passwords remain in CI and are
never uploaded to Hands.

## Publish Electron (generic provider)

Hands can host Electron apps that use `electron-updater` with the generic
provider:

```ts
autoUpdater.setFeedURL({
  provider: "generic",
  url: "https://hands.build/electron/raft-desktop/main"
});
```

Hands hosts electron-builder output **as-is**. Use
`builds publish-electron` to upload the files from `dist/` as build assets on
an `electron-installer` build/release, then create a draft release for review:

```bash
hands builds publish-electron raft-desktop \
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
macOS update artifacts must be signed before upload; Hands hosts the signed
files but does not sign Electron applications.

## Publish Tauri updater artifacts

For a complete setup, target matrix, release behavior, and signing boundary,
start with the [Tauri Updater guide](tauri-updater.md). Tauri v2 applications
can use a Hands channel as a dynamic updater endpoint:

```json
{
  "bundle": { "createUpdaterArtifacts": true },
  "plugins": {
    "updater": {
      "pubkey": "CONTENT FROM PUBLICKEY.PEM",
      "endpoints": [
        "https://hands.build/tauri/my-app/main/{{target}}/{{arch}}/{{current_version}}"
      ]
    }
  }
}
```

Publish the updater bundles and their Tauri-generated signatures together:

```bash
hands builds publish-tauri my-app \
  --version-name 1.2.3 \
  --channel main \
  --bundle target/release/bundle/macos/MyApp.app.tar.gz \
  --signature target/release/bundle/macos/MyApp.app.tar.gz.sig \
  --target darwin-aarch64
```

Repeat `--bundle`, `--signature`, and `--target` in matching order for a
multi-platform release. Supported updater bundles are macOS `.app.tar.gz`,
Linux `.AppImage` or compatibility `.tar.gz`, and Windows `.exe` / `.msi`
(or v1-compatible `.nsis.zip` / `.msi.zip`). Targets use Tauri's own names, such as `darwin-aarch64`,
`linux-x86_64`, and `windows-x86_64`.

The command creates a draft by default. Review it and publish explicitly; use
`--publish` only in an already-authorized automation lane. The Tauri signing private key remains in
CI; Hands stores only the signed bundle and the detached signature required by
the updater response. Use separate `main`, `preview`, and `nightly` endpoints
when applications follow different release channels.

The Tauri lane currently serves full-scope releases only. Non-full scopes are
ignored because Tauri does not send a stable client identifier for device-group
or cohort resolution. Percentage rollout is not evaluated by the Tauri
endpoint: keep it at 100% (or unset), and use separate channels such as
`preview` and `main` for staged desktop delivery.

## Review and Publish (draft flow)

CI creates drafts; publishing is an explicit step after changelog review:

```bash
# inspect the draft (status, rollout, changelog)
hands releases show raft-android <release-id>

# write the reviewed changelog; repeatable [lang=]file entries
hands releases update raft-android <release-id> \
  --changelog-file zh=changelog.zh.md \
  --changelog-file en=changelog.en.md

# make it live
hands releases publish raft-android <release-id>
```

Bilingual changelogs are stored per language; clients receive the language
matching their locale (`zh` normalizes to `zh-CN`; plain single-value
changelogs are served as-is).

### Exact device-group rollout

Create a named group, add stable installation ids reported by the Hands update
SDK, then bind a draft release to that group:

```bash
hands device-groups create raft-android --name "Artin test devices"
hands device-groups add-member raft-android <group-id> \
  --device-id <installation-device-id> --label "Huawei test tablet"
hands device-groups update raft-android <group-id> \
  --name "Artin test tablets" --description "Physical acceptance devices"
hands releases update raft-android <release-id> --device-group <group-id>
hands releases publish raft-android <release-id>
```

The final publish remains an explicit authorization step. Only exact group
members receive the release; other devices fall back to the prior active
release. List groups with `hands device-groups list <app>` and remove members
with `device-groups remove-member`. Rename or change the operator note with
`device-groups update`. Do not use IMEI or hardware serial numbers.

## Share Links

```bash
hands releases share raft-android <release-id> --password <pw>   # password optional
hands releases shares raft-android <release-id>                   # list
hands releases update-share raft-android <release-id> <share-id> --ttl-seconds 1209600
hands releases revoke-share raft-android <release-id> <share-id>
```

`--password` can also come from `HANDS_SHARE_PASSWORD` (legacy
`QUIVER_SHARE_PASSWORD` still works) to keep it out of shell history. Share URLs are printed once at creation; tokens are stored
hashed.

## Feedback Tickets

Agents can triage feedback and crash tickets entirely from the CLI (viewer
role for read, publisher for changes):

```bash
hands feedback list raft-android --status open --kind crash
hands feedback show raft-android <ticket-id>
hands feedback update raft-android <ticket-id> --status in_progress --assignee me
hands feedback comment raft-android <ticket-id> "已复现，修复中"
hands feedback update raft-android <ticket-id> --status resolved
```

`--assignee none` unassigns. All subcommands accept `--json` for scripting.

## CI Environment Variables

Every variable is read as `HANDS_<name>` first, then the legacy `QUIVER_<name>`,
so existing CI keeps working unchanged.

| Variable | Required | Purpose |
|---|---|---|
| `HANDS_API` | No | Hands business API base URL. Defaults to `https://hands.build`. `HANDS_CLI_API` takes precedence if set. |
| `HANDS_BEARER_TOKEN` | Yes | App-scoped deploy token for CI. |
| `HANDS_AUTH_TOKEN` | No | Alias for `HANDS_BEARER_TOKEN` (tried first). |

Legacy equivalents `QUIVER_API`, `QUIVER_BEARER_TOKEN`, `QUIVER_AUTH_TOKEN` are
still accepted.

## CI Examples

Copy-ready pipelines built on these commands live in
[botiverse/hands-examples](https://github.com/botiverse/hands-examples):

- A reusable GitHub Action: `uses: botiverse/hands-examples/publish-android@v1`.
- Complete GitHub Actions and GitLab CI workflows for Android, iOS
  (publish + server-side [TestFlight upload](ios-testflight.md)), and
  Electron (per-platform channels for the generic provider).
- Plain-bash scripts for Jenkins, Buildkite, or any runner with bash and npm.

## Versioning Guidance

For Android releases, keep APK `versionCode` and Hands `version_code` identical. Clients only update when the server release has a higher version code than the installed app.

One common scheme is:

```text
versionCode = major * 1_000_000 + minor * 10_000 + patch * 100 + build
versionName = major.minor.patch[-suffix]
```

Example: `1.0.3-rc2` becomes `versionName=1.0.3-rc2` and `versionCode=1000302`.

## Security

Do not paste deploy tokens, package tokens, signing passwords, or keystore data into public chat, issue comments, logs, or release notes. Store them in the CI secret store and pass them to Hands through environment variables.
