---
title: "Ship a Node CLI"
description: "Build, publish, and update cross-platform Node and CLI binaries with Hands."
category: "SDKs & API"
order: 17
---

# Ship a Node CLI

Hands gives a Node CLI one versioned release contract for build metadata,
platform targets, channels, release notes, and public update checks. Choose
where the bytes live before writing CI:

| Deployment model | Use when | Command |
| --- | --- | --- |
| Hands-hosted | Hands should receive and serve every binary | `hands builds publish-cli-binary` |
| External CDN | Your CDN already owns the bytes and Hands should publish their immutable identity | `hands builds publish-version` plus a draft release |

Both models use the same public `cli-binary` API. Consumers select an asset by
`platform` and `arch`, follow its `download_url`, and verify the returned
`sha256` and `size_bytes` before installing it.

## 1. Create the app and CI identity

Create a Node app once. The app bootstrap creates the `cli-binary` product type
and the `main`, `preview`, and `nightly` channels:

```bash
hands apps create \
  --slug my-cli \
  --name "My CLI" \
  --platform node \
  --description "Cross-platform command line client"
```

An existing Node app can be used instead. Inspect its channel ids and slugs
with:

```bash
hands apps get my-cli
hands channels list my-cli
```

Create an app-scoped deploy token for CI. A publisher token is sufficient and
carries `app:read`, `app:publish`, and `feedback:write`; the build and release
routes use the publisher app role. `app:admin` is not needed by the publish
job. App admin is needed to mint or revoke a token, not to use it in CI.

```bash
# Run once as an app admin. The secret is printed only once.
hands deploy-tokens create my-cli --name github-ci --role publisher
```

The API also supports explicit permission scopes for integrations whose routes
accept them, but the current build and release routes require the publisher app
role. Do not replace the publisher role with a role-free scope-only token for
this flow; it will be rejected. The publisher role is still app-scoped and
cannot publish a different app.

Store the result in the CI secret store and expose it only to the publish job:

```bash
export HANDS_API=https://hands.build
export HANDS_BEARER_TOKEN="$HANDS_DEPLOY_TOKEN"
```

Never put a token in a source URL, installer script, release note, shell
history, or build log. A token is app-scoped: a token for one app cannot publish
another app.

## 2. Choose version and targets

Use a SemVer `version_name` such as `1.4.0` or `1.4.0-rc.1`. Hands orders
versions with a non-negative numeric `version_code`; the CLI derives one from
plain `major.minor.patch` versions when `--version-code` is omitted. A version
coordinate must be unique for an app, channel, product type, and release type.
If a published version must be corrected, use a higher version code.

The supported CLI targets are:

```text
darwin-arm64  darwin-x64  linux-arm64  linux-x64  win32-arm64  win32-x64
```

Keep the same target set for a release across retries. A target is a pair of
platform and architecture; do not encode a filename or a mutable build id in
the target name.

## 3. Hands-hosted binaries

Use one `publish-cli-binary` invocation for one version. Repeat `--target` and
`--binary` in the same order; one invocation creates one build containing all
targets and one release. `--runner` and `--sha256sums`, when used, are also
paired by position.

```bash
hands builds publish-cli-binary my-cli \
  --version-name 1.4.0 \
  --channel main \
  --target darwin-arm64 --binary dist/my-cli-darwin-arm64 \
  --target linux-x64 --binary dist/my-cli-linux-x64 \
  --target win32-x64 --binary dist/my-cli-win32-x64 \
  --source-commit "$GIT_COMMIT" \
  --ci-provider github \
  --ci-run-id "$GITHUB_RUN_ID" \
  --draft
```

The CLI hashes each local file before upload, sends it through a short-lived
single-object upload URL, and checks the server's hash and byte count. Hands
creates the release only after every declared asset is ready. The `--draft`
flag is recommended for CI: it keeps activation as an explicit review step.

The command is safe to retry with the same declaration. Ready assets keep their
recorded digest and do not receive another upload URL. A second invocation with
different immutable metadata is a conflict; do not try to repair it by making a
second build for the same version coordinate.

Review and publish the draft explicitly:

```bash
hands releases show my-cli <release-id>
hands releases update my-cli <release-id> \
  --changelog-file en=release-notes/en.md \
  --changelog-file zh=release-notes/zh.md
hands releases publish my-cli <release-id>
```

`releases publish` reads the current release revision and exact stored scopes
before activation. If the app requires human approval, an agent publish request
stays pending until an authorized human approves it.

## 4. External CDN binaries

Use `publish-version` when your CDN already serves immutable bytes. Hands stores
the source URL, raw digest, byte size, optional gzip transport metadata, Node
version, and provenance. It does not copy the bytes and it does not create or
activate a release.

Hash the exact bytes that the declared URL serves. The URL must be HTTPS,
credential-free, and stable for the lifetime of the release. A versioned path
such as `https://cdn.example.com/my-cli/1.4.0/linux-x64` is preferable to a
mutable `latest` URL.

Register every target with the same version name. The first call creates the
external build; later calls attach additional targets to that build:

```bash
hands builds publish-version my-cli \
  --version-name 1.4.0 \
  --channel main \
  --target linux-x64 \
  --source-url https://cdn.example.com/my-cli/1.4.0/linux-x64 \
  --raw-sha256 "$LINUX_SHA256" \
  --raw-size "$LINUX_SIZE" \
  --node-version 22.23.2 \
  --source-commit "$GIT_COMMIT" \
  --ci-provider github \
  --ci-run-id "$GITHUB_RUN_ID"

hands builds publish-version my-cli \
  --version-name 1.4.0 \
  --channel main \
  --target darwin-arm64 \
  --source-url https://cdn.example.com/my-cli/1.4.0/darwin-arm64 \
  --raw-sha256 "$MAC_SHA256" \
  --raw-size "$MAC_SIZE" \
  --node-version 22.23.2
```

An identical declaration is an idempotent replay. Changing an immutable field
returns a conflict. Keep the returned `build_id`; it is needed to create the
release draft.

After all targets are registered, create a draft release. `hands api` is a
same-origin authenticated wrapper around the normal Hands API; it does not
bypass RBAC:

```bash
hands api POST /api/apps/<app-id>/releases/draft --data '{
  "build_id": "<build-id>",
  "channel_id": "<main-channel-id>",
  "product_type": "cli-binary",
  "release_type": "stable",
  "scopes": [{"scope_type": "full", "scope_value": "all"}],
  "changelog": "My CLI 1.4.0"
}'
```

Read the draft, write reviewed notes, then publish it. The external target
contract is required for a `cli-binary` release: the publish request must name
the complete target set, and the set is frozen when the release is activated.
Use the current `revision` and the exact stored scope set from the fresh release
detail:

```bash
hands api POST /api/apps/<app-id>/releases/<release-id>/publish --data '{
  "expected_revision": 0,
  "expected_scopes": [{"scope_type": "full", "scope_value": "all"}],
  "required_external_targets": [
    "darwin-arm64",
    "linux-x64"
  ]
}'
```

Replace `0` and the target list with the values read immediately before the
write. If the app has an approval gate, this request returns a pending approval
instead of activating the release. Once frozen, a new target cannot be added to
that published build; create a new version with the complete set.

## 5. Public downloads and updates

Latest release metadata is anonymous and has the same shape for hosted and
external artifacts:

```bash
curl -fsSL \
  'https://hands.build/public/v2/apps/my-cli/latest?channel=main&product_type=cli-binary'
```

The response includes `assets[]` entries with `platform`, `arch`, `filetype`,
`size_bytes`, `sha256`, and `download_url`. For hosted assets, `download_url`
is a time-limited Hands URL that redirects to storage. External assets use a
release-bound Hands URL that redirects to the declared CDN URL. Follow redirects
and verify the bytes before executing them:

```bash
curl -fL -o my-cli "$DOWNLOAD_URL"
echo "$SHA256  my-cli" | sha256sum --check --strict
test "$(wc -c < my-cli)" -eq "$SIZE_BYTES"
```

For an installed CLI, use the update-check endpoint with the current SemVer:

```text
GET /public/v2/apps/my-cli/updates/check
    ?channel=main
    &product_type=cli-binary
    &current_version=1.3.2
    &platform=linux
    &arch=x64
```

The Node updater in `@botiverse/hands-node` calls this endpoint, selects the
matching target, follows the download URL, and verifies `sha256` and
`size_bytes`. To request a specific available version, use `version=` instead
of a channel value:

```text
GET /public/v2/apps/my-cli/updates/check
    ?version=1.3.2
    &product_type=cli-binary
    &current_version=1.2.0
    &platform=linux
    &arch=x64
```

A version request searches eligible active and superseded releases across
channels and remains subject to availability and rollout checks.

## 6. Install with Hands

Hands provides an installer for published, self-contained CLI binaries on
Linux and macOS (`x64` and `arm64`). You do not need to write or upload an
`install.sh`. For example, to install the current `main` release of `my-cli`:

```sh
curl -fsSL -o install.sh https://hands.build/dl/my-cli/main/install.sh && sh ./install.sh
```

The installer chooses the platform and architecture, resolves a public
`cli-binary` release once, and downloads that release's target. It checks the
byte count and SHA-256 before replacing the destination. It requires `curl`,
`sha256sum` or `shasum`, and a writable install directory. It installs to
`~/.local/bin/my-cli` by default; make sure that directory is in your `PATH`.
Set `HANDS_INSTALL_DIR` to an absolute directory or `HANDS_INSTALL_NAME` to a
simple filename to choose another destination:

```sh
HANDS_INSTALL_DIR="$HOME/bin" HANDS_INSTALL_NAME=my-command sh install.sh
```

Replace `main` in the URL with another channel such as `preview` or `nightly`.
For this installer URL, app and channel names must start with an ASCII letter
or digit, contain only ASCII letters, digits, `.`, `_`, or `-`, and be at most
128 characters. `releases` is reserved as a channel path.

Only active, non-hidden, fully rolled-out releases with a `full:all` scope are
eligible; a missing target or incompatible release fails without installing.
The target must be an executable binary for that platform and architecture
(such as a Node single-executable application); this installer does not install
an npm package or install Node for you. Windows and PowerShell are not supported
by this shell installer.

The resolved release and its digest come from Hands over HTTPS. For an
external build, the declared CDN must continue to serve the same bytes over
HTTPS; an altered or unavailable file will not be installed.

## CI checklist

- Build every target once and record the exact bytes, digest, and size.
- Use one hosted publish invocation per version, or register every external
  target before creating the draft release.
- Use an app-scoped `publisher` token (its effective set includes
  `app:read`/`app:publish`); keep it in CI secrets only. `app:admin` is not
  required by the publish job.
- Prefer `--draft` and publish after release notes and target coverage are
  reviewed.
- Treat source URLs and target identities as immutable release inputs.
- Retry the same declaration instead of creating a second build for the same
  version coordinate.
- Follow redirects and verify both SHA-256 and byte size before installation.

See the [CLI Reference](cli-reference.md) for command flags and the [Public API
Reference](public-api-reference.md) for the complete anonymous update and
download schemas.
