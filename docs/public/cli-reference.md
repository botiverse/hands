---
title: "CLI Reference"
description: "Install and use @botiverse/hands-cli from local scripts or CI."
category: "SDKs & API"
order: 9
---

# CLI Reference

For publishing and installing self-contained Node CLI binaries, see [Ship a Node CLI](node-cli.md).

`@botiverse/hands-cli` is the command-line client for Hands. Use it from local scripts or CI to inspect apps, upload Android builds, and publish releases.

## Install

Install it globally:

```bash
npm install -g @botiverse/hands-cli
```

Or run it without a permanent install:

```bash
npm exec --package @botiverse/hands-cli@0.5.15 -- hands --help
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
`HANDS_AUTH_TOKEN`. An admin agent that needs to bootstrap CI should use
`hands login` and `hands deploy-tokens create`, write the returned one-time token
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

## Publish Hands-hosted CLI Binaries

`builds publish-cli-binary` uploads one or more platform binaries directly to
Hands storage and creates one release only after every declared artifact has
been verified:

```bash
hands builds publish-cli-binary raft-computer \
  --version-name 1.0.33 \
  --channel main \
  --target darwin-arm64 --binary ./raft-computer-darwin-arm64 \
  --target linux-x64 --binary ./raft-computer-linux-x64
```

`--target` and `--binary` pair by position. Optional `--runner` and
`--sha256sums` values also repeat once per target when used.

The command creates a pending build with its complete artifact slot set frozen,
streams each file to a short-lived single-object upload URL, and asks Hands to
verify the exact SHA-256 digest and byte size. Hands marks the build succeeded
and creates the release only after every frozen slot is ready. Interrupted runs
can replay the same declaration: pending assets retain their declared digest and
size, while ready assets return no upload URL. The client never receives an R2
bucket credential.

Hosted release URLs under `/dl/:slug/releases/:releaseId/:file` redirect to
a short-lived, object-scoped R2 download URL when R2 signing is configured.
The channel URL `/dl/:slug/:channel/:file` first redirects to an immutable
release URL. Download clients must follow redirects (for example, `curl -L`)
and verify the declared digest as before. Keep the Hands release URL for
future downloads; the final R2 URL expires. A HEAD request receives a URL
signed for HEAD, while GET receives one signed for GET. Redirects are
`Cache-Control: no-store`; this does not promise CDN caching of object bytes.
Self-hosted instances without R2 signing continue to stream through Hands.

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

To add symbols to an existing build, use `hands builds attach-symbols <app> <build-id> <file> --kind <kind>`. Kinds are `proguard-mapping`, `native-symbols`, and `dsym`; the command also infers the kind from the filename. A native-symbol archive uses the build's Android, HarmonyOS, or iOS product type to select its platform and requires an explicit `--platform` if the product type is unknown. Attachments are add-only and do not replace an existing asset in the same slot.

## Google Play: upload now, send for review later

Google Play reviews one set of changes at a time. While another release of the
app is in review, `hands releases play-promote` fails at `stage=commit_edit`:
Hands commits every Play edit with `changesInReviewBehavior=ERROR_IF_IN_REVIEW`
and never cancels a review in progress. To get the next release onto Play
anyway, split upload from review:

```bash
# 1. Upload: bundle, track release, release notes and mapping/symbols are saved
#    on Play with changesNotSentForReview=true, NOT sent for review
hands releases play-promote raft-android <release> --track production \
  --rollout-percent 100 --note "upload 1.17.0" --changes-not-sent-for-review

# 2. After the other review finishes: send the pending changes for review
hands releases play-send-for-review raft-android <release> --track production \
  --note "1.16.1 review done"
```

- Both need the app **publisher** role and use the same per-package Play edit
  lock as promote and `hands store-listing push`.
- The promotion receipt records `review: {requested: false,
  changes_not_sent_for_review: true}` (plain promote: `requested: true`). If the
  server could not confirm the flag (an older Play adapter), the receipt says
  `requested: null, reason: "not_acknowledged"` and the CLI warns: the release
  may have been sent for review.
- `play-send-for-review` only works for a release Hands promoted to that track.
  It checks that Play holds the accepted AAB (sha256) and that the track carries
  its versionCode, then commits an edit without `changesNotSentForReview`. Its
  receipt (`play-promotion` / `send-for-review`) records the release lifecycle
  before and after, e.g. `RELEASE_LIFECYCLE_STATE_NOT_SENT_FOR_REVIEW ->
  RELEASE_LIFECYCLE_STATE_IN_REVIEW`. Google does not document that such a
  commit submits changes saved earlier; if the lifecycle did not move to in
  review, send it for review in Play Console.
- If another change is still in review, either step fails with
  `edit_in_review` / `play_edit_in_review` and nothing is retried; wait and run
  it again. An answer Hands cannot classify fails with `edit_state_unknown`:
  check Play Console first.

API: `POST /api/apps/:appId/releases/:releaseId/distributions/play/promote`
with `changes_not_sent_for_review: true`, and
`POST /api/apps/:appId/releases/:releaseId/distributions/play/send-for-review`
with `{track, expected_revision, approval: {note}}` (see OpenAPI).

On a later promotion of the same release, Hands can omit a mapping upload when
an earlier successful receipt confirms the exact file and Play still holds the
same AAB. The new receipt cites the earlier receipt as historical evidence; Play
does not offer a mapping readback, so this does not verify its current contents.
Without that evidence, Hands continues to attempt the upload. To explicitly
replace the mapping, use `play-upload-symbols` below.

## Google Play: backfill mapping / native symbols for a live version

`hands releases play-promote` only accepts a versionCode above the track
maximum, so it cannot attach a mapping to a version that is already on Play.
`play-upload-symbols` uploads the release build's sealed R8/ProGuard mapping
(`proguard`) and/or native debug symbols zip (`nativeCode`) for its versionCode,
which must already be on Google Play. It never changes a track, rollout, bundle
or release notes.

```bash
# Dry run (the default): opens a temporary Play edit, checks the versionCode,
# deletes the edit and prints what would be uploaded. It does not upload files.
hands releases play-upload-symbols raft-android <release> --note "backfill mapping"

# Upload and commit (only the mapping in this example)
hands releases play-upload-symbols raft-android <release> --kinds proguard \
  --note "backfill mapping" --commit
```

- Needs the app **publisher** role as a signed-in human or agent; deploy tokens
  are refused. Uses the same per-package Play edit lock as promote.
- `--kinds` defaults to the mapping and any native archive declared with the
  Android release bundle. A generic native archive added with `builds
  attach-symbols` is selected only when `--kinds nativeCode` is explicit; such an
  archive may cover only part of the app. Promotion also excludes generic native
  attachments and records `attached_native_requires_explicit_selection` when no
  bundle-declared archive is present.
- Uploading a native archive **replaces** that version's existing Play native
  symbols. Before explicitly selecting one, check that it covers every native
  library and ABI you intend to symbolicate; otherwise you may lose coverage.
  Hands cannot read the existing Play symbol file back to compare it.
- If explicit native selection finds different native archives on the build, it
  fails with `symbols_ambiguous` instead of choosing one. `--kinds proguard` is
  unaffected. A build with no selected files fails with `no_symbols`, or with
  `native_symbols_selection_required` when only a generic native attachment exists.
- Play must already hold this versionCode with the release's AAB, otherwise the
  upload fails with `version_not_on_play`. Play can still reject the file even
  when the AAB is present; inspect the returned error and do not assume a retry
  will succeed.
- The adapter attempts to delete an uncommitted Play edit on failure. A lost
  response or failed cleanup can leave the result uncertain, including whether a
  commit completed. Inspect Play and the Hands receipt before retrying; uploading
  again replaces the file of the same type for that versionCode.
- `--commit` writes a receipt (`play-promotion` / `upload-symbols`); the dry run
  writes none and leaves the release revision unchanged. Opening its temporary
  Play edit can invalidate an existing edit made by the same Google user, even
  without a commit.

API: `POST /api/apps/:appId/releases/:releaseId/distributions/play/upload-symbols`
with `{mode?: "dry_run" | "commit", kinds?, expected_revision, approval: {note}}`
(see OpenAPI).

## Google Play: release notes for a version already on a track

`play-promote` sends the release changelog as Play release notes ("What's new"),
but only when it promotes. When a version was promoted without a changelog (or
with the wrong one), promote cannot fix it: it refuses a versionCode that is not
above the track maximum, and a completed release cannot be halted on Play.
`play-release-notes` replaces the notes of the track release that already
carries the release's versionCode, and changes nothing else.

```bash
# 1. Write the reviewed, localized changelog (keys map to Play languages:
#    zh/zh-cn -> zh-CN, en -> en-US, ja -> ja-JP, ...; at most 500 characters each)
hands releases update raft-android <release> \
  --changelog-file zh=play/zh-CN.md --changelog-file en=play/en.md --changelog-file ja=play/ja.md

# 2. Put those notes on the production release (track defaults to production)
hands releases play-release-notes raft-android <release> --note "add 1.23 notes"
```

- Uses the same changelog-to-Play mapping as promote (Markdown `**` stripped,
  unmapped keys skipped and listed, over 500 characters refused). A changelog
  that yields no Play language fails the `release_notes` gate with
  `no_release_notes` before any Play call.
- The release's notes become exactly the mapped list; languages not in the
  changelog are removed from that release. versionCodes, status, rollout
  fraction, country targeting and other releases on the track stay as Play
  returned them, and a readback after the commit checks that.
- The commit is `ERROR_IF_IN_REVIEW` and sends the change for review. While
  another change for the app is in review it fails with `edit_in_review`; wait
  for the review to finish and run it again. Hands never cancels a review.
- Only for a release Hands promoted to that track (`not_promoted_to_track`
  otherwise). Needs the **publisher** role as a signed-in human or agent and the
  per-package Play edit lock. Writes a `play-promotion` / `release-notes`
  receipt; `play-status` (track, rollout) is unchanged.

API: `POST /api/apps/:appId/releases/:releaseId/distributions/play/release-notes`
with `{track, expected_revision, approval: {note}}` (see OpenAPI).

## Google Play Store Listing

Update the Play store listing text (app name, short and full description,
promotional video) and graphics (screenshots, feature graphic, icon) through Hands instead of editing Play Console by hand. Hands
holds the app's Google credential; the CLI never sees it. Requires the app
**publisher** role and a verified, enabled Google Play binding.

```bash
# Export the live listing in the format push accepts
hands store-listing pull raft-android --out listing.json

# Dry run (the default): Hands opens one Play edit, applies the text,
# runs Google's edits.validate, deletes the edit and prints the plan
hands store-listing push raft-android --listing listing.json

# Publish the same change
hands store-listing push raft-android --listing listing.json --commit

# Only some languages from the file
hands store-listing push raft-android --listing listing.json --locales en-US,ja-JP --commit

# Audit trail
hands store-listing receipts raft-android
```

`listing.json` is keyed by Play language tag, with Google's `Listing` field names:

```json
{
  "en-US": { "title": "Raft", "shortDescription": "Chat with your agents", "fullDescription": "…" },
  "zh-CN": { "title": "Raft", "shortDescription": "…", "fullDescription": "…" },
  "ja-JP": { "title": "Raft", "shortDescription": "…", "fullDescription": "…", "video": "https://www.youtube.com/watch?v=…" }
}
```

Google's list form `{ "listings": [ { "language": "en-US", "title": "…" } ] }` is
accepted too. Listing pulls and dry runs open temporary Play edits; creating one
can invalidate an existing edit by the same Google user, even without a commit.

- **Languages** must be Play store listing tags, spelled exactly as Play lists
  them: `en-US`, `zh-CN`, `zh-TW`, `zh-HK`, `ja-JP`, `ko-KR`, `es-ES`, `fr-FR`,
  `de-DE`, `pt-BR`, `iw-IL` (Hebrew), `es-419`, `fil`, … (86 tags, from Play
  Console Help "Translate and localize your app"). `zh-Hans`, `en`, or `en-us`
  are rejected with a suggestion (`zh-Hans (did you mean zh-CN?)`) before any
  Play call.
- **Limits** (Play Console Help "Create and set up your app"): `title` 30,
  `shortDescription` 80, `fullDescription` 4,000 characters, counted per
  character for CJK and Latin alike. Over-long text is rejected
  (`listing_field_too_long`), never truncated.
- **Fields you leave out keep their current Play value.** A language that is not
  on Play yet needs `title`, `shortDescription` and `fullDescription`. `video: ""`
  clears the video.
- Languages on Play that are not in the file are **left untouched** unless you
  pass `--delete-unlisted-languages` (the app's default language is never
  deleted; the flag cannot be combined with `--locales`).
- **In review:** Hands commits with `changesInReviewBehavior=ERROR_IF_IN_REVIEW`
  and never cancels another change that is in review. If one is, the push fails
  with code `play_edit_in_review` and nothing is committed; wait for the review,
  then push again. Hands recognises this from Google's structured error reason
  first and its message second. If Google's answer matches neither (for
  example a localized message), or a commit returns an unexpected response, the
  push fails with `play_edit_state_unknown` and is never reported as done:
  check the app in Play Console before pushing again.
- `--changes-not-sent-for-review` (with `--commit`) sends
  `changesNotSentForReview=true`: for apps whose changes must be sent for review
  manually, the edit is added to the pending changes and you send it for review
  in Play Console. Without it, such an app fails with
  `play_changes_not_sent_for_review`.

### Store listing images

`--images <dir>` replaces screenshots and graphics in the same Play edit as the
text (text first, so a new language exists before its images). Use it alone or
together with `--listing`; dry run by default, `--commit` to publish.

```bash
# The designer export layout works as-is
hands store-listing push raft-android --listing listing.json --images ./shots/play
hands store-listing push raft-android --listing listing.json --images ./shots/play --commit
```

Two directory layouts are accepted (files are uploaded in filename order,
numeric-aware, so `01-…`, `02-…`, … `10-…`):

```text
<dir>/<device>/<language>/NN-name.png      device first (designer export)
<dir>/<language>/<imageType>/NN-name.png   language first
```

| Device folder | Play imageType | Rule checked before any Play call |
| --- | --- | --- |
| `phone` | `phoneScreenshots` | 2-8, JPEG or 24-bit PNG (no alpha), sides 320-3840 px, long side ≤ 2× short side |
| `tablet-7` | `sevenInchScreenshots` | 1-8, same screenshot rules |
| `tablet-10` | `tenInchScreenshots` | 1-8, same screenshot rules |
| `tv` | `tvScreenshots` | 1-8, same screenshot rules |
| `wear` | `wearScreenshots` | 1-8, 1:1, at least 384×384 |
| `feature-graphic` | `featureGraphic` | exactly 1, 1024×500, JPEG or 24-bit PNG |
| `icon` | `icon` | exactly 1, 512×512, 32-bit PNG (with alpha), ≤ 1024 KB |
| `tv-banner` | `tvBanner` | exactly 1, 1280×720, JPEG or 24-bit PNG |

Every image is at most 15,728,640 bytes (Google's upload limit) and one push
carries at most 24 MiB of images; split larger sets with `--locales`.
Google's `appImageTypeUnspecified` is rejected as `image_type_not_supported`.

Language folders are Play tags (`en-US`, `zh-CN`, …) or one of the explicit
aliases `en`→`en-US`, `zh-Hans`→`zh-CN`, `zh-Hant`→`zh-TW`, `ja`→`ja-JP`,
`ko`→`ko-KR`. A `default` folder applies to every target language (from
`--listing`, the other language folders, or `--locales`) that has no folder of
its own for that image type.

Each listed `(language, imageType)` set **replaces** what Play has
(`edits.images.deleteall`, then upload in order); a set Play already holds
byte-for-byte (same sha256 sequence) is skipped. Image types you do not list are
left untouched. Hands checks that every uploaded file matches its declared
sha256 (fail closed). Google's own `Image.sha256` is recorded next to it with
`sha256_match: true|false|null`; a difference is listed in `image_warnings`
and does not fail the push. A commit is read back (image count must match). `--ai-generated-state <aiGeneratedStateNotAiGenerated|
aiGeneratedStateAiGeneratedDeveloperAttested|aiGeneratedStateUnspecified>` is
passed to Google's `aiGeneratedState` for every image. The receipt records each
image's sha256, Google's sha256 and whether they match, size, type, pixel size
and Google image id.

Every push that reaches Google writes an immutable receipt: who, when, edit id,
dry run or commit, the per-language plan, and a sha256 + length of each field.
API: `GET|POST /api/apps/:appId/distributions/play/store-listing`,
`GET /api/apps/:appId/distributions/play/store-listing/receipts` (see OpenAPI).

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

An app publisher then starts the **server-side upload** through the Hands console,
API, or CLI. Poll the returned Apple Build Upload id with the upload-status API until `COMPLETE` or
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
  --notify-testers \
  --json > testflight-publish-receipt.json
```

Preserve that mutation response: `notification=sent` or `already_sent` is the
notification operation receipt. Do not add `--wait` to this receipt-producing
call. With `--wait --json`, the CLI prints the later polled GET status instead
of the original POST response, so `notification` and `operation_id` are not
preserved.

External review can take longer than a normal CLI session. Inspect the live
state separately:

```bash
hands builds testflight-status raft-ios <hands-build-id> \
  --distribution external \
  --json
```

When `--wait` is useful and the POST operation receipt is not part of the
acceptance contract, tune its bounded poll contract with
`--poll-interval-seconds` and `--timeout-seconds` (defaults: 15 and 3600).
Terminal failure/rejection/expiry states fail the command. External mode
requires an existing or supplied What to Test localization; selected group ids
must all match the requested internal/external mode.

Notification values are `not_requested`, `scheduled`, `sent`, and
`already_sent`. Only `sent`/`already_sent`, paired with a fresh exact-build
`external_build_state=IN_BETA_TESTING`, prove notification completion. If the
first response is `scheduled`, wait for that exact testing state, replay the
same publish without `--wait` to preserve `already_sent`, then fresh-read the
status again. `VALID`, group assignment, `BETA_APPROVED`, and
`auto_notify_enabled=false` are not notification receipts.

Hands follows Apple's role boundary: uploading the IPA and TestFlight group
distribution require Hands app publisher. The stored
App Store Connect key must have an Apple role permitted for the requested
operation (external testing: Account Holder, Admin, or App Manager; internal
testing also permits Developer or Marketing). Apple limits beta builds to 90
days and permits at most one build of a version in Beta App Review at a time.

Official Apple references:

- [Prerelease Versions and Beta Testers](https://developer.apple.com/documentation/appstoreconnectapi/prerelease-versions-and-beta-testers)
- [Add internal testers](https://developer.apple.com/help/app-store-connect/test-a-beta-version/add-internal-testers/)
- [Invite external testers](https://developer.apple.com/help/app-store-connect/test-a-beta-version/invite-external-testers/)
- [TestFlight overview](https://developer.apple.com/help/app-store-connect/test-a-beta-version/testflight-overview/)

### TestFlight crash reports and screenshot feedback

Pull what testers submitted from TestFlight, using the app's stored App Store
Connect key (app viewer is enough). Pulling never changes anything on Apple's
side.

```bash
# crashes: newest 20 for one build, each crash log saved as .ips
hands testflight crashes raft-ios --build 11200001 --download ./crashes
# screenshot feedback: tester text, device, build, screenshots
hands testflight feedback raft-ios --build 11200001 --download ./shots
# pin the marketing version too, JSON for scripts
hands testflight crashes raft-ios --build 11200001 --app-version 1.12.0 --json
```

Only crashes a tester chose to share from the TestFlight prompt are available
from Apple's API. Unshared crashes appear only in Xcode Organizer, so an
empty list does not prove the build never crashed. Some shared crashes have no
log on Apple's side (`CRASH_LOG_NOT_AVAILABLE`). Screenshot URLs are signed by
Apple and expire (`expires_at`). Tester emails are not returned.

**Closing (separate, explicit step).** After triage, close the item on Apple's
side. This calls Apple's official TestFlight feedback API, and Apple's only
resolution for a submission is delete: the crash or screenshot feedback is
removed from TestFlight feedback in App Store Connect. Needs app publisher or
the `feedback:triage` permission.

```bash
hands testflight close raft-ios crash <crashId>
hands testflight close raft-ios feedback <feedbackId>
```

API:

| Action | Request |
| --- | --- |
| List crashes | `GET /api/apps/<appId>/testflight-crashes?build=&version=&limit=` |
| Crash log | `GET /api/apps/<appId>/testflight-crashes/<id>/log` (text/plain) |
| List screenshot feedback | `GET /api/apps/<appId>/testflight-feedback?build=&version=&limit=` |
| Close crash | `DELETE /api/apps/<appId>/testflight-crashes/<id>` |
| Close screenshot feedback | `DELETE /api/apps/<appId>/testflight-feedback/<id>` |

For raw CI drafts, a single `--changelog-file ./changelog.txt` is still valid.
For reviewed notes, prefer repeatable `lang=file` entries such as
`--changelog-file zh=zh.md --changelog-file en=en.md`.

## App Store release

`hands app-store` drives an App Store submission through Hands. Every command
that writes to Apple is a dry run unless `--commit` is passed. Details, the
prepare decision table, and the screenshot size table:
[iOS releases & TestFlight](ios-testflight.md#app-store-release-version-listing-screenshots-review).

```bash
hands app-store status raft-ios --version-name 1.17.0
# create, reuse, or rename the version (a withdrawn 1.12.0 becomes 1.17.0)
hands app-store prepare raft-ios --version-name 1.17.0 --build <asc-build-id> [--commit]
# listing text: { "en-US": { "description": "...", "keywords": "...", "promotionalText": "...",
#                 "whatsNew": "...", "supportUrl": "...", "marketingUrl": "..." } }
# a locale new to the version needs description, keywords and supportUrl
hands app-store localizations push raft-ios --version-name 1.17.0 --file listing.json [--commit]
# screenshots: shots/<locale>/<display_type>/NN.png, e.g. shots/en-US/APP_IPHONE_67/01.png
hands app-store screenshots push raft-ios --version-name 1.17.0 --dir shots [--locales en-US,ja] [--commit]
# read-only readiness check; exits 1 when any error is found
hands app-store preflight raft-ios --version-name 1.17.0 [--json]
hands app-store submit raft-ios --version-name 1.17.0 [--commit]
hands app-store withdraw raft-ios --version-name 1.17.0 [--commit]
# after approval (PENDING_DEVELOPER_RELEASE): release -- irreversible
hands app-store release raft-ios <asc-version-id> --version-name 1.17.0 [--build <asc-build-id>] [--commit]
```

`screenshots push --commit` exits non-zero unless every set is `ok`: code
`SCREENSHOTS_FAILED` if any set failed (or was not attempted after an auth or
other run-wide error), else `SCREENSHOTS_PENDING` if Apple was still processing
uploaded screenshots. For pending sets, run the dry run again later: if every
set is `unchanged`, files and order are confirmed; if a set shows `reorder` or
`replace`, run `--commit` again.

`preflight` is read-only (viewer role; Hands sends only GET requests to Apple).
It prints findings grouped as errors, warnings and info, each with the check,
locale / display type, Apple resource path (the same path Apple names in a
refused submit's associated errors) and a fix. It exits 1 when there is any
error. `submit` without `--commit` runs it too and prints its errors.

`--release-type MANUAL|AFTER_APPROVAL` on `prepare` is applied to a created,
reused or renamed version; without it an existing version keeps Apple's
release type.

`release` refuses unless `--version` (and `--build`, when given) match what
Apple holds for that version. It prints `Released` only when Apple reads back
`READY_FOR_SALE`; otherwise it reports `Release requested` with Apple's current
state (Apple releases asynchronously). An already-live version is an error
(`ALREADY_RELEASED`), not a success.

The CLI is a dry run unless `--commit` for every command. On the API, prepare
defaults to `mode: "commit"` for backward compatibility (its writes are
reversible), while listing text, screenshots and release have no default
`mode` (they overwrite live store content or cannot be undone).

`--version-id <asc-version-id>` can replace `--version` on the push commands.
Screenshot files are ordered by name, numeric-aware (`2-` before `10-`). A
push of screenshots identical to Apple's (same MD5s, same order) writes
nothing. A refused or failed push prints the per-set or per-locale plan
before the error; `--json` prints the full response.

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

### AppGallery invitation testing (OHOS)

Hands can push a build's signed `.app` to AppGallery Connect as an
**invitation test** (Huawei App Testing, `releaseType=6`). Store listing
submission and phased release are not automated yet; do those in AppGallery
Connect. The app needs AGC Service Account credentials (Settings → AppGallery)
and the channel `bundle_id` set to the HarmonyOS package name.

CLI (0.5.30+, app admin role):

```bash
hands agc groups raft-ohos
hands agc upload raft-ohos <buildId> --package-name build.raft.mobile \
  --test-desc "1.12.0 (11200003)" --wait
hands agc submit raft-ohos <submissionId> --group <groupId>
hands agc status raft-ohos <submissionId> --events   # or: <buildId> --build
```

`upload` reuses an open attempt for the build. After `failed`, `rejected`, or
`stopped`, it starts a new attempt (a new AGC test version); the earlier
submission keeps its history. A failed response can leave a provider operation
uncertain, so inspect the submission and Huawei before trying another upload.
`hands agc market-status` may also record a terminal package state and enqueue a
notification; it is not automatically replayed after a 401.

The same flow over the admin API with `hands api`:

```bash
APP=/api/apps/<appId>
# 1. Upload the build's .app and create the test version (reuses an open attempt).
hands api POST $APP/builds/<buildId>/agc-invitation-test \
  --data '{"package_name":"build.raft.mobile","test_desc":"1.12.0 (11200003)"}' --json
# 2. Poll until state is "ready" (Huawei compiles the package, ~1-3 min).
hands api GET $APP/agc-submissions/<submissionId> --json
# 3. List groups, then submit to one or more of them.
hands api GET $APP/agc-test-groups --json
hands api POST $APP/agc-submissions/<submissionId>/submit \
  --data '{"group_id":"<groupId>"}' --json
# 4. Re-read for Huawei's review outcome.
hands api GET $APP/agc-submissions/<submissionId> --json
```

`submit` requires an explicit `group_id`/`group_ids` when the app has more than
one test group; with exactly one group it uses that group. Every `GET` of a
submission re-reads Huawei while the outcome is still open. If a package has
finished compiling, that GET can also bind the package to the test version in
Huawei. The CLI does not replay this status request after a 401; if the outcome
is uncertain, inspect the submission and Huawei before retrying. The stored
state follows AppGallery:

| Hands `state` | Huawei test `releaseState` |
| --- | --- |
| `processing` | package still compiling (`successStatus` 1) |
| `ready` | compiled and bound; `7` 准备提交 / `11` 撤销审核 |
| `testing_review` | `4` 正在审核 / `12` 预审中 |
| `testing_scheduled` | `3` 待生效 |
| `testing_active` | `0` 正在测试 |
| `rejected` | `1` 审核不通过 / `13` 预审不通过 (`provider_state.audit_opinion` has Huawei's reason) |
| `stopped` | `2` / `10` 已失效 |
| `failed` | upload error, or Huawei could not compile the package (`successStatus` 2); upload again to retry |

The raw `release_state`, `audit_opinion`, and test window are kept in
`provider_state`. If Huawei cannot be reached the response still returns the
stored submission plus `sync_error`.

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
a `desktop-installer` build/release (legacy name `electron-installer` also works), then create a draft release for review:

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
hands releases publish raft-android <release-id> --device-group <group-id>
```

The final publish remains an explicit authorization step. The CLI first reads
release detail, canonicalizes every stored scope, and sends the complete set as
`expected_scopes` together with that detail's `expected_revision`. The update
command also fresh-reads and sends the revision before PATCH. Empty, duplicate,
malformed, or unsupported scope state is
rejected locally without a publish request. A repeatable `--device-group`
asserts the exact stored device-group subset. Activation returns `409` if any
scope or revision drifts between the detail read and the guarded server
transition.
Only exact group members receive the release; other devices fall back to the
prior active release. List groups with `hands device-groups list <app>` and
remove members with `device-groups remove-member`. Rename or change the
operator note with `device-groups update`. Do not use IMEI or hardware serial
numbers.

### Percentage rollout with mandatory groups

One release can combine a percentage-gated `full:all` scope with device groups
whose members are always included:

```bash
hands releases update raft-android <release-id> \
  --full \
  --rollout-percent 25 \
  --always-include-group <acceptance-group-id> \
  --always-include-group <qa-group-id>

hands releases publish raft-android <release-id> \
  --device-group <acceptance-group-id> \
  --device-group <qa-group-id>
```

`--always-include-group` is repeatable and implies `full:all`; `--full` by
itself resets the scope to full only. `--rollout-percent` accepts integers from
0 through 100, with 100 stored as an unrestricted full rollout. The legacy
update form `--device-group <id>` still replaces the scope with one exact
group-only rollout and cannot be combined with the full-rollout options.

There is one non-cancelled release owner per
app/channel/product/release-type/version code. The publish commands preflight
that coordinate before creating a build or uploading assets. Cancelling
disables the old release and frees the version for a corrected upload while
preserving its build, assets, and audit history. Restore reactivates an old
release only while no replacement owns the version. A rare conflict that wins
after CLI preflight marks the new build `failed`, writes the conflict identity
to provenance, and includes the build ID in the terminal error. For Android
releases that already reached devices, publish the correction with a higher
version code so clients can update.

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
hands feedback list raft-android --kind crash --crash-type system_kill
hands feedback list raft-ios --build-scope external
hands feedback show raft-android <ticket-id>
hands feedback update raft-android <ticket-id> --status in_progress --assignee me
hands feedback comment raft-android <ticket-id> "已复现，修复中"
hands feedback update raft-android <ticket-id> --status resolved
hands feedback update raft-android <ticket-id> --status closed --closure-reason completed
hands feedback update raft-android <ticket-id> --closure-reason duplicate --duplicate-of <canonical-ticket-id>
```

`--assignee none` unassigns. Closing a ticket requires `--closure-reason`
(`completed`, `not_planned`, `cannot_reproduce`, `duplicate`, or
`no_longer_needed`), plus `--duplicate-of <ticket-id>` for duplicates. All
subcommands accept `--json` for scripting.
For iOS apps that enable external report separation, `--build-scope` accepts
`standard`, `external`, or `all`; the default includes configured and unknown
origins. Bundle IDs are client-reported and do not verify identity.

## App Webhooks

App admins can subscribe an endpoint to one app's events without org-admin
rights. The server pins these webhooks to the app; org-wide webhooks (all apps)
remain org-admin-only and are not listed here.

```bash
# Secret generated and printed once:
hands webhooks create my-app --url https://example.com/hands --events release:new,build:failed
# Or bring your own secret (never on argv):
printf %s "$HOOK_SECRET" | hands webhooks create my-app --url https://example.com/hands --secret-stdin
hands webhooks list my-app
hands webhooks deliveries my-app <webhook-id>
hands webhooks update my-app <webhook-id> --disable
printf %s "$NEW_SECRET" | hands webhooks update my-app <webhook-id> --secret-stdin
hands webhooks delete my-app <webhook-id>
```

`release:new` payloads carry `release_id`, `app_id`, `build_id`, `channel_id`
plus `version_name`, `version_code`, `app_slug` and `channel` (slug), so a
consumer can link the pinned public page `https://hands.build/apps/<app_slug>/v/<version_name>`
without an API call.

Omitting `--events` subscribes to all events. Deliveries carry
`X-Hands-Signature: sha256=<hex>` (HMAC-SHA256 of the raw body with the secret). REST:
`/api/apps/:appId/webhooks` (list/create), `/api/apps/:appId/webhooks/:id`
(PATCH/DELETE), `/api/apps/:appId/webhooks/:id/deliveries`.

## Direct API Access (`hands api`)

A power-user / scripting affordance for calling a Hands API endpoint directly,
over the **same** server-side RBAC, audit, and per-endpoint guards a dedicated
subcommand uses. It is not a permission bypass and not a generic-SQL escape
hatch — every write still hits the same server route.

```bash
# GET with repeatable query params
hands api GET /api/apps --param platform=android

# PATCH with an inline JSON body. NOTE: path params are raw — <appId> is the app
# UUID, not a slug: `hands api` passes the path through and does not resolve slugs.
hands api PATCH /api/apps/<appId>/releases/<releaseId>/shares/<shareId> \
  --data '{"expires_at":null}'

# ...or read the same body from a file with @path
hands api PATCH /api/apps/<appId>/releases/<releaseId>/shares/<shareId> \
  --data @body.json

# Binary / same-origin streaming response: write the raw bytes to a file
hands api GET /api/apps/<appId>/feedback/<ticketId>/attachments/<attachmentId> \
  --output attachment.bin

# Machine-readable: print only the response body (no status line)
hands --json api GET /api/apps
```

- **Raw path params.** `<appId>` and the other ids are the resource UUIDs, not
  slugs — `hands api` passes the path through verbatim and does not resolve
  slugs the way the dedicated subcommands do.
- **No automatic 401 replay.** A direct API request is sent once, even for GET:
  some reads create provider edits. Managed-agent credentials are still refreshed
  proactively before sending. If a 401 or lost response leaves the outcome
  uncertain, inspect current state before retrying.
- **Same-origin `/api/*` only.** `<path>` is resolved against the active Hands
  API base (honoring the root `--api` flag). A relative path or a **same-origin
  absolute URL** is accepted; cross-origin absolute URLs, `//protocol-relative`
  hosts, and `../` traversal that escapes the origin are rejected — so the
  Authorization bearer never leaves the Hands origin.
- **Redirects are never followed.** A `3xx` is reported, not chased; following a
  redirect off-origin would leak the bearer.
- **Auth + RBAC unchanged.** Reuses your existing CLI login/token; the server
  enforces the same role checks as any other call.
- Flags: `--param key=value` (repeatable), `--data <json|@file>`,
  `--output <file>` (required for binary). Both the global `--api` and `--json`
  flags are honored.

### App Store analytics reports

Apple produces App Store analytics reports (installs, deletions, sessions,
active devices) only after an analytics report request exists for the app, and
requests can only be created through the API. An app admin starts them once:

```bash
hands api POST /api/apps/<appId>/stats/app-store/analytics-report-requests
```

Hands resolves the App Store Connect app from the main channel's bundle id and
creates an `ONGOING` request (daily from now on) and a `ONE_TIME_SNAPSHOT`
request (history). Requests that already exist are reused, so running it again
is safe; an `ONGOING` request Apple stopped for inactivity is replaced. The
response lists each request and whether it was created. Apple usually delivers
the first reports within one to two days. The App Store Connect API key needs a
role that can read analytics, such as Admin.

Once reports exist, Hands downloads them on its own: a scheduled job checks
each app with an App Store Connect key every few hours and reads each new daily
report once. An app admin can run the same bounded read immediately:

```bash
hands api POST /api/apps/<appId>/stats/app-store/ingest
```

`hands stats <app>` then shows an App Store Analytics line with totals for the
window and a table of the most recent days; `hands stats <app> --json` (or
`GET /api/apps/<appId>/stats`) returns them as `stores.app_store.daily`,
`stores.app_store.totals`, `stores.app_store.analytics_ingest` and
`stores.app_store.analytics_note`. These come from Hands' own storage, so they
are included with `--no-live` too.

| Field | Apple report | Meaning |
|---|---|---|
| `downloads_first_time` | App Downloads Standard | First-time downloads (`Download Type` = First-time download) |
| `downloads_redownload` | App Downloads Standard | Redownloads by people who had the app before. Updates and restores are not counted |
| `installations` / `deletions` | App Store Installation and Deletion Standard | Install and delete events |
| `sessions` | App Sessions Standard | App sessions |
| `active_devices` | App Sessions Standard | Sum of Apple's `Unique Devices` over the report's rows |

What these numbers can and cannot tell you:

- **They undercount.** Installation, deletion, session and device figures only
  include people who agreed to share analytics with app developers, and Apple
  drops rows that fall below its privacy thresholds (small territories, rare
  versions). Expect them to be lower than the totals App Store Connect shows.
- **They lag.** Apple publishes a day's report one to two days later, so the
  most recent days are missing at first.
- **`active_devices` is an estimate.** A device that appears in more than one
  row of a day (for example, on two app versions) is counted more than once,
  and the value cannot be added across days. `totals` therefore gives the
  highest daily value, `active_devices_peak_daily`, instead of a sum. For exact
  active devices of builds that include the Hands SDK, use `direct.devices`.
- **A missing value is `null`, not 0:** no report covered that metric on that
  day.
- If Apple changes a report's columns, Hands records a warning (for example
  `missing_column Unique Devices`) in `analytics_ingest.warnings` and leaves
  that metric empty rather than guessing. Reports with a missing required
  column or an unrecognised value are counted in
  `analytics_ingest.instances_incomplete` and read again every six hours, so
  they fill in by themselves once Hands supports the new layout. Reports that
  could not be downloaded (`instances_failed`) are retried on the same
  schedule. A report larger than Hands reads at once (more than 50 files or
  32 MiB compressed for one day) is counted in `instances_over_limit`, with
  the reason in `last_error_code`; it is also checked again every six hours.
- Each downloaded file is checked against the checksum Apple publishes for it
  and rejected if it does not match. If Apple sends no checksum, or one in a
  format Hands cannot check, the file is used and the warning
  `checksum_missing` or `checksum_unverified` is shown.

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


## Store subscription products

Use `hands store-products apply <app> --file products.json` to preview subscription changes, then add `--commit` after review. See [Store subscription products](./store-products.md) for the file format, price and activation behavior, and recovery procedure.
