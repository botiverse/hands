# Tauri Updater

Hands can publish and serve signed updater bundles for Tauri v2 applications.
The application checks a channel-specific dynamic endpoint; Hands returns the
official Tauri updater JSON when a newer compatible release is active, or
`204 No Content` when there is no update.

Hands does not build or sign the desktop application. Keep the Tauri updater
private key in CI. Upload only the generated bundle and its detached `.sig`
file.

## What is supported

- Tauri v2 dynamic updater endpoints.
- Separate Hands channels such as `main`, `preview`, and `nightly`.
- One draft containing multiple operating-system and architecture targets.
- Signed macOS, Linux, and Windows updater bundles.
- Immutable release-specific download URLs, so an update response cannot
  silently switch to different bytes later.
- Draft-first publishing: CI uploads a draft; a human or authorized agent
  reviews it before activation.

## Configure the application

Generate updater artifacts and configure the Hands endpoint in
`tauri.conf.json`:

```json
{
  "bundle": {
    "createUpdaterArtifacts": true
  },
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

Replace `my-app` with the Hands app slug. Use a different channel segment for
preview or nightly builds.

The application calls:

```http
GET /tauri/:appSlug/:channel/:target/:arch/:currentVersion
```

Hands returns `204 No Content` when the active release is not newer or no
matching signed target exists. A successful response contains `version`,
`url`, `signature`, and optional `notes` and `pub_date` fields.

## Publish a draft from CI

Install and authenticate the Hands CLI, then upload each updater bundle with
its matching signature and target:

```bash
hands builds publish-tauri my-app \
  --version-name 1.2.3 \
  --channel main \
  --bundle target/release/bundle/macos/MyApp.app.tar.gz \
  --signature target/release/bundle/macos/MyApp.app.tar.gz.sig \
  --target darwin-aarch64
```

The command creates a draft by default. Repeat `--bundle`, `--signature`, and
`--target` in the same order to aggregate multiple targets into one release:

```bash
hands builds publish-tauri my-app \
  --version-name 1.2.3 \
  --channel main \
  --bundle dist/MyApp.app.tar.gz \
  --signature dist/MyApp.app.tar.gz.sig \
  --target darwin-aarch64 \
  --bundle dist/MyApp_1.2.3_amd64.AppImage \
  --signature dist/MyApp_1.2.3_amd64.AppImage.sig \
  --target linux-x86_64 \
  --bundle dist/MyApp_1.2.3_x64-setup.exe \
  --signature dist/MyApp_1.2.3_x64-setup.exe.sig \
  --target windows-x86_64
```

Use `--changelog` or `--changelog-file` for localized release notes. Use
`--publish` only in an automation lane that already has explicit activation
authorization.

## Target and bundle formats

| Target family | Architectures | Updater bundles |
|---|---|---|
| `darwin` | `aarch64`, `x86_64` | `.app.tar.gz` |
| `linux` | `aarch64`, `x86_64`, `i686`, `armv7` | `.AppImage`, compatibility `.tar.gz` |
| `windows` | `aarch64`, `x86_64`, `i686`, `armv7` | `.exe`, `.msi`, compatibility `.nsis.zip`, `.msi.zip` |

Targets use Tauri names such as `darwin-aarch64`, `linux-x86_64`, and
`windows-x86_64`. A `.dmg` is not a Tauri updater bundle and is not accepted by
`publish-tauri`.

## Release and download behavior

- Only an active, full-scope `tauri-updater` release is offered.
- Draft and cancelled releases are never returned by the update endpoint.
- Scoped and percentage rollouts fail closed. Tauri's default updater request
  has no stable installation identifier, so Hands does not expand a targeted
  release to every desktop client.
- The update response is revalidated quickly; a no-update response uses
  `no-store`.
- The artifact URL contains the concrete release ID, target, architecture, and
  filename. A superseded release remains downloadable so a client that already
  received the response can finish updating.
- Cancelling the release acts as a kill switch: its update response disappears
  and its artifact URL returns `404`.
- Published build assets are immutable. Publish a new build and release when
  bytes change instead of overwriting an active artifact.

## Security boundary

Tauri verifies the detached signature with the public key embedded in the
application. Hands stores the bundle and signature, but never needs the updater
private key. Keep private signing material in the CI secret store and do not
put it in Hands metadata, changelogs, logs, or chat.

See the [CLI Reference](cli-reference.md) for every command option and the
[Public API Reference](public-api-reference.md) for the endpoint contract.
