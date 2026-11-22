# Hands examples [![Built with Raft](https://raw.githubusercontent.com/raft-builders/awesome-raft-build/main/badge/built-with-raft.svg)](https://raft.build)

Copy-ready CI examples and reusable actions for publishing app builds to
[Hands](https://hands.build).

These examples used to live in `botiverse/hands-examples`. That repository is
kept read-only, so workflows using `botiverse/hands-examples/publish-android@v1`
keep working; new workflows should use
`botiverse/hands/examples/publish-android@examples-v1`.

## Start here

1. Install Hands for your Raft server by following the
   [Getting Started guide](https://hands.build/docs/getting-started/).
2. Create an app in Hands.
3. Create an app-scoped `publisher` deploy token in App Settings, or with an
   authorized CLI session:

   ```bash
   hands deploy-tokens create <app-slug> --name github-actions --role publisher
   ```

4. Store the one-time token in your CI secret store as `HANDS_BEARER_TOKEN`.
5. Build and sign your app in your existing CI, then use one of the examples
   below to publish the artifact to Hands.

Hands is the release and distribution layer. Your own build system remains
responsible for compiling and signing the APK, IPA, or other artifact.

## Android native symbols are part of the build

If an APK contains the Hands Android SDK's `libhandscrash.so`, its exact
`native-symbols` classifier is a required release artifact. The AAR and APK
contain a stripped library; repacking that file after the build does **not**
restore function or source information.

Add a resolvable classifier configuration beside the dependency in your Android
app module. This GitHub Packages example deliberately uses one version variable
for both artifacts:

```kotlin
val handsAndroidSdkVersion = "0.11.2" // keep this as your single source of truth
val handsNativeSymbols by configurations.creating {
    isCanBeConsumed = false
    isCanBeResolved = true
    isTransitive = false
}

val copyHandsNativeSymbols by tasks.registering(Sync::class) {
    from(handsNativeSymbols)
    into(layout.buildDirectory.dir("outputs/hands-native-symbols"))
}

dependencies {
    implementation("build.hands:hands-android-sdk:$handsAndroidSdkVersion")
    add(
        handsNativeSymbols.name,
        "build.hands:hands-android-sdk:$handsAndroidSdkVersion:native-symbols@zip",
    )
}
```

For JitPack, keep the AAR and classifier on JitPack rather than mixing channels:

```kotlin
implementation("com.github.botiverse:hands:android-sdk-v$handsAndroidSdkVersion")
add(
    handsNativeSymbols.name,
    "com.github.botiverse:hands:android-sdk-v$handsAndroidSdkVersion:native-symbols@zip",
)
```

Run `assembleRelease` and `copyHandsNativeSymbols` in the same build. The
validator then enforces all of the following before Hands receives anything:

- every APK ABI containing `libhandscrash.so` exists in the archive;
- APK, archive, and `manifest.json` ELF build IDs match per ABI;
- manifest SHA-256 values match the unstripped files;
- each symbol file contains `.debug_info`.

The reusable action defaults to `native-symbols-policy: auto`: an APK containing
`libhandscrash.so` fails when `symbols` is missing. APKs without the Hands native
crash library do not need this archive. `disabled` is an explicit opt-out that
leaves future native crashes unsymbolicatable; do not use it to make a release
green.

For split or external build jobs, transport the APK and classifier archive as
one immutable artifact set. Never download an APK and generate “symbols” from
its stripped libraries later.

## GitHub Actions

### Reusable Android publish action

The composite action at [`publish-android/action.yml`](publish-android/action.yml)
uploads an already-built, signed APK and creates a draft release:

```yaml
- name: Publish draft to Hands
  uses: botiverse/hands/examples/publish-android@examples-v1
  with:
    app: my-android-app
    apk: app/build/outputs/apk/release/app-release.apk
    channel: preview
    version-name: ${{ github.ref_name }}
    version-code: ${{ github.run_number }}
    changelog-file: changelog.txt
    symbols: path/to/the-resolved/hands-native-symbols.zip
    native-symbols-policy: required
    hands-token: ${{ secrets.HANDS_BEARER_TOKEN }}
```

The action defaults to `draft: true`. Activating a release remains a separate,
deliberate review step.

### Complete workflows

- [`android-gradle.yml`](github-actions/android-gradle.yml) builds a
  Gradle Android project, signs it through the project's existing release
  configuration, and publishes the resulting APK as a Hands draft.
- [`publish-existing-apk.yml`](github-actions/publish-existing-apk.yml)
  publishes an APK and its exact native-symbol archive produced by an earlier
  job or downloaded from another build system.
- [`tauri-publish.yml`](github-actions/tauri-publish.yml) builds signed
  Tauri v2 updater bundles on macOS, Linux, and Windows, then publishes one
  multi-platform Hands draft on a single channel.

Copy the selected file into your repository under `.github/workflows/`, then
replace the app slug, Gradle task, and APK path.

## Generic CI or local scripts

[`scripts/publish-android.sh`](scripts/publish-android.sh) is portable across
GitLab CI, Buildkite, Jenkins, and custom runners:

```bash
export HANDS_BEARER_TOKEN='<publisher deploy token>'

./scripts/publish-android.sh \
  --app my-android-app \
  --apk ./app-release.apk \
  --channel preview \
  --version-name 1.0.0 \
  --version-code 1000000 \
  --changelog ./changelog.txt \
  --symbols ./hands-android-sdk-native-symbols.zip \
  --native-symbols-policy required
```

## Security boundary

- Use an app-scoped `publisher` deploy token for CI.
- Store tokens only in the CI platform's encrypted secret store.
- Examples create draft releases by default.
- Android examples validate exact native symbols before upload; validation runs
  locally and does not expose symbol bytes or credentials to another service.
- Never commit signing material, deploy tokens, or generated credentials.

## Reference

- [Hands CLI reference](https://hands.build/docs/cli-reference/)
- [Hands agent guide](https://hands.build/docs/agent-guide/)
- [Hands Android SDK](https://hands.build/docs/android-sdk/)

## GitLab CI

- [`gitlab-ci/android-publish.gitlab-ci.yml`](gitlab-ci/android-publish.gitlab-ci.yml)
  — same-build APK + exact classifier transport, build-ID validation, then draft
  publish with `hands builds publish-android`.
- [`gitlab-ci/ios-publish.gitlab-ci.yml`](gitlab-ci/ios-publish.gitlab-ci.yml)
  — IPA + dSYM draft publish; TestFlight upload happens server-side in Hands
  afterwards.

## iOS on GitHub Actions

- [`github-actions/ios-publish.yml`](github-actions/ios-publish.yml)
  — archive/export placeholder + `hands builds publish-ios` draft publish.
  The App Store Connect credential is managed only in Hands; CI needs just
  the signing material and the Hands deploy token. After the draft is
  published, Hands uploads the build to TestFlight server-side with its
  stored credential ([docs](https://hands.build/docs/ios-testflight/)).

## Electron

- [`github-actions/electron-publish.yml`](github-actions/electron-publish.yml)
  — per-platform matrix (win32/darwin/linux); each platform publishes one
  draft into its own platform channel (`main-win32`/`main-darwin`/
  `main-linux`) so activations never supersede another platform. Create the
  three channels in the app (Hands Console -> Channels) before the first
  run — the CLI does not create channels on publish.
- [`generic/publish-electron.sh`](generic/publish-electron.sh)
  — env-driven, run once per platform, each into its own platform channel.

## Tauri

- [`github-actions/tauri-publish.yml`](github-actions/tauri-publish.yml)
  — three-platform build matrix followed by one draft publish job. Tauri's
  signing private key stays in GitHub Actions secrets; Hands receives only the
  updater bundles and `.sig` text.
- [`generic/publish-tauri.sh`](generic/publish-tauri.sh)
  — publish an already-built set of `target=path` bundles from any CI. Unlike
  Electron generic-provider releases, all Tauri targets share one Hands channel
  because the dynamic endpoint selects `target` and `arch`.

## Any other CI

- [`generic/publish-android.sh`](generic/publish-android.sh)
- [`generic/publish-ios.sh`](generic/publish-ios.sh)
- [`generic/publish-electron.sh`](generic/publish-electron.sh)
- [`generic/publish-tauri.sh`](generic/publish-tauri.sh)

Plain shell, driven by environment variables. Keep the Android wrapper beside
the `scripts/` directory here so it can run the shared validator; the
other platform scripts can be copied independently.
