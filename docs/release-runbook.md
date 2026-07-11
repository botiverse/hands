# Release runbook (draft-first flow)

Policy (artin, 2026-07-04): **CI never completes a real release.** CI builds,
signs, generates a raw changelog, and creates a **draft** release on Hands.
A human or agent then reviews, writes the final bilingual changelog, and
publishes explicitly.

## 1. CI (automatic)

`botiverse/mobile` → Actions → **Android Release** (defaults to draft mode):

- builds + signs the APK
- generates a raw commit-subject changelog (previous build's
  `provenance.source_commit` → HEAD, fallback last 15 subjects)
- `hands builds publish-android … --draft` creates the build + assets +
  **draft** release (invisible to update checks and share pages)
- job summary shows the draft release id and the raw changelog

For Electron apps, CI should follow the same draft-first rule. Build with
electron-builder, then publish the generated generic-provider files through
the CLI:

```sh
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

Upload the files electron-builder generated for the target platform:

- `latest.yml`, `latest-mac.yml`, or `latest-linux.yml`
- installer artifacts such as `.exe`, signed macOS `.zip` / `.dmg`, or
  `AppImage`
- `.blockmap` files when electron-builder generated them

Hands serves the active release at
`/electron/:appSlug/:channel/:file`, so the Electron app can configure:

```ts
autoUpdater.setFeedURL({
  provider: "generic",
  url: "https://hands.build/electron/<appSlug>/<channel>"
});
```

`hands builds publish-electron` preserves original filenames in `variant` and
`metadata_json.filename`. Advanced CI can also call the build, asset, and
release APIs directly using the same asset conventions. The Electron release
should remain `draft` until changelog review is complete.

For iOS/TestFlight, the CI boundary is different: macOS CI signs the app, and
Hands receives the signed output. Do not upload unsigned IPA intermediates to
Hands as the release artifact, and do not move Apple signing credentials into
Hands.

```sh
# after xcodebuild archive + xcodebuild -exportArchive
hands builds publish-ios raft-ios \
  --channel main \
  --version-name 1.0.0 \
  --version-code 1000000 \
  --ipa build/Raft.ipa \
  --dsym build/Raft.dSYM.zip \
  --changelog-file ./changelog.txt \
  --source-commit "$GITHUB_SHA" \
  --ci-provider github-actions \
  --ci-run-id "$GITHUB_RUN_ID" \
  --ci-url "$GITHUB_SERVER_URL/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID" \
  --draft

# then upload that same signed IPA to App Store Connect/TestFlight
# with Transporter or fastlane pilot in the same macOS CI job.
```

Hands stores the signed `.ipa` as the installable artifact and `.dSYM.zip` as a
support artifact for symbolication. TestFlight processing status can be written
back through metadata/status follow-ups, but the release should still remain
`draft` until changelog review is complete.

For HarmonyOS/OHOS, CI signs the HAPs inside the App Pack, verifies each HAP,
and exports both the signed `.app` and a standalone signed `.hap`. Publish both
files to one draft build so AppGallery submission and user sideloading consume
the exact same verified release:

```sh
hands builds publish-ohos raft-ohos \
  --channel main \
  --version-name 1.0.0 \
  --version-code 1000000 \
  --app build/raft-ohos-1.0.0-1000000.app \
  --hap build/raft-ohos-entry-1.0.0-1000000.hap \
  --symbols build/ohos-symbols-1.0.0-1000000.tar.gz \
  --metadata build/ohos-release-metadata.json \
  --changelog-file ./changelog.txt \
  --source-commit "$GITHUB_SHA" \
  --ci-provider github-actions \
  --ci-run-id "$GITHUB_RUN_ID" \
  --ci-url "$GITHUB_SERVER_URL/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID" \
  --draft
```

Hands records `.app` as the AppGallery installable and `.hap` as the sideload
installable. Signing material stays in the mobile CI secret boundary.

If CI already has reviewed localized release notes, use repeatable
`lang=file` entries instead of the raw plain changelog:

```sh
hands builds publish-ios raft-ios \
  --version-name 1.0.0 \
  --version-code 1000000 \
  --ipa build/Raft.ipa \
  --changelog-file zh=changelog.zh.md \
  --changelog-file en=changelog.en.md \
  --draft
```

## 2. Review + bilingual changelog (agent/human)

```sh
# inspect the draft
hands releases show raft-android <releaseId>

# write the reviewed changelog in both languages (repeatable lang=file)
hands releases update raft-android <releaseId> \
  --changelog-file zh=changelog.zh.md \
  --changelog-file en=changelog.en.md
```

Storage format: plain text (legacy, served as-is) or a JSON object
`{"en": "…", "zh-CN": "…"}`. Clients pick a language via `lang=` /
`X-Hands-Lang` (legacy `X-Quiver-Lang` still accepted) / `Accept-Language` on update checks; share pages use the
browser's `Accept-Language`. Fallback order: exact tag → language prefix →
`en` → first available.

## 3. Publish (explicit)

```sh
hands releases publish raft-android <releaseId>
# then, if desired:
hands releases share raft-android <releaseId> --password <pw>
```

Publishing supersedes the previous active release on the same
app/channel/product/release-type; staged rollout percentage can be set before
or after publish (`rollout_cohort_count`, bump via admin or API).
