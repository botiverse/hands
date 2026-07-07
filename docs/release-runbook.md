# Release runbook (draft-first flow)

Policy (artin, 2026-07-04): **CI never completes a real release.** CI builds,
signs, generates a raw changelog, and creates a **draft** release on Quiver.
A human or agent then reviews, writes the final bilingual changelog, and
publishes explicitly.

## 1. CI (automatic)

`botiverse/mobile` → Actions → **Android Release** (defaults to draft mode):

- builds + signs the APK
- generates a raw commit-subject changelog (previous build's
  `provenance.source_commit` → HEAD, fallback last 15 subjects)
- `quiver builds publish-android … --draft` creates the build + assets +
  **draft** release (invisible to update checks and share pages)
- job summary shows the draft release id and the raw changelog

For Electron apps, CI should follow the same draft-first rule. Build with
electron-builder, then publish the generated generic-provider files through
the CLI:

```sh
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

Upload the files electron-builder generated for the target platform:

- `latest.yml`, `latest-mac.yml`, or `latest-linux.yml`
- installer artifacts such as `.exe`, signed macOS `.zip` / `.dmg`, or
  `AppImage`
- `.blockmap` files when electron-builder generated them

Quiver serves the active release at
`/electron/:appSlug/:channel/:file`, so the Electron app can configure:

```ts
autoUpdater.setFeedURL({
  provider: "generic",
  url: "https://quiver.oranix.io/electron/<appSlug>/<channel>"
});
```

`quiver builds publish-electron` preserves original filenames in `variant` and
`metadata_json.filename`. Advanced CI can also call the build, asset, and
release APIs directly using the same asset conventions. The Electron release
should remain `draft` until changelog review is complete.

## 2. Review + bilingual changelog (agent/human)

```sh
# inspect the draft
quiver releases show raft-android <releaseId>

# write the reviewed changelog in both languages (repeatable lang=file)
quiver releases update raft-android <releaseId> \
  --changelog-file zh=changelog.zh.md \
  --changelog-file en=changelog.en.md
```

Storage format: plain text (legacy, served as-is) or a JSON object
`{"en": "…", "zh-CN": "…"}`. Clients pick a language via `lang=` /
`X-Quiver-Lang` / `Accept-Language` on update checks; share pages use the
browser's `Accept-Language`. Fallback order: exact tag → language prefix →
`en` → first available.

## 3. Publish (explicit)

```sh
quiver releases publish raft-android <releaseId>
# then, if desired:
quiver releases share raft-android <releaseId> --password <pw>
```

Publishing supersedes the previous active release on the same
app/channel/product/release-type; staged rollout percentage can be set before
or after publish (`rollout_cohort_count`, bump via admin or API).
