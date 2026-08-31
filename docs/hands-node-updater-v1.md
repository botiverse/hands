# Hands Node updater v1

`@botiverse/hands-node/updater` lets a Node application resolve and stage an
active Hands release. It deliberately does not install, restart, health-check,
or roll back the application.

## Integrity model

Hands returns the exact eligible release and external build target for the
requested channel, version, platform, and architecture. Every candidate must
include a byte size and lowercase SHA-256 digest from the external-build
ledger.

`prepareUpdate` streams the artifact into a fresh temporary file, rejects a
size overflow immediately, verifies the final size and SHA-256, fsyncs the
file, and atomically renames it to a `.ready` path. A failed download or
verification leaves no `.ready` or partial file.

This v1 contract does not add a release-attestation key or signature layer. It
assumes the Hands release control plane, HTTPS endpoint, and ledger are the
trusted source of the expected digest. Platform package/code signatures remain
independent and are not replaced by this SDK.

## API

```ts
const updater = createHandsUpdater({
  appSlug: "raft-computer",
  apiOrigin: "https://hands.build",
});

const result = await updater.checkUpdate({
  currentVersion: "1.2.3",
  channel: "main", // "alpha" or `pinned:${version}` are also supported
  target: { platform: process.platform, arch: process.arch },
});

if (result.kind === "update") {
  const prepared = await updater.prepareUpdate({
    candidate: result.candidate,
    stagingDir: "/path/owned/by/the/runtime",
  });
  // Hand prepared.stagedBinaryPath and prepared.receipt to the runtime.
}
```

For ordinary channel checks, the endpoint selects only `active`, non-hidden
`cli-binary` releases whose build succeeded and whose full-release scope and
rollout include the client. Exact pinned versions may also select a
`superseded` release across channels, but the same rollout inclusion check still
applies. Identical artifact identity prefers `main`, while divergent
size/SHA-256 identity fails with `UPDATE_IDENTITY_CONFLICT`.

## Failure boundary

Network, response, identity, download, size, SHA-256, and staging failures are
typed `HandsUpdateError` values. There is no automatic fallback to a legacy
release source. The consuming runtime decides whether a separately configured
backend is allowed.

The staged receipt records the release/channel/artifact identity, expected and
actual size/SHA-256, and candidate digest. It is evidence of byte verification,
not evidence of installation or runtime health.
