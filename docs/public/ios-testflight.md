---
title: "iOS Releases & TestFlight"
description: "How iOS builds reach TestFlight: Hands uploads server-side with the stored ASC credential."
category: "For agents"
order: 6
---

# iOS releases & TestFlight

How a Raft iOS build travels from CI to TestFlight. The key fact: **Hands
uploads to Apple server-side** — the App Store Connect credential lives
encrypted in Hands, and the `.p8` key never leaves it. CI does not need Apple
upload credentials, and nobody runs `altool`.

## The flow

```
iOS Release workflow          Hands                          Apple
────────────────────          ─────                          ─────
build + sign IPA  ──────────▶ build + assets in R2
                              (publish_hands=true)
                              testflight-upload  ───────────▶ Build Upload API
                              (streams IPA from R2)           PROCESSING → COMPLETE
                              testflight-publish ───────────▶ VALID build
                              groups + What to Test           internal testing, or
                              beta review + notify            external Beta Review
```

1. **Build + sign + publish** — dispatch the `iOS Release` workflow
   (botiverse/mobile) with `publish_hands=true`. It builds, signs with the
   distribution certificate, and uploads the IPA + dSYM to Hands as a build
   (usually with a draft release).
2. **Upload to TestFlight** — trigger the server-side upload for that build:

   ```
   POST /api/apps/{app_id}/builds/{build_id}/testflight-upload
   ```

   Hands streams the IPA from R2 straight to Apple's Build Upload API
   (create → register file → part PUTs → commit) and returns the initial
   state. Console: the build row's TestFlight action.
3. **Poll upload processing** —

   ```
   GET /api/apps/{app_id}/testflight-uploads/{build_upload_id}
   ```

   Read the nested `state.state` field:
   `AWAITING_UPLOAD → PROCESSING → COMPLETE | FAILED`; the same object retains
   Apple's errors, warnings, and infos. `COMPLETE` means Apple accepted the
   upload transaction; wait until the corresponding build resource reports
   `processingState=VALID` before distribution.
4. **List beta groups** — use the processed Hands build to resolve the exact
   App Store Connect app and list stable group ids:

   ```
   GET /api/apps/{app_id}/builds/{build_id}/testflight-groups
   ```

5. **Publish to TestFlight** — assign the exact processed build to groups and
   write localized What to Test metadata:

   ```
   POST /api/apps/{app_id}/builds/{build_id}/testflight-publish
   {
     "distribution": "internal",
     "group_ids": ["<asc-beta-group-id>"],
     "what_to_test": {
       "en-US": "Verify login and Activity.",
       "zh-Hans": "验证登录和活动页。"
     },
     "notify_testers": false
   }
   ```

   Internal mode adds only internal groups. External mode adds only external
   groups, submits `betaAppReviewSubmissions`, and sets
   `buildBetaDetails.autoNotifyEnabled`. When an external build is already
   approved, `notify_testers=true` creates the official
   `buildBetaNotifications` resource only when automatic notification was not
   already enabled.
6. **Refresh distribution state** —

   ```
   GET /api/apps/{app_id}/builds/{build_id}/testflight-publish?distribution=external
   ```

   The response keeps Apple's raw processing, expiry, internal/external build,
   Beta App Review, auto-notify, assigned-group, and localization state. It
   distinguishes `waiting_for_review`, `in_review`, `approved_not_notified`,
   `testing`, `rejected`, `expired`, and processing failures.
7. **Expire an exact beta build when it must leave testing** — after explicit
   human authorization, an app admin supplies all three independent
   confirmations from the status response:

   ```
   POST /api/apps/{app_id}/builds/{build_id}/testflight-expire
   {
     "asc_build_id": "<exact-asc-build-id>",
     "confirm_version": "1.0.0",
     "confirm_build_number": "1000006"
   }
   ```

   Hands resolves the immutable build tuple again, refuses any ASC id or
   version/build mismatch, sets only the ASC Build resource's `expired` flag,
   and immediately reads the same build back. Before the Apple mutation it
   stores a redacted operation intent containing the actor and exact build
   coordinate; PATCH/readback success or failure terminalizes that receipt.
   Retrying an already-expired exact build is a `200` no-op with
   `changed=false` and links to any prior PATCH-confirmed operation, so a lost
   readback or audit response cannot erase who triggered the mutation.
   Expiration removes TestFlight availability; Apple keeps the build record for
   audit/history. Responses include `operation_id` for supported inspection.

These endpoints and the matching CLI/integration actions are TestFlight-only.
They never activate a Hands release and never create, submit, or release an
App Store production version.

## Publication receipts and common pitfalls

Treat upload, review, tester notification, and App Store production as four
different boundaries:

- Build Upload `COMPLETE` and ASC build `VALID` prove only that Apple accepted
  and processed the binary.
- Group assignment, What to Test, `BETA_APPROVED`, or
  `approved_not_notified` prove eligibility, not tester notification.
- `auto_notify_enabled` is a scheduling-policy field, not an event log.
  `false` can appear before or after a manual notification and cannot prove
  that notification did not happen.
- TestFlight tester notification never activates a Hands release and never
  publishes an App Store production version.

For an external publish that must notify testers, preserve two independent
receipts:

1. The mutation response from `testflight-publish` must have
   `notification=sent` or `notification=already_sent`.
2. A fresh, separate `testflight-status` read must show
   `external_build_state=IN_BETA_TESTING` for the exact ASC build.

Do not add `--wait` to the receipt-producing CLI call. The current
`testflight-publish --wait --json` implementation prints the final polled GET
status instead of the original POST response; GET status does not contain the
POST `notification` or `operation_id`. Use the publish command without
`--wait`, save its JSON, and poll separately with `testflight-status`.

The `notification` enum is deliberate:

| Value | Meaning | Notification complete? |
| --- | --- | --- |
| `not_requested` | No notification requested | No |
| `scheduled` | Auto-notify is pending review/testing | No |
| `sent` | Manual notification operation succeeded | Yes, with fresh `IN_BETA_TESTING` |
| `already_sent` | Idempotent replay found notification already complete | Yes, with fresh `IN_BETA_TESTING` |

When the first mutation returns `scheduled`, wait until the exact build reaches
`IN_BETA_TESTING`, then replay the same publish without `--wait`. Preserve the
expected `already_sent` receipt and fresh-read the exact status once more. If
either receipt is missing after a bounded recheck, report notification as
unverified rather than calling the build published or sent.

## One-time setup (app admin)

Store the App Store Connect API credential in Hands: console → App →
Settings → TestFlight (`PUT /api/apps/{app_id}/asc-credentials`). Generate the
key in App Store Connect → Users and Access → Integrations (App Manager role);
you need the Key ID, Issuer ID, and the `.p8` file. The credential is
encrypted at rest and can be verified without exposing it
(`POST .../asc-credentials/verify`). The same credential powers the
App Store review-state surface (`GET /api/apps/{app_id}/appstore-review`).
Hands is the credential's only home — CI never needs a copy, so rotation
stays single-source.

Hands roles are intentionally split: uploading a build to Apple and
distributing it both require app publisher (upload is a publishing action on
your own app, and a publisher-scoped CI token must be able to drive it),
expiring an exact beta build requires app admin, and status/group reads
require app viewer. Apple's own role boundary still applies to the stored key: external
testing requires Account Holder, Admin, or App Manager; internal testing also
permits Developer or Marketing.

Before first external testing, App Store Connect must have the required Beta
App Description, feedback email, contact information, and export-compliance
answers. Hands fails closed and returns Apple's actionable state/error if those
prerequisites are missing. Apple allows only one build of a version in Beta App
Review at a time and up to six submitted builds in a 24-hour period.

## Versioning rules

- The **marketing version** (e.g. `1.0.0`) may repeat across uploads.
- The **build number** (`versionCode`, e.g. `1000004`) must be unique and
  ascending for that marketing version — Apple rejects reused build numbers.
  Hands build history is the quick way to see the last used code.
- TestFlight access expires 90 days after upload.
- External distribution is fail-closed: Apple must explicitly return
  `build_audience_type=APP_STORE_ELIGIBLE`. `INTERNAL_ONLY`, missing, or future
  unknown audience values are rejected before any localization, group, review,
  or notification mutation.

## CLI and Raft actions

CLI:

```sh
hands builds testflight-groups <app> <hands-build-id>
hands builds testflight-publish <app> <hands-build-id> \
  --distribution external \
  --group-id <asc-beta-group-id> \
  --what-to-test en-US="Verify the release candidate." \
  --notify-testers \
  --json > testflight-publish-receipt.json
hands builds testflight-status <app> <hands-build-id> \
  --distribution external \
  --json
```

Raft integration actions:

- `get-testflight-beta-app-description`
- `update-testflight-beta-app-description`
- `upload-testflight-build`
- `get-testflight-upload-status`
- `list-testflight-groups`
- `expire-testflight-build`
- `publish-testflight-build`
- `get-testflight-publish-status`
- `prepare-app-store-version`, `set-app-store-localizations`,
  `set-app-store-release-notes`, `submit-app-store-version`,
  `withdraw-app-store-version`, `release-app-store-version`,
  `get-app-store-release-status`, `get-app-store-preflight`
  (screenshots are multipart; use the CLI)

Agents pass Hands app/build ids and stable beta group ids. The integration
never returns the `.p8` credential.

Beta App Description is app-level invitation copy and uses
`betaAppLocalizations.description`. It is not the build-level What to Test
field (`betaBuildLocalizations.whatsNew`). The dedicated update action preserves
unsupplied locales and succeeds only after exact Apple readback.

## App Store release (version, listing, screenshots, review)

The whole App Store submission runs through Hands with the stored App Store
Connect key; nothing needs the App Store Connect website. Every step that
changes something at Apple is a dry run in the CLI unless `--commit` is passed.

On the API, `mode` defaults differ on purpose:

- prepare (`POST .../app-store/versions`) defaults to `commit` for backward
  compatibility. Its writes are reversible: the version string, build and
  release type can all be changed again by another prepare.
- listing text and screenshots have no default `mode`: they overwrite live
  store content, so the caller must say `dry_run` or `commit`.
- release has no default `mode` either: it is irreversible.

```sh
# 1. version + build: create, reuse, or rename (see below)
hands app-store prepare raft-ios --version-name 1.17.0 --build <asc-build-id>            # plan
hands app-store prepare raft-ios --version-name 1.17.0 --build <asc-build-id> --commit
# 2. listing text per locale
hands app-store localizations push raft-ios --version-name 1.17.0 --file listing.json   # plan
hands app-store localizations push raft-ios --version-name 1.17.0 --file listing.json --commit
# 3. screenshots: shots/<locale>/<display_type>/NN.png
hands app-store screenshots push raft-ios --version-name 1.17.0 --dir shots              # plan
hands app-store screenshots push raft-ios --version-name 1.17.0 --dir shots --commit
# 4. review: preflight (read-only), then submit
hands app-store preflight raft-ios --version-name 1.17.0
hands app-store submit raft-ios --version-name 1.17.0 --commit
hands app-store status raft-ios --version-name 1.17.0
hands app-store withdraw raft-ios --version-name 1.17.0 --commit
# 5. after approval (MANUAL release type): release -- irreversible
hands app-store release raft-ios <asc-version-id> --version-name 1.17.0 --build <asc-build-id>            # plan
hands app-store release raft-ios <asc-version-id> --version-name 1.17.0 --build <asc-build-id> --commit
```

### Preflight: is the version ready for review?

`GET /api/apps/{appId}/app-store/versions/{versionId}/preflight` (app viewer)
is read-only: every call Hands makes to App Store Connect is a GET. CLI:
`hands app-store preflight <app> --version-name 1.17.0 [--json]` exits 1 when
any error is found; `hands app-store submit` without `--commit` prints the
errors too. Submit itself is not blocked by it.

The response is `{version_id, version_string, state, ready, findings, checked,
not_checkable}`. Each finding has `severity` (`error`, `warning`, `info`),
`check`, optional `locale` / `display_type`, `resource`, `message` and `fix`.
`resource` uses the paths Apple uses in a refused submit's associated errors
(for example `/v1/appStoreVersionLocalizations/<id>`), and a missing field
reads as Apple words it ("You must provide a value for the attribute
'supportUrl'").

| Check | Severity |
| --- | --- |
| `version_state`: editable (`PREPARE_FOR_SUBMISSION`, `DEVELOPER_REJECTED`, `REJECTED`, `METADATA_REJECTED`, `INVALID_BINARY`) | error otherwise; `WAITING_FOR_REVIEW` / `IN_REVIEW` is info |
| `build`: attached, `VALID`, not expired | error |
| `build`: build's version string differs from the App Store version | warning |
| `export_compliance`: `usesNonExemptEncryption` unset on the build | warning |
| `copyright` empty | warning |
| `localization_required_fields`: description, keywords, supportUrl per locale | error |
| `localization_whats_new`: empty whatsNew (required unless first version) | info |
| `localization_lengths`: description 4000, keywords 100, promotionalText 170, whatsNew 4000 | warning |
| `app_info_localizations`: each version locale has an app name; privacy policy URL on the primary locale | error (privacy URL on other locales: warning) |
| `screenshots`: primary locale has a 6.9"/6.5" iPhone set (`APP_IPHONE_67` / `APP_IPHONE_65`); every screenshot `COMPLETE` | error |
| `screenshots`: other locales without screenshots fall back to the primary | info |
| `screenshots`: iPad sets exist but none 13" (`APP_IPAD_PRO_3GEN_129`) on the primary | warning; when Hands cannot tell whether the app runs on iPad, info |
| `review_detail`: contact first/last name, phone, email; demo account name and password when `demoAccountRequired` | error |
| `age_rating`: no age rating declaration | warning |
| `review_submission`: another version holds an open submission (`WAITING_FOR_REVIEW`, `IN_REVIEW`, `UNRESOLVED_ISSUES`) | error; this version's own submission or a draft is info |

A resource Apple refuses to return becomes a warning `unreadable:<what>` with
Apple's status, code and detail; the rules that need it are listed in
`not_checkable`. `ready` is true only with no error, no unreadable resource,
and every rule run. App Privacy answers are not in the public App Store
Connect API, and pricing/availability, content rights and categories are not
read yet: they are always listed in `not_checkable`.

### Prepare: one unreleased version per platform

Apple allows only one not-yet-released App Store version per platform. A
withdrawn version (for example 1.12.0, now `DEVELOPER_REJECTED`) still occupies
that slot, so creating 1.17.0 fails with Apple's 409 "You cannot create a new
version of the App in the current state." Prepare reads every version for the
platform (`include=build`) and decides:

| Apple has | Prepare does | `action` |
| --- | --- | --- |
| a version with the requested string, editable | attaches the build | `reused` |
| a version with the requested string, not editable | 409 `VERSION_NOT_EDITABLE` | - |
| another unreleased version Apple holds (`WAITING_FOR_REVIEW`, `IN_REVIEW`, `PENDING_DEVELOPER_RELEASE`, ...) | 409 `VERSION_IN_FLIGHT`, naming it; withdraw it first | - |
| exactly one editable, never-released version (`PREPARE_FOR_SUBMISSION`, `DEVELOPER_REJECTED`, `REJECTED`, `METADATA_REJECTED`, `INVALID_BINARY`) | renames it to the requested string and attaches the build in one PATCH | `renamed`, with `previous_version_string` |
| only released versions | creates the version, then attaches the build | `created` |

A version in a state Hands does not recognise, or two editable versions,
refuses (409 `VERSION_STATE_UNKNOWN` / `MULTIPLE_EDITABLE_VERSIONS`) rather
than guessing. After the write Hands reads the version back
(`GET /v1/appStoreVersions/{id}?include=build`); a version string or build that
does not match returns 502 `READBACK_MISMATCH`. A failure after an earlier
write returns 502 `PREPARE_PARTIALLY_APPLIED` with `completed_steps`. Renaming
keeps the version's existing localizations and screenshots.

`release_type` (`MANUAL` or `AFTER_APPROVAL`) applies to every action. On a
reused or renamed version Hands sends `releaseType` only when it differs from
Apple's current value (in the same PATCH as the rename and build), and the
read-back must show it (502 `READBACK_MISMATCH` with `release_type` otherwise).
When `release_type` is omitted, a created version gets `MANUAL` and an existing
version keeps whatever Apple has; prepare never resets it. `SCHEDULED` is
refused with 400 `RELEASE_TYPE_SCHEDULED_UNSUPPORTED`, because Apple needs an
`earliestReleaseDate` that Hands does not set. The response (dry run included)
carries `changes: { version_string, build, release_type }`, each `{from, to}`
or `null` when unchanged; `release_type` is Apple's value (read back after a
commit) and `requested_release_type` is what was asked (`null` if omitted).

### Release an approved version

With release type `MANUAL`, an approved version waits at
`PENDING_DEVELOPER_RELEASE`. Releasing it is **irreversible**:

`POST /api/apps/{appId}/app-store/versions/{versionId}/release` (app publisher)
with `{ "mode": "dry_run" | "commit", "version_string": "1.17.0", "asc_build_id": "<optional>" }`.

- `mode` is required; `dry_run` only reads.
- `version_string` (and `asc_build_id` when given) must equal what Apple holds
  for that version, or 409 `RELEASE_CONFIRMATION_MISMATCH`; nothing is sent.
- Only `PENDING_DEVELOPER_RELEASE` is released. A version already live
  (`READY_FOR_SALE` / `READY_FOR_DISTRIBUTION`, or retired) is 409
  `ALREADY_RELEASED`, which is not a success. Any other state is 409
  `NOT_RELEASABLE` with the state.
- On commit Hands records an operation receipt (kind `app-store-release`) and
  an `app_store.release_intent` audit row first; if either cannot be written,
  nothing is sent to Apple (500 `RELEASE_INTENT_NOT_RECORDED`). Then it sends
  `POST /v1/appStoreVersionReleaseRequests` and reads the version back for up
  to about 30 seconds. The result is recorded as `app_store.release` (or
  `app_store.release_failed`).
- `200` with `outcome: "released"` only when Apple shows `READY_FOR_SALE` /
  `READY_FOR_DISTRIBUTION`. Otherwise `202` with
  `outcome: "release_requested"` and `observed_state`: Apple releases
  asynchronously, so check `hands app-store status` later.
- Apple's release-request resource cannot be listed, so duplicates are
  guarded by the version state plus the Hands receipt: within 6 hours of an
  accepted request a repeat call returns `202 release_requested` with
  `prior_operation_id` and sends nothing; while another release call is still
  running it is 409 `RELEASE_IN_PROGRESS`.

State changes after the release reach webhooks through the existing
`app_store:version_state_changed` event.

### Listing text

`POST /api/apps/{appId}/app-store/versions/{versionId}/localizations` with
`{ "mode": "dry_run" | "commit", "localizations": { "<locale>": { ... } } }`.
Fields are Apple's `appStoreVersionLocalizations` attributes: `description`
(at most 4000 characters), `keywords` (100), `promotionalText` (170),
`whatsNew` (4000), `marketingUrl`, `supportUrl` (http or https). Only supplied
fields are written; an existing locale is patched with the changed fields
only, a missing locale is created. Creating a locale requires `description`,
`keywords` and `supportUrl` (Apple accepts the create without them but then
refuses review); without them the plan entry is blocked with
`missing_required_fields` and lists `missing_fields`. The What's New endpoint
(`.../notes`) only updates existing locales and returns 409
`LOCALIZATION_MISSING` for one that does not exist. While Apple holds the version only
`promotionalText` may change; other fields return 409
`LOCALIZATION_PLAN_BLOCKED`. Commit reads every requested field back and fails
with `READBACK_MISMATCH` if Apple holds anything else. App name and subtitle
live on `appInfoLocalizations` and are not covered yet.

### Screenshots

`POST /api/apps/{appId}/app-store/versions/{versionId}/screenshots`,
multipart: a `request` JSON part
`{ "mode": "dry_run" | "commit", "sets": [ { "locale": "en-US", "display_type": "APP_IPHONE_67", "images": [ { "part": "img1", "sha256": "<hex>" } ] } ] }`
plus one file part per image, at most 24 MiB of images per push.

Checked before any Apple call: sha256 of each part, PNG or JPEG, no
transparency (a PNG with an alpha channel or tRNS chunk is refused; flatten
it), 1-10 images per set, and an exact pixel size for the display type
(portrait or landscape):

| `display_type` | Sizes (portrait) |
| --- | --- |
| `APP_IPHONE_67` (6.9" and 6.7") | 1320x2868, 1290x2796, 1260x2736 |
| `APP_IPHONE_65` | 1242x2688, 1284x2778 |
| `APP_IPHONE_61` (6.3" and 6.1") | 1206x2622, 1179x2556, 1170x2532, 1125x2436, 1080x2340 |
| `APP_IPHONE_55` | 1242x2208 |
| `APP_IPAD_PRO_3GEN_129` (13") | 2064x2752, 2048x2732 |
| `APP_IPAD_PRO_3GEN_11` | 1488x2266, 1668x2420, 1668x2388, 1640x2360 |
| `APP_IPAD_PRO_129` | 2048x2732 |

`display_type` must be one of Apple's `ScreenshotDisplayType` values; other
Apple values are refused as not supported yet. Apple has no separate type for
dual-screen devices.

Per set, the version must already have that locale (create it with the
listing text step first). Existing screenshots are compared by MD5, which is
what Apple stores as `sourceFileChecksum`:

- same files, same order, all `COMPLETE`: `unchanged`, no write (re-running a
  push is safe);
- same files, other order: `reorder` only;
- anything else: `replace` (or `upload` / `create_set_and_upload`): delete
  the set's screenshots, reserve each image, perform Apple's upload
  operations, commit with the MD5, poll `assetDeliveryState` until `COMPLETE`,
  set the order, then read the set back.

Each set is committed on its own: one set failing does not stop the others.
Only an error that would hit every set (Apple rejects the API key with 401/403,
404, rate limit, Apple 5xx, a 409 about the version's state, or any error that
is not clearly about that one set) stops the run; later sets are then
`not_attempted`. Each set ends in one of:

- `ok`: uploaded, `COMPLETE`, ordered, and read back;
- `failed`: an image ended `FAILED`, Apple refused a request for the set, or
  the read-back did not match;
- `uploaded_pending`: every image was uploaded and committed and none was
  rejected, but Apple was still processing at least one when the poll budget
  ran out. Not a success: the set's order and read-back were not done yet;
- `not_attempted`: skipped after a run-stopping error.

The response lists `failed_sets` and `pending_sets`. Any failed or
not-attempted set makes it 502 `SCREENSHOTS_FAILED` (this wins over pending);
otherwise any pending set makes it 202 `SCREENSHOTS_PENDING` with `ok: false`.
The CLI exits non-zero for both and prints the code. For pending sets: Apple is
still processing some screenshots. Run the dry run again later: if every set is
`unchanged`, files and order are confirmed; if a set shows `reorder` or
`replace`, run `--commit` again. Nothing is retried automatically. Because a
replace deletes before it uploads, a failed replace can leave a set partly
filled: fix the cause and push again.

Every prepare, listing, and screenshot call (dry runs included) is recorded in
the app audit log (`app_store.prepare_version`, `app_store.localizations`,
`app_store.screenshots`); listing text is recorded as sha256 and length only.

## Apple references

- [App Store Connect API: Prerelease Versions and Beta Testers](https://developer.apple.com/documentation/appstoreconnectapi/prerelease-versions-and-beta-testers)
- [Build Beta Notifications](https://developer.apple.com/documentation/appstoreconnectapi/build-beta-notifications)
- [Add internal testers](https://developer.apple.com/help/app-store-connect/test-a-beta-version/add-internal-testers/)
- [Invite external testers](https://developer.apple.com/help/app-store-connect/test-a-beta-version/invite-external-testers/)
- [Provide test information](https://developer.apple.com/help/app-store-connect/test-a-beta-version/provide-test-information/)
- [TestFlight overview](https://developer.apple.com/help/app-store-connect/test-a-beta-version/testflight-overview/)
- [App Store Connect API: App Store version release requests](https://developer.apple.com/documentation/appstoreconnectapi/app-store-version-release-requests)
- [App Store Connect API: App Store version localizations](https://developer.apple.com/documentation/appstoreconnectapi/app-store-version-localizations)
- [App Store Connect API: App screenshots](https://developer.apple.com/documentation/appstoreconnectapi/app-screenshots)
- [Uploading assets to App Store Connect](https://developer.apple.com/documentation/appstoreconnectapi/uploading-assets-to-app-store-connect)
- [Screenshot specifications](https://developer.apple.com/help/app-store-connect/reference/screenshot-specifications/)

## App Store Connect webhook notifications

Apple can notify Hands when an App Store version's review state, a TestFlight
build's external review state, or a build upload's processing state changes.
This uses [App Store Connect webhooks](https://developer.apple.com/help/app-store-connect/manage-your-team/manage-webhooks/), not in-app-purchase server notifications.

An app admin creates an ingress configuration using the **Hands app UUID**:

```http
POST /api/apps/{app_id}/apple-webhook
Authorization: Bearer <Hands session>
Content-Type: application/json

{"apple_app_id":"<numeric App Store Connect app ID>"}
```

The response contains `payload_url`, `secret` (shown once), and `event_types`.

If the app already has App Store Connect credentials stored in Hands, an app
admin can register this callback without copying keys or signing secrets:

```sh
hands api POST /api/apps/{app_id}/apple-webhook/register
```

Hands calls Apple using the stored credentials, discovers an existing subscription
for this exact callback URL before creating one, and reads it back to verify the
URL, enabled state, and all four event types. The result reveals no secret.
If Apple refuses the operation, the response names the failure stage and upstream
status; use an App Store Connect key with permission to manage webhooks.
Registration alone does not prove a real review notification reached your team.

The secret is encrypted at rest with the existing ASC credential encryption
key; keep it out of chat, logs, and shell arguments. Creating an existing
configuration returns 409 without rotating its secret. `GET` on the same path
returns metadata only; `DELETE` invalidates the URL. Recreating it produces a
new URL and secret; previous event receipts survive rotation.

In App Store Connect, open **Users and Access → Integrations → Additional →
Webhooks**, create a webhook, paste the returned URL and secret, and select
**the same Apple app** specified by `apple_app_id`. Select these four triggers:

| Apple trigger | Hands outbound event |
| --- | --- |
| `APP_STORE_VERSION_APP_VERSION_STATE_UPDATED` | `app_store:version_state_changed` |
| `BUILD_BETA_DETAIL_EXTERNAL_BUILD_STATE_UPDATED` | `testflight:external_state_changed` |
| `BUILD_UPLOAD_STATE_UPDATED` | `app_store:build_upload_state_changed` |
| `BETA_FEEDBACK_CRASH_SUBMISSION_CREATED` | `testflight:crash_submission_created` |

Choose **Test** and check the delivery's successful HTTP response in Apple's
recent deliveries. Authenticated test pings and unsupported event types are
acknowledged without a review notification. A test ping proves Apple can reach
the receiver; it does not prove a real review event reached your chat channel.

Subscribe your existing app-scoped or organization-scoped Hands webhook to the
outbound events above. The existing queue sends notifications immediately and
retries failures through its usual delivery ledger. A chat relay must support
these event types and deduplicate the stable `event_id`. Creating the ingress
does not itself configure a chat destination.

Outbound `payload` contains `apple_event_id`, `apple_app_id`, `app`
(`id`, `slug`, `name`), `resource` (`type`, `id`), `previous_state`, `state`,
`occurred_at`, and `app_store_connect_url`. States are Apple's raw values. Apple
build-upload events can omit the previous state and timestamp; those fields
are then null. The resource ID identifies the Apple version/build, not a Hands
build ID or a human-readable version number. No credentials or full Apple
payloads are forwarded. Display the event's timestamp and state transition;
out-of-order delivery must not overwrite an assumed current status.

For `testflight:crash_submission_created`, `resource` identifies the crash
submission, `state` and `occurred_at` contain Apple's `createdDate`, and
`previous_state` is null. Hands follows the submission's `build` relationship
to add the same best-effort `build` identity used by other TestFlight events.
It also creates an idempotent crash ticket in the normal feedback triage
surface and stores the `.ips` log as an internal attachment (up to 2 MiB). The
outbound payload carries `ticket_id`, never the crash-log body. A crash
submission reports a tester chose to share it, not the total crash count for
the build.

To backfill existing submissions, an app admin can call
`POST /api/apps/{appId}/testflight-crashes/backfill` with the same optional
`build`, `version`, and `limit` filters as the pull endpoint. It uses the same
idempotent ingest and returns `ticket_ids` and `failed_submission_ids`; a repeat
run does not create duplicate tickets. This is the supported way to recover
history and any submission whose earlier ingest failed.

Hands verifies `x-apple-signature` over the exact request bytes, limits the
body to 64 KiB, and commits the event receipt and matching outbound deliveries
atomically. Replayed event IDs do not create extra deliveries; reuse of an ID
with different bytes returns 409. Invalid signatures return 401 and malformed
supported events return 400. Apple provides manual redelivery in its delivery
history. Configure the webhook before relying on future notifications; it does
not replay review changes that happened before it existed.

### Upload processing and internal TestFlight notifications

Apple currently exposes an external TestFlight state webhook, but not an
internal TestFlight state webhook. For operations performed through Hands,
Hands also emits two events from Apple's verified operation readback:

- `testflight:upload_processing`: the upload response reports `PROCESSING`.
- `testflight:internal_distribution_ready`: the internal publish readback
  reports `IN_BETA_TESTING` and access for every requested internal group.

Subscribe to these events on an app or organization webhook. They use the
existing `event` / `event_id` / `payload` envelope. The payload includes
`source: hands_operation_receipt`, `operation_id`, app and Apple resource
identities, version, build number, platform, state, and an App Store Connect
link. Internal distribution also includes selected groups and
`auto_notify_enabled`. The optional `groups_display` field is a complete
Chinese notification line (for example, `测试组：Botiverse、Team B`) containing
all selected group names; an unnamed group falls back to its ID. It is absent
on upload and Apple callback events, so scalar notification templates can
leave the line blank. Internal distribution also carries `what_to_test` and
`source_commit` (see [Test notes and source commit](#test-notes-and-source-commit)).
This confirms internal availability, not that a tester
received an email. The operation success receipt and delivery rows commit
atomically; repeating the same operation receipt does not duplicate deliveries.

These are distinct from Apple callback events. A terminal upload readback
does not invent an earlier `PROCESSING` transition. Changes made directly in
App Store Connect are not covered by these Hands operation events.

### `build` on Apple callback events

Apple's own webhook envelope identifies the affected build only by its
`buildBetaDetails` id — it carries no version or build number. So for
`testflight:external_state_changed`, Hands follows
`buildBetaDetails/{id}/build` once and adds a `build` field to the payload:

```json
"build": { "version": "1.14.0", "version_code": "11400009" }
```

`version` is the marketing version (`preReleaseVersion.version` on Apple's
side) and `version_code` the build number (`builds.version`) — App Store
Connect stores those two in different resources, so they are not
interchangeable.

The field is **best effort and never blocks a notification**. If the app has
no App Store Connect credentials, Apple is slow (>5s) or errors, or the
response is an unexpected shape, `build` is `null` and the event is still
delivered with every other field unchanged. The `build` key itself is always
present, so a consumer must treat `null` as "version unknown, open the link"
rather than as an absent field. Events whose resource is not a build (e.g.
`app_store:version_state_changed`) always report `build: null`.

### Test notes and source commit

`testflight:external_state_changed` and `testflight:internal_distribution_ready`
also carry two keys for rendering a "ready to test" card:

```json
"what_to_test": { "zh-Hans": "测试登录流程", "en-US": "Check the login flow" },
"source_commit": "0123456789abcdef0123456789abcdef01234567"
```

`what_to_test` maps locale to the build's TestFlight **What to Test** text,
each truncated to 1000 characters; blank locales are dropped. On the external
event Hands reads `GET /v1/builds/{id}/betaBuildLocalizations` for the build
named by the `build` lookup (5 s budget). On the internal event it uses the
publish readback, falling back to the `what_to_test` sent with the publish
request; no extra Apple call is made.

`source_commit` is `provenance_json.source_commit` of the Hands iOS build with
the same build number (the internal event prefers the published Hands build
itself). It is set when the build was uploaded with `--source-commit`.

Both are best effort and never block delivery: the keys are always present on
these two events and are `null` when the build, its localizations, or a
matching Hands build cannot be read. Other event types do not carry them.

### `version_string` on version state events

`app_store:version_state_changed` also carries the marketing version of the
`appStoreVersions` resource, read with one
`GET /v1/appStoreVersions/{id}?fields[appStoreVersions]=versionString`:

```json
"version_string": "1.17.0", "version_lookup": "ok"
```

Same contract as `build`: best effort, 5 s budget, never blocks delivery. When
the app has no App Store Connect credentials or the read fails, the event is
delivered with `"version_string": null, "version_lookup": "failed"`. Other
event types do not carry these keys.
